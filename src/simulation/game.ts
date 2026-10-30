import {
  BALANCE,
  WORLD,
  EMPTY_UPGRADES,
  WEAPON_UPGRADES,
  canUpgrade,
  movement,
  playerStats,
  isWeapon,
  isUpgrade,
  type GameSnapshot,
  type PlayerView,
  type InputFrame,
  type GameAction,
  type Mode,
  type EnemyView,
  type EnemyKind,
  type Phase,
  type Rect,
  type PickupKind,
} from "@playground/shooting-shared";
import { CombatWorld } from "./combat.ts";
import { Navigation, distanceSquared } from "./geometry.ts";

interface Control {
  frame: InputFrame;
  age: number;
  dashX: number;
  dashY: number;
}
export interface SimulationHooks {
  random: () => number;
  record: (player: PlayerView, finished: boolean) => void;
}

/** 방마다 하나의 시뮬레이션만 상태를 변경한다. 1인·2인이 같은 전투·기록 규칙을 사용한다. */
export class GameSimulation {
  readonly state: GameSnapshot;
  private readonly combat: CombatWorld;
  private readonly controls = new Map<string, Control>();
  private readonly drops = new Map<string, number>();
  private readonly hooks: SimulationHooks;
  private serial = 0;
  private manualPause = false;
  private authorizationAvailable = true;
  private pendingLevels = 0;
  private resumePhase: Phase = "combat";
  private resumeDeadline = 0;
  private bossDefeated = false;
  private lastBoss = -1;
  private ordinaryTotal = 0;
  private waveSize = 0;

  constructor(mode: Mode, hooks: SimulationHooks) {
    this.hooks = hooks;
    this.state = {
      hostId: "",
      title: "",
      privateRoom: false,
      phase: "lobby",
      mode,
      stage: 0,
      level: 1,
      xp: 0,
      nextXp: 98,
      combatMillis: 0,
      clearedStage: 0,
      clearMillis: 0,
      deadline: 0,
      paused: false,
      pauseReason: "",
      reconnectRemaining: 0,
      enemyTotal: 0,
      enemiesSpawned: 0,
      enemiesKilled: 0,
      wave: 0,
      waveCount: 0,
      bossName: "",
      notice: "",
      players: {},
      enemies: {},
      bullets: {},
      pickups: {},
      hazards: {},
      effects: {},
      walls: [],
    };
    this.combat = new CombatWorld({
      state: this.state,
      random: hooks.random,
      nextId: () => this.nextId(),
      hitPlayer: (player, damage) => this.hit(player, damage),
      defeated: (enemy) => this.defeated(enemy),
      effect: (kind, x, y, radius, value) =>
        this.effect(kind, x, y, radius, value),
    });
  }

  addPlayer(id: string, nickname: string, avatar: string): void {
    if (
      this.state.phase !== "lobby" ||
      this.activePlayers().length >= (this.state.mode === "SINGLE" ? 1 : 2)
    )
      throw new Error("Room is full.");
    const player: PlayerView = {
      id,
      nickname,
      avatar,
      // 방장 승계 후 새 참가자가 들어와도 남은 팀원과 같은 색을 배정하지 않는다.
      color: this.activePlayers().some((p) => p.color === 0x55cfff)
        ? 0x7de7aa
        : 0x55cfff,
      x: WORLD.width / 2,
      y: WORLD.height / 2,
      vx: 0,
      vy: 0,
      aim: -Math.PI / 2,
      hp: BALANCE.baseHealth,
      maxHp: BALANCE.baseHealth,
      armor: 0,
      alive: true,
      connected: true,
      departed: false,
      ready: false,
      vote: false,
      choiceDone: false,
      inputSequence: -1,
      weapon: "rifle",
      upgrades: EMPTY_UPGRADES(),
      revives: 0,
      invuls: 0,
      dashCooldown: 0,
      invulCooldown: 0,
      protection: 0,
      dashRemaining: 0,
      clearedStage: 0,
      clearMillis: 0,
    };
    this.state.players[id] = player;
    if (!this.state.hostId) this.state.hostId = id;
    this.controls.set(id, {
      frame: {
        sequence: -1,
        moveX: 0,
        moveY: 0,
        aim: -Math.PI / 2,
        firing: false,
      },
      age: 10,
      dashX: 0,
      dashY: 0,
    });
  }

