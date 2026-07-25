# Architecture Decision Record (ADR) Log — Bozorlar

Status values: `Accepted`, `Proposed`, `Superseded`, `Blocked-on-Business`.
Every ADR states **Context → Options → Decision → Consequences**. No decision in this
project may be made outside this file. If code contradicts an ADR, the code is wrong.

---

## ADR-0001 — Primary datastore: MongoDB (retained, with hard conditions)
**Status:** Accepted (conditional)

**Context.** This system moves money (seller wallet, commission, Payme/Click settlements).
The classic default for financial ledgers is PostgreSQL: strong constraints, `NUMERIC`,
mature transactional tooling. The declared stack is MongoDB + Mongoose. Rewriting the
stack against the team's declared skill set is itself a large risk.

**Options.**
1. Move everything to PostgreSQL.
2. Hybrid: MongoDB for catalog/content, PostgreSQL for the ledger.
3. Stay on MongoDB with strict invariants.

**Decision.** Option 3 — stay on MongoDB, **conditional on all of the following being
non-negotiable from commit #1**:
- MongoDB **replica set (3 nodes minimum)** in every environment including local dev.
  Multi-document ACID transactions require it; a standalone `mongod` cannot run them.
- All money mutations run inside `session.withTransaction()` with
  `writeConcern: { w: 'majority' }` and `readConcern: 'snapshot'`.
- Money is stored as **Int64 minor units (tiyin)** — never `Double`. See ADR-0004.
- The wallet is a **double-entry ledger**, not a mutable number. See ADR-0005.
- Every money-mutating command carries an **idempotency key** with a unique index.
- A nightly **reconciliation job** recomputes balances from the ledger and pages on drift.

Option 2 is the documented escape hatch. Because the ledger is isolated behind
`LedgerRepository`, migrating only the ledger to PostgreSQL later is a bounded, ~2-week
task. This is why the repository layer is mandatory (ADR-0011).

**Consequences.** We accept weaker schema enforcement in exchange for stack continuity,
and we buy the safety back with transactions, ledgers, idempotency, and reconciliation.
Reconciliation drift alerts are a **Sev-1 page**, not a dashboard tile.

---

## ADR-0002 — Deployment shape: modular monolith + satellite services, not microservices
**Status:** Accepted

**Context.** The goal is "millions of users." The reflex is microservices. With a small
team and zero production traffic, microservices on day one produce a distributed monolith:
the same coupling, plus network partitions, plus 8 deploy pipelines.

**Decision.** Ship **one core API deployable** (`apps/api`) containing all commerce
modules, plus **five separately deployable satellites from day one**, because each has a
genuinely different scaling, failure, and security profile:

| Deployable | Why it is separate |
|---|---|
| `apps/api` | Stateless HTTP core. Scales on request volume. |
| `apps/worker` | Queue consumers + crons. Scales on backlog depth. Must never share a process with HTTP, or a slow job eats the request pool. |
| `apps/payments-gateway` | Receives Payme/Click callbacks. Separate host, IP-allowlisted, separate rate limits. Compromise here is theft; blast radius must be contained. |
| `apps/search-indexer` | Consumes change events, writes to the search cluster. Isolated so a reindex storm cannot degrade checkout. |
| `apps/realtime` | WebSocket gateway (chat, order status). Long-lived connections have inverted resource profiles vs. REST. |

**Consequences.** We get real isolation where it matters and keep one transactional
boundary for commerce, which is exactly where distributed transactions would have hurt
most. Module boundaries are enforced in code (ADR-0011) so later extraction is mechanical.

**Extraction triggers (pre-agreed, so nobody argues later):**
- Catalog read traffic > 60% of API CPU → extract `catalog-read` service.
- Orders collection > 50M docs or p99 write > 200ms → extract `orders` service + shard.
- Any module needing an independent release cadence for 2+ consecutive sprints.

---

## ADR-0003 — Payment model: cash-on-pickup default, escrow-capable schema
**Status:** Accepted (business sign-off required)

**Context.** The original docs contradicted themselves: `ORDER_FLOW` had
Checkout → Payment → Order, while `DELIVERY_SYSTEM` said Pickup only. These imply two
completely different companies. Prepaid escrow means the platform holds client funds:
that requires a payment-agent licence posture, settlement runs, payout reconciliation,
refund liability, and fiscal receipt (OFD) integration. Cash-on-pickup means the platform
never touches buyer money and only bills sellers for commission.

**Decision.** Introduce `Order.paymentMode` as a first-class enum:
- `CASH_ON_PICKUP` — **enabled in v1**. Buyer pays the seller at the stall. Platform debits
  commission from the seller wallet on completion.
- `PREPAID_ONLINE` — schema, ledger accounts, `settlements` and `refunds` collections all
  exist from day one, but the mode is **feature-flagged off** until legal/licensing clears.

**Consequences.** v1 ships without escrow risk, and enabling escrow later is a flag flip
plus a settlement worker — not a re-architecture. The ledger chart of accounts (ADR-0005)
already contains the escrow liability accounts.

