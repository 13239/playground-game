import { createHash, createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, Agent } from "node:https";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import type { Mode } from "@playground/shooting-shared";

export interface Identity {
  userId: number;
  sessionId: string;
  browserKey: string;
  nickname: string;
  avatar: string;
  mode: Mode;
  origin: string;
  proofRequired: boolean;
}
export interface Lease {
  userId: number;
  sessionId: string;
  browserKey: string;
  roomId: string;
}
export interface Checkpoint {
  runId: string;
  userId: number;
  sessionId: string;
  mode: Mode;
  clearedStage: number;
  combatMillis: number;
  teammate: string;
  finished: boolean;
}
export class BackendError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Game authorization service is unavailable.");
    this.status = status;
  }
}
const tlsAgent = new Agent({
  keepAlive: true,
  maxSockets: 16,
  minVersion: "TLSv1.3",
  ...(process.env.GAME_BACKEND_CA && {
    ca: readFileSync(process.env.GAME_BACKEND_CA),
  }),
  ...(process.env.GAME_BACKEND_CERT && {
    cert: readFileSync(process.env.GAME_BACKEND_CERT),
  }),
  ...(process.env.GAME_BACKEND_KEY && {
    key: readFileSync(process.env.GAME_BACKEND_KEY),
  }),
});

/** 응답 크기·시간을 제한하고 본문까지 HMAC으로 묶는다. 인증 키·응답 원문은 오류에 포함하지 않는다. */
export async function backend<T = void>(
  operation:
    | "consume"
    | "claim"
    | "validate"
    | "release"
    | "checkpoint"
    | "lobby"
    | "restart",
  input: object,
): Promise<T> {
  const path = `/internal/shooting/${operation}`;
  const data = Buffer.from(JSON.stringify(input));
  const timestamp = Date.now().toString(),
    nonce = randomUUID();
  const digest = createHash("sha256").update(data).digest("hex");
  const signature = createHmac("sha256", config.key)
    .update(`${timestamp}\n${nonce}\nPOST\n${path}\n${digest}`)
    .digest("base64url");
  const url = new URL(path, config.backend);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        ...(url.protocol === "https:" && { agent: tlsAgent }),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
          "X-Game-Timestamp": timestamp,
          "X-Game-Nonce": nonce,
          "X-Game-Signature": signature,
        },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 32_768) {
            response.destroy();
            reject(new BackendError(502));
          } else chunks.push(chunk);
        });
        response.on("error", () => reject(new BackendError(503)));
        response.on("end", () => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(new BackendError(response.statusCode ?? 503));
            return;
          }
          if (response.statusCode === 204) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch {
            reject(new BackendError(502));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new BackendError(503)));
    request.end(data);
  });
}

/** 클리어마다 기록을 저장한다. 지연된 갱신은 직렬 재시도로 처리하고 종료 기록을 뒤로 밀지 않는다. */
export class RecordWriter {
  private readonly pending = new Map<string, Checkpoint>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  queue(value: Checkpoint): void {
    // 이전 도전의 지연된 종료 기록과 새 도전이 같은 계정이라는 이유로 덮어쓰이지 않게 한다.
    const id = `${value.runId}:${value.userId}`;
    const prior = this.pending.get(id);
    if (prior?.finished) return;
    this.pending.set(id, value);
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running || this.timer || this.pending.size === 0) return;
    this.running = true;
    try {
      for (const [id, value] of this.pending) {
        try {
          await backend("checkpoint", value);
          if (this.pending.get(id) === value) this.pending.delete(id);
          this.attempts = 0;
        } catch (error) {
          // 만료된 세션·잘못된 입력은 재전송하지 않는다. 이미 저장한 마지막 클리어는 유지된다.
          if (
            error instanceof BackendError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            if (this.pending.get(id) === value) this.pending.delete(id);
            continue;
          }
          const delay = Math.min(
            30_000,
            1000 * 2 ** Math.min(this.attempts++, 5),
          );
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, delay);
          this.timer.unref();
          break;
        }
      }
    } finally {
      this.running = false;
      if (!this.timer && this.pending.size) void this.drain();
    }
  }
}
