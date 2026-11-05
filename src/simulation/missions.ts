import {
  STAGE_MISSIONS, WORLD, type GameSnapshot, type MissionNodeView, type MissionStep,
  type PlayerView, type HazardView,
} from "@playground/shooting-shared";
import { distanceSquared, segmentRect } from "./geometry.ts";

interface MissionHooks {
  state: GameSnapshot;
  hazard: (hazard: Omit<HazardView, "id">, impact?: () => void) => boolean;
  reward: () => void;
  firing: (id: string) => boolean;
  effect: (kind: string, x: number, y: number, radius: number, value?: number) => void;
}
const instructions = {
  reflect: ["굴절 광로", "푸른 발사점에서 거울을 쏴 금색 수신기로 반사하세요"],
  resonate: ["공명 박자", "사격을 0.6초 멈춘 뒤 점등 순간 수정을 맞히세요 · 3회"],
  lure: ["공격 유도", "금색 표식에서 포격을 유도하고 예고가 고정되면 벗어나세요"],
  dash: ["균열 횡단", "화살표 방향으로 대시하며 금색 관문을 통과하세요"],
  circuit: ["전력 연결", "연결선의 1 → 2 → 3 순서로 중계기를 사격하세요"],
  pulse: ["가동 차단", "사격을 0.6초 멈추고 개방 순간 차단기를 맞히세요"],
  conveyor: ["부품 분류", "움직이는 부품을 몸으로 회수해 금색 투입구로 운반하세요"],
  carry: ["핵심 물자 운반", "푸른 물자를 몸으로 회수해 금색 도착 지점으로 옮기세요"],
  grow: ["씨앗 성장", "씨앗을 화단으로 옮긴 뒤 안에서 2초 동안 성장을 도우세요"],
  prune: ["기생근 절단", "뿌리 연결의 말단 3 → 2 → 1 순서로 사격하세요"],
  wind: ["바람 수분", "바람이 안정된 순간 화살표 방향으로 꽃가루를 사격하세요"],
  listen: ["진동 탐지", "멈춰서 1.2초 동안 진동을 듣고 드러난 유물을 회수하세요"],
  track: ["흔적 추적", "빛나는 발자국을 순서대로 밟으세요 · 다음 흔적까지 4.5초"],
  mirage: ["신기루 식별", "표식 가까이 접근해 실체를 확인한 뒤 진짜 봉인을 사격하세요"],
  heat: ["불씨 중계", "불씨를 회수해 7초 안에 화로로 전달하세요 · 출발 화로에서 재충전"],
  freeze: ["빙결 후 횡단", "표식에 냉기 포격을 유도한 뒤 얼어 있는 동안 대시로 통과하세요"],
  shelter: ["안전 지대 이동", "움직이는 안전 지대 안에서 총 3초를 확보하세요"],
  pressure: ["압력 균형", "− / + 밸브를 사격해 중앙 계기를 43~58%로 2초 유지하세요"],
  coolant: ["급랭 작업", "냉각수를 운반한 뒤 도착 지점에서 사격을 멈추고 1.4초 냉각하세요"],
} as const;

/** 맵별 행동 레시피를 실행한다. 재사용 물자·시간 초과 재시도로 적 전멸 뒤에도 공략을 복구할 수 있다. */
export class MissionDirector {
  private readonly hooks: MissionHooks;
  private stepIndex = 0;
  private phase = 1;
  private generation = 0;
  private clock = 0;
  private elapsed = 0;
  private cursor = 0;
  private hold = 0;
  private carrier = "";
  private carried = false;
  private reserve = 7;
  private lastHit = -10;
  private hitCooldown = 0;
  private markCooldown = 1.5;
  private frozen = 0;
  private pressure = 0.82;
  private feedback = "";
  private feedbackTime = 0;
  private origin = { x: 800, y: 480 };
  private cargoOrigin = { x: 800, y: 480 };

  constructor(hooks: MissionHooks) { this.hooks = hooks; }
  private get state() { return this.hooks.state; }
  private get plan() { return STAGE_MISSIONS[this.state.mapId][Math.min(9, Math.max(0, this.state.stage - 1))]; }
  private get current(): MissionStep { return this.plan.steps[(this.stepIndex + this.phase - 1) % this.plan.steps.length]; }
  private get nodes() { return Object.values(this.state.missionNodes); }
  private players(): PlayerView[] { return Object.values(this.state.players).filter(p => p.alive && !p.departed && p.connected); }

