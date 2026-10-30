/** 렌더러·네트워크·서버가 같은 규칙을 사용하며 서버 전용 인증 정보는 이 패키지에 넣지 않는다. */
export const RULE_VERSION = 2;
export const WORLD = {
  width: 1600,
  height: 960,
  border: 40,
  playerRadius: 17,
  tickRate: 60,
} as const;
export const WEAPONS = {
  rifle: {
    name: "소총",
    detail: "빠른 연사 · 균형 잡힌 중거리",
    damage: 13,
    interval: 0.13,
    speed: 1080,
    pellets: 1,
    spread: 0.025,
    range: 1100,
    blast: 0,
  },
  shotgun: {
    name: "산탄총",
    detail: "근접 화력 · 넓게 퍼지는 탄환",
    damage: 12,
    interval: 0.58,
    speed: 950,
    pellets: 7,
    spread: 0.42,
    range: 450,
    blast: 0,
  },
  sniper: {
    name: "저격총",
    detail: "정밀 조준 · 강한 한 발",
    damage: 94,
    interval: 0.88,
    speed: 1800,
    pellets: 1,
    spread: 0,
    range: 1550,
    blast: 0,
  },
  launcher: {
    name: "유탄발사기",
    detail: "폭발 피해 · 밀집한 적 정리",
    damage: 42,
    interval: 0.72,
    speed: 700,
    pellets: 1,
    spread: 0,
    range: 800,
    blast: 88,
  },
} as const;
export type WeaponId = keyof typeof WEAPONS;
export type Mode = "SINGLE" | "COOP";
/** 각 총에는 세 가지 강화만 제공한다. 서버 판정과 카드 미리보기가 같은 계산을 사용한다. */
export const UPGRADES = {
  rifleRate: {
    name: "고속 연사",
    description: "기본 연사속도 +10%",
    icon: "lightning",
  },
  riflePierce: {
    name: "관통탄",
    description: "추가 관통 +1명",
    icon: "target",
  },
  rifleCaliber: {
    name: "대구경 탄환",
    description: "탄환 크기·명중 판정 확대 · 최대 3배",
    icon: "target",
  },
  shotgunPellets: {
    name: "산탄 추가",
    description: "발사 산탄 +1발",
    icon: "target",
  },
  shotgunSpread: {
    name: "집탄 강화",
    description: "퍼짐 각도 감소 · 최소 7도",
    icon: "target",
  },
  shotgunRange: {
    name: "장거리 산탄",
    description: "사거리 +60 · 최대 930",
    icon: "target",
  },
  sniperDamage: {
    name: "고위력 탄환",
    description: "기본 탄환 피해 +20%",
    icon: "target",
  },
  sniperPierce: {
    name: "철갑 관통",
    description: "추가 관통 +1명",
    icon: "target",
  },
  sniperRate: {
    name: "신속 장전",
    description: "기본 연사속도 +10%",
    icon: "lightning",
  },
  launcherDamage: {
    name: "고폭 탄두",
    description: "기본 폭발 피해 +20% · 직격 피해는 유지",
    icon: "sun",
  },
  launcherRadius: {
    name: "광역 폭발",
    description: "기본 폭발 반경 +10% · 최대 1.8배",
    icon: "sun",
  },
  launcherRate: {
    name: "자동 장전",
    description: "기본 연사속도 +10%",
    icon: "lightning",
  },
} as const;
export type UpgradeId = keyof typeof UPGRADES;
export const UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];
export const WEAPON_UPGRADES = {
  rifle: ["rifleRate", "riflePierce", "rifleCaliber"],
  shotgun: ["shotgunPellets", "shotgunSpread", "shotgunRange"],
  sniper: ["sniperDamage", "sniperPierce", "sniperRate"],
  launcher: ["launcherDamage", "launcherRadius", "launcherRate"],
} as const satisfies Record<WeaponId, readonly UpgradeId[]>;
/** 크기·각도·범위만 제한하고 각 무기에 계속 투자할 수 있는 선택지를 남긴다. */
export const UPGRADE_CAPS: Partial<Record<UpgradeId, number>> = {
  rifleCaliber: 8,
  shotgunSpread: 10,
  shotgunRange: 8,
  launcherRadius: 8,
};
export const canUpgrade = (
  id: UpgradeId,
  upgrades: Record<UpgradeId, number>,
): boolean => upgrades[id] < (UPGRADE_CAPS[id] ?? Infinity);
export const EMPTY_UPGRADES = (): Record<UpgradeId, number> =>
  Object.fromEntries(UPGRADE_IDS.map((id) => [id, 0])) as Record<
    UpgradeId,
    number
  >;
