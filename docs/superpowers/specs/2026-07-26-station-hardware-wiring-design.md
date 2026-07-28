# Station Hardware Wiring & Workstation Config (05b-3) — Design Spec

**Date:** 2026-07-26
**Status:** Design approved (brainstorming); implementation plan pending
**Slice of:** roadmap plan 05b (05a foundation · 05b-1 operators · 05b-2 scan loop — all delivered; **05b-3 this slice**)
**Related:** `docs/design-briefs/04-line-station.md` §7 (workstation setup) and its degradation states,
`docs/superpowers/specs/2026-07-26-station-scan-loop-design.md`,
`docs/hardware-acceptance-checklist.md`

## Problem

Plan 05b-2 built the station's hardware half but never connected it: `WorkstationSetup`, `tauriHardware` and the station rasterizer are imported **only by tests** — `App.tsx` references none of them (verified). A real station therefore cannot use a serial scanner or print at all, and nothing survives a restart because no hardware configuration is persisted.

Three defects deferred from earlier reviews block that wiring or undermine it, so they belong to this slice rather than a later cleanup:

- the scanner's `SCANNING` flag makes **close-before-open** impossible, so a setup screen that opens the wrong port dead-ends until the app restarts;
- the operator roster is published non-atomically, leaving a window where a removed operator still authenticates offline;
- a station api-key can read plaintext badge codes through `GET /employees`, which defeats sending only hashes to devices.

## Scope decisions

1. **ZPL and TSC only; PDF is a later slice.** ZPL/TSPL fit the existing architecture — the emitters exist and raw bytes already reach serial/TCP:9100. PDF would need a new emitter (a new dependency or hand-rolled PDF) **and** OS-spooler printing, which was deliberately deferred as platform-specific. Adding it here would roughly double the slice and drag in the printing path we kept out on purpose. Recorded as an explicit next step with that cost stated.
2. **Hardware config lives on the station**, not on the server. It mirrors how sound settings already work, needs no API surface, and works offline — which matters because the station is configured and runs offline. Central visibility belongs to the cabinet's "Devices" section when device commissioning (brief 07) is implemented.
3. **The hardware contract stays stateless.** The station holds the configuration and passes concrete targets into every call (`openScanner(port, baud)`, `print(target, bytes)`) — as the contract already does. When an external agent later implements the same contract it becomes a pure executor, with no configuration to migrate and no ambiguity about which store owns it.

## Workstation configuration

A single `hardware_config` entry in the existing `station_meta` key/value table:

- **scanner:** serial port and baud, or absent (the keyboard wedge, which needs no configuration);
- **printer target:** a serial port **or** `host:port` (9100 by default);
- **printer language:** `zpl` | `tspl`.

The setup screen reads and writes it. On start the station loads the config and, when a serial scanner is configured, opens it — so a configured station comes up ready without anyone revisiting the screen.

## Printing takes its language from the printer, not the template

A label template stores a **`spec`** — pure geometry — and `generateZpl`/`generateTspl` consume that same spec. Nothing needs to be stored twice: both outputs are derived on demand, and storing generated text would go stale the moment the template changed.

So the station renders the shift's spec with the emitter chosen by `hardware_config.printerLanguage`. A ZPL template prints fine on a TSPL printer and vice versa, which removes a whole class of floor failures and lets a plant run mixed printers against one set of templates.

The template's own `language` field is therefore **the editor's preview and download choice**, not a property of the label — documented as such so nobody builds matching logic on it. The setup screen's test print goes through the same path, so it verifies exactly what will later reach the line.

## Truthful status indicators

The Rust reader thread already exits when the device fails; it simply never says so. It gains a `station://scanner-status` event (`connected` on a successful open, `disconnected` on a read error or close), and the status bar reports three honest states:

| State     | When                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| keyboard  | no serial scanner configured — the wedge always works, but a physical scanner cannot be detected |
| connected | a configured serial scanner is open                                                              |
| no signal | a configured scanner dropped — an alarm state the operator must see                              |

A printer cannot be proven alive without printing, so it shows **configured / not configured**; the test print is the verification. This replaces 05b-2's deliberately pessimistic `false`/`false`, which was honest but uninformative.

## Scanner sessions

`SCANNING` (a single bool serving as both "a scanner is open" and "this thread should run") becomes a **generation counter**: each reader thread captures its generation and exits once the current one differs. That removes the fast close→open double-thread race and unblocks **close-before-open** in the setup screen, without which an operator who picks the wrong port is stuck with "Scanner already open" until the app restarts.

## Atomic operator roster publication

Today the mirror upserts the incoming operators and then deletes those missing from the bundle. A failure between the two leaves a removed or deactivated operator able to sign in offline — a security gap recorded during 05b-1.

The refresh instead writes a new **generation** of the roster and switches the active generation in one statement. An interrupted refresh is simply never published, so the device keeps the last complete roster rather than a half-updated one.

## Device-key surface

`GET /employees` is `TenantGuard`-only, so a station api-key can list every employee **including plaintext badge codes** — undoing the reason the roster ships only hashes. `SessionOnlyGuard` goes on the employees module (the station never calls it), and the remaining tenant-guarded modules are audited to produce an explicit list of what a device key may reach. Anything a station does not need becomes session-only.

## Testing

- **Config:** round-trip through `station_meta`, defaults when absent, corrupt content falls back rather than breaking startup.
- **Printing:** the emitter is chosen by configured language — the same spec produces ZPL under one setting and TSPL under the other.
- **Indicators:** each of the three scanner states renders from the corresponding event/config combination.
- **Scanner sessions:** a close followed immediately by an open leaves exactly one live reader (a Rust unit test over the generation logic, which is the part that can be tested without a device).
- **Roster:** an interrupted refresh leaves the previous complete roster active, and a removed operator disappears only once a refresh completes.
- **Device-key surface:** e2e proving a station key gets 403 from `/employees` while a session still succeeds.
- Live hardware verification remains deferred to `docs/hardware-acceptance-checklist.md`.

## Out of scope

PDF output and OS-spooler printing (their own slice, cost stated above); aggregation, sync and shift close (plan 06); server-side storage or cabinet visibility of the hardware config (arrives with device commissioning, brief 07); the badge sign-in cost (O(n) PBKDF2 per scan — real, tracked, and only worth solving alongside a badge entry point in the UI).
