import { Server, WebSocketTransport, matchMaker } from "colyseus";
import { config } from "./config.ts";
import { ShootingRoom } from "./rooms/shooting-room.ts";

// 게임 인증은 일회용 참가권을 사용하며 정확한 사이트 Origin 한 곳만 허용한다.
matchMaker.controller.DEFAULT_CORS_HEADERS["Access-Control-Allow-Origin"] =
  config.origin;
matchMaker.controller.DEFAULT_CORS_HEADERS["Access-Control-Allow-Credentials"] =
  "false";
matchMaker.controller.getCorsHeaders = () => ({
  "Access-Control-Allow-Origin": config.origin,
  Vary: "Origin",
});
matchMaker.controller.exposedMethods = ["create", "joinById", "reconnect"];

const server = new Server({
  greet: false,
  devMode: false,
  transport: new WebSocketTransport({
    maxPayload: 8192,
    perMessageDeflate: false,
    pingInterval: 4000,
    pingMaxRetries: 2,
    beforeUpgrade: (request) =>
      request.headers.get("origin") === config.origin
        ? undefined
        : new Response(null, { status: 403 }),
  }),
  express: (app) => {
    app.disable("x-powered-by");
    app.get("/healthz", (_request, response) =>
      response
        .setHeader("Cache-Control", "no-store")
        .json({ status: "ok", service: "playground-game" }),
    );
    app.use((_request, response) =>
      response.status(404).json({ message: "Not found" }),
    );
  },
});
server.define("shooting", ShootingRoom);
await server.listen(config.port, "0.0.0.0");
console.info(`Playground game server is listening on ${config.port}.`);
