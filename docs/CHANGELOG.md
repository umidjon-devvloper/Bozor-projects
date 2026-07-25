# Documentation Changelog — 2026-07-23 Architecture Redesign

36 original documents reviewed. **All 36 rewritten or substantially extended. 22 new
documents added.** Every change traces to an ADR in `DECISIONS.md`.

## Reversals of the original specification
| Original | Now | ADR |
|---|---|---|
| "No SMS verification" | SMS/OTP mandatory — password recovery was otherwise impossible | ADR-0014 |
| MongoDB Atlas + Vercel + UploadThing | In-country hosting, MinIO storage | ADR-0009 |
| Regex/basic search | Typesense with Latin↔Cyrillic transliteration | ADR-0008 |
| `wallet.balance` as a mutable number | Double-entry ledger; balance is a projection | ADR-0005 |
| Linear order flow, no failure paths | Full state machine with expiry, adjustment, dispute | ADR-0006 |
| Single-seller implicit orders | Order groups splitting into per-shop orders | ADR-0007 |
| Payment before order, but pickup-only delivery | `paymentMode` enum; cash-on-pickup in v1, escrow flagged | ADR-0003 |
| PM2 + single VPS | Containerized, staged to Kubernetes | ADR-0010 |
| Roadmap: Payments before Wallet | Wallet & commission before Payments | `ROADMAP.md` |

## Added to the stack
Redis (cache, queues, locks, reservations) · Typesense (search) · SMS provider ·
MinIO + imgproxy · OpenTelemetry/Prometheus/Loki/Sentry · Testcontainers.

## Gaps closed that the original documentation did not mention at all
Variable-weight goods and handover adjustment · multi-seller cart splitting · price
snapshots · stock reservation · order expiry and auto-completion · pickup verification ·
commission reversal · i18n · data residency · password recovery · seller KYC · moderation ·
disputes · chat · audit logging · idempotency · webhook replay protection · observability ·
migrations · feature flags · offline mobile behaviour.

## New documents
`DECISIONS` `DOMAIN_MODEL` `EVENTS` `MONOREPO` `COMMISSION_SPEC` `CART_CHECKOUT` `CACHING`
`QUEUE_SYSTEM` `CONFIG_SYSTEM` `I18N` `OBSERVABILITY` `SCALABILITY` `TESTING` `CI_CD`
`COMPLIANCE` `MODERATION` `DISPUTE_SYSTEM` `CHAT_SYSTEM` `ANALYTICS` `CONVENTIONS`
`GLOSSARY` `CHANGELOG`

---

# 2026-07-23 — Database Architecture (second pass)

`DATABASE.md` replaced with the final, normative version: 55 collections reviewed field by
field, with indexes, validation rules, relationship and cascade rules, denormalization
register, transaction boundaries, shard keys, and storage projections. 18 review findings
listed in Part 9 of that document.

Three ADRs added: **ADR-0025** integer quantities in milli-units · **ADR-0026** three-layer
validation including MongoDB `$jsonSchema` · **ADR-0027** time-series collections for
append-only telemetry.

Collections renamed or restructured: `wallet_states` → `seller_wallets` · `review_replies`
embedded into `reviews` · `users` split into `users` + `user_profiles` · `user_consents`
added · `counters` added · `orders_by_buyer` deferred to Phase 3.

---

# 2026-07-23 — REST API (third pass)

`API.md` replaced with the complete specification: conventions (envelope, pagination,
filtering, sorting, sparse fieldsets, expansion, idempotency, caching, versioning), the
authentication and authorization model, a full error-code catalog, canonical resource
representations, ~189 endpoints with request/response/error definitions, the WebSocket
contract, rate limits, the client retry contract, and contract governance.

Two ADRs added: **ADR-0028** money and quantity as JSON strings of integer minor units ·
**ADR-0029** `404` rather than `403` for out-of-scope resources, to close the enumeration
oracle.

---

# 2026-07-23 — Phase 0: Foundation (development begins)

Monorepo initialised: pnpm workspaces + Turborepo, strict TypeScript, ESLint with a rule
blocking `number`-typed money fields, dependency-cruiser enforcing ADR-0011 module
boundaries in CI, commitlint, Docker Compose with a MongoDB **replica set**.

Packages: `types`, `errors` (full code catalog), `money` (`Money` + `Quantity`, integer-only,
12 tests passing), `config` (Zod env validation, fail-fast boot), `logger` (pino +
AsyncLocalStorage correlation + redaction), `contracts` (Zod), `testing` (Testcontainers).

API foundation: composition root, security headers, CORS, request context, RFC 9457 error
handler, Zod validation middleware, Redis rate limiting, signed cursor pagination, response
envelope, transactional outbox, append-only audit log, health and config endpoints.
Worker: outbox relay.

Added **ADR-0025** (integer quantities), **ADR-0026** (three-layer validation), **ADR-0027**
(time-series collections) during the database pass; **ADR-0028** (money as JSON strings) and
**ADR-0029** (404 over 403) during the API pass.

