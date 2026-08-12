# Station live roster and floor recovery design

**Date:** 2026-08-12

**Status:** Approved — final validation pending
**Scope:** Station operator sign-in, production API routing, floor header layout,
operator switching, shift-loading recovery, and badge-scan illustration

## Context

The Windows beta exposed four connected problems:

1. An operator created while a station remained online was not available until
   the station application restarted.
2. Immediately after operator sign-in, the shift list showed the generic error
   “Не удалось выполнить действие. Попробуйте ещё раз.”
3. The fullscreen exit and update controls competed with status content in the
   top-right corner.
4. The badge instruction used the character `▣` inside a dashed rectangle, which
   did not communicate a scanner, badge, or barcode.

Current code explains each symptom:

- the operator roster sync runs at startup and on a browser `online` event, but
  not after an online user is created while the station remains online;
- the station calls root API paths such as `/shifts` and `/products`, while the
  production admin host proxies only `/station/*` and a few infrastructure
  paths; a live preflight to `https://admin.markiro.app/shifts` therefore reaches
  the admin SPA route and returns 404 without station CORS headers;
- the update indicator is absolutely positioned inside the status bar;
- the badge visual is a literal text glyph rather than a purposeful illustration.

The approved direction is the focused redesign shown in
`station-auth-and-shifts-mockup.html`: preserve the existing dark industrial
visual system and offline workflow, but make the state, scan instruction, and
top-level actions unambiguous.

## Goals

- Admit a newly created, active station operator without restarting the app.
- Preserve immediate offline authentication for already cached operators.
- Never send a raw badge value or PIN to the server for authentication.
- Make every station API path used by the desktop client reachable through the
  enrolled production origin.
- Prevent top-bar controls from overlapping status values at 1280×800,
  1024×768, and the common 1280×720 Windows work area.
- Let the current operator sign out without closing the active shift, losing
  queued local work, or attributing accepted scans to the next operator.
- Replace the ambiguous badge glyph with a bundled, offline-safe illustration.
- Give transport failures a specific, recoverable message.

## Non-goals

- Replacing station device credentials or the tenant authorization model.
- Adding a server endpoint that accepts raw operator badge or PIN credentials.
- Reworking the production work screens after a shift is opened.
- Adding automatic application installation or a new update mechanism.
- Treating automated browser checks as Windows, WebView2, scanner, or physical
  touchscreen acceptance.

## Design decisions

### 1. Local-first operator authentication with one online refresh

Every credential attempt begins against the active SQLite operator mirror.
Existing operators therefore authenticate immediately without network access.

When a local lookup does not find a valid match and the station has a current
device credential:

1. If the browser reports offline, keep the existing local failure result.
2. If it reports online, request `GET /station/operators` once.
3. Atomically replace the mirror using the existing double-slot publication
   mechanism.
4. Repeat the same local verification exactly once.
5. Admit the operator only if that second local check succeeds.

This applies to:

- a badge miss;
- an unsuccessful tabular-number/PIN submission;
- name search: cached operators appear immediately; while online, opening the
  search starts one background roster refresh and republishes the results when
  it succeeds, without sending the typed name to the server.

The refresh is single-flight. Concurrent scanner input or repeated UI events
reuse or wait for the same refresh rather than starting parallel roster writes.
The existing credential-generation guard remains mandatory so a response from
an old or rejected device credential cannot publish a roster.

`syncOperatorRoster` will return a small result (`updated` or `unavailable`)
instead of swallowing all outcome information. It will continue logging a
sanitized diagnostic and will not expose keys, badge data, PINs, or raw response
bodies. The sign-in component receives a narrow refresh callback from `App`;
it does not construct its own API client.

The user-visible sequence for a local miss is:

- reserved message slot after a credential miss: “Обновляем список
  операторов…”;
- success followed by no match: the existing invalid badge or invalid
  tabular-number/PIN message;
- network failure: “Не удалось обновить список операторов. Проверьте связь или
  войдите с ранее синхронизированными данными.”

Raw badge and PIN values remain device-local throughout the sequence.

### 2. Production routing matches the station API surface

The admin-domain Caddy route will proxy the exact root route families used by
the desktop station in addition to `/station/*`:

- `GET` and `POST /shifts`;
- `POST /shifts/:id/open`;
- `GET /shifts/:id/bundle`;
- `GET /products`;
- `POST /products/gtin-check`;
- corresponding `OPTIONS` preflights.

The proxy matcher must stay aligned with the exact station surface in
`apps/api/src/cors.ts`. It must not turn every root API controller into a device
route. API tenant/device guards and the exact CORS method/path allowlist remain
the authorization boundary after the proxy forwards a request.

