import {
  WORLD,
  movement,
  weaponStats,
  type GameSnapshot,
  type PlayerView,
  type EnemyView,
  type EnemyKind,
  type BulletView,
  type HazardView,
  type Rect,
} from "@playground/shooting-shared";
import {
  Navigation,
  SpatialGrid,
  segmentCircle,
  segmentRect,
  distanceSquared,
} from "./geometry.ts";

interface EnemyActor extends EnemyView {
  cooldown: number;
  speed: number;
  damage: number;
  charging: number;
  chargeX: number;
  chargeY: number;
  attack: string;
}
interface BulletActor extends BulletView {
  damage: number;
  distance: number;
  piercing: number;
  blast: number;
  explosionDamage: number;
  hit: Set<string>;
}
interface HazardActor extends HazardView {
  damage: number;
  activated: boolean;
}
export interface CombatHooks {
  state: GameSnapshot;
  random: () => number;
  nextId: () => string;
  hitPlayer: (player: PlayerView, damage: number) => void;
  defeated: (enemy: EnemyView) => void;
  effect: (
    kind: string,
    x: number,
    y: number,
    radius: number,
    value?: number,
  ) => void;
}
const ordinary: EnemyKind[] = [
  "chaser",
  "charger",
  "shooter",
  "shield",
  "artillery",
  "brute",
  "skirmisher",
];
/** 근접은 높은 체력으로 추격하고 원거리는 낮은 체력과 거리 유지로 역할을 나눈다. */
const traits = {
  chaser: { health: 1.65, speed: 1.08, radius: 20, ranged: false },
  charger: { health: 1.9, speed: 0.9, radius: 21, ranged: false },
  shield: { health: 2.4, speed: 0.68, radius: 24, ranged: false },
  brute: { health: 3.2, speed: 0.6, radius: 28, ranged: false },
  shooter: { health: 0.85, speed: 0.82, radius: 18, ranged: true },
  artillery: { health: 1, speed: 0.65, radius: 20, ranged: true },
  skirmisher: { health: 0.7, speed: 1.22, radius: 16, ranged: true },
  "boss-charge": { health: 1, speed: 0.75, radius: 52, ranged: false },
  "boss-barrage": { health: 1, speed: 0.6, radius: 50, ranged: true },
  "boss-artillery": { health: 1, speed: 0.55, radius: 54, ranged: true },
} as const satisfies Record<
  EnemyKind,
  { health: number; speed: number; radius: number; ranged: boolean }
>;

/** 전투 판정은 서버에서 고정 간격으로 수행한다. 네트워크 스키마와 Phaser 객체에 의존하지 않는다. */
export class CombatWorld {
  private readonly enemies = new Map<string, EnemyActor>();
  private readonly bullets = new Map<string, BulletActor>();
  private readonly hazards = new Map<string, HazardActor>();
  private readonly pool: BulletActor[] = [];
  private readonly grid = new SpatialGrid<EnemyActor>();
  private navigation: Navigation;
  private readonly hooks: CombatHooks;
  private readonly shotClock = new Map<string, number>();
  private collisionWalls: Rect[] = this.boundaries();
  private targets: PlayerView[] = [];

  constructor(hooks: CombatHooks) {
    this.hooks = hooks;
    this.navigation = new Navigation([]);
  }

  reset(): void {
    this.enemies.clear();
    this.hazards.clear();
    this.shotClock.clear();
    for (const bullet of this.bullets.values()) this.recycle(bullet);
    this.bullets.clear();
    this.hooks.state.enemies = {};
    this.hooks.state.bullets = {};
    this.hooks.state.hazards = {};
    this.navigation = new Navigation(this.hooks.state.walls);
    this.collisionWalls = [...this.hooks.state.walls, ...this.boundaries()];
  }
  ceaseFire(): void {
    for (const bullet of this.bullets.values()) this.recycle(bullet);
    this.bullets.clear();
    this.hazards.clear();
    this.hooks.state.bullets = {};
    this.hooks.state.hazards = {};
  }
  get size(): number {
    return this.enemies.size;
  }

