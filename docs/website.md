# diskpush.com

The marketing and documentation site. Next.js App Router, server components
throughout, no client JavaScript of its own.

## Architecture

- Static and server-rendered. Every page, including the docs, is readable with
  JavaScript disabled.
- Docs are read from this repository's `docs/*.md` at build time by
  `apps/web/lib/docs.ts`, which also rewrites inter-document links so
  `defaults.md` resolves to `/docs/defaults`. There is no second copy of the
  documentation, so the site cannot drift from the product.
- Release metadata is fetched server-side and normalised in
  `apps/web/lib/releases.ts`, cached for an hour. No database. A repository
  with no tagged release yet degrades to "not yet published" rather than an
  error.
- `/api/releases/latest` exposes that normalised shape so the download UI never
  has to know GitHub's response format.

## Deployment

Railway, in the shared **Profullstack, Inc.** project, service `diskpush-web`.

```bash
railway link -w "Profullstack, Inc." -p "Profullstack, Inc." -e production
railway service link diskpush-web
railway up
```

### Build configuration lives in Railway, not in this repo

Railway builds with **Railpack**, which reads three service variables. They are
set on the service and are **not** in version control, so they are recorded
here — a service recreated without them will fail to build:

```text
RAILPACK_INSTALL_CMD = pnpm install --frozen-lockfile --prod=false --filter @diskpush/web...
RAILPACK_BUILD_CMD   = pnpm --filter @diskpush/web build
RAILPACK_START_CMD   = pnpm --filter @diskpush/web start
```

Three things those commands are doing deliberately:

- **`--filter @diskpush/web...`** keeps the install to the site and its
  dependencies. A full workspace install would download Electron, which the
  website has no use for.
- **`--prod=false`** is required because Railway sets `NODE_ENV=production`,
  under which pnpm would skip devDependencies — and TypeScript and Tailwind,
  which the build needs, are devDependencies.
- **The build runs from the repository root**, not from `apps/web`. Setting a
  service root directory would break the docs pages, which read `../../docs`.

`.nvmrc` pins Node 24; `engines.node` is a range and not something a builder
can pin to.

`.railwayignore` keeps `node_modules` and build output out of the upload.

### Config as code

Railway deprecated `railway.json` in favour of `.railway/railway.ts`
(existing files work until 2026-12-01). The migration is **not** applied here:
`railway config migrate` generates a file describing the whole project's
resources, and this is a shared project that also runs other production
services. Applying it risks pruning services this repository did not create.
The Railpack variables above are service-scoped and carry no such risk.

## The installer

`/install.sh` is a route, not a static file: it reads the repository's own
`scripts/install.sh` and rewrites the site URL baked into it to this
deployment's. So the script people pipe into a shell is the one in version
control that they can read on GitHub, and an installer served from a preview
installs from that preview rather than silently from production.

It is `force-static`, so the read happens at build time and
`outputFileTracingIncludes` carries the script into the deployment.

## Custom domain

`diskpush.com` and `www.diskpush.com` are attached and serving.

DNS is at Porkbun. The apex is an **ALIAS** rather than a CNAME, because a
CNAME cannot coexist with the other records at a zone apex; `www` is an
ordinary CNAME, which also has to exist explicitly because the zone has a
`*.diskpush.com` wildcard that would otherwise keep sending it to the parking
page. Both have a `_railway-verify` TXT beside them.

The MX records for Porkbun's email forwarding and the SPF record were left
alone; repointing the apex must not take the domain's mail with it.
