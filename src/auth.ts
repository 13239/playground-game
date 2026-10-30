import { createHash, webcrypto } from "node:crypto";
import { connectionMessage, type Mode } from "@playground/shooting-shared";
import { backend, type Identity } from "./backend.ts";
import { config } from "./config.ts";

export interface ConnectOptions {
  title?: string;
  privateRoom?: boolean;
  password?: string;
  ticket: string;
  mode: Mode;
  target: string;
  key?: JsonWebKey;
  signature?: string;
}

/** 티켓 소유뿐 아니라 현재 로그인 브라우저의 추출 불가 개인키 소유까지 확인한다. */
export async function verifyConnection(
  options: unknown,
  roomId: string,
  mode: Mode,
  creating: boolean,
): Promise<{ value: ConnectOptions; thumbprint: string }> {
  if (!options || typeof options !== "object")
    throw new Error("Invalid connection.");
  const value = options as ConnectOptions;
  if (
    typeof value.ticket !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) ||
    value.mode !== mode ||
    value.target !== (creating ? "create" : roomId)
  )
    throw new Error("Invalid connection.");
  // dev HTTP 예외는 서버 설정과 이후 Spring 신원이 모두 허용할 때만 성립한다.
  if (
    config.allowDevHttp &&
    value.key === undefined &&
    value.signature === undefined
  )
    return { value, thumbprint: "dev-http" };
  if (
    typeof value.signature !== "string" ||
    value.signature.length !== 86 ||
    !value.key ||
    value.key.kty !== "EC" ||
    value.key.crv !== "P-256" ||
    value.key.d ||
    typeof value.key.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.key.x) ||
    typeof value.key.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.key.y)
  )
    throw new Error("Invalid connection.");
  const publicKey = { crv: "P-256", kty: "EC", x: value.key.x, y: value.key.y };
  const thumbprint = createHash("sha256")
    .update(JSON.stringify(publicKey))
    .digest("base64url");
  const key = await webcrypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(value.signature, "base64url"),
    Buffer.from(
      connectionMessage(value.ticket, mode, value.target, config.origin),
    ),
  );
  if (!valid) throw new Error("Invalid connection.");
  return { value, thumbprint };
}

export async function authenticate(
  options: unknown,
  roomId: string,
  mode: Mode,
  creating: boolean,
): Promise<Identity> {
  const { value, thumbprint } = await verifyConnection(
    options,
    roomId,
    mode,
    creating,
  );
  const identity = await backend<Identity>("consume", { ticket: value.ticket });
  if (
    !Number.isSafeInteger(identity.userId) ||
    identity.userId <= 0 ||
    identity.browserKey !== thumbprint ||
    identity.origin !== config.origin ||
    identity.mode !== mode ||
    typeof identity.nickname !== "string" ||
    typeof identity.proofRequired !== "boolean" ||
    (!identity.proofRequired &&
      (!config.allowDevHttp || thumbprint !== "dev-http")) ||
    (identity.proofRequired && thumbprint === "dev-http")
    // 클라이언트 options의 플래그를 믿지 않고 인증 서버가 티켓에 기록한 정확한 방만 허용한다.
    || (identity.invitedRoomCode != null &&
      (creating || mode !== "COOP" || identity.invitedRoomCode !== roomId))
  )
    throw new Error("Invalid connection.");
  return identity;
}
