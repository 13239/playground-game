import {
  WORLD,
  STAGE_MAPS,
  stageSpawn,
  BOSS_COMBAT,
  ATTACK_READABILITY,
  hazardContains,
  movement,
  terrainSpeed,
  encounterFor,
  weaponStats,
  type GameSnapshot,
  type PlayerView,
  type EnemyView,
  type EnemyKind,
  type EnemyAttack,
  type BulletView,
  type HazardView,
  type Rect,
  type StageDevice,
  type MissionNodeView,
  type StageMapId,
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
  sourceId?: string;
  impact?: () => void;
}
export interface CombatHooks {
  missionHit: (id: string, vx: number, vy: number, owner: string) => void;
  bossPhase: () => void;
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
  sniper: { health: 0.8, speed: 0.7, radius: 19, ranged: true },
  support: { health: 1.2, speed: 0.75, radius: 22, ranged: true },
  "boss-charge": { health: 1, speed: 0.75, radius: 52, ranged: false },
  "boss-barrage": { health: 1, speed: 0.6, radius: 50, ranged: true },
  "boss-artillery": { health: 1, speed: 0.55, radius: 54, ranged: true },
} as const satisfies Record<
  EnemyKind,
  { health: number; speed: number; radius: number; ranged: boolean }
>;

/** 보스마다 맵 고유 패턴을 순환해 같은 공격만 반복하지 않고, 연속 공격도 서버 틱 안에서 끝낸다. */
const bossPatterns = {
  "boss-charge": ["boss-charge", "boss-cleave", "boss-fan"],
  "boss-barrage": ["boss-spiral", "boss-burst", "boss-crossfire"],
  "boss-artillery": ["boss-mortar", "boss-ring", "boss-fan"],
} as const satisfies Partial<Record<EnemyKind, readonly EnemyAttack[]>>;

// 중간 수호자는 두 가지 공략을 먼저 익히게 하고, 최종 보스는 추가 패턴과 다른 순서로 확장한다.
const guardianPatterns = {
  "boss-charge": ["boss-charge", "boss-cleave"],
  "boss-barrage": ["boss-burst", "boss-crossfire"],
  "boss-artillery": ["boss-mortar", "boss-fan"],
} as const satisfies Partial<Record<EnemyKind, readonly EnemyAttack[]>>;

