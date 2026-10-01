# syntax=docker/dockerfile:1
#
# diskpush.com on dev2. Hand-written: do NOT regenerate with nixpacks.
# dev2's compose (cli-tools dev2-site) builds this exact path, so it stays here.
#
# The build is unchanged from the nixpacks image: Node 24 + pnpm, installing
# only @diskpush/web and its deps from pnpm-lock.yaml. The monorepo stays on
# pnpm because the CLI and desktop releases are built and published with it.
# Only the runtime moves: Next's standalone server runs under Bun, with no
# Node in the final image.

FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@11.18.0
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 CI=true
RUN --mount=type=cache,id=diskpush-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod=false --filter @diskpush/web...
RUN pnpm --filter @diskpush/web build

FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Docker sets HOSTNAME to the container id, and standalone binds to it literally.
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/apps/web/.next/standalone ./
COPY --from=build --chown=bun:bun /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=bun:bun /app/apps/web/public ./apps/web/public
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/web/server.js"]
