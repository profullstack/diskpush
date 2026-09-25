FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067

ENTRYPOINT ["/bin/bash", "-l", "-c"]
WORKDIR /app/


COPY .nixpacks/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix .nixpacks/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix
RUN nix-env -if .nixpacks/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix && nix-collect-garbage -d


ARG CI NIXPACKS_METADATA NODE_ENV NPM_CONFIG_PRODUCTION
ENV CI=$CI NIXPACKS_METADATA=$NIXPACKS_METADATA NODE_ENV=$NODE_ENV NPM_CONFIG_PRODUCTION=$NPM_CONFIG_PRODUCTION

# setup phase
# noop

# install phase
ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH
COPY . /app/.
RUN --mount=type=cache,id=8nFwAs26cBU-/root/local/share/pnpm/store/v3,target=/root/.local/share/pnpm/store/v3 npm install -g corepack@0.36.0 && corepack enable
RUN --mount=type=cache,id=8nFwAs26cBU-/root/local/share/pnpm/store/v3,target=/root/.local/share/pnpm/store/v3 pnpm install --frozen-lockfile --prod=false --filter @diskpush/web...

# build phase
COPY . /app/.
RUN --mount=type=cache,id=8nFwAs26cBU-apps/desktop/next/cache,target=/app/apps/desktop/.next/cache --mount=type=cache,id=8nFwAs26cBU-apps/web/next/cache,target=/app/apps/web/.next/cache --mount=type=cache,id=8nFwAs26cBU-node_modules/cache,target=/app/node_modules/.cache pnpm --filter @diskpush/web build


RUN printf '\nPATH=/app/node_modules/.bin:$PATH' >> /root/.profile


# start
COPY . /app

CMD ["pnpm --filter @diskpush/web start"]