  reset(): void {
    this.phase = 1;
    this.clock = 0;
    this.restart();
  }
  private restart(): void {
    this.stepIndex = 0;
    this.state.objectiveComplete = false;
    this.state.objectiveWindow = 0;
    this.state.objectiveTotal = this.plan.steps.length;
    this.begin();
  }
  /** 원형 상호작용 영역 전체를 벽·경계 밖으로 밀어내어 어느 무기·기기에서도 접근 가능하게 한다. */
  private free(x: number, y: number, radius = 65): { x: number; y: number } {
    for (let ring = 0; ring < 18; ring++) {
      for (let i = 0; i < (ring ? 16 : 1); i++) {
        const a = i * Math.PI / 8;
        const point = { x: x + Math.cos(a) * ring * 35, y: y + Math.sin(a) * ring * 35 };
        if (point.x < 70 + radius || point.x > WORLD.width - 70 - radius || point.y < 70 + radius || point.y > WORLD.height - 70 - radius) continue;
        if (this.state.walls.some(w => point.x + radius > w.x && point.x - radius < w.x + w.width && point.y + radius > w.y && point.y - radius < w.y + w.height)) continue;
        if (Object.values(this.state.devices).some(d => d.hp > 0 && distanceSquared(point, d) < (radius + d.radius + 8) ** 2)) continue;
        return point;
      }
    }
    throw new Error(`Mission has no accessible placement: ${this.state.mapId}/${this.state.stage}`);
  }
  private node(kind: string, label: string, x: number, y: number, radius = 38, status = "active"): MissionNodeView {
    const point = this.free(x, y, radius + 18);
    const node = { id: `mission-${this.generation}-${this.nodes.length}`, kind, label, ...point, radius, angle: 0, progress: 0, status };
    this.state.missionNodes[node.id] = node;
    return node;
  }
  private begin(): void {
    this.generation++;
    this.state.missionNodes = {};
    this.elapsed = this.hold = this.cursor = this.hitCooldown = this.frozen = 0;
    this.carrier = "";
    this.carried = false;
    this.reserve = 7;
    this.pressure = 0.82;
    this.lastHit = -10;
    this.feedbackTime = 0;
    this.markCooldown = 1.5;
    this.state.objectiveStep = this.stepIndex;
    const { kind, variant } = this.current;
    const side = (variant + this.state.stage + this.phase) % 2 ? -1 : 1;
    this.origin = this.free(800 + side * 170, 440 + (this.phase - 1) * 70, 75);
    const { x, y } = this.origin;
    if (["carry", "heat", "grow", "conveyor", "coolant"].includes(kind)) {
      const cargo = this.node("cargo", kind === "grow" ? "씨앗" : kind === "coolant" ? "냉각수" : kind === "heat" ? "불씨" : "물자", x - side * 230, y + 120);
      this.cargoOrigin = { x: cargo.x, y: cargo.y };
      this.node("goal", kind === "grow" ? "화단" : "도착", x + side * 230, y - 100, 64);
      if (kind === "heat") this.node("hearth", "재충전", cargo.x, cargo.y, 48, "guide");
    } else if (kind === "circuit" || kind === "prune" || kind === "track" || kind === "mirage") {
      for (let i = 0; i < 3; i++) this.node(kind, kind === "mirage" ? "?" : `${i + 1}`, 450 + i * 350, y + (i % 2 ? -120 : 100));
      if (kind === "prune") this.cursor = 2;
    } else if (kind === "reflect") {
      const mirror = this.node("reflect", "거울", x, y);
      // 실제 반사 법선과 발사점·수신기를 함께 만든다. 반사 경로는 벽을 통과하지 않는다.
      const directions = [[-1, 0, 0, 1], [1, 0, 0, 1], [0, -1, 1, 0], [0, 1, -1, 0]];
      const ray = directions.find(([ax, ay, bx, by]) => {
        const a = { x: mirror.x + ax * 155, y: mirror.y + ay * 155 };
        const b = { x: mirror.x + bx * 155, y: mirror.y + by * 155 };
        return [a, b].every(p => p.x > 110 && p.x < 1490 && p.y > 110 && p.y < 850 && !this.state.walls.some(w => segmentRect(mirror.x, mirror.y, p.x - mirror.x, p.y - mirror.y, w, 48)));
      });
      if (!ray) throw new Error("No clear reflection corridor");
      const [ax, ay, bx, by] = ray;
      this.node("guide", "발사점", mirror.x + ax * 155, mirror.y + ay * 155, 48, "guide");
      this.node("receiver", "수신기", mirror.x + bx * 155, mirror.y + by * 155, 32, "guide");
      mirror.angle = Math.atan2(-ay - by, -ax - bx);
    } else if (kind === "pressure") {
      this.node("minus", "−", x - 170, y);
      this.node("plus", "+", x + 170, y);
      this.node("gauge", "43~58%", x, y + 120, 42, "guide");
    } else {
      const radius = kind === "shelter" ? 92 : ["lure", "freeze"].includes(kind) ? 65 : 44;
      const safe = this.free(x, y, kind === "shelter" ? 165 : 85);
      this.origin = safe;
      this.node(kind, instructions[kind][0], safe.x, safe.y, radius);
      if (kind === "dash") this.nodes[0].angle = side > 0 ? 0 : Math.PI;
    }
    this.describe();
  }
  private describe(): void {
    const [name, hint] = instructions[this.current.kind];
    this.state.objectiveText = `${this.stepIndex + 1}/${this.plan.steps.length} · ${name}`;
    this.state.objectiveHint = this.feedbackTime > 0 ? this.feedback : hint;
  }
  private fail(message: string): void {
    this.feedback = message;
    this.feedbackTime = 1.6;
    this.describe();
  }
  private complete(): void {
    this.hooks.effect("armor-break", this.origin.x, this.origin.y, 110);
    this.hooks.reward();
    this.stepIndex++;
    this.state.objectiveStep = this.stepIndex;
    if (this.stepIndex < this.plan.steps.length) this.begin();
    else {
      this.generation++;
      this.state.objectiveComplete = true;
      this.state.missionNodes = {};
      this.state.objectiveWindow = this.state.bossName ? (this.state.stage === 5 ? 12 : 10) : 0;
      this.state.objectiveText = this.state.bossName ? "방어 해제 · 약점 집중 공격" : "공략 완료 · 남은 적 처치";
      this.state.objectiveHint = this.state.bossName ? "금색 약점이 닫히기 전에 공격하세요" : "필수 목표를 모두 달성했어요";
    }
  }
  /** 물리 탄환의 첫 직격만 처리한다. 산탄·폭발 중복으로 순서 공략을 건너뛰지 못한다. */
  hit(id: string, vx: number, vy: number, owner: string): void {
    if (this.state.objectiveComplete) return;
    const node = this.state.missionNodes[id];
    const player = this.state.players[owner];
    if (!node || !player?.alive || this.hitCooldown > 0) return;
    const quiet = this.clock - this.lastHit >= 0.6;
    this.lastHit = this.clock;
    this.hitCooldown = 0.12;
    const kind = this.current.kind;
    if (kind === "reflect" && node.kind === "reflect") {
      const guide = this.nodes.find(n => n.kind === "guide")!;
      const receiver = this.nodes.find(n => n.kind === "receiver")!;
      const speed = Math.hypot(vx, vy), nx = Math.cos(node.angle), ny = Math.sin(node.angle);
      const dot = (vx * nx + vy * ny) / speed;
      const rx = vx / speed - 2 * dot * nx, ry = vy / speed - 2 * dot * ny;
      const toward = Math.atan2(receiver.y - node.y, receiver.x - node.x);
      if (distanceSquared(player, guide) <= 105 ** 2 && rx * Math.cos(toward) + ry * Math.sin(toward) > 0.94) {
        this.hooks.effect("mission-beam", node.x, node.y, Math.hypot(receiver.x - node.x, receiver.y - node.y), toward);
        this.complete();
      } else this.fail("푸른 발사점에 서서 거울을 조준하세요. 반사 방향이 맞지 않아요.");
    } else if (kind === "circuit" || kind === "prune") {
      const index = this.nodes.indexOf(node);
      if (index === this.cursor) {
        node.status = "done";
        this.cursor += kind === "prune" ? -1 : 1;
        if (this.cursor < 0 || this.cursor >= 3) this.complete();
      } else {
        this.cursor = kind === "prune" ? 2 : 0;
        for (const n of this.nodes) n.status = "active";
        this.fail(kind === "prune" ? "뿌리가 다시 자랐어요. 말단 3번부터 잘라 주세요." : "전력이 끊겼어요. 연결선의 1번부터 다시 시작하세요.");
      }
    } else if (kind === "pulse" || kind === "resonate") {
      if (node.status === "open" && quiet) {
        if (kind === "pulse" || ++this.cursor >= 3) this.complete();
        else node.progress = this.cursor / 3;
      } else {
        if (kind === "resonate") { this.cursor = 0; node.progress = 0; }
        this.fail("연속 사격을 멈추고, 금색으로 점등될 때 한 번씩 맞히세요.");
      }
    } else if (kind === "wind") {
      const angle = Math.atan2(vy, vx);
      if (node.status === "open" && Math.cos(angle - node.angle) > 0.88) {
        this.hooks.effect("mission-beam", node.x, node.y, 160, node.angle);
        this.complete();
      } else this.fail("밝은 바람 화살표와 같은 방향으로 꽃가루를 밀어 주세요.");
    } else if (kind === "mirage") {
      const real = (this.state.stage + this.phase + this.current.variant) % 3;
      if (node === this.nodes[real] && distanceSquared(player, node) < 125 ** 2) this.complete();
      else this.fail("가짜 봉인이에요. 가까이 접근하면 진짜는 금색으로 드러나요.");
    } else if (kind === "pressure" && (node.kind === "minus" || node.kind === "plus")) {
      this.pressure = Math.max(0, Math.min(1, this.pressure + (node.kind === "minus" ? -0.13 : 0.13)));
      this.hitCooldown = 0.28;
    }
  }
  /** 정지·강화·재접속 중에는 호출하지 않는다. 제한시간은 벽시계가 아닌 전투 시간만 사용한다. */
  step(dt: number): void {
    this.clock += dt;
    const boss = Object.values(this.state.enemies).find(e => e.boss);
    if (boss && boss.combatPhase !== this.phase) {
      this.phase = boss.combatPhase;
      this.restart();
    }
    if (this.state.objectiveComplete) {
      if (boss) {
        this.state.objectiveWindow = Math.max(0, this.state.objectiveWindow - dt);
        if (this.state.objectiveWindow === 0) this.restart();
      }
      return;
    }
    this.elapsed += dt;
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.feedbackTime = Math.max(0, this.feedbackTime - dt);
    this.frozen = Math.max(0, this.frozen - dt);
    const players = this.players(), nodes = this.nodes, kind = this.current.kind;
    const node = nodes[0];
    if (!node) return;
    if (kind === "pulse" || kind === "resonate" || kind === "wind") {
      const period = kind === "wind" ? 3.5 : 2.5;
      node.status = this.elapsed % period > period - 0.85 ? "open" : "closed";
      if (kind === "wind") node.angle = Math.floor(this.elapsed / period) % 2 ? Math.PI : 0;
      if (kind !== "resonate") node.progress = (this.elapsed % period) / period;
    } else if (kind === "dash") {
      const winner = players.find(p => p.dashRemaining > 0 && distanceSquared(p, node) < (node.radius + 24) ** 2 &&
        (p.vx * Math.cos(node.angle) + p.vy * Math.sin(node.angle)) > 100);
      if (winner) { this.complete(); return; }
    } else if (kind === "lure" || kind === "freeze") {
      if (kind === "freeze" && this.frozen > 0) {
        node.status = "open";
        node.progress = this.frozen / 4;
        if (players.some(p => p.dashRemaining > 0 && distanceSquared(p, node) < (node.radius + 22) ** 2)) { this.complete(); return; }
      } else {
        node.status = "active";
        this.markCooldown -= dt;
        if (this.markCooldown <= 0 && players.length) {
          // 협동에서는 표식에 접근한 사람이 유도를 맡을 수 있어야 한다. 멀리 있는 팀원만 계속 겨냥하지 않는다.
          const target = players.reduce((closest, p) => distanceSquared(p, node) < distanceSquared(closest, node) ? p : closest);
          const generation = this.generation, point = { x: target.x, y: target.y };
          const accepted = this.hooks.hazard({ ...point, radius: 83, warning: 1.25, windup: 1.25, life: 0.3, kind: "mission-mark" }, () => {
            if (generation !== this.generation || this.state.objectiveComplete) return;
            if (distanceSquared(point, node) <= (node.radius + 35) ** 2) {
              if (kind === "freeze") this.frozen = 4;
              else this.complete();
            } else this.fail("포격이 표식을 빗나갔어요. 표식 안에서 예고를 유도한 뒤 피하세요.");
          });
          this.markCooldown = accepted ? 3.7 : 0.35;
        }
      }
    } else if (["carry", "heat", "grow", "conveyor", "coolant"].includes(kind)) {
      const goal = nodes[1];
      if (!this.carried && kind === "conveyor") {
        const point = this.free(this.origin.x + Math.sin(this.elapsed * 0.8) * 220, this.origin.y + 130, 56);
        node.x = point.x; node.y = point.y;
      }
      if (this.carrier && !players.some(p => p.id === this.carrier)) {
        this.carrier = ""; this.carried = false; this.hold = 0; this.reserve = 7;
        node.x = this.cargoOrigin.x; node.y = this.cargoOrigin.y; node.status = "active"; node.progress = 0;
      }
      if (!this.carried) {
        const collector = players.find(p => distanceSquared(p, node) < (node.radius + 20) ** 2);
        if (collector) { this.carrier = collector.id; this.carried = true; node.status = "carried"; }
      }
      const carrier = players.find(p => p.id === this.carrier);
      if (carrier) {
        node.x = carrier.x; node.y = carrier.y - 35;
        if (kind === "heat") {
          this.reserve -= dt;
          if (distanceSquared(carrier, this.cargoOrigin) < 64 ** 2) this.reserve = 7;
          node.progress = Math.max(0, this.reserve / 7);
          if (this.reserve <= 0) {
            this.carrier = ""; this.carried = false; this.reserve = 7;
            node.x = this.cargoOrigin.x; node.y = this.cargoOrigin.y; node.status = "active"; node.progress = 0;
            this.fail("불씨가 식었어요. 출발 화로에서 다시 회수하세요.");
          }
        }
        if (this.carried && distanceSquared(carrier, goal) < goal.radius ** 2) {
          this.hold = kind === "coolant" && this.hooks.firing(carrier.id) ? 0 : this.hold + dt;
          goal.progress = this.hold / (kind === "grow" ? 2 : kind === "coolant" ? 1.4 : 0.1);
          if (this.hold >= (kind === "grow" ? 2 : kind === "coolant" ? 1.4 : 0.1)) { this.complete(); return; }
        } else this.hold = Math.max(0, this.hold - dt * 0.5);
      }
    } else if (kind === "listen") {
      if (this.cursor === 0) {
        this.hold = players.some(p => Math.hypot(p.vx, p.vy) < 15) ? this.hold + dt : Math.max(0, this.hold - dt * 2);
        node.progress = Math.min(1, this.hold / 1.2); node.status = "hidden";
        if (this.hold >= 1.2) { this.cursor = 1; node.status = "open"; this.fail("진동의 근원을 찾았어요. 금색 유물을 몸으로 회수하세요."); }
      } else if (players.some(p => distanceSquared(p, node) < 65 ** 2)) { this.complete(); return; }
    } else if (kind === "track") {
      if (this.hold > 0) this.hold -= dt;
      if (this.cursor > 0 && this.hold <= 0) { this.cursor = 0; this.fail("흔적이 흐려졌어요. 1번 발자국부터 다시 추적하세요."); }
      for (let i = 0; i < nodes.length; i++) nodes[i].status = i < this.cursor ? "done" : i === this.cursor ? "open" : "guide";
      if (players.some(p => distanceSquared(p, nodes[this.cursor]) < 65 ** 2)) {
        this.cursor++; this.hold = 4.5;
        if (this.cursor >= nodes.length) { this.complete(); return; }
      }
    } else if (kind === "mirage") {
      const real = (this.state.stage + this.phase + this.current.variant) % 3;
      for (let i = 0; i < nodes.length; i++) {
        const near = players.some(p => distanceSquared(p, nodes[i]) < 125 ** 2);
        nodes[i].status = near && i === real ? "open" : "active";
        nodes[i].label = near ? i === real ? "실체" : "환영" : "?";
      }
    } else if (kind === "shelter") {
      node.x = this.origin.x + Math.sin(this.elapsed * 0.7) * 65;
      node.y = this.origin.y + Math.cos(this.elapsed * 0.7) * 50;
      if (players.some(p => distanceSquared(p, node) < (node.radius - WORLD.playerRadius) ** 2)) this.hold += dt;
      node.progress = this.hold / 3;
      if (this.hold >= 3) { this.complete(); return; }
    } else if (kind === "circuit" || kind === "prune") {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].status !== "done") nodes[i].status = i === this.cursor ? "open" : "active";
      }
    } else if (kind === "pressure") {
      this.pressure = Math.max(0, Math.min(1, this.pressure + Math.sin(this.elapsed * 1.1) * dt * 0.045));
      const gauge = nodes[2];
      gauge.progress = this.pressure;
      gauge.label = `${Math.round(this.pressure * 100)}% · ${this.hold.toFixed(1)}/2s`;
      const stable = this.pressure >= 0.43 && this.pressure <= 0.58;
      gauge.status = stable ? "open" : "closed";
      this.hold = stable ? this.hold + dt : Math.max(0, this.hold - dt * 2);
      if (this.hold >= 2) { this.complete(); return; }
    }
    this.describe();
  }
}
