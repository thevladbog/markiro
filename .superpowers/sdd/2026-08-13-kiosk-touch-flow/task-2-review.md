# Touch flow Task 2 review

## Verdict

**CHANGES REQUESTED — 3 Important, 1 Minor.**

Commit reviewed: `e1389921` against Task 2 and the accepted kiosk
installation/credential ownership contracts.

## Important findings

### I1 — Scanner input is not an exact eight-digit pairing code

`Pairing` derives `digits = raw.replace(/\D/g, "")` and accepts the result when
its length is eight (`apps/kiosk/src/screens/Pairing.tsx:152-157`). That accepts
payloads such as `12AB345678`, `(12) 345-678`, or eight digits embedded in
otherwise invalid scanner data. The transport already removes its line
terminator before invoking the listener, so deleting arbitrary characters is
not scanner framing; it changes the pairing credential.

The API contract is exact `/^\d{8}$/`. Validate the scanner payload under the
same exact contract (with only an explicitly documented transport trim, if one
is actually produced), and keep the current reject-and-continue behavior for
everything else. Add scanner tests for alphabetic/punctuation prefixes,
suffixes and interleaving, as well as the valid eight-digit value.

### I2 — Branding fetch/persist/UI activation is not credential-generation atomic

The cache row contains `serverUrl + kioskId + credentialGeneration`, but that
owner is checked only when the old row is read. After the network/decode work,
`refreshCachedBranding` unconditionally puts or deletes `BRANDING_KEY`
(`apps/kiosk/src/store/branding.ts:145-193`), and `KioskShell` unconditionally
applies its returned value to React state (`apps/kiosk/src/ui/KioskShell.tsx:212-231`).

Concrete race: tenant A refresh starts; the tablet is revoked/re-paired to
tenant B and B's logo is persisted/rendered; A then finishes and overwrites B's
row and renders A's logo. The same stale invocation can delete B's row when its
old bootstrap advertises `logoRevision=null`. Conversely, a failed old-owner
refresh can restore A's retained cache after the binding changed. This breaks
tenant isolation even though the next reboot's owner check hides the row.

Bind delete/put/retention to the *current persisted* canonical
`serverUrl + kioskId + credentialGeneration` in the same IndexedDB transaction,
discard a stale loser without modifying the winner, and apply the returned logo
to UI only if that owner is still current. Cover two deferred refreshes across
token rotation and cross-tenant re-pairing, including stale-success,
stale-failure and stale-null-logo cleanup finishing last.

### I3 — Private logo delivery is neither strictly routed nor bounded while reading

`logoRequestUrl` accepts any same-origin absolute path from the bootstrap and
the fetch sends `x-kiosk-token` to it. A compromised/malformed bootstrap can
therefore direct the device credential to an unrelated same-origin endpoint.
The actual API route is confirmed as
`GET /kiosk/branding/logo/:revision`, UUID-parsed and tenant-scoped, and the
bootstrap advertises exactly that route. Require that exact path form and that
its final UUID equals `branding.logoRevision` before sending the token.

The 2 MiB client limit is checked only after `response.blob()` has read and
allocated the entire response (`apps/kiosk/src/store/branding.ts:166-179`).
`Content-Length` is not sufficient by itself; stream the body with an aggregate
byte budget (optionally reject an oversized declared length first), abort once
the budget is crossed, and only then build/decode the Blob. Test missing/lying
Content-Length and a chunked body exceeding the budget. The API uses a bounded
upload/image pipeline and returns `Content-Length`, but the kiosk boundary must
still bound untrusted or proxy-altered response bytes.

## Minor finding

### M1 — Invalid new logo paths leave stale storage and image decode failure has no durable fallback

For a new revision with an invalid/cross-origin path, refresh returns the
bundled fallback but neither retains the old valid same-owner logo nor removes
the old row. A subsequent reboot can show the stale old logo again. Also,
`Idle`'s `<img onError>` only clears the component URL; it does not revoke that
object URL immediately or invalidate/repair the persisted blob, so every mount
can retry the broken asset before falling back.

Make the invalid-path case follow one explicit lifecycle rule (retain the prior
valid logo on refresh failure, as network/MIME/decode failures do, or delete it
durably), and revoke/invalidate a display-time decode failure before rendering
the bundled Markiro fallback. Add reboot and `img.onerror` tests.

## Contracts verified

- Pairing still redeems once, validates bootstrap freshness, writes snapshot
  before token/config, and distinguishes unspent network retry from a spent
  code/store failure.
- Eight explicit code cells, numeric keypad, backspace, clear and submit gating
  are present. The bundled Markiro identity is rendered on pairing.
- Idle contains no “scan zone” text and never renders raw badge payloads.
- The API logo route exists, is kiosk-token protected, UUID-revision parsed and
  tenant-scoped. Cached rows do not expose another owner during an ordinary
  owner-checked load.
- Successful WebP decode, network/MIME/decode retention, null-revision cleanup,
  and ordinary object-URL cleanup on prop change/unmount are modeled.
- Landscape uses equal columns with centered animation and left-aligned copy;
  portrait centers the layout. Reduced motion disables the scan animation.
- New controls meet the 48 px minimum; RU and EN key sets remain identical.

## Verification

- `git diff --check 644e5266..e1389921` — passed.
- Focused `pairing-screen`, `idle-screen`, `branding`, and `i18n` suites —
  **47/47 passed**.
- Kiosk `tsc -p tsconfig.json --noEmit` — passed.
- API source/tests were inspected to confirm the real private route and its
  tenant/revision behavior; database-backed API tests were not rerun.
- No viewport browser, tablet, physical-scanner, slow-stream/proxy or live
  object-storage validation was performed. This review changes docs only.
