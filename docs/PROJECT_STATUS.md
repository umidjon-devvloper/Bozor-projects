# Project Status

_Last updated: 2026-07-23_

## Current stage
**Phase 0 ✅ · Phase 1 ✅ · Phase 2 (Geography & Merchants) ✅ — Phase 3 next.**

## Completed

### Design (pre-development)
- Full review of the original documentation set
- Architectural redesign: 29 ADRs in `DECISIONS.md`
- Documentation rewritten and extended (58 documents)
- Domain model, order state machine, double-entry ledger, and commission spec defined
- Complete database architecture: 55 collections field-by-field (`DATABASE.md`)
- Complete REST API specification: ~189 endpoints (`API.md`)

### Phase 0 — Foundation ✅
- pnpm + Turborepo monorepo; strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `packages/types` — shared enums, branded ids, localized text with fallback resolution
- `packages/errors` — full error-code catalog, `AppError`, code→status map, RFC 9457 shape
- `packages/money` — `Money` and `Quantity` value objects, integer-only arithmetic, half-up rounding **(12 tests passing)**
- `packages/config` — Zod-validated env; process refuses to boot on invalid configuration
- `packages/logger` — pino + AsyncLocalStorage correlation, secret redaction
- `packages/contracts` — Zod schemas: primitives, pagination/envelope/problem-details, auth
- `packages/testing` — Testcontainers helper for a real replica set
- `apps/api` — Express composition root, security headers, CORS, compression, body limits
- Middleware: request context, error handler, Zod validation, Redis rate limiting, permissions
- Signed cursor pagination; response envelope
- Transactional outbox model + service (session-required publish)
- Append-only audit log with PII redaction and mutation-blocking hooks
- `apps/worker` — outbox relay with backoff and failure recording
- Health endpoints (`/live`, `/ready`), `/config`
- Docker Compose: MongoDB **replica set**, Redis, Typesense, MinIO
- CI pipeline: typecheck → lint → **dependency-cruiser boundaries** → unit → integration
- ESLint rule blocking `number`-typed money/quantity fields

### Phase 1 — Identity & Access ✅
- Models: `users`, `user_profiles`, `refresh_tokens`, `otp_codes`, `devices`, `user_consents`
  — with the indexes from `DATABASE.md`, including partial indexes on soft-deletable collections
- Repositories (the only layer touching Mongoose)
- Services: password (bcrypt, breach list, timing equalisation, transparent rehash),
  OTP (CSPRNG, hashed, single-use, rate-limited), token (RS256 + rotating refresh with
  **family reuse detection**), session (Redis-cached identity + revocation denylist),
  SMS (`SmsProvider` with Eskiz adapter), auth (orchestration)
- RBAC: permission catalog in code, role→permission map, resource-scope policies
- Endpoints: register · OTP send/verify · login · refresh · logout · logout-all · me (GET/PATCH/DELETE) ·
  password forgot/reset/change · phone change request/confirm · sessions list/revoke ·
  2FA enable/confirm/disable · devices register/update/remove
- Tests: permissions, cursor tampering, and the integration cases mandated by `TESTING.md`
  (refresh reuse revokes the family, password change kills live access tokens, no
  enumeration oracle, mass-assignment rejected)

### Phase 2 — Geography & Merchants ✅
- **The single visibility rule** (`services/visibility.ts`) — one function, five inputs, used by
  the API, the worker sweeper, and every read path. Returns `hiddenReasons[]` so a seller can
  see exactly why their shop is hidden.
- Models: `regions`, `districts`, `markets` (GeoJSON + `2dsphere`), `shops` (embedded members,
  materialized `isVisible`), `seller_applications` (encrypted passport fields)
- Repositories with keyset pagination for markets, shops, and the moderation queue
- Services: market (incl. `$geoNear` nearby), shop (lifecycle, members, vacation, visibility),
  seller application (KYC, STIR checksum, duplicate-identity detection), geo cache
