# Device Commissioning & Cabinet Binding — Design Spec

**Date:** 2026-07-24
**Status:** Design approved (brainstorming); mockups pending (design brief 07)
**Design brief (designer-facing):** `docs/design-briefs/07-device-commissioning.md`

## Problem

A physical Markiro device — a line **station** (`apps/station`, plan 05a) or a
pickup-point **kiosk** (`apps/kiosk`, pickup-kiosk Plan B) — must be put into
service and bound to a tenant's cabinet by someone with cabinet access. Plan
05a's interim enrollment (type a long `serverUrl` + `apiKey` into the kiosk)
is too clunky for a touchscreen, and a freshly set-up station has no operators
to sign in with (the 05a F6 deadlock: `operators_mirror` is empty and the only
seeding path is unreachable before login). This spec defines a single
commissioning mechanism for both device types and the operator provisioning
that unblocks sign-in.

## Decisions

1. **Who & when.** MVP: anyone with cabinet access commissions a device, once,
   at install time (online then; the device goes offline for the shift after).
   Operators are not involved in commissioning.
2. **Mechanism (admin-first, code on device).** In the cabinet the person adds
   a device — choosing its **type** (station/kiosk) and **place** (line /
   pickup point) — and the cabinet issues a **single-use, ~15-min numeric
   pairing code** (e.g. 8 digits) plus the **same code as a scannable
   barcode**. On the device the person **types the digits** (on-screen numeric
   keypad) **or scans the barcode** (both devices have a scanner). The device
   exchanges the code for a **provisioning bundle**: organization, assigned
   place, device credential (api-key), and the **operator roster**.
3. **Server address.** SaaS: the origin is baked into the build — code only.
   On-prem (hybrid architecture): an optional **"Server address"** field is
   entered alongside the code. The pairing screen draws the field (collapsed)
   so one mockup covers both; on-prem can be enabled later without a redesign.
4. **Operator roster is org-wide (model A).** Binding pulls the whole
   organization roster (name, numeric login, PIN hash, optional badge hash,
   active flag); refreshed when online. This closes F6. Per-line scoping is a
   later filter, not an MVP model change.
5. **Sign-in at scale.** Because the roster can be large, the station sign-in
   is **badge scan → login + PIN → name search**, never a scrollable picker of
   all operators (reworks brief 04 §1).
6. **Printable instruction sheet.** Generating a code offers a printable office
   document (browser/PDF, not a ZPL/TSPL label) with the device/place, the big
   PIN, the barcode, numbered steps, and the TTL.
7. **Kiosk hardware = barcode scanner only**, with a binding-gated access rule:
   scanner setup is available **without login before binding** (so the scanner
   can be up to scan the pairing code) and **requires login after binding**.
   The station keeps its fuller agent-based hardware setup (brief 04 §7).
8. **Subscription quota.** The tenant plan caps device count; the Devices
   screen shows usage vs limit and blocks "Add device" at the cap (ties to
   brief 06 plans/limits). MVP counts total devices (stations + kiosks).
9. **UI surface.** A unified **"Devices"** cabinet section (type = filter);
   the add/pairing flow is a **right-side drawer**, not a modal. Device
   lifecycle: `awaiting pairing → bound → online/offline → revoked`.

## Device lifecycle & data flow

```
Cabinet: Add device (type, place)  ──▶  device record = "awaiting pairing"
                                        issues single-use numeric code (+barcode, +print sheet), TTL ~15m
Device:  first-run pairing screen  ──▶  enter code / scan  (+ server address on-prem)
Server:  validate code (single-use, TTL, lockout after N)  ──▶  provisioning bundle
Device:  persist bundle (org, place, api-key, operator roster) ──▶ working mode
Cabinet: device = "bound / online"; refresh roster when online
Revoke:  kills api-key + code ──▶ device returns to pairing screen on next contact
```

## Security notes

- Numeric single-use code + short TTL + server-side lockout after N wrong
  attempts; the code claims a pre-created device record, bounding brute-force.
- The device credential is an organization-owned api-key (05a `TenantGuard`
  path); revoke deletes it (05a already atomic).
- Device-management endpoints are session-only (05a `SessionOnlyGuard`); a
  station key cannot mint/list/revoke devices.

## Scope boundary

This spec is the **design** for mockups (brief 07). The implementation plan
(server pairing-code issue/verify + provisioning bundle, cabinet Devices UI,
device pairing screens for `apps/station` and `apps/kiosk`, operator roster
sync, printable sheet) is written separately via the writing-plans flow, and
depends on the 05b operator table (parallel workstream) for the roster source.

## Out of MVP

- Per-type quota split; per-line/place operator scoping; bulk provisioning; a
  fleet/health view beyond list statuses; deep decommission audit history.
