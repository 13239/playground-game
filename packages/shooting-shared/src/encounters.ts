import type { EnemyKind } from "./index.ts";
import type { StageMapId } from "./stages.ts";
import { STAGE_MISSIONS } from "./missions.ts";

/** 학습→응용→총력전의 전투량 기준은 공유하고 실제 임무·파훼 순서는 맵별 레시피를 따른다. */
export const ENCOUNTERS = [
  { enemies: 12, pack: 4, roles: ["charger", "shooter"] },
  { enemies: 16, pack: 5, roles: ["sniper", "charger", "shield"] },
  { enemies: 18, pack: 5, roles: ["shooter", "charger", "artillery"] },
  { enemies: 16, pack: 5, roles: ["support", "shield", "sniper", "brute"] },
  { enemies: 5, pack: 5, roles: ["support", "charger", "shooter"] },
  { enemies: 22, pack: 6, roles: ["charger", "sniper", "skirmisher"] },
  { enemies: 20, pack: 6, roles: ["support", "artillery", "shield", "charger"] },
  { enemies: 22, pack: 6, roles: ["sniper", "skirmisher", "brute"] },
  { enemies: 28, pack: 7, roles: ["support", "sniper", "charger", "shield", "artillery"] },
  { enemies: 8, pack: 8, roles: ["support", "sniper", "charger"] },
] as const satisfies readonly {
  enemies: number;
  pack: number;
  roles: readonly EnemyKind[];
}[];

/** 맵 식별자를 반드시 받아 같은 번호의 다른 맵 임무가 섞이지 않게 한다. */
export const encounterFor = (map: StageMapId, stage: number) => {
  const index = Math.min(9, Math.max(0, stage - 1));
  return { ...ENCOUNTERS[index], ...STAGE_MISSIONS[map][index] };
};

/** 발사 직전까지 추적하는 시간과 조준 고정 구간을 렌더러에서도 동일하게 표현한다. */
export const ATTACK_READABILITY = { lockSeconds: 0.22, supportRadius: 235 } as const;

/** 양수인 보호 시간은 0.0s로 먼저 사라지지 않게 올림하고 항상 소수점 한 자리를 유지한다. */
export const formatShieldTime = (seconds: number): string =>
  `${(Math.ceil(Math.max(0, seconds) * 10 - 1e-6) / 10).toFixed(1)}s`;
