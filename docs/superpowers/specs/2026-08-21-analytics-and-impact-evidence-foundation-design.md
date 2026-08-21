# Analytics and Impact Evidence Foundation — Design Spec

**Date:** 2026-08-21
**Status:** Approved by owner on 2026-08-21; P0 implementation planned in `docs/superpowers/plans/2026-08-21-analytics-p0-first-customer.md`
**P0 runbook:** [`docs/operations/first-customer-inventory/`](../../operations/first-customer-inventory/README.md); evidence tooling: [`tools/evidence-package/`](../../../tools/evidence-package/)

**Visual companion:** `docs/design-briefs/analytics.pen`
**Related:** `docs/architecture.md`, `docs/superpowers/specs/2026-07-28-station-sync-design.md`, `docs/superpowers/specs/2026-07-30-station-exceptions-design.md`, `docs/superpowers/specs/2026-08-14-station-shift-close-and-line-presence-design.md`

## 1. Purpose

Markiro needs an analytics foundation that proves operational impact and efficiency, supports customer management, enables fair employee development, and preserves defensible evidence for future customer presentations and a possible EB2-NIW filing.

The first customer deployment starts within days. The customer's current process has no telemetry or trustworthy analytics. Its offline desktop application can print the same SSCC on several physical boxes, allows closed shifts to be reopened, and moves reports to accounting by USB drive. The first Markiro operation will therefore be a founder-led full warehouse inventory and recovery exercise, not a normal production shift.

The design prioritizes facts that cannot be reconstructed later:

1. immutable or append-only evidence of what physically existed;
2. actor, device, tenant, product, batch/date, and time attribution;
3. idempotent preservation of offline business facts;
4. versioned formulas and reproducible metric snapshots;
5. customer confirmation of baseline, intervention, and result.

Dashboards are deliberately secondary. They can be built or rebuilt from preserved facts; a fact that was never captured cannot be recovered by a later dashboard.

## 2. First-customer context

The first operation has the following fixed characteristics:

- one founder/operator uses one Markiro Station device;
- the whole warehouse is inventoried;
- every legacy box is opened;
- every individual marked unit is scanned;
- each legacy physical box is assigned a temporary physical number;
- legacy box SSCCs are scanned into a raw text file for the old accounting/disaggregation process, not imported as Markiro boxes;
- repeated legacy SSCCs are photographed with their physical box numbers visible;
- new Markiro boxes receive new SSCCs from a new serial threshold;
- every new box contains exactly one product and one production batch;
- for this customer, product plus production date identifies the batch for the initial operation;
- production date is printed on each individual product;
- the customer may initially be named in evidence, with later anonymization and re-signing if required.

The first day is classified as a founder-led recovery operation. It establishes a risk baseline and proves controlled recovery. It is excluded from employee productivity comparisons.

## 3. Goals

### 3.1 Primary goals

- Prove the magnitude of the legacy SSCC duplication and accounting risk.
- Prove that Markiro can convert a physically inconsistent warehouse into a reconciled, uniquely identified state.
- Measure operational throughput, rework, exceptions, and report lead time without compromising offline production.
- Make every published metric reproducible from named inputs and a versioned formula.
- Give the customer a useful operational dashboard and drill-down path.
- Give Markiro an internal tenant-health and adoption view without leaking tenant data.
- Enable contextual employee scorecards only after the process and sample become stable.
- Produce a portable evidence dossier containing raw files, hashes, photographs, metric snapshots, customer attestations, and disclosed limitations.

### 3.2 Non-goals

- A Kafka, ClickHouse, or external warehouse deployment before the first customer.
- A universal employee leaderboard or a single opaque performance score.
- Treating clicks, page views, application crashes, or sync errors as proof of business impact.
- Importing legacy box SSCCs into the Markiro box registry.
- Replacing operational tables with an event store.
- Making production depend on analytics availability.
- Claiming that an evidence dossier alone establishes legal eligibility for EB2-NIW or any other immigration benefit.

## 4. Product principles