/** 같은 원형 보스를 쓰는 후반 맵도 서로 다른 공격 순서를 가지며 프레임마다 설정 객체를 만들지 않는다. */
const mapBossPatterns: Partial<Record<StageMapId, readonly EnemyAttack[]>> = {
  DESERT: ["boss-charge", "boss-mortar", "boss-cleave"],
  ICE: ["boss-burst", "boss-ring", "boss-crossfire"],
  VOLCANO: ["boss-mortar", "boss-spiral", "boss-cleave"],
};

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
  private terrainClock = 0;
  private arenaClock = 0;
  private attackSlots = 0;

  /** 공략 성공은 탄막 제거와 짧은 그로기로 즉시 보상한다. 성공 처리를 경험치로 반복 보상하지 않는다. */
  openMissionWindow(): void {
    this.ceaseFire();
    for (const enemy of this.enemies.values()) {
      enemy.cooldown = Math.max(enemy.cooldown, 1.2);
      enemy.exposed = Math.max(enemy.exposed, 2);
    }
  }

  /** 통합 위험 예산과 도달 가능한 회피 후보를 검사한 뒤 환경 공격을 예약한다. */
  queueMissionHazard(value: Omit<HazardView, "id"> & { sourceId?: string; damage?: number }, impact?: () => void): boolean {
    const players = Object.values(this.hooks.state.players).filter(p => p.alive && !p.departed);
    const pending = [...this.hazards.values()].filter(h => h.warning > 0);
    const strong = [...this.enemies.values()].filter(e => e.warning > 0 || e.charging > 0 || e.volleyRemaining > 0).length;
    const budget = this.hooks.state.mode === "COOP" ? 4 : 3;
    if (pending.length + strong >= budget) return false;
    const arrival = value.warning;
    const overlaps = pending.filter(h => Math.abs(h.warning - arrival) < 0.7);
    for (const player of players) {
      let safe = false;
      for (let i = 0; i < 25; i++) {
        const angle = (i % 12) * Math.PI / 6;
        const slow = terrainSpeed(player.x, player.y, Object.values(this.hooks.state.devices));
        const distance = i === 24 ? 0 : Math.min(230, 190 * slow * arrival) * (i < 12 ? 1 : 0.5);
        const point = movement(player.x, player.y, Math.cos(angle) * distance, Math.sin(angle) * distance, WORLD.playerRadius, this.hooks.state.walls);
        if (![value, ...overlaps].some(h => hazardContains(point, h, WORLD.playerRadius))) { safe = true; break; }
      }
      if (!safe) return false;
    }
    const hazard: HazardActor = {
      ...value, id: this.hooks.nextId(), damage: value.damage ?? 30 + this.hooks.state.stage * 2.4,
      activated: false, impact,
    };
    this.hazards.set(hazard.id, hazard);
    this.hooks.state.hazards[hazard.id] = hazard;
    return true;
  }

  constructor(hooks: CombatHooks) {
    this.hooks = hooks;
    this.navigation = new Navigation([]);
  }

  reset(): void {
    this.terrainClock = 0;
    this.arenaClock = 0;
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

  spawn(kind?: EnemyKind, elite = false): void {
    const state = this.hooks.state,
      stage = state.stage;
    const roster = STAGE_MAPS[state.mapId].ordinary;
    const selected = kind ?? roster[state.enemiesSpawned % roster.length];
    const trait = traits[selected];
    const boss = selected.startsWith("boss");
    // 같은 맵의 출현 위치와 등장 순서는 반복 도전에서도 재현한다.
    const point = boss
      ? { x: WORLD.width / 2, y: WORLD.height / 2 }
      : stageSpawn(state.mapId, stage, state.enemiesSpawned);
    const baseHealth = boss
      ? stage === 5
        ? 1400
        : 2400
      : 34 * (1 + (stage - 1) * 0.075);
    const hp =
      baseHealth *
      (state.mode === "COOP" ? (boss ? 1.9 : 1.1) : 1) *
      (1 + STAGE_MAPS[state.mapId].order * 0.12) *
      trait.health * (elite ? 1.45 : 1);
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
      windup: 0,
      elite,
      combatPhase: 1,
      targetX: point.x,
      targetY: point.y,
      spawnRemaining: boss ? 1 : 0.65,
      boss,
      exposed: 0,
      cooldown: 0.8 + (state.enemiesSpawned % 4) * 0.2,
      speed: (105 + 26 * Math.log2(stage + 1)) * trait.speed,
      // 피할 수 있게 예고한 강공격의 실수는 크게 아프고, 정예는 체력만 늘리지 않고 공격 주기도 바꾼다.
      damage: (24 + stage * 2.2) * (boss ? 1.8 : elite ? 1.2 : 1),
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
    // 고위험 예고·연사를 동시에 무제한 시작하지 않아 회피할 여지를 남긴다.
    this.attackSlots = 0;
    for (const enemy of this.enemies.values())
      if (enemy.warning > 0 || enemy.charging > 0 || enemy.volleyRemaining > 0) this.attackSlots++;
    this.advanceTerrain(dt);
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
            hazardContains(player, hazard, WORLD.playerRadius) &&
            !Object.values(this.hooks.state.missionNodes).some(node => node.kind === "shelter" && distanceSquared(player, node) < (node.radius - WORLD.playerRadius) ** 2)
          )
            this.hooks.hitPlayer(player, hazard.damage);
        hazard.impact?.();
      }
      if (hazard.activated) hazard.life -= dt;
      if (hazard.life <= 0) {
        this.hazards.delete(hazard.id);
        delete this.hooks.state.hazards[hazard.id];
      }
    }
  }

  /** 용암은 전투 시간으로만 진행한다. 예고 후 한 번만 피해를 주고 장치를 부수면 예약된 분출도 취소한다. */
  private advanceTerrain(dt: number): void {
    this.advanceMapPressure(dt);
    // 8스테이지도 맵 고유 기믹 위에 각 맵의 압박 패턴을 얹는다. 모든 위치를 충분히 예고한다.
    if (this.hooks.state.mapId !== "VOLCANO") return;
    this.terrainClock += dt;
    if (this.terrainClock < 4.8) return;
    this.terrainClock %= 4.8;
    for (const device of Object.values(this.hooks.state.devices)) {
      if (device.kind !== "lava-vent" || device.hp <= 0) continue;
      this.queueMissionHazard({
        x: device.x, y: device.y, radius: 155, warning: 1.2, windup: 1.2, life: 0.45,
        kind: "lava", damage: 18 + this.hooks.state.stage * 1.8,
        sourceId: device.id,
      });
    }
  }

  /** 같은 번호라도 맵마다 고리·광선·발밑 예고의 조합과 간격이 달라진다. 예고 중에는 범위를 고정한다. */
  private advanceMapPressure(dt: number): void {
    this.arenaClock += dt;
    const state = this.hooks.state;
    const interval = Math.max(2.9, 5.3 - state.stage * 0.17 - (state.bossName ? 0.4 : 0));
    if (this.arenaClock < interval) return;
    const targets = Object.values(state.players).filter(p => p.alive && !p.departed);
    if (!targets.length) return;
    const cycle = Math.floor(state.stageMillis / (interval * 1000));
    const target = targets[cycle % targets.length];
    const base = { x: target.x, y: target.y, radius: 95, warning: 1.2, windup: 1.2, life: 0.35, kind: "map-pressure", shape: "circle" };
    let value: Omit<HazardView, "id"> = base;
    switch (encounterFor(state.mapId, state.stage).pressure) {
      case "rocks": value = { ...base, x: Math.max(130, Math.min(1470, target.x + target.vx * 0.35)), y: Math.max(130, Math.min(830, target.y + target.vy * 0.35)), radius: 112, kind: "cave-rock" }; break;
      case "laser": value = { ...base, shape: "line", length: 1050, radius: 38, angle: cycle * Math.PI / 4, kind: "factory-laser" }; break;
      case "pollen": value = { ...base, shape: "ring", radius: cycle % 2 ? 220 : 105, innerRadius: cycle % 2 ? 125 : 0, warning: 1.3, windup: 1.3, kind: "garden-bloom" }; break;
      case "sand": value = { ...base, shape: cycle % 2 ? "line" : "circle", length: 900, radius: cycle % 2 ? 52 : 115, angle: cycle % 2 ? Math.PI / 2 : 0, kind: "desert-burrow" }; break;
      case "frost": value = { ...base, shape: "line", length: 950, radius: 42, angle: cycle % 2 ? Math.PI / 4 : -Math.PI / 4, warning: 1.5, windup: 1.5, kind: "ice-fracture" }; break;
      case "magma": value = { ...base, shape: cycle % 2 ? "ring" : "circle", radius: cycle % 2 ? 240 : 120, innerRadius: cycle % 2 ? 140 : 0, kind: "volcano-pressure" }; break;
    }
    if (this.queueMissionHazard(value)) this.arenaClock = 0;
    else this.arenaClock = interval - 0.35;
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
    enemy.exposed = Math.max(0, enemy.exposed - dt);
    // 보스의 금색 약점 표시는 공략으로 확보한 전체 공격 시간과 일치한다.
    if (enemy.boss) enemy.exposed = this.hooks.state.objectiveComplete ? Math.max(enemy.exposed, this.hooks.state.objectiveWindow) : 0;
    enemy.spawnRemaining = Math.max(0, enemy.spawnRemaining - dt);
    if (enemy.spawnRemaining > 0 || players.length === 0) return;
    // 최종 보스는 65%·35%에서 지원 분대를 호출한다. 한 단계당 두 명만 추가하며 총 처치 수에도 반영한다.
    if (enemy.boss && this.hooks.state.stage === 10) {
      const phase = enemy.hp <= enemy.maxHp * BOSS_COMBAT.finalPhaseHealth
        ? 3
        : enemy.hp <= enemy.maxHp * BOSS_COMBAT.secondPhaseHealth ? 2 : 1;
      const previousPhase = enemy.combatPhase;
      while (enemy.combatPhase < phase) {
        enemy.combatPhase++;
        this.hooks.state.enemyTotal += 2;
        this.spawn("support");
        this.spawn("charger", enemy.combatPhase === 3);
        this.hooks.effect("boss-phase", enemy.x, enemy.y, 100, enemy.combatPhase);
      }
      // 체력 경계를 넘은 바로 이 틱에 방어를 복구해 고화력·동시 탄환의 단계 건너뛰기를 막는다.
      if (previousPhase !== enemy.combatPhase) this.hooks.bossPhase();
    }
    const target = players.reduce((best, p) =>
      distanceSquared(enemy, p) < distanceSquared(enemy, best) ? p : best,
    );
    const dist = Math.sqrt(distanceSquared(enemy, target));
    enemy.angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    enemy.cooldown -= dt;
    if (enemy.charging > 0) {
      const before = { x: enemy.x, y: enemy.y };
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
      if (enemy.charging <= 0 && !enemy.boss) {
        enemy.exposed = Math.max(enemy.exposed, 0.8);
        enemy.cooldown = Math.max(enemy.cooldown, 1);
      }
      // 수정 동굴의 돌기둥에 돌진을 유도하면 장갑이 깨져 공격 기회가 생긴다.
      const blocked = Math.hypot(enemy.x - before.x, enemy.y - before.y) < Math.hypot(enemy.chargeX, enemy.chargeY) * dt * 0.4;
      if (blocked && !enemy.boss) {
        enemy.charging = 0;
        enemy.exposed = 1.2;
        enemy.cooldown = 1.3;
        this.hooks.effect("armor-break", enemy.x, enemy.y, enemy.radius * 1.5);
      }
      if (
        enemy.boss &&
        this.hooks.state.mapId === "CAVE" &&
        Math.hypot(enemy.x - before.x, enemy.y - before.y) <
          Math.hypot(enemy.chargeX, enemy.chargeY) * dt * 0.4
      ) {
        const pillar = Object.values(this.hooks.state.devices).find(
          (d) =>
            d.kind === "pillar" &&
            d.hp > 0 &&
            distanceSquared(d, enemy) < (d.radius + enemy.radius + 16) ** 2,
        );
        if (pillar) {
          this.damageDevice(pillar, pillar.hp);
          enemy.exposed = 6;
          enemy.charging = 0;
          enemy.warning = 0;
          enemy.cooldown = 1.4;
          this.hooks.effect(
            "armor-break",
            enemy.x,
            enemy.y,
            enemy.radius * 1.7,
          );
          return;
        }
      }
      // 돌진 뒤 최종 보스는 부채꼴 후속 사격을 별도로 예고해 바로 앞의 플레이어도 회피할 수 있다.
      // 중간 수호자는 돌진 뒤 빈틈을 유지해 기둥 유인과 근접 회피를 먼저 익히게 한다.
      if (enemy.charging <= 0 && enemy.boss && this.hooks.state.stage === 10) {
        enemy.attack = "boss-fan";
        enemy.targetX = target.x;
        enemy.targetY = target.y;
        enemy.warning = 0.75;
        enemy.windup = 0.75;
      }
    } else if (enemy.warning > 0) {
      // 사수는 발사 0.22초 전 조준을 고정한다. 그 뒤 늦게 피하는 판단을 실제 판정과 동일하게 표현한다.
      if ((enemy.attack === "shot" || enemy.attack === "snipe") && enemy.warning > ATTACK_READABILITY.lockSeconds) {
        enemy.targetX = target.x;
        enemy.targetY = target.y;
      }
      enemy.warning = Math.max(0, enemy.warning - dt);
      if (enemy.warning === 0) this.resolveAttack(enemy);
    } else if (enemy.volleyRemaining > 0) {
      this.advanceBossVolley(enemy, dt);
    } else {
      const ranged = traits[enemy.kind].ranged;
      const visible = this.navigation.visible(enemy, target, 5);
      const preferred =
        enemy.kind === "skirmisher" ? 270 : enemy.kind === "sniper" ? 600 : enemy.boss ? 400 : 430;
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
      const gardenSpore =
        this.hooks.state.mapId === "GARDEN" &&
        enemy.kind === "chaser" &&
        dist < 300;
      const meleeSwing =
        (enemy.kind === "brute" ||
          (this.hooks.state.mapId === "FACTORY" && enemy.kind === "chaser")) &&
        dist < 120 &&
        visible;
      if (
        enemy.cooldown <= 0 &&
        enemy.kind !== "support" &&
        this.attackSlots < (this.hooks.state.mode === "COOP" ? 3 : 2) &&
        (enemy.boss
          ? visible && dist < 850
          : ranged
            ? visible && dist < 700
            : enemy.kind.includes("charge")
              ? visible && dist < 620
              : meleeSwing || gardenSpore)
      ) {
        this.attackSlots++;
        enemy.targetX = target.x;
        enemy.targetY = target.y;
        if (enemy.boss) {
          const basePatterns = (
            this.hooks.state.stage === 5 ? guardianPatterns : bossPatterns
          )[enemy.kind as keyof typeof bossPatterns];
          const selected = mapBossPatterns[this.hooks.state.mapId];
          const patterns = selected ? selected.slice(0, this.hooks.state.stage === 5 ? 2 : 3) : basePatterns;
          enemy.attack = patterns[(enemy.attackCycle++ + enemy.combatPhase - 1) % patterns.length];
          enemy.warning = enemy.attack === "boss-charge" ? 0.95 : 0.8;
        } else {
          enemy.warning = enemy.kind === "sniper" ? 1.05 : enemy.kind.includes("charge") ? 0.65 : 0.6;
          enemy.attack = enemy.kind === "sniper" ? "snipe" : enemy.kind.includes("charge")
            ? "charge"
            : enemy.kind.includes("artillery") || gardenSpore
              ? "artillery"
              : meleeSwing
                ? "melee"
                : "shot";
          enemy.cooldown = Math.max(
            0.7,
            1.8 / (1 + Math.log2(this.hooks.state.stage + 1) * 0.12),
          ) * (enemy.elite ? 0.85 : 1);
        }
        enemy.windup = enemy.warning;
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
      // 일반 사수는 읽기 쉬운 한 발, 저격수는 조준 고정 뒤 빠르고 강한 한 발로 역할을 구분한다.
      this.hostileBullet(enemy, angle, enemy.attack === "snipe" ? 1000 : 470);
    }
  }

  private resolveBossAttack(enemy: EnemyActor, angle: number): void {
    const enraged = enemy.hp <= enemy.maxHp * BOSS_COMBAT.finalPhaseHealth;
    enemy.cooldown = enraged ? 1.05 : 1.4;
    // 강공격 종료 후 실제 피해 배율이 높아지는 반격 창을 제공한다.
    if (!['boss-charge', 'boss-burst', 'boss-spiral', 'boss-mortar', 'boss-crossfire'].includes(enemy.attack)) enemy.exposed = 0.8;
    if (enemy.attack === "boss-charge") {
      enemy.charging = BOSS_COMBAT.chargeSeconds;
      enemy.chargeX = Math.cos(angle) * BOSS_COMBAT.chargeSpeed;
      enemy.chargeY = Math.sin(angle) * BOSS_COMBAT.chargeSpeed;
    } else if (enemy.attack === "boss-fan") {
      this.fan(enemy, angle, enraged ? 9 : 7, BOSS_COMBAT.fanArc, 390);
    } else if (enemy.attack === "boss-ring") {
      const count = enraged ? 16 : 12;
      for (let i = 0; i < count; i++)
        this.hostileBullet(
          enemy,
          angle + ((i + 0.5) * Math.PI * 2) / count,
          360,
        );
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
      enemy.volleyRemaining =
        enemy.attack === "boss-spiral"
          ? enraged
            ? 18
            : 12
          : enemy.attack === "boss-burst"
            ? enraged
              ? 4
              : 3
            : enraged
              ? 7
              : 5;
      this.advanceBossVolley(enemy, 0);
    }
  }

  private fan(
    enemy: EnemyActor,
    angle: number,
    count: number,
    arc: number,
    speed: number,
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
      const angle = Math.atan2(
        enemy.targetY - enemy.y,
        enemy.targetX - enemy.x,
      );
      const step = enemy.attackStep++;
      if (enemy.attack === "boss-burst") {
        this.fan(enemy, angle + (step % 2 ? 0.07 : -0.07), 3, 0.32, 360);
        enemy.volleyWait += 0.2;
      } else if (enemy.attack === "boss-spiral") {
        this.hostileBullet(enemy, angle + step * 0.43, 350);
        this.hostileBullet(enemy, angle + step * 0.43 + Math.PI, 350);
        enemy.volleyWait += 0.11;
      } else {
        // 중심→주변 또는 십자 순서로 낙하한다. 각 지점은 생성 후 0.9초를 온전히 예고한다.
        const offset =
          step === 0
            ? 0
            : enemy.attack === "boss-crossfire"
              ? 180 * Math.ceil(step / 4)
              : 185;
        const direction =
          enemy.attack === "boss-crossfire"
            ? angle + ((step - 1) * Math.PI) / 2
            : angle + ((step - 1) * Math.PI) / 3;
        this.artillery(
          enemy,
          enemy.targetX + Math.cos(direction) * offset,
          enemy.targetY + Math.sin(direction) * offset,
        );
        enemy.volleyWait += 0.18;
      }
      enemy.volleyRemaining--;
      if (enemy.volleyRemaining === 0) {
        enemy.cooldown = enemy.hp <= enemy.maxHp * BOSS_COMBAT.finalPhaseHealth ? 0.95 : 1.3;
        enemy.exposed = Math.max(enemy.exposed, 1.1);
      }
    }
  }

  private hostileBullet(enemy: EnemyActor, angle: number, speed: number): void {
    this.createBullet({
      x: enemy.x + Math.cos(angle) * (enemy.radius + 5),
      y: enemy.y + Math.sin(angle) * (enemy.radius + 5),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      damage: enemy.damage * (enemy.attack === "snipe" ? 1.65 : 1),
      radius: enemy.boss ? 7 : 5,
      hostile: true,
      owner: enemy.id,
      weapon: enemy.attack === "snipe" ? "enemy-sniper" : "enemy",
      distance: 1900,
      piercing: 0,
      blast: 0,
      explosionDamage: 0,
    });
    this.hooks.effect("enemy-shot", enemy.x, enemy.y, enemy.radius + 12, angle);
  }
  private artillery(enemy: EnemyActor, x: number, y: number): void {
    const radius = enemy.boss ? 90 : 76;
    this.queueMissionHazard({
      // 경계에서도 원 전체와 예고가 보이도록 실제 판정 위치를 함께 제한한다.
      x: Math.max(
        WORLD.border + radius,
        Math.min(WORLD.width - WORLD.border - radius, x),
      ),
      y: Math.max(
        WORLD.border + radius,
        Math.min(WORLD.height - WORLD.border - radius, y),
      ),
      radius,
      warning: 0.9,
      windup: 0.9,
      life: 0.3,
      kind: this.hooks.state.mapId === "GARDEN" ? "spore" : "artillery",
      damage: enemy.damage * 1.25,
    });
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
        target: EnemyActor | PlayerView | StageDevice | MissionNodeView | undefined,
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
      if (!bullet.hostile) {
        // 공략 노드는 일반 장치의 체력·폭발 경로와 분리한다. 발사점·운반물은 탄환을 막지 않는다.
        for (const node of Object.values(this.hooks.state.missionNodes)) {
          if (!["reflect", "circuit", "prune", "pulse", "resonate", "wind", "mirage", "minus", "plus"].includes(node.kind) || node.status === "done") continue;
          const at = segmentCircle(bullet.x, bullet.y, dx, dy, node, node.radius + bullet.radius);
          if (at !== undefined && at < fraction) { fraction = at; target = node; wall = false; }
        }
        for (const device of Object.values(this.hooks.state.devices)) {
          if (device.hp <= 0 || bullet.hit.has(device.id)) continue;
          const at = segmentCircle(
            bullet.x,
            bullet.y,
            dx,
            dy,
            device,
            device.radius + bullet.radius,
          );
          if (at !== undefined && at < fraction) {
            fraction = at;
            target = device;
            wall = false;
          }
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
        if (!("boss" in target)) {
          if ("status" in target) {
            this.hooks.missionHit(target.id, bullet.vx, bullet.vy, bullet.owner);
            this.removeBullet(bullet, false);
            return;
          }
          this.damageDevice(target as StageDevice, bullet.damage);
          this.removeBullet(bullet, true);
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
    for (const device of Object.values(this.hooks.state.devices))
      if (
        device.hp > 0 &&
        distanceSquared(device, bullet) <= (bullet.blast + device.radius) ** 2
      )
        this.damageDevice(device, bullet.explosionDamage);
  }
  /** 장치 파괴·연쇄 폭발은 서버의 동일한 피해 경로를 사용하며 재귀 중 같은 장치를 다시 파괴하지 않는다. */
  private damageDevice(device: StageDevice, damage: number): void {
    if (device.hp <= 0) return;
    device.hp = Math.max(0, device.hp - damage);
    this.hooks.effect(
      "hit",
      device.x,
      device.y - device.radius,
      0,
      Math.round(damage),
    );
    if (device.hp > 0) return;
    this.hooks.effect(
      "device-break",
      device.x,
      device.y,
      device.kind === "crystal" ? 220 : 90,
    );
    if (device.kind === "pillar") {
      this.hooks.state.walls = this.hooks.state.walls.filter(
        (w) =>
          !(
            Math.abs(w.x + w.width / 2 - device.x) < 1 &&
            Math.abs(w.y + w.height / 2 - device.y) < 1
          ),
      );
      this.navigation = new Navigation(this.hooks.state.walls);
      this.collisionWalls = [...this.hooks.state.walls, ...this.boundaries()];
    }
    if (device.kind === "crystal") {
      for (const enemy of [...this.enemies.values()]) {
        if (distanceSquared(enemy, device) > (220 + enemy.radius) ** 2)
          continue;
        enemy.exposed = Math.max(enemy.exposed, 3);
        this.damageEnemy(enemy, enemy.boss ? enemy.maxHp * 0.1 : enemy.maxHp);
      }
    }
    // 모래·빙결 핵 파괴는 둔화 구역을 즉시 없애고 근처 적과 보스의 약점을 노출한다.
    if (device.kind === "sand-totem" || device.kind === "frost-core") {
      for (const enemy of [...this.enemies.values()]) {
        if (enemy.boss || distanceSquared(enemy, device) <= (210 + enemy.radius) ** 2) {
          enemy.exposed = Math.max(enemy.exposed, 5);
          enemy.cooldown = Math.max(enemy.cooldown, 1.5);
          this.damageEnemy(enemy, enemy.maxHp * (enemy.boss ? 0.04 : 0.35));
        }
      }
    }
    if (device.kind === "lava-vent") {
      for (const hazard of this.hazards.values()) {
        if (hazard.sourceId !== device.id) continue;
        this.hazards.delete(hazard.id);
        delete this.hooks.state.hazards[hazard.id];
      }
    }
    if (device.kind === "generator" || device.kind === "root") {
      for (const enemy of this.enemies.values()) {
        if (!enemy.boss) continue;
        enemy.exposed = 8;
        enemy.volleyRemaining = 0;
        enemy.warning = 0;
        enemy.cooldown = 1.5;
      }
      // 뿌리를 자르면 이미 생성된 꽃가루도 걷혀 접근 경로가 실제로 열린다.
      if (device.kind === "root") {
        this.hazards.clear();
        this.hooks.state.hazards = {};
      }
    }
  }
  private damageEnemy(enemy: EnemyActor, damage: number): void {
    if (!this.enemies.has(enemy.id) || enemy.hp <= 0) return;
    const state = this.hooks.state;
    // 필수 공략을 생략한 화력 처치를 차단한다. 일반 몬스터는 평소처럼 공격할 수 있다.
    if (enemy.boss && !state.objectiveComplete) return;
    const powered = Object.values(state.devices).some(
      (d) =>
        d.hp > 0 &&
        (d.kind === "generator" || (enemy.boss && d.kind === "root")),
    );
    // 공격 우선순위·장갑 파괴에 성공하면 같은 무기로도 처치 시간이 분명히 줄어든다.
    // 지원 범위의 적은 장갑을 얻는다. 지원병 자신에게는 적용하지 않아 우선 처치로 돌파할 수 있다.
    const supported = enemy.kind !== "support" && [...this.enemies.values()].some((source) =>
      source.kind === "support" && source.hp > 0 && source.spawnRemaining <= 0 &&
      distanceSquared(source, enemy) < ATTACK_READABILITY.supportRadius ** 2,
    );
    const multiplier = enemy.exposed > 0 ? 2.2 : powered ? 0.45 : supported ? 0.55 : 1;
    const actual = damage * multiplier;
    const floor = enemy.boss && state.stage === 10
      ? enemy.combatPhase === 1 ? enemy.maxHp * BOSS_COMBAT.secondPhaseHealth
        : enemy.combatPhase === 2 ? enemy.maxHp * BOSS_COMBAT.finalPhaseHealth : 0
      : 0;
    enemy.hp = Math.max(floor, enemy.hp - actual);
    this.hooks.effect(
      "hit",
      enemy.x,
      enemy.y - enemy.radius,
      0,
      Math.round(actual),
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
