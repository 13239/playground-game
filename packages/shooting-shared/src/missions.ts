import type { StageMapId } from "./stages.ts";

/** 공략은 서버가 실행하는 작은 행동으로 구성한다. 새 맵은 레시피와 고유 상호작용을 추가한다. */
export type MissionMechanic =
  | "reflect" | "resonate" | "lure" | "dash" | "circuit" | "pulse"
  | "conveyor" | "carry" | "grow" | "prune" | "wind" | "listen"
  | "track" | "mirage" | "heat" | "freeze" | "shelter" | "pressure" | "coolant";
export interface MissionStep {
  kind: MissionMechanic;
  variant: number;
}
export interface StageMission {
  title: string;
  steps: readonly MissionStep[];
  pressure: "rocks" | "laser" | "pollen" | "sand" | "frost" | "magma";
}
/** 노드·힌트·진행률만 공개한다. 입력의 성공 여부와 보스 방어 해제는 서버만 판정한다. */
export interface MissionNodeView {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  angle: number;
  progress: number;
  status: string;
}
const steps = (...kinds: MissionMechanic[]): MissionStep[] => kinds.map((kind, variant) => ({ kind, variant }));
const mission = (title: string, pressure: StageMission["pressure"], ...kinds: MissionMechanic[]): StageMission =>
  ({ title, pressure, steps: steps(...kinds) });

/** 60개 레시피는 고정되어 재도전에서 학습한 동선이 유지된다. 같은 행동 순서의 맵 복제는 허용하지 않는다. */
export const STAGE_MISSIONS = {
  CAVE: [
    mission("굴절된 입구", "rocks", "reflect"),
    mission("공명의 박자", "rocks", "resonate", "dash"),
    mission("낙석 유도", "rocks", "lure", "reflect"),
    mission("갈라진 수정길", "rocks", "dash", "carry", "resonate"),
    mission("수정 수호자의 균열", "rocks", "lure", "resonate"),
    mission("교차 굴절", "rocks", "reflect", "dash", "reflect"),
    mission("공명석 운반", "rocks", "carry", "resonate", "lure"),
    mission("붕괴 속의 광로", "rocks", "dash", "reflect", "carry"),
    mission("삼중 수정 봉인", "rocks", "resonate", "lure", "reflect", "dash"),
    mission("수정갑왕의 재생 핵", "rocks", "reflect", "lure", "resonate"),
  ],
  FACTORY: [
    mission("전력의 흐름", "laser", "circuit"),
    mission("가동 순간", "laser", "pulse", "circuit"),
    mission("부품 분류선", "laser", "conveyor", "pulse"),
    mission("전력 분배실", "laser", "pressure", "circuit", "conveyor"),
    mission("동력 관리자의 차단기", "laser", "circuit", "pulse"),
    mission("역방향 작업장", "laser", "conveyor", "dash", "circuit"),
    mission("과부하 복구", "laser", "pulse", "pressure", "circuit"),
    mission("회전선 사이로", "laser", "dash", "conveyor", "pulse"),
    mission("비상 전력망", "laser", "pressure", "conveyor", "circuit", "pulse"),
    mission("태엽 지휘관의 동력망", "laser", "conveyor", "pressure", "pulse"),
  ],
  GARDEN: [
    mission("첫 씨앗", "pollen", "grow"),
    mission("뿌리의 근원", "pollen", "prune", "grow"),
    mission("꽃가루 바람", "pollen", "wind", "prune"),
    mission("움트는 길", "pollen", "carry", "grow", "wind"),
    mission("가시 수호자의 기생근", "pollen", "prune", "wind"),
    mission("순환하는 정원", "pollen", "grow", "wind", "carry"),
    mission("번지는 기생망", "pollen", "prune", "grow", "prune"),
    mission("바람을 기다리는 씨앗", "pollen", "wind", "carry", "grow"),
    mission("개화 전야", "pollen", "grow", "prune", "wind", "carry"),
    mission("만개 여왕의 수분", "pollen", "wind", "grow", "prune"),
  ],
  DESERT: [
    mission("모래 아래의 신호", "sand", "listen"),
    mission("남겨진 발자국", "sand", "track", "listen"),
    mission("신기루의 실체", "sand", "mirage", "track"),
    mission("폭풍의 쉼터", "sand", "shelter", "listen", "mirage"),
    mission("유적 파수꾼의 흔적", "sand", "track", "mirage"),
    mission("잠든 모래길", "sand", "listen", "dash", "track"),
    mission("가짜 표식 사이로", "sand", "mirage", "shelter", "listen"),
    mission("폭풍 속 운반", "sand", "track", "carry", "shelter"),
    mission("매몰된 봉인", "sand", "listen", "mirage", "track", "shelter"),
    mission("사막 전갈왕의 잠복", "sand", "shelter", "listen", "track"),
  ],
  ICE: [
    mission("온기의 불씨", "frost", "heat"),
    mission("얼어붙은 통로", "frost", "freeze", "heat"),
    mission("움직이는 온기", "frost", "shelter", "freeze"),
    mission("해빙의 순간", "frost", "heat", "pulse", "dash"),
    mission("빙하 수호자의 관절", "frost", "freeze", "heat", "pulse"),
    mission("빙결선 횡단", "frost", "dash", "freeze", "shelter"),
    mission("불씨 중계", "frost", "heat", "shelter", "heat"),
    mission("갈라지는 빙판", "frost", "freeze", "dash", "pulse"),
    mission("협곡의 열 순환", "frost", "shelter", "heat", "freeze", "dash"),
    mission("서리 용왕의 급랭", "frost", "heat", "freeze", "shelter"),
  ],
  VOLCANO: [
    mission("압력 조절", "magma", "pressure"),
    mission("차가운 한 방울", "magma", "coolant", "pressure"),
    mission("분출을 돌려라", "magma", "lure", "coolant"),
    mission("굳어지는 용암길", "magma", "coolant", "dash", "pressure"),
    mission("화산 문지기의 과열", "magma", "pressure", "lure"),
    mission("분출 사이의 운반", "magma", "carry", "coolant", "dash"),
    mission("막힌 배출관", "magma", "pressure", "coolant", "lure"),
    mission("급랭 작업장", "magma", "coolant", "pulse", "pressure"),
    mission("성채의 임계점", "magma", "lure", "pressure", "coolant", "dash"),
    mission("용암 군주의 균열", "magma", "coolant", "pressure", "lure"),
  ],
} as const satisfies Record<StageMapId, readonly StageMission[]>;

/** 위험 범위는 렌더러와 서버가 같은 기하를 사용한다. annulus는 안쪽 안전 지대를 보존한다. */
export function hazardContains(point: { x: number; y: number }, hazard: {
  x: number; y: number; radius: number; shape?: string; angle?: number; length?: number; innerRadius?: number;
}, padding = 0): boolean {
  const dx = point.x - hazard.x, dy = point.y - hazard.y;
  if (hazard.shape === "line") {
    const angle = hazard.angle ?? 0;
    return Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) <= (hazard.length ?? 0) / 2 + padding &&
      Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) <= hazard.radius + padding;
  }
  const distance = Math.hypot(dx, dy);
  return distance <= hazard.radius + padding && distance >= Math.max(0, (hazard.innerRadius ?? 0) - padding);
}
