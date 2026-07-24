# Design Brief 07 — Device Commissioning & Cabinet Binding

> Addition to the 00–06 series and the accepted Markiro handoff. This brief
> covers how a physical **device** (a line **station** or a pickup-point
> **kiosk**) is put into service and bound to a tenant's cabinet, and how
> operators reach the device so floor sign-in works. It spans two design
> modes: the **office/cabinet** mode (the manager screen that issues and
> manages pairing) and the **floor/kiosk** device mode (the on-device pairing
> and sign-in screens). RU primary + EN, light + dark, existing design system.
>
> This is a **delta** to briefs 03 (admin panel), 04 (line station), and the
> pickup-kiosk work. Draw the NEW screens/states below and adjust the noted
> existing ones; do not redesign unrelated areas.

## Purpose

Give a non-IT person with cabinet access a simple, once-per-device way to put
a station or kiosk into service: in the cabinet they generate a short code,
on the device they enter or scan it, and the device provisions itself
(organization, assigned place, credentials, operator roster). The same
mechanism serves both device types. It also closes a gap in the station flow:
a freshly set-up device has no operators to sign in with until it is bound.

## Core concepts (shared vocabulary for the mockups)

- **Device** — a physical unit of one **type**: `station` (line terminal) or
  `kiosk` (pickup point). Both have a barcode scanner.
- **Place** — where the device serves: a **line** (station) or a **pickup
  point** (kiosk). Chosen in the cabinet when the device is added.
- **Pairing code** — a short **numeric** code (e.g. 8 digits), **single-use**,
  **short-lived** (~15 min). The same code is also rendered as a **scannable
  barcode**. Entering the code on the device triggers provisioning.
- **Provisioning bundle** — what the device pulls after a valid code:
  organization, assigned place, device credential, and the **operator roster**
  (org-wide). Refreshed whenever the device is online.
- **Subscription quota** — the tenant's plan caps how many devices exist
  (ties to brief 06 "current plan, lines/stations limits").

---

## Screens

### 1. Cabinet — Devices (list)

A new **"Devices"** section in the cabinet nav — one list for stations and
kiosks together (type is a column/filter). Draw:

- **Quota indicator** at the top: "**Devices: 7 of 10** on plan «…»" with a
  simple progress/counter. Design it so a later split into per-type counts
  won't break the layout.
- **List** (table or cards): name, **type** (station/kiosk), **place**
  (line / pickup point), **status chip**, last activity. Status chip states:
  `awaiting pairing` · `online` · `offline — last seen N min ago`. Filters by
  type and status.
- **Empty state**: "Add your first device."
- Primary action **"Add device"** — opens the pairing drawer (screen 2). When
  the quota is reached, this action is **disabled** with a hint: "Plan limit
  reached — upgrade the plan or unbind a device" (link to plan/billing).

### 2. Cabinet — Add device & pairing code (right-side drawer)

Use a **right-side drawer/sheet**, NOT a modal — the add form and the
generated-code state flow in one panel.

- **Add form**: type (station/kiosk) → place (line or pickup point, depending
  on type) → optional name. Confirm → creates the device in `awaiting pairing`.
- **Generated-code state** (shown immediately, and re-openable while the
  device is still awaiting pairing):
  - large **numeric PIN** (digits grouped for readability);
  - the same code as a **barcode** beside it, for scanning;
  - **TTL countdown** ("valid for ~15 min");
  - actions: **"Print instructions"** (screen 6), **"Regenerate code"**
    (issues a new code, invalidates the old), "Copy";
  - helper: "Enter the code on the device, or scan the barcode."
- **Device card** (after pairing): status, place, last activity, a reference
  to the device credential (never the secret). Actions — **regenerate pairing
  code / re-pair**, **unbind (revoke)**, **change place**. Sensitive actions
  use the design system's destructive/confirm pattern.

### 3. Device — pairing screen (station floor mode + kiosk mode)

One shared pattern, styled per mode (station = floor dark, kiosk = kiosk
mode). Shown on first run and whenever the device is unbound/revoked.