---

## ADR-0004 — Money representation: Int64 minor units
**Status:** Accepted

**Context.** IEEE-754 doubles cannot represent 0.1. Commission of 2.5% on 1 001 UZS is
25.025 UZS. Rounding must be deterministic and identical on server, web, mobile, and admin.

**Decision.**
- Storage type: **BSON Int64**, unit **tiyin** (1 UZS = 100 tiyin).
- One shared `Money` value object in `packages/money`, used by all four clients.
- Rounding: **half-up to the nearest tiyin**, applied once, at the moment a computed value
  is persisted. Never round intermediate values.
- Every monetary field carries an explicit currency: `{ amount: Long, currency: 'UZS' }`.
- Display formatting (`47 500 so'm`) lives only in the presentation layer.

**Consequences.** No float drift, no cross-client disagreement, multi-currency-ready.
Mongoose must be configured with `useBigInt64` / explicit `Long` casting; a lint rule
forbids `Number` typing on any field name matching `/amount|price|balance|total|fee/`.

---

## ADR-0005 — Wallet: double-entry ledger, balance is a projection
**Status:** Accepted

**Context.** The original spec described `wallet.balance` as a stored number decremented
per order. Under concurrency (order completion + top-up webhook + admin adjustment on the
same wallet) read-modify-write loses updates. Worse, an incorrect balance deactivates a
real merchant's shop — a business-visible failure, not a data-quality one.

**Options.** (a) Atomic `$inc` on a single field. (b) Append-only single-entry ledger.
(c) Full double-entry ledger.

**Decision.** Option (c). Every money movement writes a balanced `journal_entries`
document containing ≥2 `postings`, where `sum(debit) === sum(credit)`. Balances are
derived and cached in `ledger_accounts.balance`, updated by `$inc` **inside the same
transaction** as the journal entry.

**Chart of accounts.**
```
ASSET      platform:cash:payme, platform:cash:click
LIABILITY  seller:<sellerId>:wallet        (we owe the seller their prepaid balance)
LIABILITY  buyer:<buyerId>:escrow          (dormant until ADR-0003 PREPAID_ONLINE)
REVENUE    platform:commission
EXPENSE    platform:promo, platform:writeoff
```
A commission deduction is: **debit** `seller:X:wallet`, **credit** `platform:commission`.

**Consequences.** Every tiyin is traceable to a source document. Refunds are reversing
entries, never mutations. Accounting can be audited without reading application code.
Cost: more writes per transaction, and developers must learn debit/credit. Worth it.

---

## ADR-0006 — Variable weight and price adjustment as a first-class flow
**Status:** Accepted

**Context.** This is a **bazaar**. Goods are sold by kilogram, and the weight handed over
is never exactly the weight ordered. Every generic e-commerce order schema breaks here.
This was entirely absent from the original documentation and is, in my judgement, the
single biggest domain risk in the project.

**Decision.** Order lines carry `unit`, `orderedQty`, `confirmedQty`, `unitPrice`
(snapshot), and `tolerancePercent`. On handover the seller enters actual quantity:
- Delta within tolerance (default ±10%, per-category configurable) → auto-approved.
- Delta outside tolerance → order enters `PENDING_ADJUSTMENT`; buyer must approve or cancel.
- Commission is always calculated on the **confirmed** total, never the ordered total.

**Consequences.** Adds one state and one buyer interaction, and makes the product match
reality. Sellers who systematically over-deliver are surfaced in an abuse report.

---

## ADR-0007 — Multi-seller carts split into per-seller orders
**Status:** Accepted

**Context.** A buyer will put tomatoes from shop A and beef from shop B in one cart.
Acceptance, pickup, cancellation, commission, and reviews are all per-seller.

**Decision.** Checkout creates one `order_groups` document (the buyer-facing "order")
and N `orders` documents (one per shop). Each `orders` document has its own independent
state machine. The group has a derived, read-only aggregate status.

**Consequences.** All seller-side logic operates on a single-seller aggregate — clean.
Buyer UI must display group + children clearly. Cancellation of one child does not cancel
the group.

---

## ADR-0008 — Search: dedicated engine with Uzbek transliteration, never regex
**Status:** Accepted

**Context.** `$regex` search is a collection scan and cannot rank. Uzbek users type in
**Latin and Cyrillic interchangeably** (`pomidor` / `помидор`, `go'sht` / `гўшт`), with
apostrophe variants (`o'` / `oʻ` / `o`), and Russian names for the same goods.

**Decision.** Typesense cluster (self-hostable — see ADR-0009), fronted by a
`SearchProvider` interface so OpenSearch remains a drop-in replacement. Mandatory:
- A normalization pipeline: Latin↔Cyrillic transliteration, apostrophe folding, Russian
  synonym dictionary, all applied at **both** index and query time.
- A curated synonym set seeded with the ~300 most common bazaar goods.
- Indexing driven by the outbox → `search-indexer`, never by direct writes from the API.

