import { schema, t, type MapSchema, type Schema } from "@colyseus/schema";
import type { GameSnapshot } from "@playground/shooting-shared";

const numberField = () => t.number().default(0);
const stringField = () => t.string().default("");
const booleanField = () => t.boolean().default(false);
const numbers = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((name) => [name, numberField()])) as {
    [P in K]: ReturnType<typeof numberField>;
  };
const strings = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((name) => [name, stringField()])) as {
    [P in K]: ReturnType<typeof stringField>;
  };
const booleans = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((name) => [name, booleanField()])) as {
    [P in K]: ReturnType<typeof booleanField>;
  };

/** 최신 필드 빌더를 사용하며 인증 신원은 스키마에 정의하지 않아 브라우저로 직렬화되지 않는다. */
const Player = schema(
  {
    ...strings("id", "nickname", "avatar", "weapon"),
    ...numbers(
      "color",
      "x",
      "y",
      "vx",
      "vy",
      "aim",
      "hp",
      "maxHp",
      "armor",
      "revives",
      "invuls",
      "dashCooldown",
      "invulCooldown",
      "protection",
      "dashRemaining",
      "clearedStage",
      "clearMillis",
      "inputSequence",
    ),
    ...booleans(
      "alive",
      "connected",
      "departed",
      "ready",
      "vote",
      "choiceDone",
    ),
    upgrades: t.map("number"),
  },
  "ShootingPlayer",
);
const Enemy = schema(
  {
    ...strings("id", "kind"),
    ...numbers(
      "x",
      "y",
      "angle",
      "hp",
      "maxHp",
      "radius",
      "warning",
      "targetX",
      "targetY",
      "spawnRemaining",
    ),
    ...booleans("boss"),
  },
  "ShootingEnemy",
);
const Bullet = schema(
  {
    ...strings("id", "weapon", "owner"),
    ...numbers("x", "y", "vx", "vy", "radius"),
    ...booleans("hostile"),
  },
  "ShootingBullet",
);
const Pickup = schema(
  { ...strings("id", "kind"), ...numbers("x", "y", "amount") },
  "ShootingPickup",
);
const Hazard = schema(
  {
    ...strings("id", "kind"),
    ...numbers("x", "y", "radius", "warning", "life"),
  },
  "ShootingHazard",
);
const Effect = schema(
  {
    ...strings("id", "kind"),
    ...numbers("x", "y", "radius", "life", "value", "duration"),
  },
  "ShootingEffect",
);
const Wall = schema(
  { ...numbers("x", "y", "width", "height") },
  "ShootingWall",
);
export const WorldState = schema(
  {
    ...strings(
      "phase",
      "mode",
      "pauseReason",
      "bossName",
      "notice",
      "hostId",
      "title",
    ),
    ...numbers(
      "stage",
      "level",
      "xp",
      "nextXp",
      "combatMillis",
      "clearedStage",
      "clearMillis",
      "deadline",
      "reconnectRemaining",
      "enemyTotal",
      "enemiesSpawned",
      "enemiesKilled",
      "wave",
      "waveCount",
    ),
    ...booleans("paused", "privateRoom"),
    players: t.map(Player),
    enemies: t.map(Enemy),
    bullets: t.map(Bullet),
    pickups: t.map(Pickup),
    hazards: t.map(Hazard),
    effects: t.map(Effect),
    walls: t.array(Wall),
  },
  "ShootingWorld",
);
export type WorldStateType = InstanceType<typeof WorldState>;

const entityFields = {
  enemies: [
    "id",
    "kind",
    "x",
    "y",
    "angle",
    "hp",
    "maxHp",
    "radius",
    "warning",
    "targetX",
    "targetY",
    "spawnRemaining",
    "boss",
  ],
  bullets: ["id", "weapon", "owner", "x", "y", "vx", "vy", "radius", "hostile"],
  pickups: ["id", "kind", "x", "y", "amount"],
  hazards: ["id", "kind", "x", "y", "radius", "warning", "life"],
  effects: ["id", "kind", "x", "y", "radius", "life", "value", "duration"],
} as const;
const playerFields = [
  "id",
  "nickname",
  "avatar",
  "weapon",
  "color",
  "x",
  "y",
  "vx",
  "vy",
  "aim",
  "hp",
  "maxHp",
  "armor",
  "revives",
  "invuls",
  "dashCooldown",
  "invulCooldown",
  "protection",
  "dashRemaining",
  "clearedStage",
  "clearMillis",
  "inputSequence",
  "alive",
  "connected",
  "departed",
  "ready",
  "vote",
  "choiceDone",
] as const;

/** 변경된 필드만 Colyseus가 패치하도록 기존 스키마 인스턴스를 갱신한다. 매 틱 객체 전체를 교체하지 않는다. */
export function synchronize(
  state: WorldStateType,
  snapshot: GameSnapshot,
): void {
  const root = state as unknown as Record<string, unknown>;
  for (const name of [
    "hostId",
    "title",
    "privateRoom",
    "phase",
    "mode",
    "pauseReason",
    "bossName",
    "notice",
    "stage",
    "level",
    "xp",
    "nextXp",
    "combatMillis",
    "clearedStage",
    "clearMillis",
    "deadline",
    "reconnectRemaining",
    "enemyTotal",
    "enemiesSpawned",
    "enemiesKilled",
    "wave",
    "waveCount",
    "paused",
  ] as const)
    root[name] = snapshot[name];
  for (const id of state.players.keys())
    if (!snapshot.players[id]) state.players.delete(id);
  for (const [id, value] of Object.entries(snapshot.players)) {
    let target = state.players.get(id);
    if (!target) {
      target = new Player();
      state.players.set(id, target);
    }
    const row = target as unknown as Record<string, unknown>;
    for (const name of playerFields) row[name] = value[name];
    for (const [name, level] of Object.entries(value.upgrades))
      target.upgrades.set(name, level);
  }
  const constructors = {
    enemies: Enemy,
    bullets: Bullet,
    pickups: Pickup,
    hazards: Hazard,
    effects: Effect,
  };
  for (const name of Object.keys(
    constructors,
  ) as (keyof typeof constructors)[]) {
    const target = state[name] as unknown as MapSchema<Schema>;
    for (const id of target.keys()) if (!snapshot[name][id]) target.delete(id);
    for (const [id, value] of Object.entries(snapshot[name])) {
      let row = target.get(id);
      if (!row) {
        row = new constructors[name]();
        target.set(id, row);
      }
      for (const field of entityFields[name])
        (row as unknown as Record<string, unknown>)[field] = (
          value as unknown as Record<string, unknown>
        )[field];
    }
  }
  // 같은 위치에 배치되어도 스테이지마다 달라진 엄폐물 크기를 함께 동기화한다.
  if (
    state.walls.length !== snapshot.walls.length ||
    snapshot.walls.some(
      (wall, index) =>
        state.walls[index]?.x !== wall.x ||
        state.walls[index]?.y !== wall.y ||
        state.walls[index]?.width !== wall.width ||
        state.walls[index]?.height !== wall.height,
    )
  ) {
    state.walls.clear();
    for (const value of snapshot.walls) state.walls.push(new Wall(value));
  }
}