- Title "Bind device";
- an **on-screen numeric keypad** to enter the code + a large **"Scan code"**
  button (uses the device's barcode scanner);
- a **collapsible "Server address"** field for on-prem (hidden/prefilled for
  the SaaS build — draw it, but collapsed). On-prem accepts **https only** and
  the address is validated (certificate-checked) before the code is redeemed —
  design an inline "address not reachable / not secure" error; the SaaS build
  pins its origin and shows no field;
- helper: "Code from the cabinet — type the digits or scan the barcode."
- **Binding in progress**: "Binding device… downloading settings and
  operators" (progress/spinner).
- **Error states** (each a large, calm full-screen state + a clear action):
  invalid/expired code → "Refresh the code in the cabinet"; too many attempts
  (server lockout) → "Too many attempts — wait or get a new code"; no network
  / server unreachable → "Check the address and connection", retry.
- **Success → ready**: brief confirmation naming the **assigned place**
  ("Station bound to line X" / "Kiosk bound to pickup point Y"), then into the
  working mode — station → operator sign-in (screen 4); kiosk → its start
  screen.

### 4. Device — operator sign-in at scale (station; adjusts brief 04 §1)

The operator roster is org-wide and can be large, so **never** show a
scrollable picker of everyone. Rework brief 04 §1 to three tiers:

- **Primary — scan badge**: a big "Scan your badge" block; scan → instant
  sign-in, no list. Scales to any headcount.
- **Secondary — "Enter login + PIN"**: numeric keypad — the operator's own
  numeric login (personnel number), then PIN. Still no list.
- **Fallback — search by name**: typing 2–3 letters shows 3–5 matches (not the
  whole roster) for "forgot my login."
- Giant keys, works in gloves, dark theme. Explicitly **not** a scroll of all
  operators.

### 5. Kiosk — scanner setup & access rule

The kiosk configures **only its barcode scanner** (choose/allow the device —
Web Serial or keyboard-wedge mode — plus a test scan). No printer or other
hardware (the station keeps its fuller agent-based setup from brief 04 §7:
printer + scanner). Access depends on binding state:

- **Before binding** — scanner setup is reachable **without login** (no
  session exists yet), directly from the first-run / pairing screen. Practical:
  the scanner often needs to be up _before_ pairing so the pairing barcode can
  be scanned.
- **After binding** — changing the scanner requires a **staff sign-in**. Design
  the entry path: a **"Settings"** affordance on the running kiosk (e.g. a
  small gear, or a deliberate long-press on the header so a customer can't hit
  it by accident) that opens a **sign-in gate** using the same operator
  credentials as the station — **badge scan or login + PIN** (screen 4's tiers,
  in kiosk styling). On success → the scanner settings (same picker + test scan
  as pre-binding). Any authenticated operator in the org roster qualifies (no
  separate role in MVP). **Recovery** when sign-in is impossible (empty/roster
  unavailable, forgotten credentials): the device can be **re-paired from the
  cabinet** (unbind → new code) to reach setup again — surface this as the
  "can't sign in?" hint on the gate. Draw: the Settings entry point, the
  sign-in gate, and the reachable scanner-settings screen.

### 6. Printable pairing instruction sheet

Generated from the code state ("Print instructions"). A plain **office
document** (browser print / PDF — this is NOT a ZPL/TSPL label), A4/A5, light
and high-contrast (barcode must stay legible in B/W):

- header "Bind device" + Markiro brand;
- **which device**: type (station/kiosk), name, assigned place, organization;
- **large numeric PIN** (grouped digits);
- **barcode** (the same code) for scanning;
- **numbered steps**: 1) open the pairing screen on the device; 2) type the
  code or scan the barcode; 3) (on-prem) enter the server address; 4) wait for
  settings and operators to load;
- **validity**: "Code valid until HH:MM (~15 min). Expired — regenerate in the
  cabinet";
- small footer: who generated it and when.

---

## States & constraints (apply throughout)

- **Pairing code**: **8 digits**, single-use, **15 min** TTL with a live
  countdown in the cabinet; "Regenerate" kills the old one. Device entry is
  digits-only (on-screen keypad) or a scan of the same code.
- **Brute-force protection**: server-side lockout after **5** failed attempts
  per device; the code claims a pre-created device record, so guessing is
  bounded. (Full code contract — CSPRNG, hashed at rest, atomic single-use — in
  the spec; here it drives the "too many attempts" and "expired" copy.)
- **Lifecycle → status chip → retention** (one chip per state; screen 1):
  `awaiting pairing` → chip _awaiting pairing_, no local data yet;
  `bound / online` → chip _online_, full local cache;
  `bound / offline` → chip _offline — last seen N ago_, keeps cache, still
  works; `revoked` → back to chip _awaiting pairing_, device wipes its
  credential + cache on next contact.
- **Unbind (revoke)**: deletes **only that device's** credential and any code;
  on next contact the device drops to the pairing screen and clears its cache.
  Destructive-confirm styling.
- **Re-pair / reassign** (independent): **re-pair** = new code for a bound
  device, place unchanged; **reassign place** = move a bound device to another
  line/pickup point, credential kept (key not rotated).
- **Offline after binding**: cabinet shows `offline — last seen N ago`; the
  device keeps working on its local cache (operators/shifts already downloaded).
- **Quota**: adding is blocked at the plan limit; unbinding frees a slot.
- **First run vs repeat**: a bound device goes straight to working mode; the
  pairing screen appears only when unbound or revoked.
- Every list/detail: empty, loading, error states per the design system;
  tabular numerals for counters and the PIN.

## Out of MVP (design later, leave room)

- Splitting the quota into per-type counts (stations vs kiosks) — the counter
  should tolerate this later.
- Per-line / per-place operator scoping (MVP roster is org-wide).
- Bulk provisioning (many devices at once) and a fleet/health view beyond the
  list statuses.
- On-prem server-address entry is drawn but can stay hidden for the SaaS build.