# 2026-07-23 — Phase 1: Identity & Access

Six collections, five repositories, seven services, 24 endpoints.

Security-relevant behaviour worth naming:
- Refresh tokens rotate on every use and are stored hashed. Replaying a consumed token
  revokes the **entire token family** — the mechanism that makes a stolen refresh token
  survivable (ADR-0013).
- Access tokens carry no roles or permissions; those resolve per request from Redis, so a
  ban takes effect in seconds rather than at token expiry.
- A token minted before the last password change is rejected even if unexpired, closing the
  15-minute window a password reset would otherwise leave open.
- Logout adds the session to a Redis denylist for the access-token lifetime.
- Login, OTP send, and forgot-password are uniform for existing and non-existing accounts,
  with timing equalisation, so none of them can be used to enumerate phone numbers.
- OTP codes are CSPRNG-generated, hashed at rest, single-use, attempt-capped, and only one
  may be live per identifier and purpose.
- All request schemas are `.strict()`: an unknown field is a 422, not a silent drop. A
  registration payload containing `roles: ["ADMIN"]` is rejected, not ignored.
- Two-factor authentication cannot be disabled on admin roles.

---

# 2026-07-23 — Phase 2: Geography & Merchants

Five collections, four repositories, five services, 28 endpoints, two migrations, and the
real administrative divisions of Uzbekistan as seed data.

The load-bearing piece is `computeShopVisibility` — one pure function combining shop status,
moderation, market status, seller wallet state, vacation, and the clock. It is materialized
onto `shops.isVisible` because evaluating it per query would be a five-way join on the
hottest read in the product, and it is the **only** writer of that field. The worker's
sweeper imports it rather than reimplementing it; a second copy is exactly how two surfaces
drift apart and a deactivated seller stays visible on one of them.

Notable decisions and behaviours:
- Wallet-driven and market-driven hides are **synchronous**, including cache invalidation.
  A business-rule hide that takes five minutes to propagate is a violation, not latency.
- Shop approval is one transaction across `shops`, `users.roles`, `users.shopIds` and
  `seller_applications`. It calls the identity module directly rather than emitting an
  event, because an event bus cannot participate in a transaction and a half-onboarded
  seller is worse than the coupling.
- The opening wallet balance is **not** credited here. `seller.approved` goes to the outbox
  for the Phase 6 handler; creating a ledger entry from this module would violate ADR-0005.
- Passport data is encrypted with AES-256-GCM, indexed by a deterministic blind digest for
  duplicate detection, excluded from every response type, and rejected at the storage layer
  by a `$jsonSchema` validator if it is ever written unencrypted.
- STIR checksums are validated before an application reaches a moderator.
- Duplicate passports across accounts are flagged to a human, not auto-rejected: shared
  family documents are a real and legitimate case.
- Slugification handles `oʻ`, `gʻ`, three apostrophe variants and Cyrillic. A generic
  slugifier turns `doʻkoni` into `d-koni`.
- Working hours support midnight-crossing windows (a night market open at 02:00) and holiday
  overrides, evaluated in the market's IANA timezone.
- Closed shops stay listed and are marked closed rather than hidden: hiding every stall at
  20:00 would make the app look broken every evening.
- The visibility sweeper holds a Redis lock released by a compare-and-delete Lua script.
  Deleting unconditionally would let an expired holder delete a lock someone else now owns.

Extended (not rewritten) from earlier modules: `packages/types` gained geo enums and GeoJSON
helpers; `authz` gained five shop and market permissions; `identity` gained three shop
membership operations on its public surface.

**Verified:** the entire API source typechecks clean under full strict mode; 38/38 unit tests
pass.

---

# 2026-07-24 — Phase 2: Geo module (regions · districts · markets · shops)

One module, complete. 31 new files, 24 endpoints, 57 unit tests passing.

**New package `@bozorlar/domain`.** `computeShopVisibility` was moved out of the geo module
into a shared package because a second deployable needs it: the worker recomputes visibility
when a vacation expires. Keeping a private copy in each would have been the exact failure the
rule is designed to prevent — a seller hidden on one surface and visible on another.

**Behaviour worth naming:**
- Opening hours are evaluated in the market's own IANA timezone through `Intl`, handle
  windows that cross midnight, and are covered by a test that would fail for a server-clock
  implementation running in UTC.
- `isVisible` is materialized and recomputed **inside the transaction** that changed any of
  its inputs. Closing a market cascades to every shop in one `updateMany`, not a loop.
- A shop that is not visible returns **404, not 403**, so the public API cannot be used to
  enumerate suspended or unmoderated shops (ADR-0029).
- `?isVisible=false` cannot surface hidden shops: the flag is forced server-side.
- Shop creation, owner `shopIds`, the seller role grant and the market counter all commit
  together — a partially created shop would leave an owner unable to act on it.
