# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app

# install all workspace deps (devDeps included for tsc)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/connector/package.json packages/connector/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY scripts ./scripts
RUN pnpm run build

# ---------- runtime stage ----------
FROM node:24-slim
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/connector/package.json packages/connector/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build /app/packages/connector/dist ./packages/connector/dist

# SQLite data lives here (mount a volume to persist)
ENV DB_PATH=/data/kimi-gate.db
VOLUME /data

EXPOSE 3000
USER node
CMD ["node", "packages/gateway/dist/index.js"]