- **Field-level AES-256-GCM encryption** + deterministic blind index for passport data
- Uzbek-aware slugification (`oʻ`, `gʻ`, apostrophe variants, Cyrillic transliteration)
- Working-hours engine with IANA timezones, midnight-crossing windows, holiday overrides
- 28 endpoints: geo reference · markets · public shops · seller shops & members · seller
  applications · admin markets & application review
- Worker: **visibility sweeper** with a Redis compare-and-delete distributed lock, batched
  bulk writes, importing the rule from the API rather than reimplementing it
- **Migrations** (`migrate-mongo`) with MongoDB `$jsonSchema` validators for identity and geo
  collections — including a validator that rejects an unencrypted passport field at the
  storage layer
- **Real seed data**: 14 regions and ~190 districts of Uzbekistan, idempotent upserts
- Tests: visibility (8), working hours (6), crypto (7), slug (5), plus 13 integration cases

### Phase 2 — Geo (regions · districts · markets · shops) ✅
- `packages/domain` — **new**. Holds `computeShopVisibility`, the single definition of the
  shop visibility rule, because two deployables need it (API on write, worker on vacation
  expiry). Duplicating it is the defect it exists to prevent.
- Models: `regions`, `districts`, `markets`, `shops` with the indexes from `DATABASE.md`
  (2dsphere, ESR-ordered compounds, partial moderation queue, unique slugs)
- Repositories, and services: geo (regions/districts/markets/nearby), market (admin CRUD +
  status cascade), shop (create/update/members/vacation/moderation/close), working hours,
  slug
- **Timezone-correct opening hours** via `Intl`, including windows that span midnight —
  no dependency, works in DST zones
- **Materialized `isVisible`**, recomputed inside the same transaction as every input change
- `shared/cache.ts` — Redis read-through cache with single-flight locking and tag purge
- `http/query.ts` — allowlisted filters, allowlisted sorts, signed keyset cursors
- 24 endpoints: public geo/markets/shops, seller shop management, admin market + moderation
- **Real seed data: 14 regions and 206 districts of Uzbekistan**, idempotent seeder
- Migration with `$jsonSchema` collection validators + indexes (ADR-0026), reversible `down`
- Worker: vacation-expiry sweeper with a Redis distributed lock (crons must run once)

### Media (uploads · storage · scanning · derivatives) ✅
Built **ahead of seller onboarding** because KYC is the passport scan: an onboarding module
that cannot accept a document is not working software. Media also unblocks catalog images,
shop logos and review photos.
- `packages/storage` — **new**. S3-compatible client shared by the API (upload/confirm) and
  the worker (reclamation), so bucket naming cannot drift between them.
- `media_assets` model with a five-state lifecycle: PENDING → CONFIRMED → ATTACHED, plus
  ORPHANED and REJECTED
- Nine upload purposes, each declaring bucket, visibility, size cap, permitted MIME types,
  derivative set and daily quota in one table
- **Direct-to-storage presigned PUT** with `ContentLength` signed into the URL
- **Magic-byte verification** at confirm: declared type is a hint, the bytes are evidence
- **ClamAV over the clamd INSTREAM protocol**, failing closed (ADR-0030)
- **EXIF stripping via re-encode** — a stall photo carries the seller's GPS coordinates
- Derivative generation (WebP, up to 3 sizes) + blurhash placeholders
- Short-lived signed URLs for private documents, every issue audited
- `attachToEntity` / `detachFromEntity` for other modules to call inside their transactions
- Worker: orphan sweeper (abandoned uploads and confirmed-but-unused assets)
- Migration with `$jsonSchema` validator + 6 indexes; ClamAV and MinIO bucket init in Compose

### Onboarding — seller applications & KYC ✅
- **Field-level encryption** (`shared/crypto.ts`): AES-256-GCM with a versioned envelope, and
  two keys derived from one secret by HKDF with distinct labels, so the cipher key and the
  blind-index key are independent of each other and of the cursor signer.
- **Blind index** (keyed HMAC) for duplicate-identity detection without decryption, backed by
  unique partial indexes over approved applications only — a rejected attempt cannot lock a
  legitimate applicant out of their own passport.
- `seller_applications` model: six-status state machine, bounded status history, all identity
  fields `select: false`.
