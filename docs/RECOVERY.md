# Repository Recovery — 2026-07-25

The working tree of this repository was lost. What survived was twelve ZIP archives of files
that had been presented for download during the build sessions, with **all directory paths
stripped**. This document records what was recovered, what had to be written, and what is
unverified, so that nothing here is later mistaken for original work.

## What was recovered

292 distinct files, deduplicated from 351 archive entries. Seven basenames referred to more
than one real file — `index.ts` (15), `schemas.ts` (13), `events.ts` (6), `mappers.ts` (6),
`constants.ts` (3), `main.ts` (2), `ledgerPorts.ts` (2) — and were separated by content hash
before anything was moved.

Paths were reconstructed from the import graph, not from convention: module barrels name
their own children, controllers name their siblings, tests name their targets through
`../../src/...`, and five entries kept full paths inside the archives. Of the 560 relative
imports in the restored tree, 548 resolved on the first attempt; the twelve that did not were
files genuinely absent from the archives, listed below.

All thirteen modules survived complete at every layer, along with eleven migrations, the
contracts package, and every test file.

## What was written during recovery

### Configuration (expected — none of it was in the archives)
`pnpm-workspace.yaml`, `turbo.json`, root `tsconfig.json`, thirteen package manifests and
their `tsconfig.json` files, `apps/api/tsconfig.test.json`, the two vitest configs and
`vitest.setup.ts`, `.env.test`, `migrate-mongo-config.cjs`, `.gitignore`, `.npmrc`,
`.prettierrc`, `commitlint.config.cjs`, `vitest.workspace.ts`.

Package dependencies were derived from the imports each package actually makes. Versions are
**not** the original ones — the lockfile could not be recovered and has been regenerated.

### Source files that had to be authored
Thirteen are pure re-export barrels, entirely determined by their consumers:
`packages/{types,errors,money,config,logger,domain,contracts,storage}/src/index.ts`,
`packages/notifications/src/providers/index.ts`, and
`apps/api/src/modules/{authz,audit,outbox,platform}/index.ts`.

Four carry real content and are marked `RECONSTRUCTED during repository recovery` in the file:

| File | Basis | Confidence |
|---|---|---|
| `apps/api/src/shared/asyncHandler.ts` | 13 call sites | High — behaviour fully constrained |
| `apps/api/src/shared/express.ts` | `sessionService.resolve` constructs `AuthContext`; `policies.ts` reads it; the `Request` fields were derived from typecheck failures | High |
| `apps/api/src/modules/{identity,catalog,orders}/events.ts` | Constant names proved by call sites; most wire strings proved by subscribers | High, with five exceptions below |
| `packages/testing/src/mongo.ts` | Three functions and signatures proved by seven integration suites | Medium — implementation is new |
| `apps/api/src/modules/platform/config.routes.ts` | `app.ts` proves the name, signature and mount point only | **Low — payload is unverified** |

**Five event wire strings have no subscriber and could not be proved:** `order.preparing`,
`order.picked_up`, `order.adjustment_approved`, `user.registered`, `user.phone_verified`.
They follow the `domain.snake_case` convention of every surviving events file. Nothing
consumes them today, so they are not load-bearing — but they are guesses.

## Changes to recovered files

Three, all type-level, none behavioural:

1. `.eslintrc.cjs` — `parserOptions.project: ['./tsconfig.base.json']` replaced with
   `projectService: true`, and `tsconfigRootDir` added. The base file is settings-only with
   no `include`, so it is not a real TypeScript program; type-aware rules were resolving most
   imports to `any` against it.
2. `apps/api/tests/integration/media.test.ts` — a cast on `withExif`. sharp writes any EXIF
   IFD at runtime but its published `Exif` type lists only IFD0–3.
3. `apps/api/tests/integration/orders.test.ts` — `body: object` instead of `body: unknown`,
   because supertest's `send` is typed `string | object`. Every call site already passed an
   object.

Items 2 and 3 imply the original `typecheck` did **not** cover `tests/`. This restore
typechecks source and tests separately, which is stricter than what existed before.

## Verification

- `pnpm install` — clean; lockfile regenerated
- `pnpm build` — all 12 packages compile
- `pnpm typecheck` — **26/26 turbo tasks pass** under `strict`, `noUncheckedIndexedAccess`
  and `exactOptionalPropertyTypes`
- `pnpm test` — **276/276 unit tests pass**, exactly matching the last verified count before
  the loss (257 in `apps/api`, 19 in packages)
- `pnpm test:int` — **not run.** Requires Docker for the MongoDB replica set
- `pnpm lint` — see below

## Known gaps

- **Integration tests are unverified.** They typecheck and their harness is new. Run
  `pnpm --filter @bozorlar/api test:int` on a machine with Docker before trusting them.
- **Lint is not clean.** Type-aware rules report violations across recovered source. These
  are unlikely to be regressions from the recovery — the same files typecheck clean — but
  whether the original tree ever linted clean cannot be established from the archives.
  Triage before treating any of it as new debt.
- **`config.routes.ts` payload is unverified.** Check it against the API documentation.
- **Documentation is largely lost.** Only `README.md`, `CHANGELOG.md`, `DECISIONS.md`
  (ADR-0001 to ADR-0033) and `PROJECT_STATUS.md` survived. The expanded `docs/` set —
  `DATABASE.md`, `API.md`, `ERROR_HANDLING.md`, `ROADMAP.md`, `CONVENTIONS.md`, `EVENTS.md`
  and others referenced throughout the source comments — was in archives that were never
  uploaded.
- **`PROJECT_STATUS.md` is stale below its Completed section** and was already so before the
  loss: it reports 38/38 tests, lists completed modules as not started, still blocks
  commission on B3, and names Catalog as the next step. The per-module entries are accurate;
  the summary sections are not. Repair it from `CHANGELOG.md`.
