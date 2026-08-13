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

## External checks not performed

No browser geometry, tablet rotation, physical HID/Web Serial, installed-PWA restart or hardware acceptance was performed. Those remain Task 7/external gates.
