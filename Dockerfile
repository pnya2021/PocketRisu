# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .
COPY .npmrc .

RUN corepack enable
RUN corepack install --global pnpm@10.34.1

# ------------------------------------------------------------------------------------------

FROM base AS deps
# better-sqlite3 requires native build tools on Node 24
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
# dist/ is prebuilt in the builder stage, so the runtime image only needs the
# server's runtime dependency closure (~40MB) — not the full prod
# node_modules (~1GB). The dependency list and its lockfile are committed at
# scripts/portable/server-deps/; regenerating verifies the committed list
# still matches what the server actually requires, and the frozen install
# keeps transitive versions reproducible.
COPY server ./server
COPY scripts/portable ./scripts/portable
COPY scripts/updater.cjs ./scripts/updater.cjs
RUN node scripts/portable/gen-server-deps.cjs . /tmp/server-deps-check \
    && cmp /tmp/server-deps-check/package.json scripts/portable/server-deps/package.json \
    && mkdir server-deps \
    && cp scripts/portable/server-deps/package.json scripts/portable/server-deps/pnpm-lock.yaml server-deps/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store cd server-deps && pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM deps AS builder
COPY . .
# Install including dev deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm build

# ------------------------------------------------------------------------------------------

FROM base AS runtime
ARG TARGETARCH
WORKDIR /app

# Install cloudflared for remote access tunnel support
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
       -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
COPY --from=deps /app/server-deps/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 6001

CMD ["pnpm", "runserver"]

# ------------------------------------------------------------------------------------------