- Editing a shop's displayed name returns it to moderation; editing its phone number does not.
- Filters and sorts are allowlisted per endpoint and each maps to a declared index, so a
  caller cannot construct a query against an unindexed field.
- Slugs transliterate Uzbek modifier letters and Cyrillic: `Oʻzbekiston doʻkoni` becomes
  `ozbekiston-dokoni`, not `o-zbekiston-do-koni`.

**Data.** 14 regions and 206 districts of Uzbekistan, from the national administrative
classifier. The seeder is idempotent and never deletes, because removing a district would
orphan the markets inside it. District centres are left null where no authoritative
coordinate was available rather than filled with invented values; markets carry their own
precise location, which is what proximity search uses.

**Migration** `20260723000001-geo-collections` installs `$jsonSchema` collection validators
and all indexes (ADR-0026). Its `down` relaxes validators and drops indexes rather than
dropping collections, so a rollback cannot destroy shops created while it was applied.

---

# 2026-07-24 — Media module (uploads · storage · scanning · derivatives)

One module, complete. 11 module files plus a new shared package, 4 unit suites, 14
integration cases, 86 unit tests passing overall.

**Built out of the stated order, deliberately.** The plan called for seller onboarding next,
but KYC *is* the passport scan — an onboarding module that cannot accept a document is not
working software. Media was the prerequisite and also unblocks catalog images, shop logos and
review photos.

**New package `@bozorlar/storage`.** The S3 client is needed by the API (upload and confirm)
and the worker (reclaiming orphaned objects). Duplicating the client setup would let bucket
naming drift between them and break reclamation silently.

**ADR-0030** records three decisions: eager derivative generation instead of on-the-fly
imgproxy, virus scanning that fails closed, and direct-to-storage presigned uploads.

**Behaviour worth naming:**
- The client's declared content type is a hint; the bytes are evidence. Magic-byte
  verification runs at confirm, and a mismatch is rejected rather than corrected.
- `ContentLength` is signed into the presigned URL, so the size cap is enforced by storage
  rather than by trust. An integration test uploads more than declared and asserts it fails.
- Images are re-encoded, which strips EXIF — including GPS. A test writes GPS into a JPEG,
  uploads it, downloads the derivative and asserts the metadata is gone.
- KYC documents and dispute evidence are never re-encoded: a moderator must see exactly what
  was submitted. They land in the private bucket, are served only as short-lived signed
  attachments, and every issue is written to the audit log.
- Scanner unavailable means upload rejected, not accepted-and-flagged.

**Two bugs found and fixed while building:**
1. `AppError` declared its fields as bare class fields and assigned them in the constructor.
   Under define semantics the declarations overwrote the assignments, so `code`, `status` and
   `detail` were **undefined on every error the system has ever constructed**. Since clients
   translate on `code`, no error message would have rendered anywhere. Fixed with `declare`
   modifiers and covered by a regression test that explains why.
2. The `MEDIA_*` error codes were used by the module but never added to the catalog, so their
   HTTP status resolved to undefined. Added, with a test asserting every code in the catalog
   maps to a status.

---

# 2026-07-24 — Onboarding module (seller applications & KYC)

One module, complete. 10 module files, 3 unit suites, 18 integration cases, 122 unit tests
passing, and — for the first time — **a clean typecheck across the entire workspace**
including both apps.

**ADR-0031** amends the approval endpoint described in `API.md`. Approval now grants the
right to trade; the seller creates their shop afterwards. Binding shop creation to the
moderator's verdict would let a stall-number collision reject a decision the moderator had
already correctly made, and would force a cross-module distributed write.

**Security posture:**
- Passport series, passport number and STIR are encrypted with AES-256-GCM in a versioned
  envelope. Two keys are derived from one secret via HKDF with distinct labels, so the cipher
  key, the blind-index key and the cursor signer share no key material.
- Duplicate identities are caught by a keyed blind index with unique partial indexes over
  approved applications, so the same passport cannot be approved twice — without the system
  ever decrypting a stored document to find out.
- Identity fields appear in exactly one request schema and no response schema. Reading them
  requires a separate permission, a separate endpoint, and produces a CRITICAL audit entry
  that records a masked value rather than the number.
- `SUPPORT` can read application status but cannot decide one or read a document.
- A test asserts no response body anywhere contains the submitted passport number.

**A deliberate omission, recorded in the code.** Uzbekistan publishes no control-digit
algorithm for the STIR — unlike Kazakhstan, whose IIN checksum is documented. Implementing a
guessed checksum would reject valid numbers belonging to real sellers, which is worse than
not checking: a wrong number is caught by the moderator comparing it against the uploaded
certificate, whereas a wrongly rejected applicant simply leaves. Format and
known-placeholder checks only, with a test asserting the placeholder list has not quietly
become a checksum.