**Consequences.** Search is eventually consistent (target < 2s lag). Product detail pages
always read from MongoDB, so a stale index never shows a wrong price.

---

## ADR-0009 — Hosting and data residency: Uzbekistan-resident primary data
**Status:** Accepted (requires legal confirmation)

**Context.** Uzbek personal-data legislation requires that personal data of Uzbek citizens
be processed using databases physically located in the Republic of Uzbekistan, with
operator registration. The original `DEPLOYMENT.md` specified MongoDB Atlas and Vercel;
`FILE_STORAGE.md` specified UploadThing — all foreign-hosted. **This is a legal blocker,
not a preference, and it invalidates the original deployment plan.**

**Decision.**
- **Primary MongoDB replica set, Redis, Typesense, object storage, and all backups run on
  Uzbekistan-located infrastructure** (Uzcloud / UZINFOCOM / equivalent licensed DC).
- Object storage becomes **S3-compatible (MinIO)** in-country, with `imgproxy` for
  derivatives, replacing UploadThing. UploadThing is acceptable only for non-personal
  public marketing assets, and even then is not worth a second vendor.
- Vercel may host the **public web front end only** if it stores no personal data and does
  not proxy PII; otherwise the Next.js app runs in the same Uzbek cluster. Default: run it
  in-cluster, keep Vercel as a marketing-site option.
- Anonymised, aggregated analytics may leave the country. Nothing else does.

**Action required:** written opinion from Uzbek counsel before infrastructure procurement.

---

## ADR-0010 — Container orchestration, staged
**Status:** Accepted

**Decision.** Everything is containerized from commit #1 (identical images across dev,
staging, prod). Deployment target evolves on pre-agreed triggers:
- **Phase 1 (0–50k MAU):** 3 VPS, Docker Compose, Nginx, single Mongo replica set.
- **Phase 2 (50k–500k MAU):** Kubernetes, HPA on the API, Mongo replica set with hidden
  analytics secondary, Redis Sentinel, 3-node Typesense.
- **Phase 3 (500k+ MAU):** Mongo sharded cluster (ADR-0018), multi-AZ, read replicas,
  regional CDN.

**Rationale for staging it:** k8s on day one costs weeks of setup and buys nothing at zero
traffic; containerizing on day one costs almost nothing and buys the whole path.

---

## ADR-0011 — Enforced module boundaries (modular monolith rules)
**Status:** Accepted

**Decision.** Inside `apps/api`, code is organised by **feature module**, and the following
rules are enforced by ESLint `no-restricted-imports` + `dependency-cruiser` in CI:
1. A module may import another module's **public `index.ts` only** — never its internals.
2. **Mongoose models never leave the repository layer.** Services and controllers see DTOs.
3. Controllers contain zero business logic: validate → call service → map to response.
4. Services are the only layer permitted to open a database transaction.
5. Cross-module side effects go through the **domain event bus**, never direct calls.

**Consequences.** A CI failure — not a code review comment — is what stops the monolith
from turning into a mud ball. This is the single most important sustainability control in
the project.

---

## ADR-0012 — Domain events + transactional outbox
**Status:** Accepted

**Context.** `order.completed` must trigger: commission deduction, wallet threshold check,
buyer notification, seller notification, stats update, search reindex, review prompt.
Inline, that is a 900-line god function and a slow, fragile request. Fire-and-forget
in-process events silently lose work when a pod restarts.

**Decision.** **Transactional outbox.** Domain events are written to an `outbox` collection
**inside the same MongoDB transaction** as the state change. A relay process publishes them
to BullMQ (Redis Streams). Consumers are **idempotent** and keyed by `eventId`.

**Consequences.** At-least-once delivery with no lost events and no dual-write problem.
Handlers must tolerate replay. Kafka/NATS becomes a swap of the relay target at Phase 3.

---

## ADR-0013 — Auth: short access JWT + rotating refresh with reuse detection
**Status:** Accepted

**Decision.**
- Access token: JWT, **15 min**, RS256 (asymmetric, so satellites verify without the secret).
- Refresh token: opaque 256-bit random, **stored hashed** (SHA-256), 60-day sliding TTL,
  **rotated on every use**, bound to a `deviceId`. Reuse of a consumed token revokes the
  entire token family and notifies the user — this is how stolen refresh tokens are caught.
- Web: `httpOnly; Secure; SameSite=Lax` cookies + double-submit CSRF token.
  **Never `localStorage`.** Mobile: Expo SecureStore (Keychain / Keystore).
- Roles and permissions are resolved **server-side per request from Redis**, never trusted
  from JWT claims, so a ban or role change takes effect within seconds, not 15 minutes.

---

## ADR-0014 — SMS is required; "no SMS verification" is not viable
**Status:** Accepted (reverses original spec)