- Applicant flow: submit · read own · resubmit (capped at 3) · withdraw.
- Moderation flow: list · read · **claim** · approve · reject, with a decision only reachable
  from `UNDER_REVIEW`, so concurrent moderators cannot both decide.
- **Audited identity reveal**: the single path that decrypts, behind its own permission, with
  a CRITICAL audit entry recording a *masked* value rather than the number.
- KYC documents attached through the media module **inside the submission transaction**.
- Approval grants `SELLER_OWNER` atomically with the decision (ADR-0031).
- Migration with `$jsonSchema` validators — including regex patterns that make storing a
  plaintext passport number in an encrypted field impossible — plus 7 indexes.

### Catalog — categories · units · products ✅
The first module to use `Money` and `Quantity` in anger.
- **Money and quantity stored as BSON Int64** via Mongoose `BigInt`, verified against the
  driver before the schemas were written. The `$jsonSchema` validator declares them `long`,
  so a migration script or `mongosh` cannot slip a double past the discipline of ADR-0004.
- `units` with `decimalPlaces` and `allowsAdjustment` — the two flags that make weighed goods
  work: countable units reject fractional quantities, weighed units activate the ADR-0006
  handover tolerance.
- `categories` with materialised ancestor paths (subtree browse in one indexed lookup) and
  **inherited attribute schemas**, child overriding parent by key.
- `products`: 5-state machine, min/step/max order quantities with a satisfiability check,
  price + stock as their own high-frequency endpoints, images through the media module inside
  the creation transaction, moderation on identity fields only.
- **Visible vs purchasable are separate.** An out-of-stock product stays in the catalogue so
  it can be found and favourited for restock; only purchasability turns off. A remainder
  below the product's own minimum order counts as out of stock.
- `product_price_history` as a time-series collection with a 2-year TTL (ADR-0027).
- **The outbox relay now dispatches for real.** A worker handler carries
  `shop.visibility_changed` onto products, closing the gap where a hidden shop's products
  stayed listed. Restoring a shop does not blanket-publish — each product's own status and
  moderation still apply.
- Seed: 9 units and a 4-root category tree (food, clothing, household, flowers) with 24
  subcategories in uz / uz-Cyrl / ru / en.
- Migration with validators + 12 indexes, all ESR-ordered.

### Cart & checkout ✅
The first module where a bug costs a real seller a real sale.
- **ADR-0032 supersedes the Redis reservation design.** MongoDB is the single authority: a
  hold is one atomic conditional update whose availability check runs server-side, inside the
  write. There is no read-then-check window, no second datastore to disagree with the first,
  and no reconciliation job.
- `carts` — server-side, cross-device, one line per product (adding again increments).
  `priceAtAdd` is display-only and named so no future reader mistakes it for a total.
- `stock_reservations` — deliberately **no TTL index**. TTL would delete the row before
  anything decremented `reservedQtyMilli`, leaking the counter upward and stranding real stock;
  a sweeper does both writes in one transaction.
- `checkout_quotes` — a priced, reserved, time-boxed offer with frozen line snapshots and a
  content hash. Order creation will recompute that hash against live products, so being
  charged a different figure than displayed is impossible rather than unlikely.
- Line evaluation is shared between the cart view and the quote, so a green cart cannot be
  refused at checkout for a reason the cart already knew.
- Issues are reported **per line**, and a price change is advisory rather than blocking.
- One live quote per buyer: a new quote supersedes the old and gives its stock back.
- Grouped per shop (ADR-0007), each group carrying its own pickup window and the handover
  tolerance the buyer will be held to (ADR-0006).
- Guest cart merge adds quantities and reports what it dropped rather than dropping it silently.
- Migration with validators + 10 indexes; worker gains a reservation sweeper.

**Deliberately excluded:** promo codes. There is no promotions module, and the quote request
carries no `promoCode` field rather than one that silently does nothing.

### Orders ✅
The order lifecycle, end to end, plus the idempotency middleware `API.md` required and
nothing had yet built.
- **`Idempotency-Key` middleware.** A retry on a bazaar's mobile network must not become a
  second order. The unique `{key, userId}` index is the guarantee; only successful responses
  are stored, so a transient fault does not poison the key.
