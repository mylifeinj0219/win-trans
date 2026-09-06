# canvas(node-canvas)는 네이티브 애드온이라 빌드 시점에 헤더/컴파일러가,
# 실행 시점에는 공유 라이브러리(libcairo 등)가 각각 필요해서 빌드/런타임 스테이지를 분리한다.
#
# Node 버전은 로컬 개발 환경(v24)과 동일하게 맞춘다 — 이전에 node:20-bookworm-slim으로
# Cloud Run에 배포했을 때 streamingRecognize에서만 "12 UNIMPLEMENTED: GRPC target
# method can't be resolved" 에러가 재현됐고(@grpc/grpc-js, google-gax 버전은 로컬과
# 완전히 동일했음), 로컬(Node 24)에서는 동일 코드/자격증명으로 정상 동작을 확인했다.
# Node 20 vs 24의 내장 http2 구현 차이가 원인일 가능성이 높아 보여 버전을 맞춰 검증한다.
FROM node:24-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

# Cloud Run은 PORT 환경변수(기본 8080)로 리스닝 포트를 지정한다 — server.js가 이미
# process.env.PORT를 읽어서 바인딩하므로 별도 코드 수정 없이 그대로 동작한다.
EXPOSE 8080

CMD ["node", "server.js"]
