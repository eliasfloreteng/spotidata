# syntax=docker/dockerfile:1

# Two images from one file. The default target is the app (SvelteKit, its
# Graphile Worker and the migrations). `--target engine` is Deckhand's engine
# (engine/), the stack's second service. The engine's stages read only
# engine/, so a change to the app never rebuilds it.

# ------------------------------------------------------------------- engine

FROM rust:1-bookworm AS engine-build
WORKDIR /src
COPY engine/ ./
# The Pi has little memory to spare: two jobs, and caches between builds.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    CARGO_BUILD_JOBS=2 cargo build --release --locked -p deckhand-server \
    && cp target/release/deckhand-server /deckhand-server

FROM debian:bookworm-slim AS engine
# ffmpeg decrypts Amazon's encrypted MP4 downloads into FLAC.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=engine-build /deckhand-server /usr/local/bin/deckhand-server
ENV DECKHAND_MUSIC=/music DECKHAND_DATA=/data DECKHAND_BIND=0.0.0.0:8080
EXPOSE 8080
# Traefik routes to the container only once it is healthy: check every two
# seconds while it starts, so a deploy is a few seconds without the engine
# rather than the first minute.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --start-interval=2s \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
CMD ["deckhand-server"]

# ---------------------------------------------------------------------- app

# Bun runs both the build and the adapter-node server. Dev dependencies stay in
# the final image on purpose: drizzle-kit owns the migrations that run on every
# container start, and it is a devDependency.
FROM oven/bun:1 AS app

WORKDIR /app

# `prepare` runs svelte-kit sync, which needs the source tree — skip it here and
# run it explicitly once the source is in place.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
# SvelteKit loads `src/lib/server` while building, and config.ts throws on a
# missing variable — hand it throwaway values. Nothing here reaches the image:
# the real values arrive from the environment at run time.
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    SPOTIFY_CLIENT_ID=build \
    SPOTIFY_CLIENT_SECRET=build \
    SPOTIFY_REDIRECT_URI=http://127.0.0.1/auth/callback \
    sh -c 'bun run prepare && bun run build'

ENV NODE_ENV=production
ENV PORT=3000
# adapter-node caps a request body at 512 KB, which rejects a ~500 MB streaming
# history upload before the handler runs. The route enforces its own ceiling
# (HISTORY_MAX_UPLOAD_MB) against the bytes that actually arrive.
ENV BODY_SIZE_LIMIT=Infinity
EXPOSE 3000

# Every migration step is idempotent (CREATE OR REPLACE / IF NOT EXISTS, and
# drizzle's own journal), so re-running it on each start is safe and keeps a
# deploy from needing a separate migration pass.
CMD ["sh", "-c", "bun run db:migrate && exec bun --bun ./build/index.js"]