export const BALANCE = {
  baseHealth: 120,
  baseSpeed: 265,
  baseArmor: 0,
  armorUnit: 100,
  dashDistance: 165,
  dashDuration: 0.17,
  dashCooldown: 3,
  hitProtection: 0.5,
  revivalProtection: 1,
  revivalHealth: 0.5,
  heal: 0.25,
  invulnerability: 2,
  invulnerabilityCooldown: 10,
  growth: { damage: 0.06, health: 12, armor: 4 },
  // 아이템 수거 유예는 없으며 클리어 표시만 짧게 유지한다.
  lootSeconds: 0.8,
  choiceSeconds: 10,
  reconnectSeconds: 15,
  pickupRadius: 38,
  inputTimeout: 0.35,
  drops: { heal: 0.065, invul: 0.012, revive: 0.004 },
} as const;
export type Phase = "lobby" | "combat" | "upgrade" | "loot" | "over";
export type EnemyKind =
  | "chaser"
  | "charger"
  | "shooter"
  | "shield"
  | "artillery"
  | "brute"
  | "skirmisher"
  | "boss-charge"
  | "boss-barrage"
  | "boss-artillery";
export type PickupKind = "xp" | "heal" | "revive" | "invul";
/** 공격 식별자와 범위를 공유해 서버 판정과 클라이언트 예고의 방향·크기를 일치시킨다. */
export type EnemyAttack = "" | "shot" | "charge" | "artillery" | "melee"
  | "boss-charge" | "boss-cleave" | "boss-fan" | "boss-ring"
  | "boss-burst" | "boss-spiral" | "boss-mortar" | "boss-crossfire";
