# Design Brief 04 — Line Station UI

> Fourth stage. Floor mode of the design system (brief 02). Touch-first app on
> a 10–12″ tablet (landscape, 1280×800 base) or desktop by the line. Operator
> may wear gloves, stands 0.5–2 m away, works in noise. Scanner and label
> printer are attached via the local hardware agent. **Dark theme is the
> default**; light supported. RU primary, EN mirrors.

## Design principles

1. **One glance = full picture.** Current state (OK / error / duplicate /
   box progress) readable in peripheral vision from 2 m.
2. **One action per moment.** Big targets (64px+), no nested menus, no small
   modals; full-screen dialogs only.
3. **Scan is the primary input.** Wherever possible confirm by scanning, not
   tapping (e.g. scan a box label to confirm disassembly target).
4. **Never block the line.** Offline, printer trouble, agent down — the app
   degrades gracefully and always tells the operator what to do next.

## Signal system (core of the experience)

Every scan produces an unmissable reaction:

- **Success:** short green full-screen flash + soft beep.
- **Error (bad code / wrong GTIN):** red full-screen flash held longer,
  harsh distinct tone, huge reason text: «НЕВЕРНЫЙ КОД», «ЧУЖОЙ ГТИН».
- **Duplicate:** amber flash, its own tone, «ДУБЛЬ» + when/where it was first
  scanned (terminal, time).
- **Box complete:** celebratory but quick — box closes visually, label prints,
  progress resets.
- Sound volume control / mute per workstation; visual signals alone must be
  sufficient (noisy floor), sounds alone must be sufficient (operator looking
  at the line, not the screen).

Design the flash states as first-class screens, not toasts.

## Screens

### 1. Sign-in
Numeric PIN pad (giant keys) with login picker, or "scan your badge" —
both paths on one screen. Works in gloves.

### 2. Shift selection
Available planned shifts as large cards (product, plan, mode, line) — 1–2
cards visible, thumb-reachable. Tolling shifts are visibly marked with the
customer name («для: Завод X») on the card and in the work-screen status bar
— the operator must always see whose product is being aggregated. Plus "New
shift" (below) and "Rejoin active shift" when 2–3 terminals share one shift.

### 3. Ad-hoc shift creation (on the station)
Flow: tap "New shift" → **scan EAN-13 or DataMatrix from a product unit** →
GTIN resolved against the catalog:
- Found: product card appears → choose mode (validation / + aggregation) →
  if aggregation: box capacity (prefilled from product, editable) and pallet
  use yes/no → start.
- Not found: **blocking screen** — "Product is not in the catalog" with the
  scanned GTIN shown, instruction to ask an administrator to add the product
  in the admin panel, and actions "Scan again" / "Back to shifts". Products
  are created **only in the admin panel** (approved decision); a draft
  product card also blocks shift start until completed.
The whole flow is 3–4 full-screen steps, each completable in seconds.

### 4. Work screen — validation mode
- Dominant central zone: last scan result (huge status + code tail).
- Counters: shift total vs plan, this terminal, errors/duplicates.
- Recent scans feed (compact, secondary).
- Persistent status bar: network / sync queue / agent / scanner / printer /
  teammates in shift ("+2 terminals").

### 5. Work screen — aggregation mode
Everything from validation, plus the signature **box-fill visual**: a grid of
cells filling as units are scanned (e.g. 14/20), current box number, and a
pallet progress strip (boxes on pallet: 3/12) when pallets are enabled.
On box completion: auto-print label, closed-box animation, next box starts.
Manual "close box early" action (partial box) with confirmation.

### 6. Exceptions
Full-screen section, scan-to-confirm everywhere:
- Disassemble a box / pallet (scan its label to select).
- Replace a unit in a box (defective unit swap): scan box → scan unit out →
  scan unit in.
- Reprint a label (last or scan a box).
- Undo last action.

### 7. Workstation setup
Hardware via the local agent: pick printer and scanner from discovered
devices, connection status, test scan + test print buttons. Sound volume.
Designed to be done once by a non-IT person.

### 8. Degradation states
- **Offline:** prominent but calm banner "Working offline — N scans queued";
  everything keeps working; sync progress shown when back online.
- **Sync conflict / cross-terminal duplicate:** when the same code was scanned
  on two terminals while offline, the later one is flagged on sync — design a
  review state (list of conflicted codes, resolution handled by
  manager/admin, operator just informed).
- **Agent unreachable / scanner disconnected / printer out of paper or
  offline:** each with a clear full-width state, plain-language instruction
  («Проверьте бумагу в принтере»), and a retry action. Printing failures
  during aggregation must show what will happen to the pending box label.

## Multi-terminal awareness

The shift is shared: show teammates presence, combined progress vs plan, and
per-terminal contribution. Duplicates across terminals (online case) resolve
instantly via the shared backend — the duplicate signal shows *which terminal*
scanned it first.