**Three further bugs found and fixed**, all caught by extending the typecheck to `apps/` for
the first time: a duplicate permission block that had silently stripped `SHOP_UPDATE_OWN` and
`SHOP_DELETE_OWN` from shop owners; an unnarrowed index into the filter-operator map; and a
`pino` default import that has no call signature under NodeNext ESM. The permission bug is
now guarded by a test that parses every route file and asserts each required permission is
granted to at least one role.

---

# 2026-07-24 — Catalog module (categories · units · products)

One module, complete. 15 module files, 2 unit suites, 20 integration cases, 147 unit tests
passing, zero typecheck errors across the workspace.

**Verified before writing.** Mongoose 8.7's `BigInt` support was checked against the driver
first: it casts bigints and numeric strings to BSON Int64 and rejects anything else. Every
price and quantity in the module rests on that, so guessing would have been the wrong kind of
confidence. The `$jsonSchema` validator declares the same fields `long`, so the integer
discipline survives writes that bypass the application.

**Domain decisions worth naming:**
- *Visible* and *purchasable* are separate. An out-of-stock product stays in the catalogue so
  a shopper can find it and favourite it for restock; hiding it makes the shop look emptier
  than it is and destroys the restock signal.
- A remainder below the product's own minimum order counts as out of stock — 200g left when
  the seller sells in 500g steps is not stock.
- `minOrderQty` must be a whole number of `stepQty`, or the buyer can never land on it.
- Countable units reject fractional quantities outright: half an egg is not an order.
- Price and stock have dedicated endpoints with generous rate limits, and never trigger
  re-moderation. A seller repricing a whole stall each morning is normal behaviour.
- Categories inherit attribute definitions down the tree, child overriding parent by key, so
  "Oziq-ovqat" declares `origin` once and every food subcategory has it.

**The outbox relay now dispatches events for real** instead of marking them published. Its
first consumer carries `shop.visibility_changed` onto products, closing a genuine gap: a
seller whose shop went dark kept selling through the product listing. Restoring a shop does
not blanket-publish — a product still in draft or awaiting moderation stays hidden on its own
merits, and there is a test for exactly that.

**One bug found**, the same class as the media module's and caught immediately by the
workspace-wide typecheck: eight `CATALOG_*` error codes were used but never added to the
catalog, so their HTTP status resolved to undefined. Extending the typecheck to `apps/` last
module is what made this a compile error rather than a production one.

---

# 2026-07-24 — Cart & checkout

One module, complete. 14 module files, 1 unit suite, 18 integration cases, 159 unit tests
passing, zero typecheck errors across the workspace.

**ADR-0032 replaces the Redis reservation design of ADR-0017.** Implementing the original
made its cost concrete: two authorities means two truths, with a seller reducing stock below
what Redis has already promised, a Redis restart losing holds Mongo still records, and a
reconciliation job whose purpose is to discover the two disagree. Both degradation choices
are bad — failing open oversells, failing closed stops checkout. And the volume never
justified it: reservations are bounded by a rate limit of 20 quotes per minute per buyer.

MongoDB is now the sole authority. A hold is one conditional update whose availability check
runs inside the write:

```
{ $expr: { $gte: [{ $subtract: ['$stockQtyMilli', '$reservedQtyMilli'] }, qty] } }
```

`modifiedCount === 0` means somebody else got there first. Verified against the driver before
the schemas were written, and covered by the concurrency test `TESTING.md` marks mandatory:
two buyers racing for the last 2.5 kg produce one 200, one 409, and exactly one hold — never
two, never 5000 milli-units reserved against 2500 of stock.

**Details worth naming:**
- `stock_reservations` has no TTL index, on purpose. TTL would delete the row before anything
  decremented `reservedQtyMilli`, leaking the counter upward until the product looked sold out
  with stock on the shelf. A sweeper does both writes in one transaction.
- A quote that fails part-way gives back every hold it had already taken, because the whole
  thing is one transaction. There is a test that reserves one line, fails the second, and
  asserts the first went back.
- One live quote per buyer. A new quote supersedes the old and releases its stock, so an
  indecisive shopper cannot hold the same goods through five offers at once.
- Line evaluation is shared between the cart view and the quote, so a buyer cannot be shown a
  green cart and then refused for a reason the cart already knew about.
- A price change is advisory, not blocking. Refusing checkout because a tomato went up fifty
  som would be absurd; the buyer is told and the quote prices at the live figure.
- Promo codes are excluded outright rather than stubbed: no promotions module exists, so the
  request carries no `promoCode` field at all.

**One bug found**, again by the workspace typecheck: the checkout contracts redefined
`MoneySchema` and `QuantitySchema`, colliding with the existing exports in
`common/primitives` — two definitions of the wire money shape, free to drift apart. Removed
in favour of the shared ones.

---

# 2026-07-24 — Orders

One module, complete. 15 module files plus the idempotency middleware, 2 unit suites,
19 integration cases, 186 unit tests passing, zero typecheck errors.