**Context.** `AUTH.md` stated "No SMS verification (current version)." In Uzbekistan the
phone number is the identity and email penetration is low. Without SMS:
- **password recovery is impossible** — a locked-out seller is a churned seller;
- account takeover by phone-number squatting is trivial;
- fake seller accounts cost nothing to create.

**Decision.** Integrate a local SMS provider (Eskiz.uz / Play Mobile) with a
`SmsProvider` abstraction and a failover provider. OTP required for: registration,
password reset, phone change, and first seller payout/withdrawal. OTP is 6 digits, 5-min
TTL, max 5 attempts, rate-limited per phone **and** per IP, hashed at rest.

---

## ADR-0015 — API contract: versioned REST, Zod-generated OpenAPI
**Status:** Accepted

**Decision.** REST under `/api/v1` (four heterogeneous clients including a mobile app with
slow update adoption — gRPC/tRPC would couple releases). One **Zod schema per DTO** in
`packages/contracts` is the single source of truth; it generates the OpenAPI 3.1 spec, the
server validator, and the typed client SDK. Mandatory conventions: response envelope,
cursor pagination, `Idempotency-Key` on all unsafe money endpoints, RFC 9457 problem
details for errors, `ETag`/`If-None-Match` on catalog reads.

**Consequences.** Contract drift between four clients becomes a compile error. See `API.md`.

---

## ADR-0016 — Caching: Redis, with explicit invalidation ownership
**Status:** Accepted

**Decision.** Redis for: hot catalog reads, geo/reference data, config, rate limiting,
distributed locks, stock reservations, session/permission lookup, and BullMQ.
Rules: every cache key has **one owning module** that is responsible for invalidation;
TTL is mandatory (no infinite keys); invalidation is driven by domain events;
stampede protection via single-flight locks. Never cache authorization *decisions* — cache
the inputs.

---

## ADR-0017 — Stock reservation, not optimistic decrement
**Status:** Accepted

**Decision.** At checkout, stock is **reserved** in Redis with a TTL (default 15 min) and
mirrored to a `stock_reservations` collection for durability. Reservation converts to a
committed decrement on seller acceptance and is released on expiry, rejection, or
cancellation. Product `availableQty = stockQty − activeReservations`.

**Rationale.** Decrementing at order creation lets abandoned checkouts starve real buyers;
decrementing at completion oversells. Reservation is the only correct middle.

---

## ADR-0018 — Sharding and data lifecycle plan (Phase 3, designed now)
**Status:** Proposed — design fixed now, executed at trigger

**Decision.** Shard keys chosen so the hot path is *targeted*, never scatter-gather:
| Collection | Shard key | Reason |
|---|---|---|
| `users` | `{_id: hashed}` | Point lookups only. |
| `products` | `{shopId: 1, _id: 1}` | Seller dashboard and shop pages are targeted; category browse is served by Typesense, not Mongo. |
| `orders` | `{shopId: 1, _id: 1}` | Seller order queue is the hottest read/write path. |
| `journal_entries` | `{accountId: 1, _id: 1}` | Ledger reads are always per-account. |
| `messages` | `{chatId: 1, _id: 1}` | Always read per conversation. |

Buyer-side order history is served by an `orders_by_buyer` read model
(`{buyerId: 1, _id: 1}`) maintained by an event handler, so buyer queries stay targeted too.
Orders older than 12 months move to `orders_archive` via a rolling job; the ledger is
**never** archived or deleted.

---

## ADR-0019 — Observability is a launch requirement, not a phase-2 nicety
**Status:** Accepted

**Decision.** OpenTelemetry traces (`traceId` propagated from client through queue jobs),
`pino` structured JSON logs shipped to Loki, Prometheus + Grafana metrics, Sentry for
errors on all four clients. **Business** SLOs are alerted alongside technical ones:
ledger drift ≠ 0, commission failures, payment webhook error rate, order acceptance
timeout rate, sellers deactivated per hour.

**Rationale.** In a money system, the outage you cannot see is the expensive one. A
deploy that silently stops deducting commission is worse than a 500 page.

---

## ADR-0020 — i18n from schema level, four locales
**Status:** Accepted

**Context.** Absent from every original document. Retrofitting i18n after 40 screens exist
is one of the most expensive avoidable rewrites in this kind of project.

**Decision.** Locales: `uz-Latn` (default), `uz-Cyrl`, `ru`, `en`. User-generated and
reference content uses embedded localized objects (`{ uz: string, ru: string, en: string }`).
UI strings live in `packages/i18n` shared by web, mobile, and admin. All server error
messages are **codes**, translated by the client (see `ERROR_HANDLING.md`).
Number, date, and currency formatting via `Intl` with an explicit locale — never manual.

---

## ADR-0021 — Offline-tolerant mobile client
**Status:** Accepted

**Context.** The user is standing in a bazaar on a congested mobile network. Treating the
network as reliable will make the app feel broken to a large share of real users.

**Decision.** TanStack Query + MMKV persistence, stale-while-revalidate catalog cache,
an offline mutation queue with idempotency keys, optimistic UI on cart operations, and an
explicit offline banner. Checkout is **never** optimistic — it requires a live server quote.