The station release live CORS gate will no longer prove only pairing. It will
perform safe preflight checks for pairing, roster, shifts, shift open/bundle,
product lookup, and GTIN check using the Windows WebView origin and the actual
requested methods/headers. A missing proxy route, wrong origin, wrong method,
or missing allow headers must fail the release before the Windows build.

Production-bundle contract tests will assert that the Caddy device matchers and
the release verifier cover the same station route inventory.

### 3. Honest server reachability

`navigator.onLine` describes a network interface, not API reachability. The
approved top bar says “Сервер доступен”, so it must not be driven by that browser
flag alone.

The station client will report transport reachability through an optional
callback:

- any received HTTP response means the server was reached, including an
  authenticated 4xx response;
- fetch, DNS, TLS, CORS, and timeout failures mean the server is unavailable;
- a browser offline event immediately marks it unavailable;
- before the first request settles, the state is “Проверяем”.

The top bar renders “Сервер: Проверяем / Доступен / Нет связи”. Existing sync
queue and conflict indicators remain separate; server reachability does not
claim that queued production work has already synchronized.

### 4. One top bar with reserved action cells

The separate 72px fullscreen chrome row is removed from floor screens. Floor
identity, operational status, update entry, and window-mode control share one
explicit CSS grid:

- brand/station/operator context;
- server and synchronization state;
- scanner/printer state;
- update action;
- change-operator action, when an operator is authenticated;
- window-mode action.

Update and window-mode controls participate in layout. Neither is absolutely
positioned. Long station, operator, printer, and update labels truncate inside
their own cells and cannot cover another control.

At wide widths the groups occupy one row. At 1024–1179px the grid may use a
denser two-line context/status treatment, but all actions retain at least the
64px station touch target. The main screen and footer continue to use
`minmax(0, 1fr)` and fixed action rows so no application action overlaps another
at 1280×800, 1024×768, or 1280×720.

The compact layout may place the three action controls in a dedicated second
header row. This is preferable to shrinking them below the station touch-target
contract or overlaying operational status.

The ordinary onboarding/setup shell keeps its existing floating window control;
this change concerns the authenticated floor shell where status and update
controls exist.

### 5. Change operator without closing the shift

An authenticated floor always provides a visible “Сменить оператора” action in
the reserved top-bar action area.

With no active shift, the action immediately clears the in-memory operator and
returns to badge sign-in. It resets transient floor navigation such as shift
creation, setup, conflicts, or update center, but does not clear the device
credential, roster mirror, outbox, or other durable station data.

With an active shift, the action opens a confirmation:

- title: “Сменить оператора?”;
- explanation: “Текущая смена останется открытой. Все записанные операции
  сохранятся на станции.”;
- primary action: “Сменить оператора”;
- secondary action: “Остаться”.

After confirmation the station stops accepting new scan input and unmounts the
work screen, which closes its ordered scan/job queue. It waits for every item
already accepted by that queue to finish its local journal write before
clearing the current operator. While this boundary settles, the station shows
“Сохраняем текущую операцию…” and offers no scan or floor action.

If the local barrier cannot settle, the station keeps the current operator
authenticated and shows a retryable error; it must not cross an uncertain
operation into the next operator session. No server acknowledgement is required:
the durable outbox remains device-owned and continues synchronizing after the
operator changes.

The active shift, its mirrored context, and current open box remain selected.
Durable box counts reload from SQLite; the accepted/rejected counters belonging
to the previous operator's on-screen session restart at zero. After the next
operator authenticates, the application resumes that same active shift under
the new operator identity. New journal entries use the new operator ID; entries
already accepted before the boundary retain the old operator ID. The action
never calls the server's close-shift operation.

### 6. Badge scan instruction

The dashed rectangle and `▣` character are replaced by a small inline SVG
component built from the Markiro visual language:

- an identification badge;
- a visible barcode;
- a handheld scanner;
- one green scan beam.

The asset is bundled with the station and has no CDN or runtime network
dependency. It is decorative (`aria-hidden`) because the adjacent visible text
contains the complete instruction. The copy is:

- heading: “Поднесите бейдж к сканеру”;
- explanation: “Станция распознает код автоматически. Если сотрудник добавлен
  только что, список обновится с сервера.”

The existing “Найти по имени” and “Ввести табельный номер” fallbacks remain in
the same fixed action row.

### 7. Shift-loading recovery

Once production routing is corrected, `GET /shifts` should load normally.
Failures still require an honest recovery state:

- a transport failure shows “Не удалось загрузить смены. Проверьте доступ к
  серверу.”;
- a server response with a domain error continues to display its safe API
  message;
- the retry action remains visible in the content area;
- “Новая смена”, workstation setup, and conflicts remain in the fixed footer
  when their existing permissions allow them.

