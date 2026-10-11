# Markiro Support History Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Preserve the existing isolated worktree and uncommitted integration; use a separate implementer and independent review.

**Goal:** Make every public message reachable in the private cabinet chat after an exhausted history cursor and a large new-message burst, without reload or manual gap recovery.

**Architecture:** Keep the current server-verified bounded Chatwoot backfill and private latest/backward local API. Repair the client reconciliation boundary rather than increasing page limits or scanning all remote history on every poll. A server-confirmed cursor covers only the page/range it was obtained for; an exhausted old range cannot suppress a subsequently discovered gap. Progress and asynchronous results remain scoped to tenant, user and episode.

**Chosen bounded implementation after source diagnosis:** normal polls read the latest page and at most one additional backward page. A separate resumable sweep covers the already-loaded range to its stable oldest boundary, or the actual end for manually exhausted history; manual pagination keeps its own cursor. Completed sweeps can restart so older timestamped rows inserted later are rediscovered even when cached pages overlap. Failed, stale or denied reads must not advance progress. Large ranges can take several polls; no schema or public-contract change is necessary.

**Tech Stack:** Existing Node24/Corepack pnpm11.22, React/TanStack Query, Vitest/Testing Library, Playwright1.62 pinned Chromium, real local Nest/auth/PostgreSQL and fake external Chatwoot. No new dependencies.

**Spec:** `../specs/2026-10-06-markiro-support-chat-design.md`; additional acceptance evidence: `.superpowers/sdd/2026-10-06-markiro-support-chat/final-fix-re-review.md`. The user explicitly authorized this separate follow-up stage after seeing the residual defect. Existing spec/plan status prose is historical; current source and reports determine completed work.

## Global Constraints

- Each read/send/consent checks current session/membership; preserve tenant/user/episode ownership, fail-closed remote contact checks and revocation clearing.
- Public history excludes private/activity messages and credentials; billing readers still require the accepted consent boundary.
- Preserve raw text, original timestamp and UUID deduplication; no remote IDs in public DTOs.
- Visible chat polls every five seconds; hidden-tab polling pauses. No blind uncertain POST resend.
- Preserve existing billing status/reply gates, immutable consent and all seven previously reviewed fixes.
- No production, shared databases, user `.env`, migration rewrites, commit/push/PR/deploy or cleanup of worktrees/ledger.
- Feature remains default off. Production-docs local runtime, real inbox admission/redaction and deployment are still separate unpassed release gates.

## Review Focus

1. Exhausted old history followed by more than fifty new messages: no silent middle gap (Task1).
2. Backfill inserts older timestamped messages after newer ones were already rendered: older inserted data remains discoverable (Task1).
3. Repeated polls/overlap/manual older reads: no duplicate rows, retained existing history, bounded work that resumes (Task1).
4. Late response or failure during episode/tenant/user change, logout or403: no old data/composer survives, recovery state remains scoped (Task1).
5. A partial source backfill must not be called complete merely because the latest page overlaps cached newer rows (Task1).

## Task 1: Reproduce and repair incremental history reconciliation

**Files:** Modify `apps/admin/src/pages/support/SupportChatPage.tsx`, `apps/admin/test/support-chat.test.tsx`, `tools/production-browser/support-chat-tests/support-chat.spec.ts`, and `docs/operations/support-chat.md` if the operational behavior needs clarification. A focused helper may be created under `apps/admin/src/pages/support/` if needed to keep the page readable. Do not change server contracts, schemas or routes without first giving the controller concrete evidence of necessity.

For mixed-activity browser coverage only, extend `tools/production-browser/support-chat-tests/fixture.ts` and `apps/api/test/support-chat-browser-server.test.ts` with optional test-command `activity?: boolean`; emit upstream `message_type=2` only for explicit activity and preserve the existing default1. Keep the dedicated harness guard and nonce control intact. This is not a production DTO/API change.

**Interfaces:** Consumes current `getEpisode(id, cursor?) -> SupportEpisodeView` with chronological latest/backward pages, local message UUIDs, nextCursor and sync state; current external backfill imports at most two raw pages per read and persists progress. Produces complete eventual client coverage of newly available public ranges while preserving old manual-history pagination. No new public identifier or timestamp-only ingestion assumption.

- [ ] Trace the current queryFn merge, olderCursors map, loadOlder, bounded remote backfill and native browser fixture. State the failing data flow before editing production.
- [ ] Extend the existing native history case: initial65 public messages, finish initial bounded backfill using real API reads, open support, load older until the button is absent, append80 public messages via the external fake. Thereafter do not call support detail manually, click history or reload; ordinary browser polling must make all old65 and new80 unique messages reachable.