---

## ADR-0022 — Configuration is data, not code
**Status:** Accepted

**Decision.** Commission rate, initial wallet balance, deactivation threshold, grace
period, reservation TTL, tolerance percent, order auto-expiry, feature flags, minimum
supported app version and maintenance mode live in a `settings` collection with an audit
trail and an admin UI, cached in Redis, hot-reloaded. Environment variables hold only
secrets and infrastructure endpoints, and are validated by Zod at boot — the process
**refuses to start** on a missing or malformed variable.

---

## ADR-0023 — Testing strategy weighted to money paths
**Status:** Accepted

**Decision.** Unit tests for pure domain logic; integration tests against a real Mongo
replica set (Testcontainers) for every repository and service; contract tests generated
from the Zod schemas; E2E (Playwright / Maestro) for the six critical journeys.
**Coverage gates:** ≥ 90% on `wallet`, `ledger`, `commission`, `orders`, `payments`;
≥ 70% elsewhere. Mandatory concurrency tests: parallel commission deduction, duplicate
payment webhook, simultaneous checkout of the last unit of stock.

---

## ADR-0024 — Trunk-based delivery with feature flags
**Status:** Accepted

**Decision.** Short-lived branches into `main`, CI gate (typecheck → lint → test →
dependency-cruiser → build → image scan), automatic deploy to staging, manual promote to
production, canary at 10% for 30 minutes with automatic rollback on SLO breach. Incomplete
features ship dark behind flags rather than living on long branches. Database migrations
are **expand → migrate → contract**, always backward compatible for one release.

---

## ADR-0025 — Quantities are integers too (milli-units)
**Status:** Accepted (extends ADR-0004)

**Context.** ADR-0004 fixed money as integer tiyin, but left quantity as a decimal. In a
bazaar most goods are weighed: `2.5 kg`, `0.375 kg`. If quantity is a `Double`, then
`lineTotal = qty × unitPrice` reintroduces exactly the float error that ADR-0004 eliminated
— on the *other* operand. Summing 20 such lines produces a total that disagrees with the
seller's own arithmetic, which is a trust failure, not a rounding curiosity.

**Decision.** Quantities are stored as **Int64 milli-units**: `qtyMilli`, where
1 kg = 1000, 1 dona = 1000. `unit.decimalPlaces` controls display and input granularity.
```
lineTotal(tiyin) = roundHalfUp(qtyMilli × unitPrice / 1000)
```
All arithmetic is integer. `packages/money` gains a `Quantity` value object alongside `Money`.

**Consequences.** No float anywhere in the commerce path. `stepQty`, `minOrderQty`,
`stockQty`, and `tolerancePercent` all follow the same representation. The lint rule from
ADR-0004 extends to any field matching `/qty|quantity|weight/`.

---

## ADR-0026 — Three layers of validation, MongoDB included
**Status:** Accepted

**Context.** Mongoose validation runs in the application. Anything that bypasses the
application — a migration script, an admin using `mongosh`, a second service written later
— bypasses every rule. In a ledger, one hand-written `updateOne` that unbalances an entry
is unrecoverable, because we would not know it happened.

**Decision.** Three layers, all mandatory:
1. **Zod** at the API boundary (`packages/contracts`) — shape, ranges, business rules.
2. **Mongoose** schemas — types, required, enums, custom validators, hooks.
3. **MongoDB `$jsonSchema` collection validators** with `validationLevel: 'strict'`,
   `validationAction: 'error'` — the database refuses malformed documents regardless of
   who is writing.

Validators are generated from the Mongoose schemas by a build step, so the two cannot drift.

**Consequences.** Slightly slower writes, meaningfully harder to corrupt. Migrations must
update the validator in the expand phase before writing new-shape documents.

---

## ADR-0027 — Time-series collections for append-only telemetry
**Status:** Accepted

**Context.** `analytics_events`, `search_logs`, and `product_price_history` are
write-heavy, never updated, and queried by time range. Storing them as ordinary collections
wastes storage and index memory that the commerce path needs.

**Decision.** Use MongoDB **time-series collections** with `metaField` and automatic
`expireAfterSeconds`. Retention: analytics 90 days raw (rollups kept indefinitely), search
logs 180 days, price history 2 years.

**Consequences.** 3–5× storage reduction and much cheaper range scans. Constraint accepted:
time-series collections do not support updates or deletes of individual documents, which is
exactly right for append-only telemetry — and exactly why the **ledger is not one**, since
it needs unique indexes and transactional participation.

---

## ADR-0028 — Money and quantity are JSON **strings** on the wire
**Status:** Accepted

**Context.** Money is `Int64` tiyin internally (ADR-0004) and quantity is `Int64`
milli-units (ADR-0025). JSON has no integer type — every number is an IEEE-754 double, and
`JSON.parse` silently truncates above 2^53. Our realistic per-order values (~10^7 tiyin) are
far below that, so numbers would work *today*. Lifetime-GMV and platform-revenue aggregates
are the values that eventually approach the boundary, and they are exactly the numbers
nobody notices are wrong.