**Built the idempotency middleware alongside it**, because order creation is the endpoint
that made it necessary. A buyer on a bazaar's mobile network taps "order", the request
completes, the response never arrives — without this, their retry is a second order and a
second commitment of the seller's stock. The unique `{key, userId}` index is the real
guarantee, and only successful responses are stored so a transient database fault does not
permanently poison that key.

**Order creation is the money-critical path**, so it does three things before writing
anything: recomputes the quote's content hash against live products, refuses a mismatch with
the list of exactly which prices moved, and converts the checkout holds into committed stock
decrements inside the same transaction that creates the orders. A quote can be spent once —
guarded by its own status, and backstopped by a unique index on `order_groups.quoteId`.

**Everything displayable is frozen.** Shop name, stall, phone, market, and each line's name,
price and tolerance are copied at creation. A test changes the product price to 99 000 after
ordering and asserts the receipt still says 18 000.

**Handover adjustment (ADR-0006)** works as specified: within the product's tolerance the
corrected weight applies silently at the corrected total; beyond it the order waits for the
buyer. Over-delivery is treated identically to under-delivery, because a seller handing over
30% more is charging 30% more than was agreed.

**The cancellation matrix is one table**, enforced by the service and read by the serializer,
so `canCancel` on the response and what the API will actually accept cannot drift. Nobody
cancels after pickup except an admin — a database write does not unwind a physical handover.

**Three worker timers**, each writing its outbox event in the same transaction as the state
change: sellers who never answer, buyers who collect and never confirm, and adjustments left
hanging. The second matters most — without it the seller's commission would never be charged,
because a buyer walking away from a stall has no reason to open the app again.

**Two bugs found**: the `ORDER_*` error codes were used but never added to the catalog (third
occurrence of that class, caught immediately by the workspace typecheck), and an unauthored
`identityUserRepository` alias was exporting a repository across a module boundary against
ADR-0011 — replaced with a purpose-built `buyerSnapshot` export.

---

# 2026-07-24 — Wallet, ledger & commission

One module, complete. A new shared package plus 5 module files, 1 unit suite, 203 unit tests
passing, zero typecheck errors. The revenue loop closes.

**Built despite B3 being open**, after re-examining what B3 actually blocks. It blocks the
commission *number*, not the software: rates are effective-dated administrative data, entered
through an API, exactly like markets and categories. **ADR-0033** records this, along with two
consequences that follow from it — resolution keys on `order.createdAt` rather than the clock,
which makes resolving at completion mathematically equivalent to resolving at creation; and a
missing rule fails loudly without blocking the order, because a marketplace that quietly stops
billing discovers the fact from its bank statement.

**`packages/ledger` is new.** Charging happens on `order.completed`, which the worker relays,
while administrative movements happen in the API — and neither app may import the other
(ADR-0011). Rather than duplicate ledger posting in two places, the ledger core moved into a
shared package with `EventPublisher` and `AuditRecorder` as injected ports. Each app supplies
its own plumbing; the money logic exists once.

**Ledger properties worth naming:**
- Append-only and immutable. A correction is a reversing entry, never an edit, so the books
  can show that a charge was made and undone rather than that it never happened.
- `entryKey` is a unique natural key derived from the order id. A redelivered
  `order.completed` finds the entry already there and does nothing — at-least-once delivery
  is the only guarantee the outbox gives, and double-billing a seller is the worst thing this
  module could do.
- The balance invariant is asserted before every write, by a shared pure function every writer
  calls. `$jsonSchema` cannot express arithmetic, so the validator instead removes the ways an
  unbalanced entry could be constructed: every amount a positive Int64 on a known account.
- The materialised wallet balance is a cache; `reconcile` recomputes from the journal and
  reports divergence rather than silently repairing it, because a quiet fix hides the cause.
- A balance may go negative. Refusing a charge would mean the platform working for free.

**`shops.sellerWalletActive` finally has a writer.** The geo module's visibility rule has read
that field since Phase 2 with nothing setting it; `seller.deactivated` now drives it, and the
prepaid model is mechanically complete.

**One bug found**: `Money.clamp` accepted only `undefined` bounds, but a commission rule with
no floor arrives from the database as `null`. Widened — optional bounds are optional columns.

---

# 2026-07-24 — Notifications

One module, complete. A new shared package plus 3 API files and 2 worker files, 1 unit suite,
222 unit tests passing, zero typecheck errors.

**Every event the platform emits has been written to the outbox and relayed to nobody since
Phase 0.** Fourteen handlers now turn them into something a person sees: a seller learns an
order arrived and that a clock is running, a buyer learns their order is ready and which
stall to walk to, a seller learns their shop has just vanished from the catalogue and why.

**Three push providers, written against the published protocols.** FCM HTTP v1 does the
service-account JWT and OAuth2 exchange itself, caching the access token so a burst of pushes
costs one exchange. APNs runs over Node's built-in HTTP/2 with an ES256 provider token and a
reused session, which is what Apple asks for. Expo is a third provider rather than a
normalisation layer, because `ExponentPushToken[...]` is not an FCM or APNs token and sending
it to either produces a misleading "invalid token".