1. **Operational truth remains authoritative.** Shifts, scans, code ownership, boxes, memberships, exceptions, close events, conflicts, and reports remain the source of business state.
2. **Business facts are append-only where possible.** Corrections create new facts or explicit superseding snapshots; they do not silently rewrite evidence.
3. **Offline work never waits for analytics.** Station preserves business work in its existing durable journals and outboxes. Analytics projection happens after or alongside authoritative ingest.
4. **One event has one business meaning.** Names use past tense and stable schemas. A semantic change creates a new schema version or event name.
5. **Business events, audit/security events, and technical telemetry are distinct.** They may share infrastructure, but their meaning, retention, and permitted uses differ.
6. **Both business time and arrival time are preserved.** `occurredAt` answers when the work happened; `recordedAt` answers when the server learned about it.
7. **Every metric is a versioned contract.** Formula, unit, grain, dimensions, eligibility, exclusions, source watermark, and confidence are inspectable.
8. **Observed, derived, modelled, and attested claims are labelled differently.** Estimated time or monetary savings never masquerade as directly observed facts.
9. **Tenant isolation is structural.** Every server query, event, aggregate, snapshot, evidence object, and authorization check is tenant-scoped.
10. **Named-customer and cross-tenant use requires consent.** Internal tenant operations remain private; public naming and anonymized benchmarks have separate consent scopes.

## 5. Chosen architecture

### 5.1 Decision

Use typed business-event contracts plus versioned Postgres projections and immutable metric snapshots. Existing domain tables remain operational truth. An external analytical warehouse may be introduced later without changing event or metric semantics.

This is intentionally between two rejected extremes:

- direct ad-hoc SQL over mutable operational tables is fast initially but produces drifting formulas and weak historical evidence;
- Kafka/ClickHouse from day one adds operational risk without improving the first customer's evidence capture.

### 5.2 Logical flow

```text
Station durable facts       Admin/API transactions       External evidence
scan/outbox/boxes/close     shifts/audit/reports         raw TXT/photos/acts
          \                       |                          /
           \---- canonical typed business-event adapters --/
                                  |
                         validated event stream
                                  |
                    versioned deterministic projectors
                                  |
              rebuildable aggregates + immutable snapshots
                     /             |              \
              Customer Admin   Markiro Ops   Evidence dossier
                                      \
                               Employee scorecards
                           only after eligibility gates
```

### 5.3 One logical stream, several physical ledgers

The canonical event stream is a logical contract, not a requirement to copy every fact into one universal table.

- `scan_events` remains the high-volume, month-partitioned physical event ledger for scan attempts.
- `codes` and `code_registry` remain authoritative for accepted-code ownership.
- `box_exceptions`, `station_shift_close_events`, `code_conflicts`, sync quarantine, and tenant audit ledgers remain authoritative immutable or append-only sources for their facts.
- Mutable lifecycle transitions that are not already preserved immutably emit typed records into a new analytics event ledger in the same server transaction.
- Evidence-specific facts and manifests use the new analytics/evidence ledger.

This avoids doubling the largest scan dataset while still giving projectors one stable typed contract.

## 6. Canonical event contract

### 6.1 Required envelope

Every canonical business event exposes the following logical fields, whether they are stored directly or supplied by an adapter over an existing ledger.

| Group            | Fields                                                                                                   | Rules                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | `tenantId`, persisted deterministic `sourceKey`, optional native `eventId`, `eventName`, `schemaVersion` | Tenant is derived from the authenticated/authoritative source, never trusted from a device body.                                 |
| Business context | nullable `operationId`, `shiftId`, `productId`, `lineId`, `boxId`                                        | References must resolve inside the same tenant.                                                                                  |
| Actor            | `actorType`, nullable `actorId`, nullable `operatorId`, `deviceId`/`terminalId`                          | Cabinet users, station operators, devices, systems, founders, and customer signers remain distinct trust domains.                |
| Time             | `occurredAt`, `recordedAt`, optional timezone offset                                                     | Both timestamps are retained. The device clock is bounded by existing scan-window validation.                                    |
| Ordering         | optional `deviceSeq`/`sourceSeq`, `sessionId`, `correlationId`, `causationId`                            | Required when the source can retry or arrive out of order.                                                                       |
| Provenance       | `source`, optional `appVersion`, `payloadDigest`, evidence class                                         | Payload digest binds retries to identical normalized content.                                                                    |
| Payload          | schema-specific typed payload                                                                            | Bounded and validated. Raw KM/GS1 values are not copied merely for analytics; hashes and authoritative references are preferred. |
| Evidence         | zero or more artifact references                                                                         | A reference contains a private object pointer and SHA-256, never public object URLs.                                             |