  spawn(kind?: EnemyKind): void {
    const state = this.hooks.state,
      stage = state.stage;
    const selected =
      kind ??
      ordinary[
        Math.floor(this.hooks.random() * (stage < 2 ? 3 : ordinary.length))
      ];
    const trait = traits[selected];
    const boss = selected.startsWith("boss");
    let point = { x: WORLD.width / 2, y: 230 };
    if (!boss) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const side = Math.floor(this.hooks.random() * 4);
        point =
          side < 2
            ? {
                x: side === 0 ? 105 : WORLD.width - 105,
                y: 110 + this.hooks.random() * (WORLD.height - 220),
              }
            : {
                x: 110 + this.hooks.random() * (WORLD.width - 220),
                y: side === 2 ? 105 : WORLD.height - 105,
              };
        if (
          !state.walls.some(
            (w) =>
              point.x > w.x - 40 &&
              point.x < w.x + w.width + 40 &&
              point.y > w.y - 40 &&
              point.y < w.y + w.height + 40,
          ) &&
          Object.values(state.players).every(
            (p) => !p.alive || distanceSquared(p, point) > 150 ** 2,
          )
        )
          break;
      }
    }
    const baseHealth = boss
      ? 900 * (1 + stage * 0.15) ** 1.8
      : 34 * (1 + (stage - 1) * 0.18) ** 1.35;
    const hp =
      baseHealth *
      (state.mode === "COOP" ? (boss ? 2.5 : 1.4) : 1) *
      trait.health;
    const id = this.hooks.nextId();
    const enemy: EnemyActor = {
      id,
      kind: selected,
      ...point,
      angle: Math.PI / 2,
      hp,
      maxHp: hp,
      radius: trait.radius,
      warning: 0,
      targetX: point.x,
      targetY: point.y,
      spawnRemaining: boss ? 1 : 0.65,
      boss,
      cooldown: 0.8 + this.hooks.random(),
      speed: (105 + 26 * Math.log2(stage + 1)) * trait.speed,
      damage: 12 * (1 + stage * 0.09) ** 2.15 * (boss ? 1.3 : 1),
      charging: 0,
      chargeX: 0,
      chargeY: 0,
      attack: "",
    };
    this.enemies.set(id, enemy);
    state.enemies[id] = enemy;
    state.enemiesSpawned++;
  }

  step(dt: number): void {
    const targets = Object.values(this.hooks.state.players).filter(
      (p) => p.alive && !p.departed,
    );
    this.targets = targets;
    this.navigation.refresh(dt, targets);
    for (const enemy of this.enemies.values())
      this.advanceEnemy(enemy, targets, dt);
    this.grid.rebuild(this.enemies.values());
    for (const bullet of this.bullets.values()) this.advanceBullet(bullet, dt);
    for (const hazard of this.hazards.values()) {
      hazard.warning = Math.max(0, hazard.warning - dt);
      if (hazard.warning === 0 && !hazard.activated) {
        hazard.activated = true;
        this.hooks.effect("enemy-explosion", hazard.x, hazard.y, hazard.radius);
        for (const player of targets)
          if (
            distanceSquared(player, hazard) <=
            (hazard.radius + WORLD.playerRadius) ** 2
          )
            this.hooks.hitPlayer(player, hazard.damage);
      }
      if (hazard.activated) hazard.life -= dt;
      if (hazard.life <= 0) {
        this.hazards.delete(hazard.id);
        delete this.hooks.state.hazards[hazard.id];
      }
    }
  }

  fire(player: PlayerView, firing: boolean, dt: number): void {
    let wait = (this.shotClock.get(player.id) ?? 0) - dt;
    if (!firing || !player.alive) {
      this.shotClock.set(player.id, Math.max(0, wait));
      return;
    }
    const weapon = weaponStats(
      player.weapon,
      player.upgrades,
      this.hooks.state.level,
    );
    const interval = weapon.interval;
    if (wait <= 0) {
      const cycles = Math.floor(-wait / interval) + 1;
      // 높은 공격속도는 피해량으로 묶어 보존하여 성장 상한 없이 실제 생성 비용을 제한한다.
      const renderedCycles = Math.min(3, cycles),
        weight = cycles / renderedCycles;
      // 산탄을 계속 강화해도 화면의 탄환 수는 제한하고 묶인 산탄의 피해량은 보존한다.
      const pellets = Math.min(21, weapon.pellets),
        pelletWeight = weapon.pellets / pellets;
      for (let cycle = 0; cycle < renderedCycles; cycle++)
        for (let pellet = 0; pellet < pellets; pellet++) {
          const spread =
            pellets > 1 ? (pellet / (pellets - 1) - 0.5) * weapon.spread : 0;
          const angle = player.aim + spread;
          this.createBullet({
            // 벽에 붙어 쏠 때도 탄환을 벽 안에서 생성하지 않아 관통 판정을 보존한다.
            x: player.x,
            y: player.y,
            vx: Math.cos(angle) * weapon.speed,
            vy: Math.sin(angle) * weapon.speed,
            damage: weapon.damage * weight * pelletWeight,
            radius: weapon.radius,
            hostile: false,
            owner: player.id,
            weapon: player.weapon,
            distance: weapon.range,
            piercing: weapon.piercing,
            blast: weapon.blast,
            // 폭발 피해와 반경을 독립 강화하며 첫 범위 강화부터 실제 반경이 커진다.
            explosionDamage: weapon.explosionDamage * weight,
          });
        }
      wait += cycles * interval;
    }
    this.shotClock.set(player.id, wait);
  }

  eliminateRemaining(): void {
    // 보스 사망 소멸도 정상 경험치·확률 드롭을 적용한다. 추가 웨이브는 진행 계층에서 중단한다.
    for (const enemy of Array.from(this.enemies.values())) this.kill(enemy);
    this.ceaseFire();
  }

  private advanceEnemy(
    enemy: EnemyActor,
    players: PlayerView[],
    dt: number,
  ): void {
    if (enemy.hp <= 0) return;
    enemy.spawnRemaining = Math.max(0, enemy.spawnRemaining - dt);
    if (enemy.spawnRemaining > 0 || players.length === 0) return;
    const target = players.reduce((best, p) =>
      distanceSquared(enemy, p) < distanceSquared(enemy, best) ? p : best,
    );
    const dist = Math.sqrt(distanceSquared(enemy, target));
    enemy.angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    enemy.cooldown -= dt;
    if (enemy.charging > 0) {
      const next = movement(
        enemy.x,
        enemy.y,
        enemy.chargeX * dt,
        enemy.chargeY * dt,
        enemy.radius,
        this.hooks.state.walls,
      );
      enemy.x = next.x;
      enemy.y = next.y;
      enemy.charging -= dt;
      // 돌진 종료 후의 보스 탄환도 현재 목표 방향 한 발로 통일한다.
      if (enemy.charging <= 0 && enemy.boss)
        this.hostileBullet(enemy, enemy.angle, 280);
    } else if (enemy.warning > 0) {
      enemy.warning = Math.max(0, enemy.warning - dt);
      if (enemy.warning === 0) this.resolveAttack(enemy);
    } else {
      const ranged = traits[enemy.kind].ranged;
      const visible = this.navigation.visible(enemy, target, 5);
      const preferred =
        enemy.kind === "skirmisher" ? 270 : enemy.boss ? 400 : 430;
      // 벽에 가린 원거리 적은 사격 대기하지 않고 크기에 맞는 길을 찾아 엄폐물을 우회한다.
      if (
        !ranged ||
        !visible ||
        dist > preferred ||
        dist < 170 ||
        enemy.kind === "skirmisher"
      ) {
        const destination = this.navigation.direction(
          enemy,
          target,
          enemy.radius,
        );
        const angle = Math.atan2(
          destination.y - enemy.y,
          destination.x - enemy.x,
        );
        const direction = ranged && visible && dist < 170 ? -1 : 1;
        const strafe =
          enemy.kind === "skirmisher" &&
          visible &&
          dist >= 170 &&
          dist <= preferred;
        const steering = strafe ? enemy.angle + Math.PI / 2 : angle;
        const next = movement(
          enemy.x,
          enemy.y,
          Math.cos(steering) * enemy.speed * direction * dt,
          Math.sin(steering) * enemy.speed * direction * dt,
          enemy.radius,
          this.hooks.state.walls,
        );
        // 후퇴·옆걸음이 벽에 막히면 추격 경로로 돌아가 같은 자리에서 계속 걷지 않는다.
        if (
          ranged &&
          Math.hypot(next.x - enemy.x, next.y - enemy.y) <
            enemy.speed * dt * 0.2
        ) {
          const forward = movement(
            enemy.x,
            enemy.y,
            Math.cos(angle) * enemy.speed * dt,
            Math.sin(angle) * enemy.speed * dt,
            enemy.radius,
            this.hooks.state.walls,
          );
          enemy.x = forward.x;
          enemy.y = forward.y;
        } else {
          enemy.x = next.x;
          enemy.y = next.y;
        }
      }
      const meleeSwing = enemy.kind === "brute" && dist < 120 && visible;
      if (
        enemy.cooldown <= 0 &&
        (ranged
          ? visible && dist < 700
          : enemy.kind.includes("charge")
            ? visible && dist < 620
            : meleeSwing)
      ) {
        enemy.targetX = target.x;
        enemy.targetY = target.y;
        enemy.warning = enemy.kind.includes("charge")
          ? enemy.boss
            ? 0.85
            : 0.6
          : enemy.boss
            ? 0.6
            : 0.4;
        enemy.attack = enemy.kind.includes("charge")
          ? "charge"
          : enemy.kind.includes("artillery")
            ? "artillery"
            : enemy.kind === "boss-barrage"
              ? "barrage"
              : meleeSwing
                ? "melee"
                : "shot";
        enemy.cooldown = Math.max(
          0.7,
          (enemy.boss ? 1.65 : 2.0) /
            (1 + Math.log2(this.hooks.state.stage + 1) * 0.12),
        );
      }
    }
    for (const player of players)
      if (
        distanceSquared(enemy, player) <
        (enemy.radius + WORLD.playerRadius) ** 2
      )
        this.hooks.hitPlayer(
          player,
          enemy.damage * (enemy.charging > 0 ? 1.25 : 1),
        );
  }

  private resolveAttack(enemy: EnemyActor): void {
    const angle = Math.atan2(enemy.targetY - enemy.y, enemy.targetX - enemy.x);
    if (enemy.attack === "charge") {
      enemy.charging = enemy.boss ? 0.55 : 0.38;
      enemy.chargeX = Math.cos(angle) * (enemy.boss ? 850 : 690);
      enemy.chargeY = Math.sin(angle) * (enemy.boss ? 850 : 690);
    } else if (enemy.attack === "artillery") {
      // 보스도 한 공격당 포격 지점 하나만 생성해 여러 갈래 공격을 동시에 피하지 않게 한다.
      this.artillery(enemy, enemy.targetX, enemy.targetY);
    } else if (enemy.attack === "barrage") {
      this.hostileBullet(
        enemy,
        angle,
        250 + Math.log2(this.hooks.state.stage + 1) * 15,
      );
    } else if (enemy.attack === "melee") {
      // 중장갑 근접병은 예고한 방향으로 한 번 휘두른다. 멀리 빠지거나 뒤로 돌아 피할 수 있다.
      this.hooks.effect("melee-swipe", enemy.x, enemy.y, 110, angle);
      for (const player of this.targets) {
        const toward = Math.atan2(player.y - enemy.y, player.x - enemy.x);
        if (
          distanceSquared(enemy, player) <= 110 ** 2 &&
          Math.cos(toward - angle) > 0.35 &&
          this.navigation.visible(enemy, player, 0)
        )
          this.hooks.hitPlayer(player, enemy.damage * 1.2);
      }
    } else {
      // 일반 몬스터는 조준 방향으로 한 발만 발사해 세 갈래 탄환의 회피 부담을 줄인다.
      this.hostileBullet(enemy, angle, 350);
    }
  }

  private hostileBullet(enemy: EnemyActor, angle: number, speed: number): void {
    this.createBullet({
      x: enemy.x + Math.cos(angle) * (enemy.radius + 5),
      y: enemy.y + Math.sin(angle) * (enemy.radius + 5),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      damage: enemy.damage,
      radius: enemy.boss ? 7 : 5,
      hostile: true,
      owner: enemy.id,
      weapon: "enemy",
      distance: 1900,
      piercing: 0,
      blast: 0,
      explosionDamage: 0,
    });
  }
  private artillery(enemy: EnemyActor, x: number, y: number): void {
    const id = this.hooks.nextId();
    const hazard: HazardActor = {
      id,
      x,
      y: Math.max(75, Math.min(WORLD.height - 75, y)),
      radius: enemy.boss ? 100 : 76,
      warning: 0.9,
      life: 0.3,
      kind: "artillery",
      damage: enemy.damage * 1.25,
      activated: false,
    };
    this.hazards.set(id, hazard);
    this.hooks.state.hazards[id] = hazard;
  }

  private createBullet(value: Omit<BulletActor, "id" | "hit">): void {
    const bullet = this.pool.pop() ?? {
      ...value,
      id: "",
      hit: new Set<string>(),
    };
    Object.assign(bullet, value, { id: this.hooks.nextId() });
    bullet.hit.clear();
    this.bullets.set(bullet.id, bullet);
    this.hooks.state.bullets[bullet.id] = bullet;
  }

  private advanceBullet(bullet: BulletActor, dt: number): void {
    let remaining = Math.min(
      Math.hypot(bullet.vx, bullet.vy) * dt,
      bullet.distance,
    );
    if (remaining <= 0) {
      this.removeBullet(bullet, true);
      return;
    }
    // 한 틱에서 여러 면을 만나도 가장 가까운 충돌부터 처리한다.
    for (
      let pass = 0;
      pass < 8 && remaining > 0 && this.bullets.has(bullet.id);
      pass++
    ) {
      const speed = Math.hypot(bullet.vx, bullet.vy),
        dx = (bullet.vx / speed) * remaining,
        dy = (bullet.vy / speed) * remaining;
      let fraction = 1.001,
        target: EnemyActor | PlayerView | undefined,
        wall = false;
      for (const item of this.collisionWalls) {
        const hit = segmentRect(
          bullet.x,
          bullet.y,
          dx,
          dy,
          item,
          bullet.radius,
        );
        if (hit && hit.fraction < fraction) {
          fraction = hit.fraction;
          wall = true;
          target = undefined;
        }
      }
      const candidates = bullet.hostile
        ? this.targets
        : this.grid.query(
            bullet.x + dx / 2,
            bullet.y + dy / 2,
            remaining / 2 + 60,
          );
      for (const candidate of candidates) {
        if (
          candidate.hp <= 0 ||
          bullet.hit.has(candidate.id) ||
          ("spawnRemaining" in candidate && candidate.spawnRemaining > 0)
        )
          continue;
        const radius =
          "radius" in candidate ? candidate.radius : WORLD.playerRadius;
        const at = segmentCircle(
          bullet.x,
          bullet.y,
          dx,
          dy,
          candidate,
          radius + bullet.radius,
        );
        if (at !== undefined && at < fraction) {
          fraction = at;
          target = candidate;
          wall = false;
        }
      }
      const travel = Math.min(1, fraction);
      bullet.x += dx * travel;
      bullet.y += dy * travel;
      bullet.distance -= remaining * travel;
      remaining *= 1 - travel;
      if (fraction > 1) break;
      if (wall) {
        // 벽 충돌 시 제거 경로에서만 폭발시켜 중복 효과·이중 피해를 방지한다.
        this.removeBullet(bullet, true);
        return;
      } else if (target) {
        bullet.hit.add(target.id);
        if (bullet.hostile) {
          this.hooks.hitPlayer(target as PlayerView, bullet.damage);
          this.removeBullet(bullet, false);
          return;
        }
        const enemy = target as EnemyActor;
        let damage = bullet.damage;
        if (enemy.kind === "shield" && bullet.piercing === 0) {
          const approach = Math.atan2(-bullet.vy, -bullet.vx);
          if (
            Math.abs(
              Math.atan2(
                Math.sin(approach - enemy.angle),
                Math.cos(approach - enemy.angle),
              ),
            ) < 1.05
          )
            damage *= 0.22;
        }
        this.damageEnemy(enemy, damage);
        if (bullet.blast > 0) this.explosion(bullet);
        if (bullet.piercing > 0) {
          bullet.piercing--;
          bullet.x += (bullet.vx / speed) * 0.1;
          bullet.y += (bullet.vy / speed) * 0.1;
        } else {
          this.removeBullet(bullet, false);
          return;
        }
      }
    }
    if (bullet.distance <= 0) this.removeBullet(bullet, true);
  }

  private explosion(bullet: BulletActor): void {
    this.hooks.effect("explosion", bullet.x, bullet.y, bullet.blast);
    for (const enemy of this.grid.query(
      bullet.x,
      bullet.y,
      bullet.blast + 55,
    )) {
      if (
        enemy.hp > 0 &&
        enemy.spawnRemaining <= 0 &&
        distanceSquared(enemy, bullet) <= (bullet.blast + enemy.radius) ** 2
      )
        this.damageEnemy(enemy, bullet.explosionDamage);
    }
  }
  private damageEnemy(enemy: EnemyActor, damage: number): void {
    if (!this.enemies.has(enemy.id) || enemy.hp <= 0) return;
    enemy.hp = Math.max(0, enemy.hp - damage);
    this.hooks.effect(
      "hit",
      enemy.x,
      enemy.y - enemy.radius,
      0,
      Math.round(damage),
    );
    if (enemy.hp <= 0) this.kill(enemy);
  }
  private kill(enemy: EnemyActor): void {
    if (!this.enemies.delete(enemy.id)) return;
    enemy.hp = 0;
    delete this.hooks.state.enemies[enemy.id];
    this.hooks.effect(
      enemy.boss ? "boss-death" : "death",
      enemy.x,
      enemy.y,
      enemy.radius * 2,
    );
    this.hooks.defeated(enemy);
  }
  private removeBullet(bullet: BulletActor, explode: boolean): void {
    if (!this.bullets.delete(bullet.id)) return;
    if (explode && bullet.blast > 0 && !bullet.hostile) this.explosion(bullet);
    delete this.hooks.state.bullets[bullet.id];
    this.recycle(bullet);
  }
  private recycle(bullet: BulletActor): void {
    if (this.pool.length < 2048) this.pool.push(bullet);
  }
  private boundaries() {
    return [
      { x: 0, y: 0, width: WORLD.width, height: WORLD.border },
      {
        x: 0,
        y: WORLD.height - WORLD.border,
        width: WORLD.width,
        height: WORLD.border,
      },
      { x: 0, y: 0, width: WORLD.border, height: WORLD.height },
      {
        x: WORLD.width - WORLD.border,
        y: 0,
        width: WORLD.border,
        height: WORLD.height,
      },
    ];
  }
}
