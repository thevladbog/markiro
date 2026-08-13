# Touch flow Task 6 implementation report

## Outcome

The result screen now distinguishes four honest states without recolouring neutral controls: only a server-confirmed acceptance is green; an unreachable/timeout queue is amber and explicitly says it is not confirmed success; terminal refusal is red; partial acceptance is red with both accepted and rejected counts. Box conflicts show only the SSCC tail, whole-box bottle count and allowlisted reason. Member keys and raw box contents never enter the result.

## Durable discoverability

- IndexedDB version 4 adds an `outcomes` store without replacing the existing config, snapshot, queue, journal, quarantine, registry or branding stores.
- Server outcomes are sanitized and persisted before journal/dequeue. Replay upserts the same owner/device-sequence key, so the crash window does not duplicate results.
- Ownership is `normalized serverUrl + kioskId + credentialGeneration`; a different employee, tenant binding, kiosk, or re-pair generation cannot read the result.
- The store accepts at most 200 conflict/box rows per result and retains the newest 100 results per owner generation. Untrusted rows are validated on read.
- Terminal 400/409/413/422 and exact subscription rejection persist a red result alongside quarantine. Network timeout/unreachable leaves only the queue, so the immediate screen remains amber.
- The same employee sees the oldest unviewed durable result after a later badge admission, before an empty cart. Rendering does not acknowledge it. `Готово`/auto-finish atomically stamps the exact owner and device sequence, then returns to login.

## TDD and verification

- RED: missing outcomes store/module and migration, absent semantic tone/copy, unsafe/incomplete box conflict presentation, missing sync persistence, and restart login routing were reproduced while existing focused assertions stayed green.
- Focused Task 6/store/sync/reducer/App: 30 files / 239 tests passed.
- Complete kiosk suite: 105 files / 583 tests passed with zero skips.
- Direct kiosk TypeScript check passed.

## Review fix

All three Important review findings are addressed. Replay now performs a single
read/write transaction and preserves the first-observed timestamp plus any
durable `viewedAt` acknowledgement. A failed acknowledgement leaves the result
unviewed and re-enables both the explicit action and its auto-reset timer. The
store accepts only canonical owner/key pairs, UUID credential generations,
canonical ISO dates, valid SSCCs and allowlisted conflict reasons; all public
text is control-free and bounded by both characters and UTF-8 bytes. RED
reproduced five original failures plus the multibyte boundary; focused outcome,
screen, sync, App, store and reducer verification passed 231/231, followed by a
clean TypeScript check.

The bounded re-review found two residual acknowledgement boundaries. They are
also closed: acknowledgement requires exactly one canonical row and a canonical
ISO timestamp; missing/corrupt rows stay on the result screen. A failed promise
cannot re-arm a timer after unmount, and the shell acknowledges the owner
captured by the displayed result rather than a later pairing. Kiosk and employee
identifiers are now UUID-only. Moving the online indicator to the post-dequeue
commit signal also keeps “link restored” from racing ahead of durable local
completion. Terminal responses publish the same signal only after durable
outcome/quarantine/dequeue; a failed quarantine publishes nothing. The final
full kiosk suite passed 105 files / 589 tests.

## External checks not performed

No browser geometry, tablet rotation, physical HID/Web Serial, installed-PWA restart or hardware acceptance was performed. Those remain Task 7/external gates.
