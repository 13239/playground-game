import {
  WORLD,
  BOSS_COMBAT,
  movement,
  weaponStats,
  type GameSnapshot,
  type PlayerView,
  type EnemyView,
  type EnemyKind,
  type EnemyAttack,
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
  attack: EnemyAttack;
  attackCycle: number;
  volleyRemaining: number;
  volleyWait: number;
  attackStep: number;
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

/** 보스마다 네 패턴을 순환해 같은 공격만 반복하지 않고, 연속 공격도 서버 틱 안에서 끝낸다. */
const bossPatterns = {
  "boss-charge": ["boss-charge", "boss-fan", "boss-cleave", "boss-ring"],
  "boss-barrage": ["boss-fan", "boss-burst", "boss-spiral", "boss-ring"],
  "boss-artillery": ["boss-mortar", "boss-crossfire", "boss-burst", "boss-ring"],
} as const satisfies Partial<Record<EnemyKind, readonly EnemyAttack[]>>;

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
    // 클리어·종료 때 예약된 연사와 돌진도 취소해 이후 틱에서 다시 발사되지 않게 한다.
    for (const enemy of this.enemies.values()) {
      enemy.volleyRemaining = 0;
      enemy.warning = 0;
      enemy.charging = 0;
    }
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
      attackCycle: 0,
      volleyRemaining: 0,
      volleyWait: 0,
      attackStep: 0,
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
      // 돌진 뒤 보스는 부채꼴 후속 사격을 별도로 예고해 바로 앞의 플레이어도 회피할 수 있다.
      if (enemy.charging <= 0 && enemy.boss) {
        enemy.attack = "boss-fan";
        enemy.targetX = target.x;
        enemy.targetY = target.y;
        enemy.warning = 0.75;
      }
    } else if (enemy.warning > 0) {
      enemy.warning = Math.max(0, enemy.warning - dt);
      if (enemy.warning === 0) this.resolveAttack(enemy);
    } else if (enemy.volleyRemaining > 0) {
      this.advanceBossVolley(enemy, dt);
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
        (enemy.boss
          ? visible && dist < 850
          : ranged
            ? visible && dist < 700
            : enemy.kind.includes("charge")
              ? visible && dist < 620
              : meleeSwing)
      ) {
        enemy.targetX = target.x;
        enemy.targetY = target.y;
        if (enemy.boss) {
          const patterns = bossPatterns[enemy.kind as keyof typeof bossPatterns];
          enemy.attack = patterns[enemy.attackCycle++ % patterns.length];
          enemy.warning = enemy.attack === "boss-charge" ? 0.95 : 0.8;
        } else {
          enemy.warning = enemy.kind.includes("charge") ? 0.6 : 0.4;
          enemy.attack = enemy.kind.includes("charge")
            ? "charge"
            : enemy.kind.includes("artillery")
              ? "artillery"
              : meleeSwing
                ? "melee"
                : "shot";
          enemy.cooldown = Math.max(
            0.7,
            2 / (1 + Math.log2(this.hooks.state.stage + 1) * 0.12),
          );
        }
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
    if (enemy.boss) {
      this.resolveBossAttack(enemy, angle);
    } else if (enemy.attack === "charge") {
      enemy.charging = 0.38;
      enemy.chargeX = Math.cos(angle) * 690;
      enemy.chargeY = Math.sin(angle) * 690;
    } else if (enemy.attack === "artillery") {
      // 일반 포격병은 한 지점, 보스는 별도의 다중 포격 패턴으로 역할을 구분한다.
      this.artillery(enemy, enemy.targetX, enemy.targetY);
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

  private resolveBossAttack(enemy: EnemyActor, angle: number): void {
    const enraged = enemy.hp <= enemy.maxHp * 0.5;
    enemy.cooldown = enraged ? 0.95 : 1.3;
    if (enemy.attack === "boss-charge") {
      enemy.charging = BOSS_COMBAT.chargeSeconds;
      enemy.chargeX = Math.cos(angle) * BOSS_COMBAT.chargeSpeed;
      enemy.chargeY = Math.sin(angle) * BOSS_COMBAT.chargeSpeed;
    } else if (enemy.attack === "boss-fan") {
      this.fan(enemy, angle, enraged ? 9 : 7, BOSS_COMBAT.fanArc, 290);
    } else if (enemy.attack === "boss-ring") {
      const count = enraged ? 16 : 12;
      for (let i = 0; i < count; i++)
        this.hostileBullet(enemy, angle + (i + 0.5) * Math.PI * 2 / count, 235);
    } else if (enemy.attack === "boss-cleave") {
      const { cleaveRadius: radius, cleaveHalfAngle } = BOSS_COMBAT;
      this.hooks.effect("melee-swipe", enemy.x, enemy.y, radius, angle);
      for (const player of this.targets) {
        const toward = Math.atan2(player.y - enemy.y, player.x - enemy.x);
        if (
          distanceSquared(enemy, player) <= radius ** 2 &&
          Math.cos(toward - angle) >= Math.cos(cleaveHalfAngle) &&
          this.navigation.visible(enemy, player, 0)
        )
          this.hooks.hitPlayer(player, enemy.damage * 1.35);
      }
    } else {
      // 최대 18회만 예약하며 별도 타이머·클로저를 만들지 않는다. 일시정지 시 시뮬레이션과 함께 멈춘다.
      enemy.attackStep = 0;
      enemy.volleyWait = 0;
      enemy.volleyRemaining = enemy.attack === "boss-spiral"
        ? (enraged ? 18 : 12)
        : enemy.attack === "boss-burst"
          ? (enraged ? 4 : 3)
          : (enraged ? 7 : 5);
      this.advanceBossVolley(enemy, 0);
    }
  }

  private fan(
    enemy: EnemyActor, angle: number, count: number, arc: number, speed: number,
  ): void {
    for (let i = 0; i < count; i++)
      this.hostileBullet(enemy, angle + (i / (count - 1) - 0.5) * arc, speed);
  }

  private advanceBossVolley(enemy: EnemyActor, dt: number): void {
    enemy.volleyWait -= dt;
    // 큰 틱이 들어와도 한꺼번에 무제한 발사하지 않으며 정상 고정 틱에서는 발사 간격을 보존한다.
    for (
      let emitted = 0;
      enemy.volleyRemaining > 0 && enemy.volleyWait <= 0 && emitted < 4;
      emitted++
    ) {
      const angle = Math.atan2(enemy.targetY - enemy.y, enemy.targetX - enemy.x);
      const step = enemy.attackStep++;
      if (enemy.attack === "boss-burst") {
        this.fan(enemy, angle + (step % 2 ? 0.07 : -0.07), 3, 0.32, 360);
        enemy.volleyWait += 0.2;
      } else if (enemy.attack === "boss-spiral") {
        this.hostileBullet(enemy, angle + step * 0.43, 245);
        this.hostileBullet(enemy, angle + step * 0.43 + Math.PI, 245);
        enemy.volleyWait += 0.11;
      } else {
        // 중심→주변 또는 십자 순서로 낙하한다. 각 지점은 생성 후 0.9초를 온전히 예고한다.
        const offset = step === 0 ? 0
          : enemy.attack === "boss-crossfire" ? 180 * Math.ceil(step / 4) : 185;
        const direction = enemy.attack === "boss-crossfire"
          ? angle + (step - 1) * Math.PI / 2
          : angle + (step - 1) * Math.PI / 3;
        this.artillery(
          enemy,
          enemy.targetX + Math.cos(direction) * offset,
          enemy.targetY + Math.sin(direction) * offset,
        );
        enemy.volleyWait += 0.18;
      }
      enemy.volleyRemaining--;
      if (enemy.volleyRemaining === 0)
        enemy.cooldown = enemy.hp <= enemy.maxHp * 0.5 ? 0.95 : 1.3;
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
    const radius = enemy.boss ? 90 : 76;
    const hazard: HazardActor = {
      id,
      // 경계에서도 원 전체와 예고가 보이도록 실제 판정 위치를 함께 제한한다.
      x: Math.max(WORLD.border + radius, Math.min(WORLD.width - WORLD.border - radius, x)),
      y: Math.max(WORLD.border + radius, Math.min(WORLD.height - WORLD.border - radius, y)),
      radius,
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