**Options.** (a) JSON numbers, documented bound. (b) Strings everywhere. (c) Numbers for
transactional values, strings for aggregates.

**Decision.** Option (b) — **all money and quantity values are JSON strings** of the integer
minor unit: `"amount": "4500000"`, `"qty": "2500"`. Option (c) was rejected outright: a rule
that depends on which endpoint you are calling will be violated within a month.

**Consequences.** Clients must parse via `packages/money` rather than using the value
directly — which is the behaviour we want anyway, since raw tiyin should never be rendered.
Costs a little client code; removes an entire class of silent financial bug and matches the
convention used by Stripe and Payme for large integers. A lint rule forbids arithmetic on a
raw API money field outside the `Money` type.

---

## ADR-0029 — `404` rather than `403` for resources the caller cannot see
**Status:** Accepted

**Context.** Returning `403 Forbidden` for another seller's order confirms that the order
exists. Iterating IDs against a `403`/`404` boundary is a cheap enumeration oracle that
leaks order volume, user counts, and growth rate to any competitor with a script.

**Decision.**
- Caller **lacks the permission key entirely** (a buyer calling a seller endpoint) → `403`.
  The endpoint's existence is public; no information leaks.
- Caller **has the permission but not for this resource** (seller A opening seller B's
  order) → `404`, with the same body as a genuinely missing resource.
- Authorization denials are logged with the true reason (`PERM_SCOPE_DENIED`) even though
  the client is told `404`, so investigation is unaffected.

**Consequences.** Slightly harder debugging for integrators, which the error `code` in logs
and the `requestId` mitigate. Enumeration is closed.

---

## ADR-0030 — Media pipeline: eager derivatives, fail-closed scanning, direct-to-storage upload
**Status:** Accepted (supersedes the imgproxy note in `FILE_STORAGE.md`)

**Context.** `FILE_STORAGE.md` specified imgproxy for on-the-fly derivatives. Building the
media module surfaced three decisions that deserve to be recorded rather than absorbed
silently into code.

**Decision 1 — Derivatives are generated eagerly at confirm time, not on demand.**
imgproxy is excellent when the variant set is unknown or unbounded. Ours is not: three sizes,
two formats, fixed. Generating them once at upload turns every later read into a plain static
object that a CDN caches indefinitely, removes a second deployable from the critical path of
every product-image render, and makes cost predictable per upload instead of per view. The
trade accepted is a slower confirm call (a few hundred milliseconds) and wasted work on
assets that are never displayed — bounded by the orphan sweeper.

**Decision 2 — Virus scanning fails closed.**
If ClamAV is unreachable, the upload is **rejected**, not accepted-and-flagged. Everywhere
else in this system an unavailable dependency degrades gracefully; here it must not. The
private bucket holds passport scans that moderators open in a browser, and an unscanned file
reaching that bucket is the one failure that cannot be undone after the fact. `MEDIA_SCAN_ENABLED`
exists only so local development can run without ClamAV, and the config schema **refuses to
boot** if it is false while `NODE_ENV=production`.

**Decision 3 — Clients upload directly to object storage via presigned URLs.**
The API never receives file bytes. A 10MB image through Express would occupy a request worker
for the duration of a slow mobile upload at a bazaar; at any real concurrency that is the
whole pod. The API issues a scoped, expiring, size-capped presigned PUT and validates the
object *afterwards* — which is why `confirm` re-reads the object header from storage rather
than trusting anything the client says about it.

**Consequences.** imgproxy is dropped from the stack. Storage holds ~4× the bytes per image
(original plus variants). `sharp` becomes a native dependency of the API image. Confirm is
the only expensive endpoint in the module and is rate-limited accordingly.

---

## ADR-0031 — Approval grants the right to trade; the seller creates the shop
**Status:** Accepted (amends the approval endpoint described in `API.md` 5.14)

**Context.** `API.md` specifies that approving a seller application "creates shop, grants
role, credits opening balance in one transaction". Building the onboarding module made two
problems with that visible.

First, it couples a *judgement* to a *data operation*. Shop creation validates a stall
number against the market, and stall numbers collide. A moderator who has read the passport,
checked the market contract and decided "yes" would have that verdict rejected because
someone else already registered stall B-42 — a conflict the moderator cannot resolve and did
not cause.

Second, it forces a cross-module distributed write. Shop creation lives in the geo module and
opens its own transaction; nesting it inside onboarding's transaction would mean either
threading a session through another module's public API, or accepting a partial commit where
the applicant is approved but has no shop.

**Decision.** Approval does two things, atomically: it moves the application to `APPROVED`
and grants `SELLER_OWNER`, recording `approvedMarketId`. The seller then creates their shop
through the existing `POST /seller/shops`, which already requires that role.