`eventName` and `schemaVersion` are immutable. Unknown future versions are quarantined or ignored by older projectors without blocking production ingest.

### 6.2 Source identity and idempotency

Every event persists one canonical `sourceKey`; uniqueness is enforced by
`(tenantId, source, sourceKey)`. A source with a native `eventId` also stores it
for traceability and deterministically maps it to `sourceKey` as
`event:<eventId>`. `payloadDigest` is always stored separately from identity.

Different sources derive the canonical key as follows:

- station scan/box/exception records: authenticated terminal + `batchId` + `recordKind` + `recordIndex`;
- station shift close: `event:<eventId>`;
- mutable server lifecycle transition: `event:<generated UUID>`, inserted in the same Postgres transaction as the domain mutation;
- evidence artifact: operation id + artifact id;
- imported baseline: operation id + manifest version + stable file identifier.

Exact redelivery of the same canonical key and digest is an acknowledged no-op.
Reuse of the same canonical key with a different digest is a conflict, is
retained, and is never silently overwritten.

### 6.3 Initial event families

The initial catalog contains 18 approved event families. Families containing a slash represent two concrete event names with symmetric schemas.

#### Production facts

| Event family                                                    | Minimum payload                                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory.operation_started` / `inventory.operation_completed` | operation id, protocol version, site, founder/operator, device, app version; completion adds counts, duration, reconciliation status, manifest digest |
| `shift.opened` / `shift.closed`                                 | shift, product, line, production date, actor/device, plan snapshot; close adds actual quantity, closed boxes, reason, outcome                         |
| `item.scan_recorded`                                            | scan source identity, verdict, code hash when available, GTIN, box reference, operator                                                                |
| `box.opened` / `box.closed`                                     | box/device identity, shift, operator, timestamps; close adds SSCC, item count, print state                                                            |
| `sscc.assigned` / `label.printed`                               | box, SSCC, issuer/range reference; print adds template version, attempt, outcome, printer/error class                                                 |
| `item.assigned_to_box`                                          | code hash, box, membership time, operator/device                                                                                                      |

#### Control and correction facts

| Event family                              | Minimum payload                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `duplicate.detected`                      | duplicate scope, code/SSCC hash, winning and losing references, detection source               |
| `scan.rejected`                           | attempted code hash when safe, reason code, shift/product/box context                          |
| `conflict.detected` / `conflict.resolved` | conflict id/type, competing references, resolution actor, outcome and reason                   |
| `box.disassembled` / `box.reprinted`      | box, actor/operator, reason, source exception or document, print attempt/outcome when relevant |
| `shift.reopened`                          | shift, prior close reference, actor, reason, before/after status                               |
| `manual_adjustment.recorded`              | target type/id, before/after summary, actor, fixed reason, related audit id                    |

#### Evidence facts

| Event family                  | Minimum payload                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `baseline.file_registered`    | operation, artifact id, SHA-256, size, format, scan count, amendment relationship            |
| `evidence.photo_attached`     | operation, artifact id/hash, physical box references, duplicate group, capture metadata      |
| `reconciliation.completed`    | counts, delta, explained discrepancies, source watermarks, metric version                    |
| `customer.attestation_signed` | artifact/hash, signer name and role, organization, scope, signed time, consent flags         |
| `metric.snapshot_created`     | snapshot id, metric key/version, window, dimensions, value parts, watermark, manifest digest |
| `dossier.exported`            | dossier version/hash, included artifacts/snapshots, actor, naming/anonymization mode         |

### 6.4 Later scorecard prerequisites

Employee comparisons require active-time and condition context that is not yet fully captured. Before scorecards become eligible, the event catalog adds or derives:

- operator session start/end;
- shift work entry/leave or pause/resume intervals;
- training/recovery mode flags;
- equipment, printer, material, and network downtime intervals with reason ownership;
- process/configuration version changes.

Until those facts exist and pass quality thresholds, throughput may be shown at shift/device level but not used as a fair employee comparison.

### 6.5 Technical telemetry

Application start, crash, sync lag, queue depth, printer errors, heartbeat, and update version use a separate technical channel. Technical telemetry may explain an operational result and power Markiro Ops alerts, but it cannot independently count as impact or employee performance.

## 7. Storage and projection model

### 7.1 Analytics event ledger

Add a tenant-scoped append-only ledger for lifecycle and evidence events not already covered by an authoritative immutable source. Its logical fields mirror the envelope and include a bounded JSONB payload.

Required constraints:

- unique `(tenant_id, source, source_key)`;
- payload digest format and payload byte-size checks;
- bounded event/source/actor enums or validated code sets;
- tenant-scoped indexes by occurred time, recorded time, operation, shift, and event name;
- append-only database protection against update/delete, with a narrowly controlled retention/erasure path;
- no raw secrets, badge values, session tokens, or public object URLs.

The implementation plan must decide whether the initial lower-volume ledger needs physical monthly partitioning immediately. Scan-volume events stay in the existing partitioned `scan_events` ledger regardless.

### 7.2 Rebuildable projections

Initial projectors produce rebuildable facts at these grains:

- shift summary;
- operator × shift summary;
- product × production date/batch × shift summary;
- box lifecycle and cycle-time summary;
- tenant × local calendar day summary;
- sync/data-quality health summary;
- inventory-operation reconciliation summary.

Projector code is deterministic and versioned. A projector records its input watermark and can replay a tenant/range without mutating immutable metric snapshots.

### 7.3 Metric definitions

Metric definitions are code-owned and versioned. Database metadata may expose them to the UI, but the system never executes arbitrary SQL stored in tenant-editable data.

Each definition contains:

- `metricKey` and monotonic `metricVersion`;
- human label and precise description;
- unit and grain;
- numerator, denominator, aggregation, zero/null semantics;
- allowed dimensions and comparison context;
- eligible facts and exclusion reasons;
- confidence and minimum-sample rules;
- owner, effective date, deprecation date;
- computation-code or formula digest.

### 7.4 Immutable metric snapshots

Dashboards may read mutable/rebuildable projections. Customer attestations and evidence dossiers reference immutable snapshots.

A snapshot stores:

- tenant, metric key/version, time window, local timezone;
- dimensions and comparison/baseline id;
- value, numerator, denominator, unit;
- event/fact counts and input watermarks;
- data-quality status and confidence;
- computation time and formula/code digest;
- optional model assumptions;
- manifest digest and optional superseded snapshot id.

Late data can update an open dashboard projection. A signed or exported snapshot is never rewritten; a later recalculation creates a new snapshot that explicitly supersedes the old one.

## 8. Production date on shifts

### 8.1 Purpose

The first customer commonly has one batch per product per production day. Markiro therefore adds an optional shift production date to preserve the actual batch/date used for reports, labels, metrics, and evidence.

This is a production date, not a universal lot identifier. A future optional lot/batch entity may supplement it when a customer has multiple lots of the same product on one day.

### 8.2 Data contract

- Postgres: nullable `shifts.production_date date`; no backfill.
- API/OpenAPI: `productionDate: string | null` in `YYYY-MM-DD` form.
- Admin: optional create/edit/clear field with Russian and English copy.
- Station: optional new-shift field and mirrored nullable value in SQLite.
- Bundle compatibility: omission from an older server is treated as unknown and must not silently clear a previously mirrored value; explicit `null` clears it where clearing is still permitted.

`null` preserves the current behavior.

### 8.3 Effective dates

- Box label production date: `shift.productionDate ?? localDate(box.closedAt)`.
- Box label expiry: effective production date plus the product's shelf-life calendar days.
- Shift exports/reports: `shift.productionDate ?? shift.plannedDate`; if both are null, the existing missing-date error remains.
- Analytics/batch dimension: production date when present; otherwise the existing shift/box calendar fallback is labelled inferred rather than declared.

Using the explicit date for both label and report avoids a box whose label and accounting report claim different production days.

### 8.4 Mutability

The date may be set, changed, or cleared while a shift is planned or active only until the first box is closed. After any box closure, the API rejects the change with 409. This protects already printed labels, expiry dates, reports, and batch analytics.

The restriction is server-authoritative and applies equally to Admin and Station. UI disabling is only a convenience. Every successful change and rejected attempt is audited with actor, tenant, shift, before/after values, result, and reason.

### 8.5 Rollout order

1. Postgres migration and API/OpenAPI support.
2. Admin create/edit/list support.
3. Station bundle/mirror and new-shift support.
4. Label and export fallback changes.

The API must not silently strip a production date sent by a newer client. During a rolling deployment, a new Station treats an API that does not advertise/return the field as incompatible for production-date-dependent work rather than claiming the date was saved.

## 9. Metric catalog

### 9.1 Tier 0 — data quality

| Metric                          | Definition                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `capture_coverage`              | Confirmed captured physical units or boxes divided by the operation's declared expected total. The denominator source is displayed. |
| `reconciliation_delta`          | Authoritative post-operation units minus physically confirmed units. Target is zero; every non-zero component must be explained.    |
| `late_event_rate`               | Eligible business facts recorded after the shift/operation close or configured grace window divided by eligible facts.              |
| `quarantine_rate`               | Quarantined sync facts divided by submitted facts.                                                                                  |
| `missing_attribution_rate`      | Facts missing required operator/device/context divided by eligible facts.                                                           |
| `declared_production_date_rate` | Units/boxes whose shift has an explicit production date divided by eligible units/boxes.                                            |

No operational, impact, or employee metric is presented without an adjacent data-quality status.

### 9.2 Tier 1 — operations

| Metric             | Definition and caveat                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted_units`   | Current authoritative unique accepted codes for the selected grain and watermark.                                                                       |
| `closed_boxes`     | Closed, non-disassembled boxes at the selected watermark.                                                                                               |
| `throughput`       | Accepted units divided by eligible active hours. Shift-duration throughput may be shown before active-time capture exists; employee throughput may not. |
| `box_cycle_time`   | Time from box open to accepted close; show distribution/median, not only mean.                                                                          |
| `first_pass_yield` | Boxes reaching accepted closure without operator-responsible correction. Technical print retries are reported separately.                               |
| `exception_rate`   | Eligible exceptions divided by accepted units or boxes, with kind/reason drill-down.                                                                    |
| `rework_rate`      | Units/boxes affected by undo, clear, disassembly, or business rework divided by eligible units/boxes.                                                   |
| `plan_attainment`  | Actual accepted quantity divided by plan snapshot. It is a planning/shift metric, not automatically an employee metric.                                 |
| `report_lead_time` | First valid report-ready/exported time minus authoritative shift close time.                                                                            |

