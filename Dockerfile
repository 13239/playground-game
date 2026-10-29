# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app/game/playground
# Node 24의 TypeScript 실행을 사용하고 잠금 파일대로 운영 의존성만 설치한다.
COPY game/playground/packages ./packages
COPY game/playground/package.json game/playground/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app/game/playground
ENV NODE_ENV=production PORT=9083
COPY --from=dependencies --chown=node:node /app /app
COPY --chown=node:node game/playground/src ./src
USER node
EXPOSE 9083
# 인증 비밀값·공개 주소는 실행 환경에서 주입한다.
CMD ["node", "src/index.ts"]
