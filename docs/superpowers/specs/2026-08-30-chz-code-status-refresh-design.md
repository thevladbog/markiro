# Chestny ZNAK Code Status Refresh — Design Spec

**Date:** 2026-08-30

**Status:** Proposed for implementation

**Scope:** A tenant-wide store of the current Chestny ZNAK status of every marking code the system knows about, kept fresh in the background through True API's `cises/info`. Teaching inventory to fix a snapshot from that store instead of from six imported exports is a **separate** slice; so is retention and archival.

## Why

Preparing an inventory today means getting the six status exports into the system — by hand from the ЧЗ cabinet, or, since the exports slice, by ordering them over True API. Either way each inventory starts by loading the tenant's entire code population again, and each one is as slow as the first.

That is only necessary because the system has no durable answer to "what does ЧЗ currently think of this code". It has the codes — `codes` holds `canonical_raw` for everything the Station scanned — but no status against them.

`cises/info` supplies exactly that answer, for up to 1000 codes per request. Kept current in the background, it turns the next inventory's starting point from a bulk import into a query.

**It only answers about codes you name.** There is no "give me everything of mine". So a status store can refresh what the system already knows and can never discover a code it has not seen. That is acceptable here because codes originate in the tenant's own production, which the Station already records, and code ordering is planned to move into Markiro as well — after a one-time bootstrap from an export, the system sees new codes as they are made. A tenant that also receives goods marked by someone else still needs an export to learn those codes; this design does not remove that.

## Scale

`cises/info` takes 1000 codes per request against a global limit of 50 requests per second per participant. A million codes is a thousand requests — on the order of twenty seconds. Ten million is minutes.

This is worth stating because it removes a complication the design might otherwise carry: there is no need to rank codes by business importance, or to sample, or to accept that a full pass is unaffordable. The binding constraints are our own write throughput and not calling a third party's API more often than the data changes.

## Data model

One table, `chz_code_statuses`, keyed by `(tenant_id, code_hash)` — one row per code, not per scan:

- the facts ЧЗ returns: `status`, `status_ex`, `owner_inn`, `withdraw_reason`;
- `chz_product_group_code` — `cises/info` requires `pg`, so a code that cannot be attributed to a product group cannot be asked about;
- `first_seen_at`, `checked_at`, `next_refresh_at`.

**The raw code is deliberately not stored here.** `codes.canonical_raw` already holds it, and duplicating roughly a hundred bytes per code would enlarge the very thing this store exists to avoid re-reading. The refresh job joins `codes` for the batch it is about to send.

That has a consequence worth naming, because it is a feature rather than an oversight: `codes` is partitioned monthly, so when an old partition is eventually detached, the raw code goes with it and the status row can no longer be refreshed. Archived codes stop being polled by construction, without anyone writing a rule for it.

The table is not partitioned. Rows are small and are reached by hash, not by time.

## How codes enter the store

A job finds hashes in `codes` with no status row and inserts them due immediately. The product group is resolved through `codes.gtin14` → `products` → `chz_product_group_code`.

A code whose product has no group is stored but not polled, and is reported as such — the same shape as the exports slice's pre-flight, and for the same reason: the operator can fix it, and silence would leave them wondering why a code never updates.

The initial population of a tenant that has history predating Markiro comes from one ordered export, which the inventory exports slice already automates.

## Refresh policy

A cron selects rows whose `next_refresh_at` has passed, oldest first, groups them by product group, batches by 1000, joins `codes` for the raw values, calls `POST /cises/info?pg=<code>` and writes the answer back.

Each pass is bounded by a batch count rather than running until the queue drains. The first pass for a tenant with existing history has the entire population due at once, and an unbounded pass would hold a worker for as long as that takes; bounded, it simply takes several passes to catch up, oldest first, and nothing else in the queue starves.

The interval depends on what the last answer was:

- **in circulation** — `EMITTED`, `APPLIED`, `INTRODUCED`, `DISAGGREGATION` — daily;
- **withdrawn** — `RETIRED`, `WITHDRAWN`, `WRITTEN_OFF` — monthly.

A status ЧЗ returns that is not in either list is treated as in-circulation, because the cost of asking too often is small and the cost of ignoring an unrecognised state is a code the system quietly stops tracking.

**Withdrawn codes are polled rarely rather than never.** Chestny ZNAK permits returning a code to circulation, so `RETIRED` is not a terminal state and treating it as one would create a blind spot exactly where a divergence from ЧЗ is most expensive to discover late. The cost of the slower cadence is negligible at the request volumes above.

A code ЧЗ does not recognise is retried a small number of times and then moved to the long interval. It is never silently dropped: an unknown code means the code belongs to someone else or is malformed, and that is a fact the operator needs rather than an absence.

## What is reused

The token, the journal and the HTTP client all exist. `ChzTokenService` resolves the tenant's bearer and base URL; the integrations journal records passes and failures under `channelType: "chestny_znak"`; `TrueApiClient` gains one method, `cisesInfo`. Token values never reach the journal, a log or the UI, exactly as in the slices before this one.

New in this slice: the table, the ingest job and the refresh job.

## Errors

The three classes match the exports slice, and for the same reasons:

- **Pre-flight** — no signer agent, no valid token, or a product with no ЧЗ group. Nothing is asked; the condition is surfaced.
- **Transient** — network failure, 5xx, or a rate limit. The batch is retried; the affected rows keep their old status and stay due.
- **Terminal** — ЧЗ rejects the request itself (a bad product group, no contract). The affected rows are pushed to the long interval and the reason is journalled, rather than the job retrying a refusal forever.

A failed batch never advances `checked_at`. Staleness must be visible rather than papered over by a timestamp that records an attempt instead of an answer.

## Interface

One line in the Chestny ZNAK integration card: how many codes are known, how many were refreshed in the last day, and how long ago the last pass ran. Enough to answer "is this working" and "is the data I am about to rely on fresh".

Per-code lookup is not in this slice. It is the obvious next request and it is cheap to add later, but nothing here needs it.

## Testing

- The refresh job against an injected `fetch`: a full pass, a batch spanning two product groups, a transient failure leaving rows due and their status untouched, a terminal refusal moving rows to the long interval, and a code ЧЗ does not recognise.
- The ingest job: a code with no product group is stored and not polled; a code scanned twice yields one status row.
- The interval rule: a code that moves from circulation to withdrawn gets the long interval, and one that returns to circulation gets the short one back.
- Token confinement, asserted the way the exports slice asserts it — the journal and the outbound request are both checked to be free of the token.

**Known unknown.** The exact response shape of `cises/info` cannot be verified from here, the same position `packageType` was in for the exports slice. The parsing lives in one place so that settling it against the sandbox changes one function, and the manual runbook gains a step for it.

## Out of scope

- Fixing an inventory snapshot from this store instead of from six imports. That is the payoff, and it is the next slice; the snapshot invariant it touches is guarded in four layers plus a composite foreign key and deserves its own design.
- Retention, archival and purging. `codes` and `scan_events` are already partitioned monthly, so the eventual answer is detaching and archiving an old partition rather than deleting rows by status — which would scatter deletes across every partition, leave the table just as large until a `VACUUM FULL`, and break duplicate detection in `code_registry` for exactly the codes most worth catching a second time. It needs measured volumes and a retention decision that is legal rather than technical.
- Refreshing on events — shift close, before a shipment. Worth adding once shipments exist; on its own it would leave the store only as fresh as the list of events someone remembered.
- Alerting on a status that changed unfavourably. The store makes it possible; deciding what deserves an operator's attention is a product question, not this one.
