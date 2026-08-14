# Touch flow Task 2 implementation report

## Outcome

Pairing and badge login now use the approved dark, fixed-viewport touch treatment. Pairing keeps the existing redeem/error/storage lifecycle while adding the bundled Markiro identity, eight explicit code cells and a 4×3 floor keypad with Backspace and Clear. Login renders tenant name, an install-bound cached company logo when available, a bundled Markiro fallback, and the wordless badge-scan animation in the approved portrait/landscape grids.

## Compatibility and custody choices

- Pairing still subscribes to the shell scanner from mount, pauses only for the server-address editor, accepts exactly eight scanner digits, and preserves invalid-code, unusable-bundle and spent-code messages.
- The durable pairing order remains bootstrap snapshot first and device token/config second. Company-logo delivery starts only after the paired state can be reloaded; it never turns a successful pairing/bootstrap into a failure or delays the handoff.
- The scanner setup entry and on-prem server URL control remain available before pairing. Their touch targets and the pairing keypad are at least 48 px; the compact 800×480 keypad uses 72 px keys.
- Branding is stored as bounded WebP bytes in the existing snapshot object store. A cache row is readable only for the current `serverUrl + kioskId + credentialGeneration` owner and matching revision.
- Logo fetch accepts only the bootstrap's relative kiosk route on the configured API origin, sends the private kiosk token, bounds the response to 2 MiB, verifies `image/webp`, and decodes it before replacement. A failed/invalid refresh retains the previous valid logo for that same installation; another binding receives Markiro fallback.
- Object URLs are created only while login renders a cached logo and are revoked on replacement/unmount. An image decode/render error immediately falls back to bundled Markiro. No CDN, remote font, or external logo URL is used.
- Existing badge classification, PBKDF2 lookup, one-admission guard, settings long-press, offline snapshot/queue, Task 6 registry, and Task 1 flow state are unchanged.

## Responsive and accessibility behavior

- Portrait login is a centered single column. Landscape is exactly two equal columns: centered animation on the left and left-aligned copy on the right.
- `BadgeScanAnimation` contains no visible scan-zone label; `prefers-reduced-motion` disables its moving beam.
- Tenant name remains visible with either company or fallback logo. Pairing exposes eight visible cells, an announced entered-code status, translated keypad labels, visible focus behavior, and disabled submit until all eight digits are present.

## TDD and verification

- RED: focused run had 39 existing passes and four expected failures: missing branding module, missing pairing logo/cells/backspace, and missing login branding/grid/reduced-motion CSS.
- Focused GREEN: pairing, idle, branding and i18n tests passed 47/47.
- Full kiosk suite completed with exit 0; its final summary was truncated by the existing volume of app-test React `act(...)` and intentional registry/revocation warning logs, so no exact full count is claimed here.
- Kiosk typecheck, full ESLint, Vite PWA production build, changed-file Prettier, `git diff --check`, and the no-scan-zone source check passed.
- Browser viewport inspection, physical tablet/scanner acceptance, real private object-storage logo delivery and offline browser restart were not performed in this task; they remain manual/external acceptance gates.

## Review fix: exact scanner input and generation-atomic branding

Review confirmed that scanner input deleted arbitrary non-digits, logo refresh committed after credential rotation, the private token could follow an arbitrary same-origin path, and the byte limit ran after complete body allocation.

- Scanner input now trims only terminal whitespace and then requires exactly eight ASCII digits. Embedded letters, punctuation, marking codes and longer values are rejected without changing the code cells; CR/LF-framed exact values remain accepted.
- Logo commit/delete/retention now compares the request owner with current config inside one `config + snapshot` IndexedDB transaction. Cross-tenant re-pair, same-kiosk token rotation, stale null cleanup and stale success cannot mutate the current owner's row.
- Refresh returns explicit `{ applied, owner, branding }`. `KioskShell` additionally requires the latest request id and current owner before activating it, so an old result cannot flash in React state.
- Only `/kiosk/branding/logo/{UUID revision}` matching the advertised revision can receive the token. MIME and declared length are checked before reading; streamed chunks are accumulated only through a 2 MiB budget and the reader is cancelled on overflow.
- Invalid advertised path/revision CAS-removes a same-owner stale row. Valid-route network, 5xx, MIME or decode failures retain the prior valid same-owner asset. Display-time `img.onerror` immediately revokes the object URL, falls back to bundled Markiro, and CAS-invalidates the persisted asset.
- Fix RED reproduced scanner canonicalisation and three branding boundary failures. Focused GREEN passed 56/56; full kiosk suite exited 0. Typecheck, ESLint, PWA build, Prettier and diff-check passed.

## Final re-review fix: exact raw scanner input and displayed-asset invalidation

- Pairing now validates the listener payload itself with exact `/^\d{8}$/`. Spaces, tabs and CR/LF delivered past a transport are payload and are rejected; the scanner sources remain responsible for removing their own terminators.
- Every cached logo exposed to `Idle` carries its immutable `serverUrl + kioskId + credentialGeneration` owner and revision. The rendered object URL captures that same display handle, and a late image error reports it instead of asking the shell for whichever owner is current at callback time.
- Durable invalidation reads config and the stored branding row in one `config + snapshot` transaction. It deletes only when both current owner and stored owner/revision still equal the displayed handle. An old tenant or old revision therefore cannot erase the replacement logo; a matching broken current asset is removed and falls back to bundled Markiro.
- Object URL cleanup is target-specific: replacement/unmount/error revokes the URL associated with that render without revoking a newer displayed URL.
- RED was 54 passed / 2 failed: whitespace was trimmed into a valid pairing code and `Idle` emitted an ownerless error callback. Final focused pairing/branding/idle GREEN is 58/58. The complete kiosk suite is 523/523; typecheck, ESLint, Vite PWA build, changed-file Prettier and diff-check passed.
- The full app gate also exposed three stale Task 2 copy assertions (`Подключение киоска`, the former idle headline, and the former submit label); they were aligned with the already-approved current UI and `app.test.tsx` passes 47/47.
