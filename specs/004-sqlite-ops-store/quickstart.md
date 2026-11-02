# Quickstart: SQLite Ops Store

Validation guide for [spec.md](spec.md). Details live in
[contracts/ops-store.md](contracts/ops-store.md), [contracts/agent-tools.md](contracts/agent-tools.md),
and [data-model.md](data-model.md).

## Prerequisites

- Node.js 22.13 or newer: `node -p "process.versions.node + ' sqlite ' + process.versions.sqlite"`
- `npm install` done. There is no new dependency, and `sequelize` is removed.
- An `.env` with the OpenRouter key, for the live steps (5 and 6) only. Both are run by hand.

## 1. Gates

```bash
npm run typecheck
npm test
```

Expected: both green. The store tests run on `":memory:"`, and `data/opspilot.db` is not created
or changed by the suite (SC-005).

## 2. Schema and seed on a fresh file (US1, SC-002)

```bash
OPSPILOT_DB=./data/qs.db npm run seed
sqlite3 ./data/qs.db "SELECT (SELECT count(*) FROM services), (SELECT count(*) FROM alerts), (SELECT count(*) FROM runbooks), (SELECT count(*) FROM incidents)"
```

Expected: `6|7|3|0`. Run `npm run seed` again and the counts are the same.

`npm run seed` is the explicit reset (FR-004a): it deletes every incident and restores seeded
records. Opening the store (for example `npm run dev`) only adds missing seed rows (FR-004).

If the `sqlite3` CLI is not installed, use `node -e` with `DatabaseSync` for the same query.

## 3. CHECK constraints (FR-007, SC-003)

```bash
sqlite3 ./data/qs.db "INSERT INTO alerts VALUES ('ALT-X','t','checkout-api','urgent','firing','2026-11-02T00:00:00Z')"
sqlite3 ./data/qs.db "UPDATE services SET tier = 4 WHERE name = 'search-api'"
```

Expected: both fail with `CHECK constraint failed`.

## 4. Survives a restart (US1, SC-001)

Covered by the file-backed test in `src/store/sqlite-ops-store.test.ts`. It uses a temporary
directory, opens an incident, closes the store, reopens it, and expects the same id and status and
`INC-002` next. To check by hand, use step 5, stop the server, start it again, and ask again.

## 5. Live copilot (US2, US3, SC-004; manual)

```bash
OPSPILOT_DB=./data/qs.db npm run dev
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Open a sev2 incident for the checkout latency alert","reflect":false}'
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"Which incidents are open?","reflect":false}'
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"message":"How do I handle the checkout alert?","reflect":false}'
```

Expected:

- the second answer lists `INC-001` without asking for an id;
- the third answer gives the checkout runbook steps;
- after a server restart, the second question still returns `INC-001`.

## 6. Bench stays isolated (US5, SC-005; manual)

The bench calls the live model, so it needs the `.env` key and spends tokens. Run it yourself.

```bash
shasum ./data/opspilot.db 2>/dev/null; npm run bench; shasum ./data/opspilot.db 2>/dev/null
```

Expected: the two hashes are equal, or the file is absent both times.

## Cleanup

```bash
rm -f ./data/qs.db
```

`data/` is git-ignored, so `git status` shows no database file.
