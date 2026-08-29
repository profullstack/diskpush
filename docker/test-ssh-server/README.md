# Test SSH server

An OpenSSH + rsync container for the integration tests. Two instances run, so a
direct server-to-server transfer has two real hosts to move data between.

```bash
ssh-keygen -t ed25519 -N '' -f test_key
docker compose up -d --build
```

Then:

```bash
DISKPUSH_TEST_SSH=1 \
DISKPUSH_TEST_SSH_HOST=localhost \
DISKPUSH_TEST_SSH_PORT=2222 \
DISKPUSH_TEST_SSH_USER=diskpush \
DISKPUSH_TEST_SSH_KEY=$PWD/test_key \
pnpm vitest run tests/integration
```

Without `DISKPUSH_TEST_SSH=1` the integration suite skips itself, so a checkout
with no Docker still runs green. The unit tests and the live rsync tests in
`tests/live` need neither Docker nor a network and always run.

`test_key` is generated locally and is gitignored. It is a throwaway key for a
throwaway container; do not reuse it for anything.