### 9.3 Tier 2 — impact

| Metric                             | Definition and evidence class                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `duplicate_risk_eliminated`        | Legacy physical boxes minus unique legacy SSCC values, compared with duplicate new SSCC assignments. Observed for the first operation.           |
| `prevented_error_signals`          | Duplicate/rejected/conflict business facts that Markiro blocked or surfaced. This is not automatically equal to customer financial loss avoided. |
| `accounting_correction_time_delta` | Customer-attested legacy correction lead time minus measured Markiro correction/report lead time at comparable volume.                           |
| `manual_transfer_steps_eliminated` | Signed legacy process steps minus current process steps, with the process maps attached.                                                         |
| `verified_hours_saved`             | Comparable baseline labor hours minus current eligible labor hours. It remains modelled until assumptions and result are customer-attested.      |

### 9.4 Tier 3 — adoption and health

- active Station shifts and active tenants;
- offline continuity and restart recovery success;
- sync latency, stuck queues, and late data;
- report-generation success and stale-report regeneration;
- adoption of production-date, box, exception, and dossier workflows.

These metrics serve Markiro Ops and product improvement. They are not used as customer impact or employee performance without an explicit business link.

## 10. Employee scorecards

### 10.1 Product decision

Start with a transparent multidimensional scorecard, not a leaderboard and not a single composite score.