- 12-state machine in `packages/domain`, shared by the API and the worker's timers.
- **Order creation from a quote**: content hash recomputed against live products, a mismatch
  refused with the list of what changed; holds converted to committed stock decrements;
  quote marked CONSUMED; one order per shop (ADR-0007).
- Frozen snapshots: shop name, stall, phone, market, and every line's name, price and
  tolerance. A later rename or price change cannot rewrite a receipt.
- Human-readable numbers (`BZ-260728-000142`) from a per-day atomic counter.
- **Pickup verification**: CSPRNG six-digit code, hash-only storage, five attempts, and a
  reissue on each buyer request so an old screenshot stops working.
- **Handover adjustment (ADR-0006)**: within tolerance it applies silently; beyond it the
  buyer must agree, and over-delivery is treated exactly like under-delivery.
- Cancellation matrix enforced from the same table the API returns `canCancel` from, so a
  button the client renders is one the server will honour.
- Worker timers: accept-window expiry, auto-completion after 48h, adjustment timeout — each
  writing its outbox event in the same transaction as the state change.
- Migration with validators + 15 indexes, every timer cursor partial.

**The seam to the wallet:** `order.completed` carries seller, total and timestamp. Commission
fields exist on the order with status `PENDING` and no writer — the wallet module owns
commission rules and the ledger, and charges from that event.

### Wallet, ledger & commission ✅
Built **without waiting on B3**, because B3 blocks the commission *number*, not the software:
rates are effective-dated administrative data, like markets and categories (ADR-0033).
- **`packages/ledger` — new.** The ledger is driven by two deployables: the API for
  administrative movements, the worker for charging on `order.completed`. Publishing and
  auditing are injected ports, so the money logic exists exactly once.
- **Double-entry journal**, append-only and immutable. Corrections are reversing entries. The
  balance invariant is asserted before every write, and `entryKey` is a unique natural key
  derived from the order — which is what makes at-least-once delivery safe.
- **Materialised wallet balance with the journal as truth.** `reconcile` recomputes from the
  ledger and reports divergence rather than silently repairing it.
- **Commission rules are effective-dated and append-only.** A rate change is a new rule;
  editing one in place would reprice orders already charged under it.
- **A balance may go negative.** Refusing a charge would mean the platform silently working
  for free; taking it and deactivating after a grace period is the honest outcome.
- **`shops.sellerWalletActive` finally has its writer** — the geo visibility rule has read it
  since Phase 2, and `seller.deactivated` now drives it.
- Manual credits and debits: CRITICAL audit, mandatory reason, dual control above a
  threshold with the approver required to be a different administrator, and idempotent.
- Commission rate setting is **SUPER_ADMIN only**.

**No rate is seeded, in any environment.** A missing rule records the commission as `FAILED`
with a CRITICAL audit entry and leaves the order alone — the platform failing to bill itself
is not the buyer's or seller's problem, and it is visible rather than lost.

### Notifications ✅
- **`packages/notifications` — new.** Events are relayed in the worker, while the inbox and
  preferences are served by the API, so the delivery engine is shared (ADR-0011). SMS is an
  injected port, since the identity module already owns the Eskiz adapter for OTP.
- **Three real push providers**, written against the published protocols rather than vendor
  SDKs: **FCM HTTP v1** (service-account JWT → OAuth2 → send, with token caching), **APNs**
  over HTTP/2 with an ES256 provider token and a reused session, and **Expo** for development
  builds. Any provider may be absent; that transport then does not exist, rather than
  silently succeeding.
- **15 templates in four locales** (uz-Latn, uz-Cyrl, ru, en). A missing variable is an
  error, not an empty string — a push reading "Your order at  is ready" never goes out.
- **Idempotent by `dedupeKey`**, derived from the event id and uniquely indexed, so
  at-least-once relay delivers once.
- **Dead tokens are retired, not retried.** `devices.invalidatedAt` has had a partial index
  excluding it from fan-out since Phase 1 and no writer until now.
