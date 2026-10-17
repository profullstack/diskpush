# ThreatCrush scan

[![ThreatCrush: verified](https://img.shields.io/badge/ThreatCrush-verified%20safe-brightgreen)](threatcrush-scan.md)

DiskPush is scanned with [ThreatCrush](https://threatcrush.com) on every push
and pull request (`.github/workflows/threatcrush.yml`). The badge means exactly
what those gates enforce:

| Scope | Gate | Result (ThreatCrush 0.13.32, 2026-10-17) |
| --- | --- | --- |
| `packages/plugin-dbbackup`, with `--deps` (OSV.dev advisories) | no critical, high or medium | **0 critical · 0 high · 0 medium** · 16 low · 0 dependency advisories |
| `packages/s3-core`, with `--deps` | no critical, high or medium | **0 critical · 0 high · 0 medium** · 3 low · 0 dependency advisories |
| the whole repository | no critical | **0 critical** · 1 high · 3 medium · 20 low |

Nothing is suppressed: there is no `.threatcrushignore` and no
`threatcrush-disable` comment in the tree. Every finding below the gates was
read, and none is a vulnerability. (A local scan after a build also reports
findings in `apps/desktop/dist-electron/`: that is gitignored build output,
which CI never has.)

Reproduce:

```bash
npm install -g --ignore-scripts @profullstack/threatcrush@0.13.32
threatcrush scan packages/plugin-dbbackup --deps --fail-on critical,high,medium
threatcrush scan packages/s3-core --deps --fail-on critical,high,medium
threatcrush scan . --fail-on critical
```

## Findings, and why each is not a vulnerability

**`secret-database-url`, 16 × low, `packages/plugin-dbbackup/src/plugin.test.ts`.**
Postgres and MySQL connection strings in the plugin's tests, written with a
one-letter user, password and host. They are fixtures for the URL parser and
the dump argv: the hosts do not exist or are the test's own, and the passwords
are placeholders. ThreatCrush already reports them at low because they are in
a test file.

**`secret-aws-access-key`, 3 × low, `packages/s3-core/src/s3.test.ts`.**
The access key id and secret from AWS's own Signature Version 4 documentation
(the ones ending in `EXAMPLE` and `EXAMPLEKEY`), used as a known-answer test:
DiskPush's signer must produce the exact signature AWS publishes for them.
They are public, and belong to no account.

**`js-ssrf-outbound-request`, high, `packages/plugin-mediaanalyzer/src/fake-server.fixture.ts:112`.**
The fake MediaAnalyzer OAuth server used by the tests follows the loopback
`redirect_uri` the test itself created. It is test code (`*.fixture.ts`), never
shipped, and only ever talks to `127.0.0.1`. ThreatCrush's test-path rule
recognises `*.test.ts` and `fixtures/`, not the `.fixture.ts` suffix, which is
why it is reported at full severity; that is a scanner fix, not a code one.

**`js-unescaped-html-sink`, 2 × medium + 1 × low, `apps/web/app/page.tsx`, `apps/web/app/security/page.tsx`, `apps/web/app/docs/[slug]/page.tsx`.**
The site's JSON-LD block (`JSON.stringify` of constants in the file) and the
documentation pages, whose HTML is rendered at build time from this
repository's own Markdown. No user input reaches either.

**`sql-template-interpolation`, medium, `packages/database/src/store.ts:265`.**
The job-update statement interpolates its `SET` list, which is built from a
fixed map of column names, each written as `column = ?`; every value is a
bound parameter.
