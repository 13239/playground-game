/** 인증되지 않은 기본 키나 임의 공개 Origin으로 게임 서버가 실행되지 않게 시작 시 확인한다. */
function configuration() {
  const origin = new URL(process.env.APP_ORIGIN ?? "http://localhost:3000");
  const backend = new URL(
    process.env.GAME_BACKEND_ORIGIN ?? "http://localhost:8080",
  );
  const secret = process.env.GAME_SERVICE_SECRET ?? "";
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32 || key.toString("base64") !== secret)
    throw new Error(
      "GAME_SERVICE_SECRET must be a dedicated 32-byte Base64 key.",
    );
  if (
    ![origin, backend].every(
      (url) =>
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
    )
  )
    throw new Error("Game service origins are invalid.");
  // 로컬 기본 포트는 back(8080)·chat(8081) 다음인 8082이며 배포 포트는 환경변수로 지정한다.
  const port = Number(process.env.PORT ?? 8082),
    maxRooms = Number(process.env.GAME_MAX_ROOMS ?? 128);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isInteger(maxRooms) ||
    maxRooms < 1 ||
    maxRooms > 4096
  )
    throw new Error("Game service limits are invalid.");
  const environment =
    process.env.APP_ENV ??
    (process.env.NODE_ENV === "production" ? "prod" : "local");
  return {
    origin: origin.origin,
    backend: backend.origin,
    key,
    port,
    maxRooms,
    allowDevHttp: environment === "dev" && origin.protocol === "http:",
  };
}
export const config = configuration();
