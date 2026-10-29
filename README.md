# Playground Game

Colyseus 기반의 Node.js 슈팅 전투 서버다. Node.js 24.13 이상을 사용하며 로컬 기본 포트는 8082다. front(3000)·back(8080)·chat(8081)과 함께 실행한다.

## 공유 코드 통합

기존 루트의 `packages/shooting-shared`는 이 프로젝트의 `packages/shooting-shared`로 통합했다. 별도 서버가 아니라 무기·강화·자동 성장·맵 규칙, 게임 상태 타입, 접속 증명 메시지를 front와 game이 함께 사용하는 순수 TypeScript 패키지다. 공유 코드에는 서버 전용 비밀값을 넣지 않는다.

- game: `file:./packages/shooting-shared`
- front: `file:../../game/playground/packages/shooting-shared`

front와 game에서 각각 `npm ci`를 실행하면 같은 소스가 연결된다. 공유 패키지 자체를 별도로 실행하거나 설치하지 않는다.

## 다른 PC에서 로컬 실행

1. `front/playground`, `back/playground`, `back/chat`, `game/playground` 구조로 복사한다. 공유 패키지는 game 프로젝트 내부에 포함한다.
2. `.env.example`을 `.env`로 복사한다. 이미 실제 `.env`가 있으면 기존 값을 유지한다.
3. `.env`의 `GAME_SERVICE_SECRET`을 새로 생성한 32바이트 Base64 값으로 채우고, back의 `game.shooting.service-secret`에도 같은 값을 넣는다.
4. `APP_ENV=local`, `APP_ORIGIN=http://localhost:3000`, `GAME_BACKEND_ORIGIN=http://localhost:8080`, `PORT=8082`를 확인한다. back의 local 설정에도 `game.shooting.enabled=true`, 같은 인증 키, `game.shooting.public-url=ws://localhost:8082`를 설정하고 local 프로필로 실행한다.
5. 다음 명령을 실행한다.

```powershell
npm ci
npm run dev
```

키 생성:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

실제 `.env`와 `node_modules`는 Git에서 제외한다. 공유 패키지 자체에는 별도의 npm 설치가 필요 없다. 네 서버의 설정과 실행 순서는 [통합 로컬 실행 안내](../../docs/local-development.md)를 따른다.

Docker 이미지는 전체 작업 폴더를 빌드 컨텍스트로 사용한다: `docker build -f game/playground/Dockerfile -t playground-game .`. dev/prod의 게임 포트는 기존 9083을 유지하며 실행 환경변수로 지정한다.

