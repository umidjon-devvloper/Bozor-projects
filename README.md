# Bozorlar — Backend

Marketplace ecosystem for Uzbekistan's traditional bazaars.
Design documentation lives in `docs/`; **`docs/DECISIONS.md` is authoritative**. If code
contradicts an ADR, the code is wrong.

## Requirements
Node 22 LTS · pnpm 9 · Docker

## Getting started

```bash
pnpm install
pnpm infra:up                      # mongo (replica set rs0), redis, typesense, minio
cp .env.example .env
pnpm --filter @bozorlar/api keys:generate
pnpm dev
```

The API listens on `http://localhost:4000`. Health: `GET /health/ready`.

> MongoDB **must** run as a replica set, even locally. Multi-document transactions do not
> exist without one, and every money path in this system is transactional (ADR-0001). The
> API refuses to start otherwise, with instructions.

## Layout
```
apps/api        REST API (modular monolith)
apps/worker     outbox relay, queues, crons
packages/*      contracts (zod), money, errors, config, logger, types, testing
```

## Commands
| Command | Purpose |
|---|---|
| `pnpm dev` | Run all apps in watch mode |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm lint` | ESLint, including the money-as-number rule |
| `pnpm boundaries` | Enforce module boundaries (ADR-0011) |
| `pnpm test` | Unit tests |
| `pnpm test:int` | Integration tests against a real replica set |

## Conventions that are enforced, not suggested
1. Money is `Int64` tiyin; quantity is `Int64` milli-units. Never `number` (ADR-0004, ADR-0025).
2. Mongoose models never leave the repository layer (ADR-0011).
3. Cross-module imports go through `module/index.ts` only.
4. Every state change writes to the outbox inside its transaction (ADR-0012).
5. Validation happens at three layers: Zod, Mongoose, MongoDB `$jsonSchema` (ADR-0026).

CI fails on violations of 1–3. They are not review comments.
