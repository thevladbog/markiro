# Handheld site-wide reprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A reason selected once, then each scan/manual lookup immediately prints the existing unit/box/pallet label anywhere on the site.

**Architecture:** A Kotlin `SiteReprintBackend` seam adapts the host warehouse protocol and cloud warehouse protocols to immutable sources and frozen audit envelopes. Room jobs freeze source, printer, layout, bytes and operator before sending. A single reason/scanning UI orchestrates these jobs; retry and verification never masquerade as a fresh scan.

**Tech Stack:** Kotlin/Compose/Hilt/Room, existing label emitters and scanner/printer ports, Rust host and NestJS API.

**Spec:** `docs/superpowers/specs/2026-11-01-handheld-site-reprint-design.md` (corrected V2 scan-to-print flow).

## Global Constraints

- Reason once per session; no per-label confirmation, object selection or printer/template picker.
- Existing site-wide source contracts; no new code/SSCC or reconstruction from current shift.
- Device credentials stay distinct from operator identity. Scope/owner/generation preserved on every journal write and network acknowledgment.
- Printer and templates from device settings; exact frozen bytes survive restart. Sending at restart becomes unknown, never auto-reprinted.
- Unknown requires explicit retry or matching-label verification; failed before send supports explicit retry. Background sync only sends audit envelopes.
- RU/EN, 320 dp, touch targets >=48 dp, bundled fonts/assets. No new dependencies unless justified.

## Review Focus

- Scan arrives while sending: reject with visible busy feedback, never silently queue or double-send.
- Ownership/operator changes during lookup/render: no printing under the new session, retain old job evidence.
- Source is released/disassembled or raw scan differs from returned identity: refuse before rendering.
- Crash after sending but before result persistence: unknown and stable audit IDs; no automatic print replay.
- Chosen template becomes incompatible/deleted: explicit refusal; valid frozen jobs replay their original bytes.

### Task 1: Shared backend boundary and server contracts

**Files:** create `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/reprint/SiteReprintBackend.kt`, `HostSiteReprintBackend.kt`, `CloudSiteReprintBackend.kt`; affected API/host route-policy modules and contract tests.

**Interfaces:** `SiteReprintSource` contains purpose, subjectId, identity, productId/name/groupCode, `Map<LabelField,String>`, original sourceJson/revision and optional default template. `SiteReprintLookup` is Found/NotFound/Unavailable. `SiteReprintAuditInput` contains stable record/session/job/attempt, reason/outcome/error, frozen layout/template identity, printer language/DPI/id, bytes, operator and instant. `SiteReprintBackend.lookup(raw,operatorId)`, `refreshTemplates()`, `auditPayload(source,input)` (pure), `report(payload)` (accepted/rejected result). Host/cloud implementations share types but not wire events.

- [ ] Write focused failing host/API tests for handheld allowed warehouse access and other device kinds denied, exact scoped operator/tenant audit and receipt idempotency.
- [ ] Add Kotlin adapter tests for native/imported sources, raw/canonical identity, data restrictions, template scope and exact saved wire envelopes.
- [ ] Implement narrow route permissions and typed adapters. Preserve station behavior; all network via existing authenticated/pinned clients and generation guards.
- [ ] Run affected focused server and Kotlin adapter gates.

### Task 2: Durable Android journal and print engine

**Files:** create `core/reprint/SiteReprintStore.kt`, `SiteReprintEngine.kt`; modify Room database, migrations/storage registration, dataset/recovery classification, printer template catalog/settings and sync scheduling.

**Interfaces:** engine `print(raw,reason,sessionId,operatorId): SiteReprintResult`, `retry(jobId,operatorId)`, `verify(jobId,raw,operatorId)`, `pending()` and `flushAudit()`. Results identify Printed/Failed/Unknown/NotFound/Unavailable/Busy. Engine returns the persisted jobId for recovery, and never calls transport on a previously unknown job without explicit retry.

- [ ] Write failing tests for crash/restart, unknown, busy, duplicate callbacks, exact frozen bytes, printer reassignment, dataset/operator generation race and receipt mismatch/retry.
- [ ] Add Room migration retaining old data; register business tables for reset and recovery. Freeze owner/source/layout/printer/bytes and stable audit envelopes before hardware writes.
- [ ] Reuse printer endpoint serialization/status and generation-aware transport. Produce durable known outcomes and independent audit acknowledgment; do not treat failed audit upload as failed physical print.
- [ ] Add unit template assignment alongside box/pallet templates. Incompatible/missing assignments fail precisely, never select an arbitrary incompatible layout.
- [ ] Run focused engine/migration/storage/printer tests.

### Task 3: Native V2 screens and navigation

**Files:** create `feature/reprint/SiteReprintViewModel.kt`, `SiteReprintScreens.kt`; modify AppNavigation, HubScreen and RU/EN strings.

**Interfaces:** `SiteReprintUi` exposes reason, scan/manual state, last result, busy and unresolved job. VM `selectReason`, `beginScanning`, `submit`, `retry`, `verify`, `backToReason`; screen callbacks open the existing printer settings route and return to retained reason.

- [ ] Write failing Compose/VM tests for reason gating, gear/return, automatic print on scan, manual find-and-print, no success-confirmation button, busy feedback and unknown verification isolation.
- [ ] Add global menu row available without a shift; only collect scanner on the active search/verification step and with current operator/generation.
- [ ] Match approved V2 screens at 320/360 dp and large text; physical print results shown inline, not as another mandatory step.
- [ ] Run focused UI tests and inspect native renders.

### Task 4: Integration and completion

- [ ] Run Android `testDebugUnitTest lintDebug assembleDebug`; local `JAVA_TOOL_OPTIONS=-XX:TieredStopAtLevel=1` may be used for the documented JDK C2 crash.
- [ ] Run affected API/host gates and domain protocol fixtures; explicitly distinguish missing infrastructure from passing tests.
- [ ] Review full diff, scoped docs, affected-job ownership, formatting and `git diff --check`; refresh local AST Graphify graph.
- [ ] Independent implementation review, address findings, then commit/push/open PR per existing user authorization. No merge/release/deployment/hardware acceptance implied.
