FROM node:24-bookworm-slim

ARG CODEX_VERSION=latest
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --uid 10001 gateway

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY openapi.yaml README.md ./

RUN mkdir -p /workspace /home/gateway/.codex /data \
    && chown -R gateway:gateway /app /workspace /home/gateway/.codex /data

USER gateway
ENV HOST=0.0.0.0 \
    PORT=4317 \
    CODEX_ALLOWED_ROOTS=/workspace \
    CODEX_HOME=/home/gateway/.codex \
    CODEX_TRACE_FILE=/data/traces.json

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
