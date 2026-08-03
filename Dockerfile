FROM docker.io/oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
USER bun
EXPOSE 8787
ENTRYPOINT ["bun", "src/index.ts"]