Consequently `detachShop` no longer revokes `SELLER_OWNER` when a seller's last shop closes.
The role now means "approved to trade", which outlives any individual stall; revoking it
would silently un-approve a seller who closed one shop intending to open another.

**Consequences.** One extra step for the seller, which matches how the process actually works
— approval and finding a stall are separate events in time. The wallet credit that `API.md`
bundled into the same transaction is unaffected: it belongs to the wallet module (Phase 6)
and will hang off the `seller.approved` event rather than the HTTP request.

---

## ADR-0032 — MongoDB is the single authority for stock reservations
**Status:** Accepted (amends ADR-0017)

**Context.** ADR-0017 specified reservations held in Redis with a TTL and "mirrored to a
`stock_reservations` collection for durability", with Redis authoritative for speed and
Mongo authoritative for truth. Implementing it made the cost of that split concrete.

Two authorities means two truths. Redis knows a reservation exists; Mongo knows the stock it
was taken against. Between them sits every failure mode worth worrying about: a seller
reducing stock below what Redis has already promised, a Redis restart losing holds that Mongo
still records, a reconciliation job whose job is to discover that the two disagree. And the
degradation choice is unattractive from both ends — a Redis outage that fails open oversells
real goods, one that fails closed stops checkout entirely.

The volume does not justify it. Reservations are bounded by checkout rate, which is rate-limited
to 20 quotes per minute per user; at the Phase-2 target that is tens per second platform-wide,
several orders of magnitude below where a single conditional update on an indexed document
becomes a bottleneck.

**Decision.** Reservations live in MongoDB alone. A hold is an atomic conditional update:

```js
updateOne(
  { _id: productId, $expr: { $gte: [{ $subtract: ['$stockQtyMilli', '$reservedQtyMilli'] }, qty] } },
  { $inc: { reservedQtyMilli: qty } },
)
```

`modifiedCount === 0` means insufficient stock — there is no read-then-check window for a
concurrent buyer to slip through. The matching `stock_reservations` document is written in the
same transaction, so a hold and its record cannot exist without each other.

Redis is not in this path at all. Expiry is owned by a sweeper over a partial index, exactly
as ADR-0017 already required — TTL indexes cannot be used, because deleting the row before the
sweeper decrements `reservedQtyMilli` would leak the counter upward and permanently strand the
stock.

**Consequences.** One authority, no reconciliation job, no dual-write. Every reservation costs
a transaction rather than a Redis round trip; that is the price of the guarantee, and at this
volume it is not a price worth optimising away. If reservation rate ever approaches the write
capacity of a single product document — a single item selling thousands of times a minute — the
answer is a sharded counter on that document, not a second datastore.

---

## ADR-0033 — Commission rules are effective-dated data; resolution happens at completion
**Status:** Accepted (refines `COMMISSION_SPEC.md` "Timing")

**Context.** `COMMISSION_SPEC.md` requires that an order be charged at "the rule effective at
order creation time, snapshotted into `order.commission`", so that changing the rate never
retroactively reprices orders already placed. Orders shipped before this module existed, so
none of them carry that snapshot, and the obvious reading is that they are now unchargeable.

**Decision 1 — Resolution is keyed on `order.createdAt`, not on the clock.**
Because rules are effective-dated, resolving "the rule in force at `order.createdAt`" returns
the same answer whenever it is evaluated. Resolving at completion is therefore *equivalent* to
resolving at creation, not merely close to it. The snapshot is still written onto the order —
it is simply written at the moment of charging, using the order's own creation timestamp as
the key. Orders created before any rule existed remain chargeable the instant a rule with an
appropriate `effectiveFrom` is entered.

**Decision 2 — No rate is seeded, in any environment.**
The commission rate is a commercial decision (open item B3), and inventing one in code or in
a seed would be worse than having none: a wrong rate applied silently is indistinguishable
from a correct one until a seller reconciles their own arithmetic. `commission_rules` is
therefore an empty collection with an administrative API, exactly like markets or categories.

**Decision 3 — A missing rule fails loudly and does not block the order.**
When `order.completed` arrives and no rule applies, the commission is recorded as `FAILED`
with reason `NO_APPLICABLE_RULE`, a CRITICAL audit entry is written, and an alert event is
emitted. The order still completes: it is an agreement between a buyer and a seller, and the
platform failing to bill itself is not their problem. Failed commissions are retryable, and
retrying is what an operator does after entering the missing rule.

Charging nothing silently was rejected. A marketplace that quietly stops billing is a
marketplace that discovers the fact from its bank statement.

**Consequences.** The wallet module is buildable and complete without B3 being answered; what
B3 unblocks is *entering* the rate, not writing the software. Any order completed before a
rule exists sits in `FAILED` until an operator resolves it, which is visible in the pending
commission index rather than lost.

---

## ADR-0034 — Favourite alerts are decided from a stored watermark, not from the event

**Status.** Accepted, 2026-07-25. Supersedes nothing; extends ADR-0012 and reuses ADR-0032.