The initial dimensions are:

- normalized throughput in comparable conditions;
- valid-scan and first-pass yield;
- operator-responsible exception/rework rate with causes;
- stability and trend over time;
- contribution to shift results with visible confidence.

### 10.2 Eligibility gate

An employee comparison returns `insufficient_data` unless all required conditions pass:

- operator identity and role are known;
- eligible active time is known;
- process/configuration version is known;
- product, production date/batch, mode, line, capacity, and other material conditions are equal or an approved normalization exists;
- at least configured `N` comparable shifts and `M` eligible events exist;
- data-quality metrics exceed configured thresholds;
- sync is complete for the evaluation window;
- the window excludes inventory recovery, training, tests, material/equipment stops, printer/network failures, and manager-declared abnormal work.

Thresholds are product configuration determined after real data review, not hard-coded in this design.

### 10.3 Fairness and access

- The first founder-led inventory is permanently ineligible for employee comparison.
- Technical faults never count against an employee merely because they occurred on the same device.
- Managers see sample size, comparison cohort, exclusions, formula version, and confidence.
- Employees or their manager can inspect the source basis and attach a contextual review note; source facts are not edited.
- Access is capability-scoped. There is no public or cross-tenant employee view.
- A future composite score requires a separately approved formula and validation against perverse incentives.

