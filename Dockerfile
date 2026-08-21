# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:24-slim AS build
WORKDIR /app

# install all workspace deps (devDeps included for tsc)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/connector/package.json packages/connector/
RUN npm ci --no-audit --no-fund

COPY packages ./packages
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build /app/packages/connector/package.json ./packages/connector/package.json
COPY --from=build /app/packages/connector/dist ./packages/connector/dist

# SQLite data lives here (mount a volume to persist)
ENV DB_PATH=/data/kimi-gate.db
VOLUME /data

EXPOSE 3000
USER node
CMD ["node", "packages/gateway/dist/index.js"]