Vendor SDKs were declined deliberately: each pulls in a large dependency tree to perform one
HTTPS request, and each puts a library between us and the per-token error codes that decide
whether a device is retired or retried.

**Details worth naming:**
- A missing template variable is an error. A push reading "Your order at  is ready" is worse
  than one that never arrives, because the second gets noticed.
- Templates carry all four locales and are code, not data — a wording change is a code
  review, and a template editable in a database is editable into a phishing message.
- `dedupeKey` is the event id, uniquely indexed. At-least-once relay delivers once.
- Dead tokens are retired rather than retried, finally writing to `devices.invalidatedAt` —
  which has had a partial index excluding it from fan-out since Phase 1 and no writer at all.
- Transactional categories cannot be opted out of; they are the service, not a mailing list.
  Marketing respects both the opt-out and quiet hours, evaluated in the recipient's timezone
  rather than the server's.
- Suppressions are recorded with a reason, so "why didn't they get it?" has an answer.

**No production bug this time.** One of my own tests asserted the wrong quiet-hours
arithmetic — 18:00 UTC is 23:00 in Tashkent, which is inside quiet hours — and the assertion
was corrected rather than the code.

---

# 2026-07-24 — Search

One module, complete. A new shared package plus 3 API files and 1 worker file, 1 unit suite,
240 unit tests passing, zero typecheck errors.

**The module exists for one reason: Uzbek is written in two alphabets.** A seller lists
`Goʻsht`, a buyer searches `гўшт`, another types `gosht` because the modifier letter is
awkward on a phone keyboard. All three mean beef, and to MongoDB they were three unrelated
strings. Every text field is now indexed twice — the original for display and exact ranking,
and a canonical ASCII twin that all three fold into. `x`/`h` and `ts`/`s` fold as well,
because Uzbek writers swap them routinely and `xolodilnik` and `holodilnik` are the same word
to everyone except a strict matcher.

The folding is deliberately aggressive and deliberately confined to a parallel field: it never
touches displayed text, so an over-eager fold costs a few extra results rather than a wrong
product name. Tests assert both directions — the three spellings collide, and genuinely
different words (`olma`/`olcha`, `non`/`nok`) do not.

**Typesense over its REST API rather than the SDK**, on the same reasoning as the push
providers: five endpoints, and going direct keeps the error bodies.

**Details worth naming:**
- Only visible documents are indexed, and the indexer *deletes* rather than skips when
  something stops being public — a product indexed and then hidden must disappear from
  results, not merely go stale.
- Reindexing builds into a fresh versioned collection and repoints an alias only once the
  import finishes. Search serves the previous index throughout, and a failed rebuild changes
  nothing.
- A shop going dark fans out to its entire catalogue. That is the cost of denormalising shop
  names onto product documents, and it is paid on a rare event rather than on every query.
- Filter strings are assembled server-side from named fields. A filter built from user input
  is an injection surface in any query language, including this one.
- Search being unavailable returns 503 rather than an empty result set. Zero hits and "the
  engine is down" are different answers, and a regex fallback over an unindexed collection
  would turn one outage into two.
- Prices are `int64` minor units in the index, exactly as in MongoDB — a float would let
  search disagree with the catalogue about a price.

No production bug found this round.

---

# 2026-07-24 — Reviews & ratings

One module, complete. 9 module files, 1 unit suite, 255 unit tests passing, zero typecheck
errors.

**This closes a loop that has been open since Phase 3.** `ratingAvg` and `ratingBayesian` are
read by catalogue sorting and, since last module, by search ranking — and nothing wrote them.
Ranking was driven by sales volume alone, which quietly favours whoever started first.

**The aggregate is a single atomic pipeline update**, not read-modify-write. Two buyers
reviewing the same product in the same instant would otherwise both read the old average, both
write their own, and one review would vanish from the score while remaining visible in the
list — a discrepancy nobody notices until a seller counts. Products and shops now carry an
exact `ratingSum`, which is what makes the increment possible without a read.

**The Bayesian prior is the interesting bit.** A new stall with one five-star review from a
friend must not outrank a seller with four hundred at 4.8, so sorting uses a prior of 20
reviews at 4.00. The displayed average still favours the newcomer; the sort key does not. The
same damping protects a newcomer from a single one-star review — and an unrated product sorts
*at* the prior rather than at zero, because no reviews is unknown, not bad.

**Details worth naming:**
- Eligibility is proved by a completed order containing that product, not asserted by the
  client. A review anybody can leave is a review nobody trusts.
- A reported review keeps counting toward the score until a moderator decides. Removing it on
  an accusation alone would make reporting a lever for attacking a competitor's rating.
- A repeat report from the same person returns success without doing anything: telling them
  "you already reported this" invites them to find another account.
- The public projection carries a snapshot buyer name and nothing else. A public document
  linking a person to what they bought and when is a privacy leak dressed as a feature.
