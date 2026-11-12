FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/*.tgz ./vendor/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src/ ./src/

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
USER node
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz', { signal: AbortSignal.timeout(3000) }).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