- Transactional categories cannot be switched off; marketing respects opt-out **and** quiet
  hours evaluated in the recipient's own timezone.
- Suppressions are recorded, so "why didn't they get it?" has an answer.
- 14 event handlers wired: order lifecycle, wallet, onboarding and moderation outcomes.

### Search ✅
- **`packages/search` — new.** Querying happens in the API, indexing is driven by relayed
  events in the worker, so the engine client and the indexer are shared (ADR-0011).
- **Typesense over its REST API**, not the SDK — the surface used is five endpoints, and going
  direct keeps the error bodies where the useful information is.
- **Uzbek transliteration is the point of the module.** `Goʻsht`, `гўшт` and `gosht` are the
  same word to a shopper and were three different strings to MongoDB. Every text field is
  indexed twice: the original for display and exact ranking, and a canonical ASCII twin that
  all three fold into. `x`/`h` and `ts`/`s` fold too, because Uzbek writers swap them
  routinely.
- **Only visible documents are indexed.** A hidden product appearing in results would leak
  exactly what the visibility rule exists to hide, so the indexer *deletes* rather than skips
  when something stops being public.
- **Alias-based reindexing.** A rebuild writes into a fresh versioned collection and repoints
  the alias only when the import finishes, so search keeps serving the old index throughout
  and a failed rebuild changes nothing.
- A shop going dark fans out to its whole catalogue — the cost of denormalising shop names
  onto product documents, paid on a rare event rather than on every query.
- Filter strings are built server-side from named fields; nothing a caller sends reaches the
  engine's query language.
- Search being down returns **503**, never an empty result set: zero hits and "the engine is
  down" are different answers, and a regex fallback over an unindexed collection would turn
  one outage into two.

### Reviews & ratings ✅
Closes the loop that catalogue sorting and search ranking have both been reading and nothing
was writing.
- **Ratings live in `packages/domain`.** Three places read them — the catalogue sorts by them,
  the search index ranks by them, the reviews module writes them — so the formula exists once.
- **Integer arithmetic throughout.** Ratings are scaled by 100, and products and shops now
  store an exact `ratingSum` alongside the count.
- **Aggregation is one atomic pipeline update**, not read-modify-write. Two buyers reviewing
  the same product in the same instant would otherwise race, and one review would vanish from
  the score while staying visible in the list.
- **Bayesian sort key with a 20-review prior at 4.00.** A new stall with one five-star review
  from a friend does not outrank a seller with four hundred at 4.8 — and a single one-star
  review does not sink one either.
- **An unrated product sorts at the prior, not at zero.** No reviews is unknown, not bad.
- **Eligibility is proved by a completed order**, not asserted by the client, with one review
  per product per order and a 30-day window.
- **A reported review keeps counting** until a moderator decides. Removing a score on an
  accusation alone would make reporting a way to attack a competitor's rating.
- The public projection carries a snapshot buyer name and nothing else — no id, no order
  number. A public document linking a person to what they bought is a privacy leak.
- Seller replies once; withdrawal and hiding both retract the score in the same transaction.
- Wired into search (`review.rating_changed` reindexes) and notifications (seller hears about
  a review, buyer hears about a reply).

### Disputes ✅
The last hole in the order lifecycle. `DISPUTED` and `REFUNDED` have been in the order state
machine since it was written with no way to reach them, and `reverseForOrder` in the ledger
was written, tested and waiting for a caller.
- **Cash-on-pickup refunds are honest about what they are.** The platform never held the
  buyer's money, so it cannot hand it back. A resolution reverses the platform's own
  commission and records `SELLER_DIRECT` — the seller owes the buyer at the stall. Prepaid
  orders are *refused* with 501 until payments lands, rather than recording a refund nothing
  will execute.
- **Commission is reversed proportionally.** A buyer recovering 40% of an order means the
  seller kept 40% less revenue; charging full commission on a transaction just judged to have
  failed would mean profiting from it. `reverseForOrder` gained an optional partial amount.
- **Only a moderator closes a case** once it reaches review. Letting the parties settle
  privately would leave the platform unable to say what was decided or why.