- A shop's rating is derived from its products' reviews rather than a separate corpus, so the
  two can never tell different stories about the same seller.

**Cut deliberately:** helpful-vote sorting. It is a discovery nicety, and nothing depends on
it the way the catalogue and search depend on the aggregate.

No production bug found this round.

---

# 2026-07-24 — Disputes

One module, complete. 8 module files, 1 unit suite, 276 unit tests passing, zero typecheck
errors. This closes the last hole in the order lifecycle.

**`DISPUTED` and `REFUNDED` have been in the order state machine since it was written with no
way to reach them**, and `reverseForOrder` in the ledger has been written, tested and waiting
for a caller since the wallet module. Both are now wired.

**The interesting problem was what a refund actually means here.** Every v1 order is cash on
pickup: the buyer handed som to a seller at a stall, and the platform never touched it. It
therefore cannot hand it back, and pretending otherwise would be the most consequential piece
of fiction in the codebase. So a resolution does the two things the platform genuinely can do
— reverses its own commission, and records `SELLER_DIRECT`, meaning the seller owes the buyer
directly. Prepaid orders are refused with 501 rather than recording a refund nothing will
execute; no prepaid order can exist until payments lands, so the path is unreachable rather
than incomplete.

**Commission comes back proportionally.** A buyer recovering 40% of an order means the seller
kept 40% less revenue, so the platform returns 40% of what it charged. Anything else means
profiting from a transaction it has just judged to have failed. `reverseForOrder` gained an
optional partial amount, rounded down so a reversal can never exceed the original charge.

**Details worth naming:**
- Only a moderator closes a case once it reaches review. Letting the parties settle privately
  would leave the platform unable to say what was decided or why — and a dispute is the
  evidentiary record behind money moving.
- A seller who ignores a dispute cannot stall it: the response window lapses and the case
  escalates on the existing order-timers sweeper.
- `shops.reliabilityScore` finally has a writer. It has been read and never written since
  Phase 2. A loss costs 75 and a win returns 10, so recovery takes eight clean outcomes —
  deliberately slow, because a seller regularly disputed and occasionally vindicated is still
  one buyers should be warned about.
- An order that was completed before any commission rule existed reverses to zero rather than
  erroring, which is the state every order in the database is currently in.
- Evidence lands in the private bucket and is fetched through the audited media endpoint; the
  dispute response carries keys, never public URLs.

No production bug found this round.

---

# 2026-07-25 — Favourites (wishlist, restock and price-drop alerts)

One module, complete. A new shared package, 6 API module files, 1 worker handler, 1 contracts
schema set, 1 migration, 2 notification templates, 24 new unit tests. Build 15/15, typecheck
28/28, **301 tests passing**.

**The interesting problem was not storage, it was idempotency.** Alerts ride on
`product.price_changed` and `product.stock_changed`, which arrive at least once and in no
guaranteed order. Computing a drop from the event's own `from`/`to` is the obvious
implementation and notifies everybody twice the first time an event is redelivered. **ADR-0034**
records the alternative: every favourite stores the price its owner has already been shown and
whether it was last seen buyable, the decision is taken against that row and the product's
current state in the database, and the row advances by compare-and-set — ADR-0032's mechanism
applied to a second problem. A redelivery decides the same thing, fails to advance, and sends
nothing.

**State moves before the notification is sent.** A crash between the two costs one missed alert
instead of a duplicate. A missed price drop is a disappointment; a repeated one at midnight is
why people turn notifications off.

**The watermark follows the price upward**, so a product followed at 10 000 som and now
regularly 30 000 can still produce a drop. Anchoring to the favouriting price would exhaust the
alert after one seasonal fall.

**Seller availability is the existing visibility rule, not a new one.** A deactivated seller's
shop goes invisible, the cascade materialises that onto every product, and every favourite goes
quiet through `computeProductVisibility` — the same function the catalogue and search call.
When the seller tops up, the restock edge fires naturally. There is deliberately no "your seller
is back" notification: what the buyer followed was the tomatoes.

**`products.favoriteCount` finally has its writer** — read by the catalogue mapper and displayed
on every product card since Phase 3, written by nothing. It now moves in the same transaction as
the favourite row and its outbox event, so a public counter cannot drift from the data it counts.

**The first two MARKETING templates**, which tripped a tripwire the notifications module left
behind: a test asserting that no marketing template existed, so nobody could introduce a
silently opt-outable message by accident. It did its job. The assertion now pins the new intent
— marketing templates are exactly these two, they stay opt-outable, they respect quiet hours,
and they never go to SMS — and a third will trip it again.

**Smaller calls:**
- Adding a favourite is an upsert, not an insert. Tapping a heart twice on a slow connection is
  normal behaviour, and `$setOnInsert` means a second tap can never reset somebody's watermark.
- A price drop must clear both a proportional floor (5%) and an absolute one (1 000 som). Half
  off a bunch of herbs is proportionally huge and absolutely trivial.
