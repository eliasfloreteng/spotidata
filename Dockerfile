# syntax=docker/dockerfile:1

# rbxport's analysis, as the `rbx-analyse` binary the analysis chain runs. Its
# own stage, fed only analyser/, so a change to the app never rebuilds it. The
# same Debian as oven/bun:1 (trixie), so the binary finds the glibc it was
# linked against.
FROM rust:1-trixie AS analyser
WORKDIR /src
COPY analyser/ ./
# The Pi has little memory to spare: two jobs, and caches between builds.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    CARGO_BUILD_JOBS=2 cargo build --release --locked \
    && cp target/release/rbx-analyse /rbx-analyse

# Bun runs both the build and the adapter-node server. Dev dependencies stay in
# the final image on purpose: drizzle-kit owns the migrations that run on every
# container start, and it is a devDependency.
FROM oven/bun:1

WORKDIR /app

COPY --from=analyser /rbx-analyse /usr/local/bin/rbx-analyse

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
