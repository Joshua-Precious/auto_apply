FROM oven/bun:1.4.2 AS client
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
COPY docs ./docs
RUN bunx vite build --config web/vite.config.ts

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=client --chown=bun:bun /app/dist/web ./dist/web
# Built on the host with `bun run build`; the Cequre CLI is not shipped in the image.
COPY --chown=bun:bun dist/server/server.js ./dist/server/server.js
USER bun
ENV HOST=0.0.0.0 PORT=4310 ENABLE_LOCAL_DEMO=false
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "const r=await fetch('http://127.0.0.1:4310/v1/health');process.exit(r.ok?0:1)"
CMD ["bun", "dist/server/server.js"]
