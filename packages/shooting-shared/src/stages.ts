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
  // 기존 세 맵의 순서·시간은 유지하고 새 맵만 뒤에 추가해 이전 완주 기록을 보존한다.
  DESERT: {
    id: "DESERT",
    order: 3,
    name: "모래 유적",
    description: "모래 토템을 파괴해 느려진 통로를 열고 적의 장갑을 무너뜨리세요.",
    theme: "desert",
    color: "#d8ad68",
    boss: "사막 전갈왕",
    guardian: "유적 파수꾼",
    ordinary: ["charger", "shield", "artillery"],
    bossKind: "boss-charge",
    times: { SINGLE: [480_000, 660_000], COOP: [480_000, 660_000] },
  },
  ICE: {
    id: "ICE",
    order: 4,
    name: "얼음 협곡",
    description: "빙결 핵 주변에서는 이동이 느려져요. 핵을 부수고 안전한 길을 만드세요.",
    theme: "ice",
    color: "#8ccfe7",
    boss: "서리 용왕",
    guardian: "빙하 수호자",
    ordinary: ["skirmisher", "shooter", "brute"],
    bossKind: "boss-barrage",
    times: { SINGLE: [520_000, 720_000], COOP: [520_000, 720_000] },
  },
  VOLCANO: {
    id: "VOLCANO",
    order: 5,
    name: "용암 성채",
    description: "분출 예고를 피해 이동하고 용암 분출구를 파괴해 화염을 잠재우세요.",
    theme: "volcano",
    color: "#df826b",
    boss: "용암 군주",
    guardian: "화산 문지기",
    ordinary: ["brute", "artillery", "charger"],
    bossKind: "boss-artillery",
    times: { SINGLE: [560_000, 780_000], COOP: [560_000, 780_000] },
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
// 맵 개수에 맞춰 권한 마스크를 계산한다. UI·인증 경계에서 3개/7 값을 고정하지 않는다.
export const ALL_MAPS = 2 ** STAGE_MAP_IDS.length - 1;
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
  kind: "crystal" | "pillar" | "generator" | "root" | "sand-totem" | "frost-core" | "lava-vent";
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
  } else if (map === "GARDEN") {
    walls.push(
      { x: 280, y: 250, width: 95, height: 360 },
      { x: 1220, y: 350, width: 95, height: 360 },
      { x: 520, y: 180, width: 350, height: 70 },
      { x: 730, y: 720, width: 350, height: 70 },
    );
    if (!boss) walls.push({ x: 920 + n * 25, y: 410, width: 80, height: 140 });
  } else if (map === "DESERT") {
    // 유적 기둥 사이는 충분히 열어 두고 모래 토템으로 통로 공략 순서를 바꾼다.
    for (const x of [310, 1150]) {
      walls.push({ x, y: 230, width: 140, height: 120 }, { x, y: 610, width: 140, height: 120 });
    }
    if (!boss) walls.push({ x: 670 + n * 18, y: 400, width: 160, height: 100 });
  } else if (map === "ICE") {
    // 지그재그 빙벽과 핵의 둔화 영역을 따로 두어 벽과 효과의 판정이 겹치지 않게 한다.
    walls.push(
      { x: 270, y: 260, width: 370, height: 80 },
      { x: 970, y: 600, width: 360, height: 80 },
      { x: 1050, y: 190, width: 90, height: 230 },
      { x: 460, y: 550, width: 90, height: 190 },
    );
    if (!boss) walls.push({ x: 710, y: 400 + n * 12, width: 190, height: 70 });
  } else if (map === "VOLCANO") {
    walls.push(
      { x: 290, y: 220, width: 110, height: 210 },
      { x: 1200, y: 530, width: 110, height: 210 },
      { x: 570, y: 230, width: 400, height: 75 },
      { x: 610, y: 670, width: 400, height: 75 },
    );
    // 분출구가 엄폐물 안에 묻히지 않도록 두 장치 사이에서만 중앙 벽을 변형한다.
    if (!boss) walls.push({ x: n % 2 ? 640 : 900, y: 440, width: 90, height: 100 });
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
  } else if (map === "GARDEN") {
    add("root", 520, 520, 90 + stage * 7, 30);
    add("root", 1080, 370, 90 + stage * 7, 30);
  } else if (map === "DESERT") {
    add("sand-totem", 520, 470, 100 + stage * 8, 29);
    add("sand-totem", 1080, 470, 100 + stage * 8, 29);
  } else if (map === "ICE") {
    add("frost-core", 760, 280, 100 + stage * 8, 28);
    add("frost-core", 830, 640, 100 + stage * 8, 28);
  } else if (map === "VOLCANO") {
    add("lava-vent", 500, 500, 120 + stage * 8, 30);
    add("lava-vent", 1100, 400, 120 + stage * 8, 30);
  }
  return { walls, devices };
}

/** 메뉴 미리보기와 실제 렌더러가 동일한 맵 재질을 사용한다. 숫자 색상은 Phaser에 바로 전달한다. */
export const STAGE_PALETTES = {
  CAVE: { floor: 0x9086b2, wall: 0xb2a2ce, edge: 0x62567e },
  FACTORY: { floor: 0xb4a2b5, wall: 0xe5c797, edge: 0x7e617d },
  GARDEN: { floor: 0x9dbda5, wall: 0x9cc485, edge: 0x4d7b60 },
  DESERT: { floor: 0xc6a570, wall: 0xefcf91, edge: 0x927143 },
  ICE: { floor: 0x8dbdce, wall: 0xc6ecf5, edge: 0x527f9c },
  VOLCANO: { floor: 0x695975, wall: 0x9c7c91, edge: 0x473a55 },
} as const satisfies Record<StageMapId, { floor: number; wall: number; edge: number }>;

/** 지형 효과를 서버·클라이언트 예측에서 공유해 빙결·모래 구역을 통과할 때 위치 보정이 튀지 않게 한다. */
export function terrainSpeed(
  x: number,
  y: number,
  devices: Iterable<StageDevice>,
): number {
  let speed = 1;
  for (const device of devices) {
    if (device.hp <= 0) continue;
    const radius = device.kind === "frost-core"
      ? 165
      : device.kind === "sand-totem" ? 145 : 0;
    if (radius && (device.x - x) ** 2 + (device.y - y) ** 2 <= radius ** 2)
      speed = Math.min(speed, device.kind === "frost-core" ? 0.55 : 0.75);
  }
  return speed;
}

/** 무작위 호출 순서와 독립적인 출현 지점으로 같은 맵의 공략 동선을 재현한다. */
export function stageSpawn(map: StageMapId, stage: number, index: number) {
  // 6·9스테이지는 분대별 좌우 출현을 교대로 사용해 한 방향으로 도는 회피만으로 풀리지 않게 한다.
  if (stage === 6 || stage === 9) {
    const left = Math.floor(index / 4) % 2 === 0;
    return { x: left ? 140 : 1460, y: 150 + (index % 4) * 220 };
  }
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