export const BOSS_COMBAT = {
  fanArc: 1.4,
  cleaveRadius: 185,
  cleaveHalfAngle: 1.2,
  chargeSpeed: 850,
  chargeSeconds: 0.55,
} as const;
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PlayerView {
  id: string;
  nickname: string;
  avatar: string;
  color: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  hp: number;
  maxHp: number;
  armor: number;
  alive: boolean;
  connected: boolean;
  departed: boolean;
  ready: boolean;
  vote: boolean;
  choiceDone: boolean;
  inputSequence: number;
  weapon: WeaponId;
  upgrades: Record<UpgradeId, number>;
  revives: number;
  invuls: number;
  dashCooldown: number;
  invulCooldown: number;
  protection: number;
  dashRemaining: number;
  clearedStage: number;
  clearMillis: number;
}
export interface EnemyView {
  id: string;
  kind: EnemyKind;
  /** 구형 스냅샷에는 없을 수 있으며 연속 공격의 내부 타이머는 공개하지 않는다. */
  attack?: EnemyAttack;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  radius: number;
  warning: number;
  targetX: number;
  targetY: number;
  spawnRemaining: number;
  boss: boolean;
}
export interface BulletView {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hostile: boolean;
  radius: number;
  weapon: string;
  owner: string;
}
export interface PickupView {
  id: string;
  x: number;
  y: number;
  kind: PickupKind;
  amount: number;
}
export interface HazardView {
  id: string;
  x: number;
  y: number;
  radius: number;
  warning: number;
  life: number;
  kind: string;
}
export interface EffectView {
  id: string;
  x: number;
  y: number;
  radius: number;
  life: number;
  kind: string;
  value: number;
  duration: number;
}
export interface GameSnapshot {
  /** 공개 방 정보만 동기화하며 비밀번호와 인증 신원은 포함하지 않는다. */
  hostId: string;
  title: string;
  privateRoom: boolean;
  phase: Phase;
  mode: Mode;
  stage: number;
  level: number;
  xp: number;
  nextXp: number;
  combatMillis: number;
  clearedStage: number;
  clearMillis: number;
  deadline: number;
  paused: boolean;
  pauseReason: string;
  reconnectRemaining: number;
  enemyTotal: number;
  enemiesSpawned: number;
  enemiesKilled: number;
  wave: number;
  waveCount: number;
  bossName: string;
  notice: string;
  players: Record<string, PlayerView>;
  enemies: Record<string, EnemyView>;
  bullets: Record<string, BulletView>;
  pickups: Record<string, PickupView>;
  hazards: Record<string, HazardView>;
  effects: Record<string, EffectView>;
  walls: Rect[];
}
export interface InputFrame {
  sequence: number;
  moveX: number;
  moveY: number;
  aim: number;
  firing: boolean;
}
export type GameAction =
  | { type: "replay" }
  | { type: "ready"; weapon: WeaponId }
  | { type: "dash" }
  | { type: "invul" }
  | { type: "revive"; target: "self" | "ally" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "upgrade"; upgrade: UpgradeId };
/** 예측 이동도 서버와 같은 정규화·벽 충돌을 사용해 화면 크기에 따른 이동 이득을 막는다. */
export function movement(
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  walls: readonly Rect[],
): { x: number; y: number } {
  let nextX = Math.max(
    WORLD.border + radius,
    Math.min(WORLD.width - WORLD.border - radius, x + dx),
  );
  for (const wall of walls) {
    if (y + radius <= wall.y || y - radius >= wall.y + wall.height) continue;
    if (dx > 0 && x + radius <= wall.x && nextX + radius > wall.x)
      nextX = Math.min(nextX, wall.x - radius);
    if (
      dx < 0 &&
      x - radius >= wall.x + wall.width &&
      nextX - radius < wall.x + wall.width
    )
      nextX = Math.max(nextX, wall.x + wall.width + radius);
  }
  let nextY = Math.max(
    WORLD.border + radius,
    Math.min(WORLD.height - WORLD.border - radius, y + dy),
  );
  for (const wall of walls) {
    if (nextX + radius <= wall.x || nextX - radius >= wall.x + wall.width)
      continue;
    if (dy > 0 && y + radius <= wall.y && nextY + radius > wall.y)
      nextY = Math.min(nextY, wall.y - radius);
    if (
      dy < 0 &&
      y - radius >= wall.y + wall.height &&
      nextY - radius < wall.y + wall.height
    )
      nextY = Math.max(nextY, wall.y + wall.height + radius);
  }
  return { x: nextX, y: nextY };
}
export const isWeapon = (value: unknown): value is WeaponId =>
  typeof value === "string" && Object.hasOwn(WEAPONS, value);
export const isUpgrade = (value: unknown): value is UpgradeId =>
  typeof value === "string" && Object.hasOwn(UPGRADES, value);
