import type { EnemyKind } from "./index.ts";

/** 6개 맵이 같은 학습→응용→총력전 흐름을 공유하되 지형·장치·기본 몬스터는 각 맵을 따른다. */
export const ENCOUNTERS = [
  { title: "회피의 시작", goal: "eliminate", enemies: 12, pack: 4, roles: ["charger", "shooter"], limit: 0 },
  { title: "조준선을 끊어라", goal: "eliminate", enemies: 16, pack: 5, roles: ["sniper", "charger", "shield"], limit: 0 },
  { title: "장치 제압", goal: "devices", enemies: 18, pack: 5, roles: ["shooter", "charger", "artillery"], limit: 0 },
  { title: "지원망 돌파", goal: "eliminate", enemies: 16, pack: 5, roles: ["support", "shield", "sniper", "brute"], limit: 0 },
  { title: "수호자의 시험", goal: "boss", enemies: 5, pack: 5, roles: ["support", "charger", "shooter"], limit: 0 },
  { title: "양면 압박", goal: "eliminate", enemies: 22, pack: 6, roles: ["charger", "sniper", "skirmisher"], limit: 0 },
  { title: "가동을 저지하라", goal: "disrupt", enemies: 20, pack: 6, roles: ["support", "artillery", "shield", "charger"], limit: 36 },
  { title: "교차 포격", goal: "crossfire", enemies: 22, pack: 6, roles: ["sniper", "skirmisher", "brute"], limit: 0 },
  { title: "총력전", goal: "eliminate", enemies: 28, pack: 7, roles: ["support", "sniper", "charger", "shield", "artillery"], limit: 0 },
  { title: "최후의 공략", goal: "boss", enemies: 8, pack: 8, roles: ["support", "sniper", "charger"], limit: 0 },
] as const satisfies readonly {
  title: string;
  goal: "eliminate" | "devices" | "disrupt" | "crossfire" | "boss";
  enemies: number;
  pack: number;
  roles: readonly EnemyKind[];
  limit: number;
}[];

export const encounterFor = (stage: number) => ENCOUNTERS[Math.min(9, Math.max(0, stage - 1))];

/** 발사 직전까지 추적하는 시간과 조준 고정 구간을 렌더러에서도 동일하게 표현한다. */
export const ATTACK_READABILITY = { lockSeconds: 0.22, supportRadius: 235 } as const;

/** 양수인 보호 시간은 0.0s로 먼저 사라지지 않게 올림하고 항상 소수점 한 자리를 유지한다. */
export const formatShieldTime = (seconds: number): string =>
  `${(Math.ceil(Math.max(0, seconds) * 10 - 1e-6) / 10).toFixed(1)}s`;