## 11. Analytical surfaces

### 11.1 Customer Admin

The customer overview answers four questions in order:

1. Can the data be trusted?
2. What happened in the selected period?
3. What requires attention?
4. Where did the result come from?

Initial components:

- data-quality/confidence banner;
- accepted units, closed boxes, throughput, first-pass yield, exceptions, conflicts, and report lead time;
- period trends with the metric version visible;
- funnel from scan attempts to accepted units, boxes, and ready report;
- drill-down period → product → production date/batch → shift → box → event;
- attention queue for conflicts, quarantine, late data, and reconciliation gaps;
- explicit observed/derived/modelled/attested badges.

### 11.2 Markiro Ops

The internal surface includes tenant health, data-pipeline health, adoption, outcome alerts, deployment/app versions, and evidence-package status. Cross-tenant benchmarks use only anonymized aggregates from tenants that explicitly opted in. No raw cross-tenant drill-down exists.

### 11.3 Employee scorecard

The scorecard shows trends and dimensions, not rank. It displays cohort definition, sample size, exclusions, abnormal-condition flags, confidence, and `insufficient_data` states.

### 11.4 Evidence dossier

The dossier presents:

- baseline;
- intervention protocol;
- observed outcome;
- versioned derived metrics;
- repeatability across later shifts/customers;
- customer attestations;
- source hashes and manifest;
- assumptions, exclusions, limitations, and superseded snapshots.

The same dossier can be generated in named-customer or anonymized mode according to stored consent.

## 12. First-day evidence protocol

### 12.1 Before the first scan

The start gate requires:

- production date verified end-to-end through DB, API, Admin, Station mirror, label, and export;
- one stable `operationId` for the inventory;
- customer/site, founder/operator, device, timezone, app/build version, and protocol version recorded;
- Station/device clocks checked;
- raw-evidence directory created;
- one complete rehearsal box: scan → close → print → restart → sync → export;
- physical scanner, printer, labels, photography, offline restart, and recovery checked on the actual hardware;
- new SSCC threshold/range documented;
- empty manifest and `SHA256SUMS` prepared.

Automated tests do not replace this physical gate.

The implemented P0 runbook uses the bundled read-only
[`evidence:station-date`](../../../tools/evidence-package/station-date.mjs)
diagnostic and a six-surface proof matrix for the Station mirror check.

### 12.2 Legacy baseline capture

The legacy scan file remains deliberately simple:

- `baseline/old-sscc.raw.txt` contains exactly one scanner payload per line;
- it has no header and is never corrected or reordered;
- accidental extra/missing lines are documented in a separate amendment rather than editing the raw file;
- the file is hashed at controlled checkpoints and at operation close.

A separate `baseline/old-box-index.csv` maps raw line number to:

- physical box number;
- product;
- production date;
- optional note;
- duplicate photo references.

Every repeated SSCC is photographed with the relevant physical box numbers. Photos preserve original metadata where available and receive content hashes. Public or shared copies may later be redacted, but originals remain private evidence under retention policy.

For P0, “scanner payload” means the character string delivered by the configured
HID or serial integration. The first controlled hash makes the stored UTF-8 file
immutable; it does not claim proof of scanner-wire bytes.

### 12.3 Controlled transformation

For every legacy box:

1. confirm and record its physical number and legacy SSCC line;
2. open the box;
3. scan every individual product code in Markiro;
4. verify product and printed production date;
5. route mismatches, unreadable codes, unexpected products/dates, and other anomalies to explicit exceptions;
6. form new boxes containing only one product and one production date/batch;
7. close the box, assign the new SSCC, print the label, and visually verify it;
8. preserve membership, close, print, operator, and timing facts.