- **A seller who ignores a dispute cannot stall it**: the response window lapses and the case
  escalates on a timer.
- **`shops.reliabilityScore` finally has its writer** — another field that has been read and
  never written since Phase 2. A loss costs 75, a win returns 10: recovery is deliberately
  slow, because a seller regularly disputed and occasionally vindicated is still one buyers
  should be warned about.
- One live dispute per order, enforced by a partial unique index, while leaving a settled one
  able to be followed by a second genuine claim.
- Evidence goes to the private bucket and is fetched through the audited media endpoint; the
  dispute response returns keys, never public URLs.

### Favourites — wishlist, restock and price-drop alerts ✅
The last unblocked module in the buyer journey, and the writer `products.favoriteCount` has
been waiting for since Phase 3.
- **Alerts are decided from a stored per-favourite watermark, never from the event payload**
  (ADR-0034). The outbox delivers at least once and in no order; a drop computed from the
  event's own `from`/`to` notifies everybody twice on the first redelivery.
- **The state advances by compare-and-set, before the notification is sent.** ADR-0032's
  mechanism applied again. A crash costs a missed alert rather than a duplicate one.
- **The watermark follows the price upward**, so one seasonal fall does not exhaust the alert.
- **Seller availability is the existing visibility rule.** A deactivated seller's stall goes
  quiet through `computeProductVisibility`; the restock edge fires when they top up.
- **The first two MARKETING templates**, opt-outable and quiet-hours-respecting, never on SMS.
- Adding a favourite is an upsert; a repeat tap cannot reset a watermark.
- A drop must clear both a 5% and a 1 000 som floor; a 24-hour cooldown bounds both alert kinds.

## Verified
- **The entire workspace typechecks clean** under `strict`, `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` — 28/28 turbo tasks
- Unit suites: **301/301 passing** (282 in `apps/api`, 12 money, 7 errors)
- Build: 15/15 turbo tasks
- Integration suites are **not** run in CI yet; they require Docker for the MongoDB replica set

> The sections below this point drifted out of date during the module sequence and were only
> partially repaired during the 2026-07-25 recovery. The per-module entries above are accurate;
> `CHANGELOG.md` is the reliable record. A full pass over the remainder is outstanding.

## Not yet started
| Module | Phase |
|---|---|




| Notifications & realtime | 8 |
| Search | 9 |
| Engagement | 10 |
| Web / seller / mobile / admin | 11–14 |

## Blocked
| Item | Blocker |
|---|---|
| Infrastructure procurement | B2 legal opinion on data residency (ADR-0009) |
| Payments implementation | B5 merchant contracts and sandbox credentials |
| Commission implementation | B3 signed-off parameters |

## Deferred within completed modules (tracked, not forgotten)
- `GET /auth/me/export` (data export job) — needs the job runner from Phase 8
- Breach-list lookup currently uses a local floor list; k-anonymity API integration pending
- Settings collection reads in `/config` and `showClosedShops` — currently registry defaults
- `GET /admin/seller-applications/:id/documents/:docId` — deliberately **not built**: signed
  document URLs require the media module (Phase 3). Building it against a non-existent bucket
  would have been a fake implementation.
- `sellerWalletState` reads the `seller_wallets` collection directly. It returns real state
  the moment Phase 6 writes records; at that point the direct read is replaced by the wallet
  module's exported service.
- District list must be reconciled against the official MHOBT/SOATO classifier before
  production seeding (noted in the seed data file). The seed is idempotent, so corrections
  are a re-run.

## Next step
**Payments (Payme / Click) remains the only blocked module**, on B5 — signed merchant contracts
and sandbox credentials. Unblocked candidates: admin reporting over data every module already
writes, and running the integration suites on a Docker host, which is the largest untested
surface in the backend.

Superseded, retained for history — **Phase 3 — Catalog:** categories with materialized `ancestors` paths, units, products with
integer milli-unit quantities, the media pipeline, moderation queue, price history, bulk
import. Not blocked by B1–B8.

## Update rule
This file is updated in the same PR that changes module status.