**Context.** Restock and price-drop alerts are driven by `product.stock_changed` and
`product.price_changed`, which arrive through the transactional outbox. The outbox guarantees
at-least-once delivery and nothing about ordering (ADR-0012). Both events carry enough
information to compute an alert directly — the price event carries `from` and `to` — and doing
so is the obvious implementation.

It is also wrong in two ways that only appear in production. A redelivered event recomputes the
same transition and notifies everybody a second time. Two edits delivered out of order compute
a fall from a price that was never the current one. Neither failure is visible in a test that
delivers each event once in order, and both are visible to users immediately.

**Decision 1 — Every favourite stores its own alert state.** A `priceWatermarkMinor` (the price
that user has already been shown) and a `wasPurchasable` flag (what the last pass observed).
The decision compares the product as the database currently reports it against that row, and
never reads the event payload. The event is a hint that something changed; the database is the
only thing that knows what it changed to. This is the same discipline the search indexer
already follows, for the same reason.

**Decision 2 — The state advances by compare-and-set, and it advances before the notification
is sent.** The update matches on all four state fields and only then writes; a redelivery finds
them already moved, matches nothing, and sends nothing. This is ADR-0032's mechanism — MongoDB
as the single authority, an atomic conditional update instead of a lock — applied to a second
problem. Ordering the write before the send means a crash between them costs a missed alert
rather than a duplicate one. That trade is deliberate: a missed price drop is a disappointment,
while a repeated one arriving four times at midnight is why people disable notifications.

**Decision 3 — The watermark follows the price upward.** Anchoring it to the price on the day
of favouriting would exhaust the alert after a single seasonal fall: a product followed at
10 000 som and now regularly 30 000 could never produce a drop again. Following the price up
means the reference is the current regular price, and a fall is measured from what the buyer
would actually pay today.

**Decision 4 — An invisible product is silent, and its watermark is held.** Seller availability
enters here and nowhere else: a deactivated seller's shop is not visible, the existing cascade
has already materialised that onto the product, and `computeProductVisibility` is the same
shared function the catalogue and search use. Alerting somebody about a stall they cannot buy
from is worse than silence — it sends them across the bazaar for nothing. Holding the watermark
while hidden means the seller's return does not replay a backlog of price movements nobody saw.

**Decision 5 — Favourite alerts are MARKETING, not transactional.** They are therefore
opt-outable and respect quiet hours. A restock is genuinely useful and genuinely not part of
the service anyone signed up for, and a price alert at two in the morning is precisely what
quiet hours exist to prevent.

**Consequences.** The alerting decision is a pure function with no clock, database or notifier,
and is exhaustively tested. The cost is four extra fields on every favourite row and a
compare-and-set per alert, which is the price of never sending the same notification twice.

---

## ADR-0035 — Reports read money from the ledger, and are computed rather than rolled up

**Status.** Accepted, 2026-07-25.

**Context.** The admin panel needs platform figures, seller performance and commission
statements. Two questions had to be settled before any of it could be written: where money
figures come from, and whether they are precomputed.

**Decision 1 — Money comes from the journal, never from `orders.commission`.** The order records
what was *meant* to be charged; the journal records what was actually posted. They diverge
exactly when something went wrong — a charge that failed for a missing rule, a reversal after a
dispute — and those are the cases a statement exists to show. A report built on the order's
intention would be confidently wrong in precisely the situations somebody is checking it for.
GMV is the exception and comes from orders, because GMV is a statement about goods sold, not
about money the platform received.

**Decision 2 — Only completed orders count toward GMV.** A cancelled order is not revenue under
any definition, and counting pending orders would produce a figure that falls on its own as
orders expire. A metric that moves backwards without anybody doing anything is a metric nobody
trusts.

**Decision 3 — Every figure is computed from the source collections, not read from a rollup.**
There is no production traffic yet; a rollup would be a second source of truth to keep correct,
and a wrong rollup is far harder to notice than a slow query. Every pipeline is bounded by the
reporting period and matches an indexed field first, so cost is proportional to the window. The
window is capped at 366 days for the same reason — the range *is* the cost. When volume makes
this insufficient the answer is a nightly rollup written by the worker, built from the shape of
these pipelines; that is a performance change, not a correctness one.

**Decision 4 — Periods are half-open, `[from, to)`.** A closed range makes the caller decide
whether `to` means midnight or the last millisecond of the day, and the two answers differ by a
day of orders. Half-open windows also tile: a month of daily reports sums exactly to the monthly
report, which is the property that makes a statement checkable.

**Decision 5 — A comparison that cannot be made is reported as null.** A seller's first month
has no previous month. Reporting "+100%" for it would be a fabricated number that reads as a
fact, so `changeBp` and `effectiveRateBp` return null instead.

**Consequences.** The module owns no collection and writes nothing, which is what lets it read
across module boundaries without becoming a place where business rules hide. The arithmetic
lives in two pure functions covered by 23 tests, because a seller will check their statement
against their own notes and a statement that is wrong once is never read again.
