import type { EnemyKind, Mode, Rect } from "./index.ts";

/** 맵·시간 기준은 프론트와 전투 서버가 공유한다. 변경 시 RULE_VERSION도 함께 올린다. */
export const STAGE_MAPS = {
  CAVE: {
    id: "CAVE",
    order: 0,
    name: "수정 동굴",
    description: "수정과 기둥의 반응을 살펴보세요.",
    theme: "cave",
    color: "#a58de7",
    boss: "수정갑왕",
    guardian: "수정 수호자",
    ordinary: ["charger", "shield", "shooter"],
    bossKind: "boss-charge",
    times: { SINGLE: [360_000, 480_000], COOP: [360_000, 480_000] },
  },
  FACTORY: {
    id: "FACTORY",
    order: 1,
    name: "태엽 공장",
    description: "동력 장치와 적의 연결을 살펴보세요.",
    theme: "factory",
    color: "#d6a758",
    boss: "태엽 지휘관",
    guardian: "동력 관리자",
    ordinary: ["chaser", "artillery", "skirmisher"],
    bossKind: "boss-barrage",
    times: { SINGLE: [400_000, 540_000], COOP: [400_000, 540_000] },
  },
  GARDEN: {
    id: "GARDEN",
    order: 2,
    name: "덩굴 정원",
    description: "뿌리와 꽃가루가 만드는 길을 살펴보세요.",
    theme: "garden",
    color: "#80be9d",
    boss: "만개 여왕",
    guardian: "가시 수호자",
    ordinary: ["chaser", "brute", "shooter"],
    bossKind: "boss-artillery",
    times: { SINGLE: [440_000, 600_000], COOP: [440_000, 600_000] },
  },
} as const satisfies Record<
  string,
  {
    id: string;
    order: number;
    name: string;
    description: string;
    theme: string;
    color: string;
    boss: string;
    guardian: string;
    ordinary: readonly EnemyKind[];
    bossKind: EnemyKind;
    times: Record<Mode, readonly [number, number]>;
  }
>;
export type StageMapId = keyof typeof STAGE_MAPS;
export const STAGE_MAP_IDS = Object.keys(STAGE_MAPS) as StageMapId[];
export const STAGES_PER_MAP = 10;
export const ALL_MAPS = 7;
export const isStageMap = (value: unknown): value is StageMapId =>
  typeof value === "string" && Object.hasOwn(STAGE_MAPS, value);
export const mapUnlocked = (mask: number, map: StageMapId): boolean =>
  (mask & (1 << STAGE_MAPS[map].order)) !== 0;
export const mapStars = (
  map: StageMapId,
  mode: Mode,
  milliseconds: number,
): number => {
  const [three, two] = STAGE_MAPS[map].times[mode];
  return milliseconds <= three ? 3 : milliseconds <= two ? 2 : 1;
};

/** 프로필 원화 5종만 제공한다. 외형은 이동·피격·무기 계산에 영향을 주지 않는다. */
export const SHOOTING_CHARACTERS = {
  MINT_ROBOT: { name: "민트 로봇", image: "29-mint-robot.webp", frame: 0 },
  HOODIE_HAMSTER: {
    name: "후드 햄스터",
    image: "30-hoodie-hamster.webp",
    frame: 1,
  },
  HEADPHONE_DINO: {
    name: "헤드폰 공룡",
    image: "12-headphone-dino.webp",
    frame: 2,
  },
  GAMER_GHOST: {
    name: "게임하는 유령",
    image: "105-gamer-ghost.webp",
    frame: 3,
  },
  HOODIE_PENGUIN: {
    name: "후드 펭귄",
    image: "11-hoodie-penguin.webp",
    frame: 4,
  },
} as const;
export type ShootingCharacterId = keyof typeof SHOOTING_CHARACTERS;
export const CHARACTER_IDS = Object.keys(
  SHOOTING_CHARACTERS,
) as ShootingCharacterId[];
export const isShootingCharacter = (
  value: unknown,
): value is ShootingCharacterId =>
  typeof value === "string" && Object.hasOwn(SHOOTING_CHARACTERS, value);
export const characterImage = (id: ShootingCharacterId): string =>
  `/images/avatars/characters-v1/${SHOOTING_CHARACTERS[id].image}`;

export interface StageDevice {
  id: string;
  kind: "crystal" | "pillar" | "generator" | "root";
  x: number;
  y: number;
  radius: number;
  hp: number;
  maxHp: number;
}

/** 각 맵은 서로 다른 통로 원형 5개를 변형한다. 보스 공간도 통로·기둥을 실제 판정에 사용한다. */
export function stageLayout(
  map: StageMapId,
  stage: number,
): { walls: Rect[]; devices: StageDevice[] } {
  const n = (stage - 1) % 5,
    boss = stage % 5 === 0;
  const walls: Rect[] = [];
  if (map === "CAVE") {
    if (!boss) {
      walls.push(
        { x: 290 + n * 20, y: 200, width: 100, height: 260 - n * 20 },
        { x: 1120 - n * 20, y: 490, width: 130, height: 250 },
        { x: 590, y: 180 + n * 25, width: 320, height: 75 },
        { x: 580, y: 700 - n * 18, width: 350, height: 70 },
      );
    }
  } else if (map === "FACTORY") {
    walls.push(
      { x: 290, y: 270, width: 300, height: 70 },
      { x: 1010, y: 270, width: 300, height: 70 },
      { x: 290, y: 630, width: 300, height: 70 },
      { x: 1010, y: 630, width: 300, height: 70 },
    );
    if (!boss)
      walls.push({ x: n % 2 ? 610 : 930, y: 405, width: 70, height: 140 });
  } else {
    walls.push(
      { x: 280, y: 250, width: 95, height: 360 },
      { x: 1220, y: 350, width: 95, height: 360 },
      { x: 520, y: 180, width: 350, height: 70 },
      { x: 730, y: 720, width: 350, height: 70 },
    );
    if (!boss) walls.push({ x: 920 + n * 25, y: 410, width: 80, height: 140 });
  }
  const devices: StageDevice[] = [];
  const add = (
    kind: StageDevice["kind"],
    x: number,
    y: number,
    hp: number,
    radius: number,
  ) =>
    devices.push({
      id: `device-${devices.length}`,
      kind,
      x,
      y,
      radius,
      hp,
      maxHp: hp,
    });
  if (map === "CAVE") {
    add("crystal", 470, 510, 42, 25);
    add("crystal", 1110, 420, 42, 25);
    if (boss) {
      for (const x of [580, 1020]) {
        add("pillar", x, 370, 500, 43);
        walls.push({ x: x - 40, y: 330, width: 80, height: 80 });
      }
    }
  } else if (map === "FACTORY") {
    add("generator", 450, 480, 100 + stage * 8, 30);
    add("generator", 1150, 480, 100 + stage * 8, 30);
  } else {
    add("root", 520, 520, 90 + stage * 7, 30);
    add("root", 1080, 370, 90 + stage * 7, 30);
  }
  return { walls, devices };
}

/** 무작위 호출 순서와 독립적인 출현 지점으로 같은 맵의 공략 동선을 재현한다. */
export function stageSpawn(map: StageMapId, stage: number, index: number) {
  const positions = [
    [135, 155],
    [1465, 805],
    [800, 130],
    [135, 805],
    [1465, 155],
    [800, 825],
    [450, 125],
    [1150, 825],
    [145, 480],
    [1455, 480],
  ] as const;
  const point =
    positions[
      (index * 3 + stage + STAGE_MAPS[map].order * 2) % positions.length
    ];
  return { x: point[0], y: point[1] };
}
