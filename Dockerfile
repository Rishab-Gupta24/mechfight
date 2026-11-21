# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, and the map at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY mechfight.ts map.ts brain.ts bot.ts package.json ./
ENTRYPOINT ["bun", "/bot/bot.ts"]