Raw evidence is never altered to make the reconciliation pass.

### 12.4 Close and sign-off

The close gate reconciles at least:

- physical legacy boxes;
- legacy scan lines;
- unique legacy SSCCs;
- duplicate groups and duplicate physical boxes;
- individual units scanned;
- accepted unique units;
- rejected/exception units;
- new closed boxes;
- unique new SSCCs;
- disassembled/reprinted boxes;
- unexplained difference;
- start, end, elapsed time, and report-ready time.

`reconciliation_delta` must be zero or every component must be explicitly explained and accepted.

The customer act records baseline totals, duplicate evidence, intervention, result, open discrepancies, system/build and protocol versions, signer identity/role, signature time, and consent for customer naming or anonymized use.

### 12.5 Evidence-package layout

```text
evidence/<operation-id>/
  manifest.json
  SHA256SUMS
  backup-locations.txt
  baseline/
    old-sscc.raw.txt
    old-box-index.csv
  amendments/
  photos/
    duplicates/
  exports/
    system/
  metrics/
    snapshot-v1.json
  attestation/
    customer-act.pdf
    consent.json
```

`manifest.json` binds every artifact to operation id, category, original name, byte size, SHA-256, capture/import time, actor, and applicable physical box/evidence references. At close, identical encrypted/private copies are written to two controlled locations and recorded in `backup-locations.txt` without exposing credentials.

## 13. Evidence storage, privacy, and consent

- Evidence objects are private, content-hashed, and referenced by opaque object keys.
- Object bytes are never embedded in analytics events or application logs.
- Access is tenant- and capability-scoped and is itself audited.
- Customer-publication consent and anonymized-benchmark consent are separate nullable/dated decisions.
- Anonymization produces a derived export and new dossier hash; it never mutates the signed original.
- Employee reports contain the minimum identity needed for the authorized user.
- Retention inherits the tenant's configured business-data retention, five years by default, with an explicit legal/evidence hold capability to be designed before automatic deletion of signed dossiers.
- Erasure and retention jobs must preserve manifest integrity by recording tombstones and new dossier versions rather than leaving silently broken hashes.

## 14. Late data, correction, and replay

- Open dashboards are provisional while the shift/operation is active or within the configured late-data window.
- Late Station facts are accepted under existing offline rules, retain original occurrence time, and update rebuildable projections.
- A shift/operation exposes a visible late-data marker when a previously reported total changes.
- Signed/exported metric snapshots remain immutable. Recalculation creates a new version with a supersedes link and reason.
- Projector replay over the same input watermark and code version must produce byte-equivalent normalized results.
- Failed or unknown records are quarantined with tenant/device/source identity and safe bounded payloads; one bad record never discards unrelated facts.

## 15. Rollout

### P0 — before the first customer scan

- production date end-to-end;
- operation identity and protocol version;
- legacy raw-file and photo procedure;
- physical rehearsal and clock checks;
- SSCC threshold/range documentation;
- evidence directory, manifest, hashing, backup, and sign-off templates;
- explicit exclusion of the operation from employee scorecards.

P0 optimizes capture, attribution, and recoverability. A polished dashboard is not a P0 dependency.

### P1 — days 2–14

- canonical server adapters over existing scan/box/exception/close facts;
- append-only analytics/evidence event ledger;
- metric catalog v1;
- inventory-operation, shift, product/date, and tenant projections;
- immutable metric snapshots;
- evidence-manifest registration and dossier export;
- first customer impact report.

### P2 — weeks 2–6

- customer trends, funnel, distributions, and drill-down;
- data-quality/confidence banners;
- Markiro Ops tenant/pipeline/adoption health;
- late-data replay and superseded-snapshot UI;
- customer-attested baseline and time/cost model workflow.

### P3 — stable sample only

- active-time and downtime context;
- comparable employee cohorts and configurable sample gates;
- employee scorecards;
- validated time/cost savings model;
- repeatability evidence across later shifts and customers;
- consented anonymized benchmarks.

## 16. Security and authorization