/** 티켓은 로그인에 결합한 브라우저 개인키로 한 번 더 서명한다. 다른 게임·Origin·방으로 재사용하지 않는다. */
export const connectionMessage = (
  ticket: string,
  mode: Mode,
  target: string,
  origin: string,
): string => `shooting-connect-v1\n${ticket}\n${mode}\n${target}\n${origin}`;
/** 공격·체력·방어는 레벨마다 자동 성장하고 이동·대시 조작감은 일정하게 유지한다. */
export function playerStats(level: number) {
  const growth = Math.max(0, level - 1);
  return {
    health: BALANCE.baseHealth + BALANCE.growth.health * growth,
    armor: BALANCE.baseArmor + BALANCE.growth.armor * growth,
    speed: BALANCE.baseSpeed,
    damage: 1 + BALANCE.growth.damage * growth,
  };
}
/** 유탄은 직격 피해와 폭발 피해를 분리한다. 폭발은 명중한 적을 포함해 정확히 한 번 적용한다. */
export function weaponStats(
  weapon: WeaponId,
  upgrades: Record<UpgradeId, number>,
  level: number,
) {
  const base = WEAPONS[weapon],
    growth = playerStats(level).damage;
  return {
    ...base,
    damage:
      base.damage *
      growth *
      (weapon === "sniper" ? 1 + 0.2 * upgrades.sniperDamage : 1),
    interval:
      base.interval /
      (1 +
        0.1 *
          (weapon === "rifle"
            ? upgrades.rifleRate
            : weapon === "sniper"
              ? upgrades.sniperRate
              : weapon === "launcher"
                ? upgrades.launcherRate
                : 0)),
    pellets:
      base.pellets + (weapon === "shotgun" ? upgrades.shotgunPellets : 0),
    spread:
      weapon === "shotgun"
        ? Math.max(0.12, base.spread - 0.03 * upgrades.shotgunSpread)
        : base.spread,
    range:
      base.range +
      (weapon === "shotgun" ? 60 * Math.min(8, upgrades.shotgunRange) : 0),
    radius:
      weapon === "launcher"
        ? 7
        : weapon === "sniper"
          ? 3.5
          : weapon === "rifle"
            ? 3 + 0.75 * Math.min(8, upgrades.rifleCaliber)
            : 3,
    piercing:
      weapon === "rifle"
        ? upgrades.riflePierce
        : weapon === "sniper"
          ? upgrades.sniperPierce
          : 0,
    blast: base.blast * (1 + 0.1 * Math.min(8, upgrades.launcherRadius)),
    explosionDamage:
      weapon === "launcher"
        ? base.damage * 0.8 * growth * (1 + 0.2 * upgrades.launcherDamage)
        : 0,
  };
}
/** 화면에 쓰는 수치도 실제 전투 계산에서 추출하여 설명과 판정이 어긋나지 않게 한다. */
export function upgradePreview(
  weapon: WeaponId,
  upgrades: Record<UpgradeId, number>,
  level: number,
  id: UpgradeId,
): string {
  const before = weaponStats(weapon, upgrades, level);
  const after = weaponStats(
    weapon,
    { ...upgrades, [id]: upgrades[id] + 1 },
    level,
  );
  const value = (stats: ReturnType<typeof weaponStats>): string => {
    if (id.endsWith("Rate")) return `${(1 / stats.interval).toFixed(2)}발/초`;
    if (id.endsWith("Pierce")) return `${stats.piercing + 1}명`;
    if (id === "rifleCaliber") return `${(stats.radius / 3).toFixed(2)}배`;
    if (id === "shotgunPellets") return `${stats.pellets}발`;
    if (id === "shotgunSpread")
      return `${((stats.spread * 180) / Math.PI).toFixed(1)}°`;
    if (id === "shotgunRange") return `${stats.range}`;
    if (id === "launcherRadius") return `${stats.blast.toFixed(1)}`;
    return `${(id === "launcherDamage" ? stats.explosionDamage : stats.damage).toFixed(1)}`;
  };
  return canUpgrade(id, upgrades)
    ? `${value(before)} → ${value(after)}`
    : `${value(before)} · 최대 강화`;
}
export const formatTime = (milliseconds: number): string => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(
      2,
      "0",
    )}:${(seconds % 60).toString().padStart(2, "0")}.${Math.floor(
    (milliseconds % 1000) / 10,
  )
    .toString()
    .padStart(2, "0")}`;
};
