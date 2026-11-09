FROM node:24-slim AS base
RUN npm install -g pnpm@11.13.1
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node assets ./assets
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
# Migrations run first; a failed migration exits non-zero and blocks the deploy.
# Concurrent replicas serialise on a Postgres advisory lock.
CMD ["sh", "-c", "node dist/database/migrate.js && exec node dist/main.js"]
