import { createHash, randomInt, randomUUID } from "node:crypto";
import { Room, ServerError, type Client, type AuthContext } from "colyseus";
import {
  BALANCE,
  WORLD,
  type Mode,
  type PlayerView,
} from "@playground/shooting-shared";
import {
  authenticate,
  verifyConnection,
  type ConnectOptions,
} from "../auth.ts";
import {
  backend,
  BackendError,
  RecordWriter,
  type Identity,
  type Lease,
} from "../backend.ts";
import { config } from "../config.ts";
import {
  WorldState,
  synchronize,
  type WorldStateType,
} from "../network/state.ts";
import { GameSimulation } from "../simulation/game.ts";
import { RoomSettings } from "./room-settings.ts";

type GameClient = Client<{ auth: Identity }>;
const writer = new RecordWriter();
let activeRooms = 0;
const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** 두 사람 모두 서버 판정을 받으며 방의 고정 간격 루프만 전투 상태를 변경한다. */
export class ShootingRoom extends Room<{
  state: WorldStateType;
  client: GameClient;
}> {
  state = new WorldState();
  maxMessagesPerSecond = 100;
  patchRate = 50;
  private simulation!: GameSimulation;
  private readonly identities = new Map<string, Identity>();
  private readonly actionTimes = new Map<string, number[]>();
  private runId = randomUUID();
  private mode: Mode = "SINGLE";
  private creator!: Identity;
  private creatorTicket = "";
  private creatorJoined = false;
  private counted = false;
  private validating = false;
  private restarting = false;
  private disposed = false;
  private lobbyUpdates: Promise<void> = Promise.resolve();
  private settings!: RoomSettings;
  private lobbyOwner?: Identity;
  private readonly leaving = new Map<string, Promise<void>>();
  private readonly pendingReleases = new Map<string, Identity>();
  private readonly passwordAttempts = new Map<
    number,
    { count: number; expires: number }
  >();

  async onCreate(options: ConnectOptions): Promise<void> {
    if (
      activeRooms >= config.maxRooms ||
      !options ||
      (options.mode !== "SINGLE" && options.mode !== "COOP")
    )
      throw new ServerError(
        503,
        "지금은 새 게임을 만들 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    this.mode = options.mode;
    this.maxClients = this.mode === "SINGLE" ? 1 : 2;
    this.roomId = Array.from(
      { length: 8 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
    // 느린 모바일에서도 첫 소켓을 열 여유를 주며 게임 중 복귀 유예 15초와는 분리한다.
    this.seatReservationTimeout = 20;
    try {
      // 유효한 티켓과 브라우저 키를 확인하기 전에는 방 자원이나 사용권을 확보하지 않는다.
      this.creator = await authenticate(options, this.roomId, this.mode, true);
      this.settings = new RoomSettings(options.title, options.privateRoom);
      await this.settings.initialize(options.password);
      if (activeRooms >= config.maxRooms) throw new Error();
      // 사용권은 실제 소켓의 onJoin에서만 확보한다. 생성 요청을 취소한 예약이 사용권을 남기지 않는다.
    } catch (error) {
      throw new ServerError(
        error instanceof BackendError && error.status === 409 ? 409 : 403,
        error instanceof BackendError && error.status === 409
          ? "이미 다른 화면에서 게임을 이용하고 있습니다."
          : "게임 접속을 확인하지 못했습니다. 다시 입장해 주세요.",
      );
    }
    this.creatorTicket = createHash("sha256")
      .update(options.ticket)
      .digest("hex");
    activeRooms++;
    this.counted = true;
    this.simulation = new GameSimulation(this.mode, {
      random: () => randomInt(0x100000000) / 0x100000000,
      record: (player, finished) => this.record(player, finished),
    });
    this.applySettings();
    // 명시적 퇴장은 사용권을 반환한 뒤 확인 응답을 보내 즉시 재참가와 경합하지 않게 한다.
    this.onMessage("leave", (client) => {
      void this.finishLeave(client)
        .then(() => {
          client.send("released");
          client.leave(4000); // Colyseus의 CONSENTED 종료로 재접속 좌석을 남기지 않는다.
        })
        .catch(() =>
          client.leave(4000, "게임 퇴장 처리를 확인하지 못했습니다."),
        );
    });
    this.onMessage("input", (client, value: unknown) =>
      this.simulation.acceptInput(client.sessionId, value),
    );
    this.onMessage("action", (client, value: unknown) => {
      const now = Date.now(),
        times = (this.actionTimes.get(client.sessionId) ?? []).filter(
          (time) => now - time < 1000,
        );
      if (times.length >= 16) return;
      times.push(now);
      this.actionTimes.set(client.sessionId, times);
      if (
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "replay"
      ) {
        const player = this.simulation.state.players[client.sessionId];
        if (
          this.simulation.state.phase === "over" &&
          player &&
          player.connected &&
          !player.departed
        )
          player.vote = true;
        void this.replay();
        return;
      }
      const before = this.simulation.state.phase;
      this.simulation.action(client.sessionId, value);
      if (before === "lobby" && this.simulation.state.phase !== "lobby") {
        void this.lock();
        void this.publishLobby();
      }
    });
    this.onMessage("ping", (client, value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value))
        client.send("pong", value);
    });
    this.setFixedTimestep(
      (context) => this.simulation.step(context.dt),
      WORLD.tickRate,
    );
    this.clock.setInterval(() => {
      void this.validateParticipants();
    }, 10_000);
    synchronize(this.state, this.simulation.state);
  }

  async onAuth(
    _client: GameClient,
    options: ConnectOptions,
    context: AuthContext,
  ): Promise<Identity> {
    if (
      context.headers.get("origin") !== config.origin ||
      this.simulation.state.phase !== "lobby"
    )
      throw new ServerError(403, "이 게임에 입장할 수 없습니다.");
    try {
      const creating =
        !this.creatorJoined &&
        typeof options?.ticket === "string" &&
        createHash("sha256").update(options.ticket).digest("hex") ===
          this.creatorTicket;
      if (creating) {
        const proof = await verifyConnection(
          options,
          this.roomId,
          this.mode,
          true,
        );
        if (proof.thumbprint !== this.creator.browserKey) throw new Error();
        return this.creator;
      }
      const identity = await authenticate(
        options,
        this.roomId,
        this.mode,
        false,
      );
      // 일회용 티켓 외에도 사용자별·방별 비밀번호 시도 횟수를 제한한다.
      const now = Date.now();
      for (const [id, attempt] of this.passwordAttempts)
        if (attempt.expires <= now) this.passwordAttempts.delete(id);
      const attempt = this.passwordAttempts.get(identity.userId) ?? {
        count: 0,
        expires: now + 60_000,
      };
      if (this.settings.privateRoom) {
        if (++attempt.count > 5)
          throw new ServerError(
            429,
            "비밀번호 확인은 잠시 후 다시 시도해 주세요.",
          );
        this.passwordAttempts.set(identity.userId, attempt);
        if (!(await this.settings.verify(options.password)))
          throw new ServerError(403, "비밀번호를 확인해 주세요.");
        this.passwordAttempts.delete(identity.userId);
      }
      return identity;
    } catch (error) {
      if (error instanceof ServerError) throw error;
      throw new ServerError(
        403,
        "게임 접속 증명이 만료되었습니다. 다시 입장해 주세요.",
      );
    }
  }

  async onJoin(client: GameClient): Promise<void> {
    const identity = client.auth;
    if (
      !identity ||
      [...this.identities.values()].some(
        (value) => value.userId === identity.userId,
      )
    )
      throw new ServerError(409, "이미 이 게임에 참여하고 있습니다.");
    try {
      await backend("claim", this.lease(identity));
    } catch (error) {
      throw new ServerError(
        error instanceof BackendError && error.status === 409 ? 409 : 503,
        error instanceof BackendError && error.status === 409
          ? "이미 다른 화면에서 게임을 이용하고 있습니다."
          : "게임 참가 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    // 초대 수락·좌석 예약 도중 방장이 떠났으면 사용권을 반환하고 빈 대기실에 입장시키지 않는다.
    if (
      identity.userId !== this.creator.userId &&
      (this.simulation.state.phase !== "lobby" || !this.hostPresent())
    ) {
      await backend("release", this.lease(identity)).catch(() => {
        /* 사용권은 짧은 TTL로도 만료된다. */
      });
      throw new ServerError(
        409,
        "방장이 방을 나갔습니다. 다른 방에 참가해 주세요.",
      );
    }
    this.identities.set(client.sessionId, identity);
    if (identity.userId === this.creator.userId) this.creatorJoined = true;
    this.simulation.addPlayer(
      client.sessionId,
      identity.nickname,
      identity.avatar,
    );
    synchronize(this.state, this.simulation.state);
    // 최초 참가가 확인된 방만 공개하고, 참가 인원이 바뀔 때 목록의 좌석도 함께 갱신한다.
    await this.publishLobby();
    client.send("welcome", { roomId: this.roomId, mode: this.mode });
  }

  onBeforePatch(): void {
    if (this.simulation) synchronize(this.state, this.simulation.state);
  }

  onDrop(client: GameClient): void {
    this.simulation.disconnect(client.sessionId);
    void this.publishLobby();
    this.allowReconnection(client, BALANCE.reconnectSeconds).catch(() => {
      /* 실제 퇴장은 onLeave 한 경로에서 처리한다. */
    });
  }
  async onReconnect(client: GameClient): Promise<void> {
    const identity = this.identities.get(client.sessionId);
    if (!identity) throw new ServerError(403, "복귀할 수 없는 게임입니다.");
    await backend("validate", this.lease(identity));
    this.simulation.reconnect(client.sessionId);
    await this.publishLobby();
    synchronize(this.state, this.simulation.state);
  }
  async onLeave(client: GameClient): Promise<void> {
    try {
      await this.finishLeave(client);
    } finally {
      this.leaving.delete(client.sessionId);
    }
  }

  /** 퇴장 경로를 하나로 묶어 강제 종료·자발적 퇴장이 겹쳐도 사용권을 한 번만 정리한다. */
  private finishLeave(client: GameClient): Promise<void> {
    const existing = this.leaving.get(client.sessionId);
    if (existing) return existing;
    const task = this.releaseParticipant(client);
    this.leaving.set(client.sessionId, task);
    return task;
  }

  private async releaseParticipant(client: GameClient): Promise<void> {
    const identity = this.identities.get(client.sessionId);
    if (!identity || !this.simulation) return;
    const lobby = this.simulation.state.phase === "lobby";
    this.simulation.depart(client.sessionId);
    this.actionTimes.delete(client.sessionId);
    // 방장 승계와 목록 변경을 먼저 확정한다. 마지막 사용권을 지운 뒤에는 목록 갱신이 거절될 수 있다.
    await this.publishLobby();
    try {
      await backend("release", this.lease(identity));
      // 먼저 다시하기를 누른 팀원만 남았으면 추가 클릭 없이 그 동의로 대기실에 복귀한다.
      await this.replay();
    } catch {
      // 장애로 반환하지 못한 사용권은 검증 주기와 종료 시 재시도하고 TTL도 유지한다.
      this.pendingReleases.set(client.sessionId, identity);
      throw new Error("게임 퇴장 처리를 확인하지 못했습니다.");
    } finally {
      if (lobby) this.identities.delete(client.sessionId);
    }
  }
  async onDispose(): Promise<void> {
    this.disposed = true;
    await this.publishLobby();
    if (this.counted) {
      activeRooms--;
      this.counted = false;
    }
    if (this.simulation)
      for (const player of Object.values(this.simulation.state.players))
        if (!player.departed) this.simulation.depart(player.id);
    const identities = [
      ...this.identities.values(),
      ...this.pendingReleases.values(),
      ...(!this.creatorJoined && this.creator ? [this.creator] : []),
    ];
    await Promise.allSettled(
      identities.map((identity) => backend("release", this.lease(identity))),
    );
  }

  /** 현재 접속한 방장만 새 참가와 초대를 받을 수 있다. */
  private hostPresent(): boolean {
    return !!this.simulation.state.players[this.simulation.state.hostId]
      ?.connected;
  }

  /** 갱신은 직렬화해 늦게 도착한 하트비트가 전투 시작·종료된 방을 다시 공개하지 않게 한다. */
  private publishLobby(): Promise<void> {
    if (this.mode !== "COOP" || !this.creator || !this.simulation)
      return Promise.resolve();
    this.lobbyUpdates = this.lobbyUpdates
      .then(async () => {
        const host = this.identities.get(this.simulation.state.hostId);
        const players = Object.values(this.simulation.state.players).filter(
          (player) => !player.departed,
        );
        const open =
          !this.disposed &&
          this.simulation.state.phase === "lobby" &&
          players.length === 1 &&
          !!host &&
          this.hostPresent();
        const owner = host ?? this.lobbyOwner ?? this.creator;
        await backend("lobby", {
          userId: owner.userId,
          sessionId: owner.sessionId,
          roomId: this.roomId,
          runId: this.runId,
          open,
          title: this.settings.title,
          privateRoom: this.settings.privateRoom,
        });
        if (open) this.lobbyOwner = owner;
      })
      .catch(() => {
        // 목록 임대는 25초 뒤 만료된다. 조회 갱신 실패가 진행 중인 전투를 종료시키지 않는다.
      });
    return this.lobbyUpdates;
  }

  private lease(identity: Identity): Lease {
    return {
      userId: identity.userId,
      sessionId: identity.sessionId,
      browserKey: identity.browserKey,
      roomId: this.roomId,
    };
  }

  /** 결과 화면에서는 각자 동의한 뒤 같은 방·참가자를 유지한 새 도전으로 돌아간다. */
  private async replay(): Promise<void> {
    if (this.simulation.state.phase !== "over") return;
    const players = Object.values(this.simulation.state.players).filter(
      (p) => !p.departed,
    );
    if (
      this.restarting ||
      players.length === 0 ||
      !players.every((p) => p.connected && p.vote)
    )
      return;
    this.restarting = true;
    try {
      await backend("restart", { mode: this.mode });
      for (const player of players) {
        const identity = this.identities.get(player.id);
        if (!identity) return;
        await backend("validate", this.lease(identity));
      }
      // 확인 중 퇴장·재접속이 발생한 이전 참가자를 새 도전에 다시 넣지 않는다.
      if (players.some((p) => p.departed || !p.connected)) return;
      // 이전 도전에서 떠난 참가자의 신원을 새 도전 기록의 팀원으로 잘못 사용하지 않는다.
      const activeIds = new Set(players.map((p) => p.id));
      for (const id of this.identities.keys()) if (!activeIds.has(id)) this.identities.delete(id);
      this.runId = randomUUID();
      this.simulation = new GameSimulation(this.mode, {
        random: () => randomInt(0x100000000) / 0x100000000,
        record: (value, finished) => this.record(value, finished),
      });
      this.applySettings();
      for (const member of players)
        this.simulation.addPlayer(member.id, member.nickname, member.avatar);
      this.actionTimes.clear();
      void this.unlock();
      synchronize(this.state, this.simulation.state);
      void this.publishLobby();
    } catch {
      for (const player of players) player.vote = false;
      for (const client of this.clients)
        client.send(
          "notice",
          "재도전 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        );
    } finally {
      this.restarting = false;
      const remaining = Object.values(this.simulation.state.players).filter(
        (p) => !p.departed,
      );
      if (
        this.simulation.state.phase === "over" &&
        remaining.length > 0 &&
        remaining.length < players.length &&
        remaining.every((p) => p.connected && p.vote)
      )
        void this.replay();
    }
  }

  private applySettings(): void {
    this.simulation.state.title = this.settings.title;
    this.simulation.state.privateRoom = this.settings.privateRoom;
  }
  private record(player: PlayerView, finished: boolean): void {
    const identity = this.identities.get(player.id);
    if (!identity) return;
    const teammate =
      [...this.identities.values()].find(
        (value) => value.userId !== identity.userId,
      )?.nickname ?? "";
    writer.queue({
      runId: this.runId,
      userId: identity.userId,
      sessionId: identity.sessionId,
      mode: this.mode,
      clearedStage: player.clearedStage,
      combatMillis: Math.round(player.clearMillis),
      teammate,
      finished,
    });
  }
  private async validateParticipants(): Promise<void> {
    if (this.validating || !this.simulation) return;
    this.validating = true;
    let available = true;
    try {
      for (const [id, identity] of this.pendingReleases) {
        try {
          await backend("release", this.lease(identity));
          this.pendingReleases.delete(id);
        } catch {
          /* 다음 검증 주기 또는 사용권 TTL로 재시도한다. */
        }
      }
      for (const [id, identity] of this.identities) {
        if (this.simulation.state.players[id]?.departed) continue;
        try {
          await backend("validate", this.lease(identity));
        } catch (error) {
          const client = this.clients.find((value) => value.sessionId === id);
          if (
            error instanceof BackendError &&
            error.status >= 400 &&
            error.status < 500
          )
            client?.leave(4000, "로그인 또는 게임 참가 권한이 종료되었습니다.");
          else if (client) {
            available = false;
            this.simulation.setAuthorizationAvailable(false);
            client.send(
              "notice",
              "접속 권한 확인이 지연되고 있어 게임을 일시정지했습니다.",
            );
          }
        }
      }
      this.simulation.setAuthorizationAvailable(available);
      await this.publishLobby();
    } finally {
      this.validating = false;
    }
  }
}