The screen does not discard cached operator identity or local production data
because shift loading failed.

## State and data flow

```text
badge scan / PIN
        |
        v
read active SQLite roster ---- match ----> authenticate locally
        |
      no match
        |
  browser online + current device credential?
        | no                         | yes
        v                            v
 show local failure       single-flight GET /station/operators
                                      |
                          atomic mirror replacement
                                      |
                          repeat local verification once
                              | match          | no match/failure
                              v                v
                         authenticate      safe inline message
```

The server never receives the attempted badge or PIN. It returns only the
tenant-scoped roster representation already used for offline verification.

## Error handling and recovery

- Roster refresh failure preserves the previous mirror.
- A partially written roster is never published.
- A credential rejection follows the existing sealing/recovery path and cannot
  publish late data.
- Repeated scan input is ignored while authentication/refresh is in flight.
- Operator switching closes intake and drains accepted local jobs before the
  identity changes; a failed drain leaves the old identity active.
- Station request timeouts remain bounded by the existing request deadline.
- Caddy or CORS drift becomes a release-gate failure rather than a Windows-only
  runtime surprise.
- Errors shown to operators never include API keys, badge values, PINs, raw
  fetch exceptions, or internal URLs.

## Testing and acceptance

Implementation follows focused red-green-refactor slices.

Automated coverage must include:

- local badge success performs no network request;
- badge miss, successful roster refresh, and second local success;
- badge miss with offline or failed refresh;
- PIN miss and retry after a successful refresh;
- name search shows cached results immediately and adopts a successful
  background refresh without transmitting the query;
- single-flight behavior and credential-generation invalidation;
- reachability transitions for success, HTTP error, transport error, and
  browser offline;
- shift transport error copy and retry;
- status/action grid contract with no absolute update/window controls;
- operator switch with no active shift;
- active-shift confirmation, queue-drain ordering, same-shift resume, and
  preservation of old/new operator attribution;
- operator-switch barrier failure leaves the current operator authenticated;
- bundled SVG presence and removal of the `▣` placeholder;
- Caddy route inventory and live CORS verifier cases for every station route;
- existing station tests, typecheck, lint, build, and Rust tests;
- production bundle and station release contract suites;
- repository formatting and diff checks.

Manual Windows/WebView2 acceptance remains separate:

- create an active station operator while the login screen is already open;
- scan the new badge without restarting and confirm entry;
- repeat with the network disconnected and a previously cached operator;
- load, open, create, and rejoin shifts against production;
- inspect 1280×800, 1024×768, and 1280×720 in locked and windowed modes;
- confirm update, fullscreen, printer, and scanner controls never overlap;
- change operators with and without an active shift; confirm the same shift
  resumes and scans on each side retain the correct operator attribution;
- reveal the Windows taskbar and confirm application actions recover when it
  hides again;
- verify keyboard-wedge and configured scanner input on real hardware.

## Rollout

This is a two-stage rollout; do not deploy it or publish a beta without an
explicit release decision.

1. Deploy the additive Caddy route change first. It must proxy only the exact
   Station root API paths in this design, before any beta uses them.
2. Against that deployed production revision, run the expanded live Station
   CORS preflight gate. It must check the Windows WebView origin, methods, and
   capability headers for every listed Station route.
3. Start the next Station beta build only after the live preflight passes, from
   the approved `main` commit. Building an installer is not Windows acceptance.
4. Install and exercise the immutable beta on the target Windows/WebView2
   hardware, recording the unchecked hardware checklist outcomes separately.

If the Caddy deployment or live preflight fails before a beta is released,
stop the release: do not start the beta workflow, retain the previous desktop
release, and restore the last known-good Caddy revision or deploy a narrowly
reviewed forward fix. If a beta has already reached a station, do not remove
its required Station routes as a blind rollback; halt further rollout, keep the
previous installer available for recovery, and repair or deliberately roll back
the compatible route and desktop versions together. In every case preserve the
device-local shift, journal, and outbox data; recovery must not clear local
production work.

No database migration is required. Existing enrolled configurations continue
using their stored `https://admin.markiro.app` server URL.

## Validation record (pending)

This design remains approved pending final validation. Record outcomes only when
the release candidate is executed; this section is not a production deployment
or Windows acceptance record.

- Run the exact Station test, typecheck, lint, and production-build gates from a
  lockfile-frozen install, plus the host Cargo tests.
- Run the complete Station release and production-bundle contract suites.
- Run formatting and diff-hygiene checks on the candidate commit.
- Keep live deployment, live CORS preflight, Windows/WebView2, scanner, printer,
  touchscreen, and taskbar acceptance explicitly pending until exercised on the
  target environment; host Cargo evidence cannot satisfy those checks.
