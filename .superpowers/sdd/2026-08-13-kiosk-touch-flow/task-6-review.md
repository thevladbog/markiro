# Touch flow Task 6 review

## Verdict

**APPROVED AFTER FIXES.** Commit `60715596` correctly separates accepted,
queued, rejected and partial outcomes. The follow-up fixes close all three
Important recovery and validation gaps below; no Critical, Important or Minor
findings remain in the bounded Task 6 scope.

The second bounded re-review found two residual edges and both are addressed in
the final fix: zero-row/non-canonical acknowledgement now rejects; failed work
after unmount cannot re-arm an old timer; the screen carries its immutable
outcome owner across a re-pair; kiosk and employee ids are UUID-only. The link
recovery signal was also moved to the post-dequeue commit boundary exposed by
the full-suite timing regression. Terminal 400/409/413/422 paths emit that same
signal only after their outcome, quarantine and dequeue complete; failed local
parking leaves it unchanged.

## Important findings

### I1 — Replay makes an acknowledged result unviewed again and can reorder the oldest result

**ADDRESSED.** The upsert is now one read/write transaction and preserves the
existing stable `at` and non-null `viewedAt`. Regression coverage exercises
persist, acknowledge, replay and a second outcome whose ordering must not move.

Every sync/replay calls `putOutcome` with a new `at` and `viewedAt: null` (`apps/kiosk/src/sync/worker.ts:772-793`). `putOutcome` then unconditionally overwrites the row for the same owner/device sequence (`apps/kiosk/src/store/outcomes.ts:92-96`). This is duplicate-free, but it is not an idempotent state transition.

The queue deliberately survives a journal or dequeue failure. If the worker acknowledges the immediate result before the next retry, replay overwrites the stamped `viewedAt` with `null`, so the same result appears again at the next badge login. Replay also replaces the first-observed timestamp; `findOldestUnviewedOutcome` sorts by that mutable value (`apps/kiosk/src/store/outcomes.ts:120-130`), so an old replay can move behind newer outcomes and violate “oldest unviewed first”.

Required correction: upsert in one readwrite transaction while preserving an existing non-null `viewedAt` and the original stable result timestamp. Refresh only the server payload fields that may legitimately be repeated. Add the crash-window sequence persist → acknowledge → replay and prove that the row remains viewed, plus two results proving replay cannot change their presentation order.

### I2 — A failed acknowledgement permanently traps the kiosk on the outcome screen

**ADDRESSED.** Done awaits the shell acknowledgement. Rejection clears its
pending/spent state and starts a fresh ten-second timer, so either a new press or
auto-reset retries without falsely marking the row viewed.

`Done` marks its reset action as spent and clears the auto-reset timer synchronously before invoking the shell callback. The shell starts `acknowledgeOutcome(...).then(finish)` without a rejection path (`apps/kiosk/src/ui/KioskShell.tsx:1036-1044`). If IndexedDB rejects that update, `finish` is never dispatched, the timer is already gone, and every later press is swallowed by `Done`'s spent ref. The kiosk remains on that worker's result until a page reload.

Required correction: make acknowledgement a retryable screen state. Do not consume the only exit until the exact outcome has been durably stamped; on failure restore the Done action/timer or provide an explicit retry while keeping the result unviewed. Add pointer and auto-reset failure tests showing that no result is falsely viewed and the kiosk can recover without reload.

### I3 — The outcome-store validator does not enforce the owner/key contract or bound untrusted strings

**ADDRESSED.** Reads require the canonical normalized owner-derived id and exact
requested owner. Credential generation, dates, SSCCs and reason vocabularies are
validated; text rejects controls and is bounded by characters and UTF-8 bytes.
Adversarial injected rows cover owner/key mismatch, delimiter, malformed date,
SSCC/reason and ASCII/multibyte overflow.

`isStored` accepts any string as the record id, owner fields, employee id, order number, SSCC and conflict reason; it does not validate `viewedAt` as a date, SSCC check digits, allowlisted reasons, or that `id === idOf(owner, deviceSeq)` (`apps/kiosk/src/store/outcomes.ts:43-89`). `readOutcome` fetches by the requested key and returns the record solely on that structural check (`apps/kiosk/src/store/outcomes.ts:134-141`). A corrupted or locally injected row can therefore claim a different embedded owner/employee than its IndexedDB key, bypass the intended canonical owner binding on the immediate-result read, and carry unbounded text into the fixed public screen.

Required correction: validate and canonicalize every untrusted field with explicit byte/character bounds and existing SSCC/reason vocabularies; reject delimiter/control characters in owner parts; verify the stored id is exactly derived from its normalized owner and device sequence; and verify a direct read's embedded owner equals the requested owner. Add adversarial records for mismatched key/owner, malformed SSCC/reason/date and oversized strings.

## Reviewed behavior without findings

- Success and terminal paths persist the durable outcome before `dequeueOrder`; success replay uses the same owner/device-sequence key and therefore does not create a second record.
- Timeout, unreachable fetch and 502/503/504 paths do not manufacture a server result, so the immediate outcome remains queued amber. Terminal 400/409/413/422 and the exact subscription rejection are quarantined and persisted red when the installation owner is available.
- Restart lookup filters by normalized server URL, kiosk id, credential generation, employee id and `viewedAt === null`. Token rotation/re-pair generation and a different employee do not see the row through the normal API.
- The store is hard-bounded to 100 outcomes per owner generation and 200 accepted/rejected rows per result. The current policy deliberately retains the newest 100 even when older rows are unviewed; that custody tradeoff is documented in the implementation report, though browser/admin reconciliation remains outside this task.
- Loose rejected values are reduced to a six-character tail plus an allowlisted reason before entering the outcome store. Box error details are copied as SSCC/count/allowlisted reason only; member keys and raw box contents do not enter the outcome or its UI. The public loose list renders reasons, not raw KM values.
- Accepted is the only success-colored state. Queued is amber with the exact not-yet-confirmed copy; rejected and partial are red and use icon plus text, not color alone. RU/EN key parity remains covered.

## Verification

- Fresh focused store/outcome/sync/App review: **19 files, 191/191 tests passed**.
- Kiosk TypeScript no-emit check: passed.
- `git diff --check` and clean production worktree after `60715596`: passed.
- Implementer evidence: full kiosk **105 files, 583/583 tests**, ESLint, Vite PWA build, targeted Prettier and diff-check passed.
- No browser geometry, installed-PWA restart, tablet rotation or physical scanner acceptance was performed or inferred.