```ts
await stack.command({
  kind: "seedRemote",
  episodeId: episode.id,
  messages: Array.from({ length: 80 }, (_, i) => ({
    text: `Burst message ${i}`,
    private: false,
  })),
});
await expect(page.getByText(/^Burst message \d+$/)).toHaveCount(80, { timeout: 30_000 });
await expect(page.getByText("History message 0", { exact: true })).toBeVisible();
```

- [ ] Run the browser case before production edits and record behavioral RED, distinguishing fixture/permission errors. Add component RED for the same exhausted-cursor burst, overlapping partial backfill, retry after failed recovery,403 and late context response.
- [ ] Implement explicit gap reconciliation with bounded resumable page work and a stable coverage boundary; cache overlap alone is not a proof of completeness. Preserve discovered ranges until they are covered, keep old manual history cursor separate from new gap progress, and do not advance progress on failed/stale/denied reads. Derive existing UI state rather than adding a parallel store or polling timer. If a different approach is necessary, explain the concrete trade-off before changing the interface.
- [ ] GREEN: focused component coverage; native case including the80-message burst and mixed private/activity data; run the critical burst case five times without retries masking failures. No absent middle messages, duplicate rows, reload, manual support-detail calls or production API response mocks.
- [ ] Run admin typecheck/lint/build on frozen source, plus browser typecheck and changed-file formatting; preserve retained visual artifacts. Full admin tests are required in Task2's fresh forced rootwide command, not duplicated separately here; no final completion claim until that full gate. Do not overlap heavy browser and full suites.
- [ ] Self-review, report exact source changes/RED/GREEN commands/counts/skips/limitations, announce source freeze. Independent task review reads the scoped diff once; no covering test reruns.

## Task 2: Verify final integration on the frozen repaired tree

**Files:** Only ignored verification artifacts/report in this plan's SDD workspace. Product edits require returning to Task1 review, not ad hoc gate fixes.

**Interfaces:** Consumes independently accepted Task1 source and all prior support implementation. Produces current-tree full verification and explicit unrun external release gates.

- [ ] Create a unique local test-owned PostgreSQL database, apply0177–0179 with complete synthetic environment and pinned pnpm shim. Preserve three preexisting named test databases.
- [ ] Run `corepack pnpm turbo lint typecheck test build --concurrency=1 --force`, then `corepack pnpm format:check`; no heavy browser concurrently. Capture complete summary, exact API skip names/reasons, warnings and own scratch cleanup.
- [ ] After the broad suite drains, run the full native support browser suite with `--repeat-each=5`, using output separate from retained screenshots. Verify UUID scratch residue is zero.
- [ ] Run production-bundle contract and CI-policy gates; fresh `git diff --check`. Fucina source is unchanged from its43/43 locally verified tests; do not duplicate those suites.
- [ ] Do not rerun known missing-stack production-docs browser merely to repeat its environment failure. Record it remains unverified, not waived/passed, alongside real inbox/public ingress/redaction/remote CI/deployment prerequisites.
- [ ] Final independent review checks this follow-up's aggregate diff and cross-module integration against the residual finding and prior full-review evidence. No completion or enable claim from partial/skipped DB proof. No commit/push/deploy or destructive worktree cleanup.

## Preflight and acceptance

The API remains the trust boundary; this plan changes client coverage, not consent or ownership. Task1 owns every Review Focus regression; Task2 does not alter its source. The shared cursor/poll interface is examined together, not as separate fixes. Acceptance requires all145 public texts in the native burst scenario, preserved authorization/context fences and a fresh final gate report. Local code acceptance does not imply production enablement.

## Final whole-review fix wave

The current full-source review found four adjacent load-bearing gaps after Task1 acceptance: accepted transcript fast cycles discard a continuation after two pages and falsely report healthy; cabinet episode lists expose only the first50; a send response from an old episode erases a newly selected draft; cached unlinked history suppresses upstream outage feedback. These violate the original support spec's full-history, context-isolation and recovery requirements, not new product features. Resolve them together under `.superpowers/sdd/2026-10-06-markiro-support-history-gap/final-fix-brief.md`, with the full findings in `final-review-findings.md`.

Expected added scope: accepted-import checkpoint/worker and real-PG regressions, cabinet list API/pagination and RU/EN controls, episode-generation mutation fences, unlinked error/retry feedback and native/component scenarios. No schema/public DTO/dependency expansion. Both initial and incremental reconciliation stay bounded and durable; legacy unknown checkpoints reconcile rather than fabricate a boundary. Healthy/lastSyncedAt require actual captured-cycle coverage. Task2 attempt1 was intentionally interrupted, cleaned and preserved as partial evidence. After ONE final fix wave and one scoped re-review, Task2 resumes with a fresh full gate on the updated freeze; no historical green substitution.