- Every event, projection, metric snapshot, evidence manifest, artifact, and attestation is tenant-scoped in the database statement.
- Station endpoints derive tenant and device from the paired credential.
- Cabinet endpoints reload membership/capability state and never trust tenant ids from the client.
- Generic actor references cannot be used to cross trust domains; source adapters validate the actor inside the tenant before recording attribution.
- Public dossier generation requires explicit publication capability and current consent.
- Markiro Ops cross-tenant views expose only approved aggregate fields; raw tenant payloads require separately authorized support access and audit.
- Audit assertions verify exact actor, tenant, action, target, outcome, before/after, source, metric version, and artifact hash.
- Raw badge/PIN values, code payloads, credentials, tokens, and signed-object URLs never enter analytics logs.

## 17. Testing and acceptance

### 17.1 Production date

- Postgres migration/schema tests for nullable date and tenant-safe shift updates.
- API DTO/OpenAPI tests for valid dates, malformed dates, explicit null, legacy omission, and 409 after the first box closure.
- Export tests for `productionDate ?? plannedDate` and the existing error when both are null.
- Domain/Station label tests for explicit production date, close-date fallback, shelf-life calculation, timezone boundaries, leap days, reprint identity, and invalid values.
- Admin and Station UI tests for create/edit/clear, translated copy, active-shift rules, and rolling compatibility.
- SQLite migration/mirror tests for old rows, omitted legacy field, explicit null, and restart.

### 17.2 Events and projections

- schema/migration tests for append-only behavior, payload bounds, tenant keys, source uniqueness, and digest conflicts;
- adapter tests proving exact retry is one logical fact and changed-payload retry is a visible conflict;
- tests that existing Station journal/outbox acknowledgements remain independent of analytics projector availability;
- replay tests producing the same aggregates from the same watermark;
- late-data tests updating provisional projections and creating—not mutating—signed snapshot successors;
- cross-tenant denial at event, projection, snapshot, evidence, and dashboard boundaries;
- quarantine tests preserving unrelated records.

### 17.3 Metrics

- golden fixtures for every v1 formula, numerator, denominator, null/zero rule, dimension, and exclusion;
- property tests for aggregation invariants where practical;
- first-day reconciliation fixtures with duplicate legacy SSCCs, amendments, rejected units, and explained deltas;
- observed/derived/modelled/attested classification tests;
- employee eligibility tests covering insufficient sample, incomparable product/batch/mode, technical downtime, recovery/training, and incomplete sync.

### 17.4 Evidence

- artifact hash verification, duplicate upload, corrupted upload, private access, tenant denial, and manifest consistency;
- dossier generation tests pinning metric and protocol versions, input hashes, consent mode, limitations, and superseded snapshots;
- anonymized export tests that never mutate or replace the signed original;
- retention/hold tests before automatic signed-evidence deletion is enabled.

### 17.5 External first-customer gate

- actual Windows Station, scanner, printer, label stock, one-device restart, offline operation, reconnect, and report export;
- production-date label/report agreement on a real box;
- raw legacy SSCC file and duplicate photographs inspected before transformation;
- full warehouse reconciliation reviewed with the customer;
- final hashes independently rechecked;
- signed customer act and consent captured;
- two private evidence-package copies opened and verified.

Automated tests, local browser checks, and a green build do not prove these physical or customer-attestation gates.

## 18. Open configuration parameters

These do not block P0 capture but must be selected from real data before their dependent feature is enabled:

- employee scorecard minimum `N` shifts and `M` events;
- data-quality/confidence thresholds;
- late-data grace windows for operational dashboards;
- per-tenant evidence retention and legal-hold policy;
- customer baseline labor/time/cost assumptions;
- anonymized benchmark inclusion rules;
- future lot/batch identity beyond product plus production date.

## 19. Completion criteria for this design

The foundation is considered implemented only when:

1. P0 facts and production date survive device restart, offline work, sync, export, and evidence packaging;
2. authoritative facts can be projected through stable typed adapters;
3. v1 metrics replay deterministically and show data quality;
4. a signed snapshot cannot be silently changed by late data;
5. Customer Admin and Markiro Ops read tenant-safe aggregates;
6. employee views remain gated until fair-comparison prerequisites pass;
7. the first customer's evidence package can be independently verified from its manifest and hashes.