- A 24-hour cooldown per favourite per alert kind, so oscillating prices and stock that flickers
  as reservations expire cannot become a stream of notifications.
- The fan-out is paged. A product followed by fifty thousand people is not one unbounded query.
- An archived product stays in the buyer's list as an unavailable card rather than vanishing.
  Silently removing rows from somebody's own list is more confusing than explaining them.
- No public favourites endpoint. Who follows what is not a fact the platform publishes.

**Not verified:** the integration path. The alert policy is pure and covered from both
directions, but the fan-out's paging and the compare-and-set have been reasoned about rather
than executed — `pnpm --filter @bozorlar/api test:int` needs Docker for the replica set.

---

# 2026-07-25 — Admin reporting

Platform overview, seller leaderboard, moderation queue depths, and commission statements for
both administrators and sellers. Read-only: the module owns no collection and writes nothing.

**Money comes from the ledger, not from `orders.commission`** (**ADR-0035**). The order says what
was meant to be charged; the journal says what was posted, and they diverge exactly when
something went wrong — a failed charge, a reversal after a dispute. Those are the cases a
statement exists to show. GMV is the deliberate exception: it is a claim about goods sold, so it
comes from completed orders.

**Periods are half-open**, so adjacent windows tile and a month of daily reports sums exactly to
the monthly one. That is what makes a statement checkable rather than merely plausible.

**Nothing is precomputed.** Every figure is aggregated from the source collections, bounded by
the period and capped at 366 days, because the range is the cost. A rollup would be a second
source of truth to keep correct, and a wrong rollup is harder to notice than a slow query. When
volume demands it, the pipelines here are the shape to build one from.

**Smaller calls:**
- Completion rate is measured against *decided* orders only. Including those still in flight
  would report a rate that rises on its own as the day settles.
- The seller leaderboard ranks by sales and carries the dispute rate beside it, because the
  second number is what says whether the ranking should be believed.
- Queue depth is reported with the age of its oldest item. A queue of two where one has waited
  five days is a worse state than a queue of forty opened this morning.
- The seller statement takes its shop set from the token; there is no parameter through which
  to ask about somebody else's takings.
- Money that cannot be read exactly throws rather than defaulting. In a financial report a
  plausible zero is worse than a stopped report.

23 new unit tests, all on the two pure functions. Build 15/15, typecheck 28/28, **324 tests**.
Module boundaries clean; the aggregations themselves are still unverified against a real
database, like every module since notifications.

---

# 2026-07-25 — Payments: Payme and Click wallet top-ups

The module PAYMENT_SYSTEM.md has named since the beginning, and the one that unblocks the whole
wallet lifecycle: sellers can now put money in, so the commission engine has something to
deduct from and the inactive-seller cascade has a way out.

Constants come from the providers' own reference implementations, not from memory. Both
documentation sites block automated reading, so `PaycomUZ/paycom-integration-php-template` and
`click-llc/click-integration-php` were read directly — error codes, transaction states, cancel
reasons, the twelve-hour timeout, and Click's signature field order, which is not guessable and
not rearrangeable.

**Idempotency is the protocol here, not a nicety** (**ADR-0036**). Payme's documentation states
that every call is sent twice on purpose and that the second must answer identically. One
collection keyed `(provider, providerTransactionId)` with a unique index, plus a compare-and-set
from `CREATED` in the same transaction as the journal entry, is what makes the retry post
nothing. Without it the first retry of the first real payment doubles a wallet.

**Payme's state integers are the shared vocabulary**, Click rows included. −1 and −2 stay
distinct because −2 means the money was taken and then returned, and a cancellation after
completion posts a reversing entry pointing at the original — a refund that only changed a
status would leave the wallet holding money the platform no longer has.

**Click's decimal som are converted, never rounded.** `1000.5` is one thousand som and fifty
tiyin; a third decimal place is rejected outright, because a rounded credit is a figure the
provider does not agree with and the gap becomes an unreconcilable ledger.

**The shared secret is the authentication.** No session, no bearer token — anybody who can reach
the callback URL can post to it. Basic `Paycom:<key>` compared in constant time for Payme, MD5
over the protocol's field order for Click, both checked before any part of the request is read.
Merchant credentials stay optional in the environment so the API boots without them, and an
unset secret can never match a signature: the callbacks are closed while B5 is unsigned, not
open.

A third instance of the same bug class turned up in review, in the newest code: `String()` over
an untrusted payload field. A provider callback is exactly where `[object Object]` becomes a
transaction key. `shared/scalar.ts` now holds the safe reader, matching the worker's.

25 new unit tests on signature construction, auth comparison, amount conversion and the
transaction lifecycle. Build 15/15, typecheck 28/28, **349 tests**.

**Not done:** buyer-side prepaid orders, and any contact with either sandbox. The protocol logic
is pure and covered; sandbox conformance is what those tests cannot stand in for, and it needs
the credentials B5 is waiting on.