  acceptInput(id: string, input: unknown): void {
    const control = this.controls.get(id);
    if (!control || !input || typeof input !== "object") return;
    const value = input as InputFrame;
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence <= control.frame.sequence ||
      value.sequence < 0 ||
      ![value.moveX, value.moveY, value.aim].every(Number.isFinite) ||
      typeof value.firing !== "boolean"
    )
      return;
    const length = Math.max(1, Math.hypot(value.moveX, value.moveY));
    control.frame = {
      sequence: value.sequence,
      moveX: Math.max(-1, Math.min(1, value.moveX / length)),
      moveY: Math.max(-1, Math.min(1, value.moveY / length)),
      aim: Math.atan2(Math.sin(value.aim), Math.cos(value.aim)),
      firing: value.firing,
    };
    control.age = 0;
  }

  action(id: string, action: unknown): void {
    const player = this.state.players[id];
    if (
      !player ||
      player.departed ||
      !player.connected ||
      !action ||
      typeof action !== "object"
    )
      return;
    const value = action as GameAction;
    if (value.type === "pause") {
      if (
        this.state.phase === "lobby" ||
        this.state.phase === "over" ||
        this.manualPause
      )
        return;
      this.manualPause = true;
      this.clearVotes();
      this.updatePause();
      return;
    }
    if (value.type === "resume") {
      if (
        !this.manualPause ||
        this.drops.size > 0 ||
        !this.authorizationAvailable
      )
        return;
      player.vote = true;
      if (this.activePlayers().every((p) => p.vote)) {
        this.manualPause = false;
        this.clearVotes();
      }
      this.updatePause();
      return;
    }
    if (this.state.paused) return;
    if (
      value.type === "ready" &&
      this.state.phase === "lobby" &&
      isWeapon(value.weapon)
    ) {
      player.weapon = value.weapon;
      player.ready = true;
      const players = this.activePlayers();
      if (
        players.length === (this.state.mode === "SINGLE" ? 1 : 2) &&
        players.every((p) => p.ready && p.connected)
      ) {
        for (const p of players) this.hooks.record(p, false);
        this.nextStage();
      }
      return;
    }
    if (
      value.type === "upgrade" &&
      this.state.phase === "upgrade" &&
      !player.choiceDone &&
      isUpgrade(value.upgrade) &&
      (WEAPON_UPGRADES[player.weapon] as readonly string[]).includes(
        value.upgrade,
      ) &&
      canUpgrade(value.upgrade, player.upgrades)
    ) {
      // 다른 총 강화·구형 장착/무기 변경 요청은 서버에서도 허용하지 않는다.
      this.upgrade(player, value.upgrade);
      this.finishChoices();
      return;
    }
    if (!["combat", "loot"].includes(this.state.phase)) return;
    if (value.type === "revive") {
      if (
        player.revives <= 0 ||
        (value.target !== "self" && value.target !== "ally")
      )
        return;
      const target =
        value.target === "self"
          ? player
          : this.activePlayers().find((p) => p.id !== id && !p.alive);
      if (
        !target ||
        target.alive ||
        target.departed ||
        (value.target === "ally" && !player.alive)
      )
        return;
      player.revives--;
      target.alive = true;
      target.hp = target.maxHp * BALANCE.revivalHealth;
      target.protection = BALANCE.revivalProtection;
      if (target.id !== player.id) {
        target.x = player.x;
        target.y = player.y;
      }
      this.effect("revive", target.x, target.y, 80);
      return;
    }
    if (!player.alive) return;
    if (
      value.type === "invul" &&
      player.invuls > 0 &&
      player.invulCooldown <= 0
    ) {
      player.invuls--;
      player.invulCooldown = BALANCE.invulnerabilityCooldown;
      player.protection = Math.max(player.protection, BALANCE.invulnerability);
      this.effect("invul", player.x, player.y, 55);
      return;
    }
    const control = this.controls.get(id)!;
    if (value.type === "dash" && player.dashCooldown <= 0) {
      const vector = control.frame,
        length = Math.hypot(vector.moveX, vector.moveY);
      control.dashX =
        length > 0.01 ? vector.moveX / length : Math.cos(player.aim);
      control.dashY =
        length > 0.01 ? vector.moveY / length : Math.sin(player.aim);
      player.dashRemaining = BALANCE.dashDuration;
      player.dashCooldown = BALANCE.dashCooldown;
      return;
    }
    // 충격파를 포함한 별도 스킬은 제거했다. 보스 처치 판정은 전투 틱의 공통 경로만 사용한다.
  }

  disconnect(id: string): void {
    const player = this.state.players[id];
    if (!player || player.departed) return;
    player.connected = false;
    this.drops.set(id, Date.now() + BALANCE.reconnectSeconds * 1000);
    this.clearVotes();
    this.updatePause();
  }
  /** 권한 서비스 장애는 사용자 동의만으로 우회하지 않는다. 복구 뒤에도 재개 동의를 다시 받는다. */
  setAuthorizationAvailable(available: boolean): void {
    if (this.authorizationAvailable === available) return;
    this.authorizationAvailable = available;
    this.manualPause = true;
    this.clearVotes();
    this.updatePause();
  }
  reconnect(id: string): void {
    const player = this.state.players[id];
    if (!player || player.departed) return;
    player.connected = true;
    this.drops.delete(id);
    if (this.state.phase !== "lobby" && this.state.phase !== "over")
      this.manualPause = true;
    this.clearVotes();
    this.updatePause();
  }
  depart(id: string): void {
    const player = this.state.players[id];
    if (!player || player.departed) return;
    player.departed = true;
    player.connected = false;
    player.alive = false;
    player.vx = 0;
    player.vy = 0;
    this.drops.delete(id);
    this.hooks.record(player, true);
    // 퇴장한 방장 대신 접속 중인 남은 참가자를 우선 선택한다. 팀원 연결은 유지한다.
    if (this.state.hostId === id) {
      const candidates = this.activePlayers();
      this.state.hostId =
        (candidates.find((p) => p.connected) ?? candidates[0])?.id ?? "";
    }
    if (this.state.phase === "lobby") delete this.state.players[id];
    this.controls.delete(id);
    if (this.activePlayers().length === 0) this.end();
    else if (this.state.phase === "upgrade") this.finishChoices();
    this.checkGameOver();
    this.updatePause();
  }

  step(dt: number): void {
    this.state.reconnectRemaining = this.drops.size
      ? Math.max(0, (Math.min(...this.drops.values()) - Date.now()) / 1000)
      : 0;
    this.updatePause();
    if (
      this.state.paused ||
      this.state.phase === "lobby" ||
      this.state.phase === "over"
    )
      return;
    if (this.state.phase === "upgrade") {
      this.state.deadline = Math.max(0, this.state.deadline - dt);
      if (this.state.deadline === 0) {
        for (const player of this.activePlayers())
          if (!player.choiceDone) {
            const choices = WEAPON_UPGRADES[player.weapon].filter((id) =>
              canUpgrade(id, player.upgrades),
            );
            this.upgrade(
              player,
              choices[Math.floor(this.hooks.random() * choices.length)],
            );
          }
        this.finishChoices();
      }
      return;
    }
    this.ageEffects(dt);
    for (const player of this.activePlayers()) this.advancePlayer(player, dt);
    if (this.state.phase === "combat") {
      this.state.combatMillis += dt * 1000;
      for (const player of this.activePlayers()) {
        const control = this.controls.get(player.id)!;
        this.combat.fire(
          player,
          control.age < BALANCE.inputTimeout && control.frame.firing,
          dt,
        );
      }
      this.combat.step(dt);
      if (
        this.bossDefeated ||
        (this.state.enemiesSpawned >= this.state.enemyTotal &&
          this.combat.size === 0)
      )
        this.clearStage();
      else if (
        !this.state.bossName &&
        this.combat.size <= Math.max(3, Math.floor(this.waveSize * 0.2)) &&
        this.state.enemiesSpawned < this.state.enemyTotal
      )
        this.spawnWave();
    } else if (this.state.phase === "loot")
      this.state.deadline = Math.max(0, this.state.deadline - dt);
    if (this.state.phase === "combat") this.collectItems();
    this.applyExperience();
    this.checkGameOver();
    if (this.state.phase === "loot" && this.state.deadline === 0) {
      this.state.pickups = {};
      // 보스 뒤에도 처음 고른 총을 유지하며 무기 교체 정비 화면 없이 다음 전투로 이어진다.
      this.nextStage();
    }
  }

  private advancePlayer(player: PlayerView, dt: number): void {
    const control = this.controls.get(player.id)!;
    control.age += dt;
    player.dashCooldown = Math.max(0, player.dashCooldown - dt);
    player.invulCooldown = Math.max(0, player.invulCooldown - dt);
    player.protection = Math.max(0, player.protection - dt);
    player.armor = playerStats(this.state.level).armor;
    player.vx = 0;
    player.vy = 0;
    if (!player.alive) return;
    player.aim = control.frame.aim;
    player.inputSequence = control.frame.sequence;
    if (player.dashRemaining > 0) {
      const duration = Math.min(dt, player.dashRemaining);
      player.vx = (control.dashX * BALANCE.dashDistance) / BALANCE.dashDuration;
      player.vy = (control.dashY * BALANCE.dashDistance) / BALANCE.dashDuration;
      const next = movement(
        player.x,
        player.y,
        player.vx * duration,
        player.vy * duration,
        WORLD.playerRadius,
        this.state.walls,
      );
      player.x = next.x;
      player.y = next.y;
      player.dashRemaining = Math.max(0, player.dashRemaining - dt);
    } else if (control.age < BALANCE.inputTimeout) {
      const speed = playerStats(this.state.level).speed;
      player.vx = control.frame.moveX * speed;
      player.vy = control.frame.moveY * speed;
      const next = movement(
        player.x,
        player.y,
        player.vx * dt,
        player.vy * dt,
        WORLD.playerRadius,
        this.state.walls,
      );
      player.x = next.x;
      player.y = next.y;
    }
  }

  private upgrade(
    player: PlayerView,
    upgrade: keyof PlayerView["upgrades"],
  ): void {
    player.upgrades[upgrade]++;
    player.choiceDone = true;
  }
  private finishChoices(): void {
    if (!this.activePlayers().every((p) => p.choiceDone)) return;
    if (this.state.phase === "upgrade") {
      this.pendingLevels--;
      if (this.pendingLevels > 0) {
        this.state.deadline = BALANCE.choiceSeconds;
        for (const player of this.activePlayers()) player.choiceDone = false;
      } else {
        this.state.phase = this.resumePhase;
        this.state.deadline = this.resumeDeadline;
      }
    }
  }

  private nextStage(): void {
    this.state.stage++;
    this.state.phase = "combat";
    this.state.deadline = 0;
    this.state.enemiesSpawned = 0;
    this.state.enemiesKilled = 0;
    this.state.wave = 0;
    this.state.notice = "";
    this.state.pickups = {};
    this.state.effects = {};
    this.bossDefeated = false;
    this.state.walls = this.generateWalls();
    this.combat.reset();
    let seat = 0;
    for (const player of this.activePlayers()) {
      player.x = WORLD.width / 2 + (seat++ === 0 ? -45 : 45);
      player.y = WORLD.height / 2 + 90;
      player.dashCooldown = 0;
      player.invulCooldown = 0;
      player.protection = 0;
      player.dashRemaining = 0;
      player.vx = 0;
      player.vy = 0;
      const control = this.controls.get(player.id)!;
      control.age = 10;
    }
    if (this.state.stage % 5 === 0) {
      const choices = [0, 1, 2].filter((index) => index !== this.lastBoss);
      this.lastBoss = choices[Math.floor(this.hooks.random() * choices.length)];
      const kinds: EnemyKind[] = [
        "boss-charge",
        "boss-barrage",
        "boss-artillery",
      ];
      this.state.bossName = [
        "돌진형 · 브레이커",
        "사격형 · 센티넬",
        "포격형 · 디스트로이어",
      ][this.lastBoss];
      this.ordinaryTotal = Math.ceil(
        (6 + 2 * Math.floor(Math.log2(this.state.stage / 5 + 1))) *
          (this.state.mode === "COOP" ? 1.8 : 1),
      );
      this.state.enemyTotal = this.ordinaryTotal + 1;
      this.state.waveCount = 1;
      this.state.wave = 1;
      this.combat.spawn(kinds[this.lastBoss]);
      for (let index = 0; index < this.ordinaryTotal; index++)
        this.combat.spawn();
    } else {
      this.state.bossName = "";
      this.ordinaryTotal = Math.ceil(
        (18 + 4 * this.state.stage) * (this.state.mode === "COOP" ? 1.8 : 1),
      );
      this.waveSize = Math.ceil(
        (10 + Math.log2(this.state.stage + 1) * 3) *
          (this.state.mode === "COOP" ? 1.8 : 1),
      );
      this.state.enemyTotal = this.ordinaryTotal;
      this.state.waveCount = Math.ceil(this.ordinaryTotal / this.waveSize);
      this.spawnWave();
    }
  }

  private spawnWave(): void {
    const count = Math.min(
      this.waveSize,
      this.state.enemyTotal - this.state.enemiesSpawned,
    );
    if (count <= 0) return;
    this.state.wave++;
    for (let index = 0; index < count; index++) this.combat.spawn();
  }
  private clearStage(): void {
    if (this.state.phase !== "combat") return;
    this.state.clearedStage = this.state.stage;
    this.state.clearMillis = Math.round(this.state.combatMillis);
    this.state.phase = "loot";
    // 클리어 뒤에는 수거 시간을 주지 않고 짧은 전환만 표시한다.
    this.state.deadline = BALANCE.lootSeconds;
    if (this.bossDefeated) this.combat.eliminateRemaining();
    else this.combat.ceaseFire();
    this.state.pickups = {};
    for (const player of this.activePlayers()) {
      player.clearedStage = this.state.clearedStage;
      player.clearMillis = this.state.clearMillis;
      this.hooks.record(player, false);
    }
    this.effect("stage-clear", WORLD.width / 2, WORLD.height / 2, 200);
  }

  private defeated(enemy: EnemyView): void {
    this.state.enemiesKilled++;
    if (enemy.boss) this.bossDefeated = true;
    const amount = enemy.boss
      ? 120
      : 8 / (this.state.mode === "COOP" ? 1.8 : 1);
    // 경험치는 자동 획득한다. 처치 순회 도중 강화 화면으로 전환하지 않도록 틱 끝에 적용한다.
    this.state.xp += amount;
    for (const kind of ["heal", "invul", "revive"] as const)
      if (this.hooks.random() < BALANCE.drops[kind])
        this.drop(
          kind,
          enemy.x + (this.hooks.random() - 0.5) * 35,
          enemy.y + (this.hooks.random() - 0.5) * 35,
          1,
        );
  }
  private drop(kind: PickupKind, x: number, y: number, amount: number): void {
    const id = this.nextId();
    this.state.pickups[id] = { id, kind, x, y, amount };
  }
  private collectItems(): void {
    const players = this.activePlayers().filter((p) => p.alive);
    let experience = 0;
    for (const [id, pickup] of Object.entries(this.state.pickups)) {
      const candidates = players.filter(
        (p) => pickup.kind !== "heal" || p.hp < p.maxHp,
      );
      const collector = candidates
        .filter((p) => distanceSquared(p, pickup) <= BALANCE.pickupRadius ** 2)
        .sort(
          (a, b) => distanceSquared(a, pickup) - distanceSquared(b, pickup),
        )[0];
      if (!collector) continue;
      delete this.state.pickups[id];
      if (pickup.kind === "xp") experience += pickup.amount;
      if (pickup.kind === "heal") {
        collector.hp = Math.min(
          collector.maxHp,
          collector.hp + collector.maxHp * BALANCE.heal,
        );
        this.effect("heal", collector.x, collector.y, 42);
      }
      if (pickup.kind === "revive") collector.revives++;
      if (pickup.kind === "invul") collector.invuls++;
    }
    if (experience <= 0) return;
    this.state.xp += experience;
  }

  /** 자동 경험치를 레벨로 변환하며 클리어 전환 상태도 강화 이후 정확히 이어간다. */
  private applyExperience(): void {
    if (this.state.phase === "over") return;
    while (this.state.xp >= this.state.nextXp) {
      this.state.xp -= this.state.nextXp;
      this.state.level++;
      // 한 번에 여러 레벨을 얻어도 각 레벨의 자동 성장을 누락하지 않는다. 쓰러진 플레이어는 자동 부활하지 않는다.
      const stats = playerStats(this.state.level);
      for (const player of this.activePlayers()) {
        const gainedHealth = stats.health - player.maxHp;
        player.maxHp = stats.health;
        player.armor = stats.armor;
        if (player.alive)
          player.hp = Math.min(player.maxHp, player.hp + gainedHealth);
      }
      this.pendingLevels++;
      this.state.nextXp = 70 + this.state.level * 28;
    }
    if (this.pendingLevels > 0 && this.state.phase !== "upgrade") {
      this.resumePhase = this.state.phase;
      this.resumeDeadline = this.state.deadline;
      this.state.phase = "upgrade";
      this.state.deadline = BALANCE.choiceSeconds;
      for (const player of this.activePlayers()) player.choiceDone = false;
    }
  }

  private hit(player: PlayerView, raw: number): void {
    if (
      !player.alive ||
      player.departed ||
      player.protection > 0 ||
      this.state.phase !== "combat"
    )
      return;
    const damage =
      (raw * BALANCE.armorUnit) /
      (BALANCE.armorUnit + Math.max(0, player.armor));
    player.hp = Math.max(0, player.hp - damage);
    player.protection = BALANCE.hitProtection;
    this.effect("player-hit", player.x, player.y, 35, Math.round(damage));
    if (player.hp <= 0) {
      player.alive = false;
      this.effect("down", player.x, player.y, 60);
    }
  }
  private checkGameOver(): void {
    if (this.state.phase === "lobby" || this.state.phase === "over") return;
    const players = this.activePlayers();
    if (!players.some((p) => p.alive) && !players.some((p) => p.revives > 0))
      this.end();
  }
  private end(): void {
    if (this.state.phase === "over") return;
    this.state.phase = "over";
    this.state.paused = false;
    this.state.pauseReason = "";
    this.clearVotes();
    this.combat.ceaseFire();
    for (const player of this.activePlayers()) this.hooks.record(player, true);
  }
  private activePlayers(): PlayerView[] {
    return Object.values(this.state.players).filter((p) => !p.departed);
  }
  private clearVotes(): void {
    for (const player of this.activePlayers()) player.vote = false;
  }
  private updatePause(): void {
    const available =
      this.state.phase !== "lobby" && this.state.phase !== "over";
    this.state.paused =
      available &&
      (this.manualPause || this.drops.size > 0 || !this.authorizationAvailable);
    this.state.pauseReason = !this.state.paused
      ? ""
      : !this.authorizationAvailable
        ? "authorization"
        : this.drops.size
          ? "connection"
          : "manual";
  }
  private ageEffects(dt: number): void {
    for (const effect of Object.values(this.state.effects)) {
      effect.life -= dt;
      if (effect.life <= 0) delete this.state.effects[effect.id];
    }
  }
  private effect(
    kind: string,
    x: number,
    y: number,
    radius: number,
    value = 0,
  ): void {
    // 시각 효과 수만 제한한다. 피해·공격속도·성장 판정에는 이 제한을 적용하지 않는다.
    // 집중 사격 중에도 처치 모션이 피격 스파크에 밀려 사라지지 않게 우선 표시한다.
    if (Object.keys(this.state.effects).length >= 160) {
      const expendable = (kind === "death" || kind === "boss-death")
        ? Object.values(this.state.effects).find(effect => effect.kind === "hit")
        : undefined;
      if (!expendable) return;
      delete this.state.effects[expendable.id];
    }
    const id = this.nextId();
    // 효과별 진행률을 클라이언트에서 동일하게 계산하며 공격 판정과 시각적 수명을 분리한다.
    const duration = kind === "hit" ? 0.2 : kind === "death" ? 0.85 : kind === "boss-death" ? 1.1
      : kind === "revive" ? 0.8 : kind === "stage-clear" ? 0.75 : 0.55;
    this.state.effects[id] = {
      id,
      kind,
      x,
      y,
      radius,
      value,
      duration,
      life: duration,
    };
  }
  private nextId(): string {
    return (++this.serial).toString(36);
  }
  private generateWalls(): Rect[] {
    for (let attempt = 0; attempt < 20; attempt++) {
      const walls: Rect[] = [];
      for (const x of [240, 480, 1040, 1280])
        for (const y of [240, 600])
          if (this.hooks.random() < 0.7)
            walls.push({
              x: x + Math.floor(this.hooks.random() * 2) * 40,
              y,
              width: 80 + Math.floor(this.hooks.random() * 2) * 40,
              height: 80 + Math.floor(this.hooks.random() * 2) * 40,
            });
      if (new Navigation(walls).connected()) return walls;
    }
    return [];
  }
}
