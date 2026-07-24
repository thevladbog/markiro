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
   pickup point) — and the cabinet issues a pairing code plus the **same code
   as a scannable barcode**. On the device the person **types the digits**
   (on-screen numeric keypad) **or scans the barcode** (both devices have a
   scanner). The device exchanges the code for a **provisioning bundle**:
   organization, assigned place, device credential, and the **operator roster**.

   Pairing-code contract (normative baseline; the implementation plan may only
   tighten it):
   - **Format:** 8 decimal digits, generated with a CSPRNG (uniform over the
     8-digit space; not sequential).
   - **At rest:** stored **hashed** (the plaintext exists only in the cabinet's
     one-time reveal and the printed sheet), keyed to its device record.
   - **Redemption:** **single-use and atomic** — the first successful redemption
     marks the code consumed in the same transaction that issues the credential;
     concurrent redemptions cannot both succeed.
   - **Expiry:** **15 minutes** from issue; expired codes are rejected and shown
     as expired in the cabinet.
   - **Brute-force:** **5 failed attempts** per device record (within the code's
     life) locks that code; the operator must have a new one regenerated. This
     pairing-endpoint lockout is separate from the runtime api-key rate limit.

3. **Device credential (per-device).** The bundle's credential is a **per-device
   organization-owned api-key** — one api-key per device record (the 05a
   `station_devices` model: each row references its own `apiKeyId`). It is
   organization-**referenced** only for tenant scoping (`referenceId = tenantId`
   via `TenantGuard`), **not** a single shared org key. **Revoking one device
   deletes only that device's key** and leaves every other device authenticating
   (05a's revoke is already atomic and per-device).
4. **Server address & trust.** **SaaS:** the origin is **pinned in the build** —
   the device only redeems codes and pulls provisioning from that origin; the
   field is not shown. **On-prem (hybrid):** an optional **"Server address"**
   field is entered alongside the code and must be **https with a validated
   certificate** (no plain http, no arbitrary origin); the device treats that
   validated address as its single trusted endpoint for the code exchange and
   all later sync. The pairing screen draws the field (collapsed) so one mockup
   covers both; on-prem can be enabled later without a redesign.
5. **Operator roster is org-wide (model A).** Binding pulls the whole
   organization roster (name, numeric login, PIN hash, optional badge hash,
   active flag); refreshed when online. This closes F6. Per-line scoping is a
   later filter, not an MVP model change.
6. **Sign-in at scale.** Because the roster can be large, the station sign-in
   is **badge scan → login + PIN → name search**, never a scrollable picker of
   all operators (reworks brief 04 §1).
7. **Printable instruction sheet.** Generating a code offers a printable office
   document (browser/PDF, not a ZPL/TSPL label) with the device/place, the big
   PIN, the barcode, numbered steps, and the TTL.
8. **Kiosk hardware = barcode scanner only**, with a binding-gated access rule:
   scanner setup is available **without login before binding** (so the scanner
   can be up to scan the pairing code) and **requires login after binding**.
   The station keeps its fuller agent-based hardware setup (brief 04 §7).
9. **Subscription quota.** The tenant plan caps device count; the Devices
   screen shows usage vs limit and blocks "Add device" at the cap (ties to
   brief 06 plans/limits). MVP counts total devices (stations + kiosks).
10. **UI surface.** A unified **"Devices"** cabinet section (type = filter);
    the add/pairing flow is a **right-side drawer**, not a modal. Device
    lifecycle: `awaiting pairing → bound → online/offline → revoked`.

## Device lifecycle & data flow

```text
Cabinet: Add device (type, place)  ──▶  device record = "awaiting pairing"
                                        issues single-use 8-digit code (+barcode, +print sheet), 15m TTL
Device:  first-run pairing screen  ──▶  enter code / scan  (+ validated server address on-prem)
Server:  redeem code (single-use, 15m TTL, lock after 5) ──▶  per-device api-key + provisioning bundle
Device:  persist bundle (org, place, api-key, operator roster) ──▶ working mode
Cabinet: device = "bound / online"; refresh roster when online
Revoke:  deletes that device's api-key ──▶ device returns to pairing screen on next contact
```

**State machine & displayed status** (each state maps to one cabinet status
chip; brief 07 screen 1):

| State              | Cabinet chip                      | Enters on…                                             | Local data retention                                |
| ------------------ | --------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `awaiting pairing` | `awaiting pairing`                | device added (or after revoke/expiry, on next contact) | none yet                                            |
| `bound / online`   | `online`                          | successful code redemption; heartbeat within window    | full local cache (bundle + roster)                  |
| `bound / offline`  | `offline — last seen N ago`       | no heartbeat past the window                           | keeps its cache; still works offline                |
| `revoked`          | `awaiting pairing` (after unbind) | manual unbind in cabinet                               | device wipes its credential + cache on next contact |

Transitions the cabinet must expose: **re-pair** (issue a fresh code for a
bound device without changing place — e.g. reinstall), **reassign place**
(move a bound device to another line/pickup point, credential kept), **unbind**
(revoke → back to `awaiting pairing`). Place and credential are independent:
reassigning place does not rotate the key; re-pairing does not change place
unless the operator also reassigns.

## Security notes

- **Pairing code:** 8-digit CSPRNG value, hashed at rest, single-use with
  atomic redemption, 15-min TTL, server-side lockout after 5 failed attempts
  per device record; the code claims a pre-created device record, so guessing
  is bounded and the lockout is per-device, not global. This pairing-endpoint
  limit is distinct from the device api-key's runtime rate limit (05a: enabled,
  600/min).
- **Device credential:** a **per-device** organization-owned api-key
  (`referenceId = tenantId` for tenant scoping via 05a `TenantGuard`; one key
  per `station_devices` row). **Revoke deletes only that device's key** — other
  devices keep working (05a revoke is atomic and per-device).
- **Trusted endpoint:** the device only redeems codes / receives provisioning
  from the pinned SaaS origin or a validated **https** on-prem address entered
  at pairing — never an arbitrary origin; on-prem requires a valid certificate.
- **Device management is session-only** (05a `SessionOnlyGuard`): a station
  key cannot mint/list/revoke devices — only a signed-in cabinet user can.

## Scope boundary

This spec is the **design** for mockups (brief 07). The implementation plan
(server pairing-code issue/verify + provisioning bundle, cabinet Devices UI,
device pairing screens for `apps/station` and `apps/kiosk`, operator roster
sync, printable sheet) is written separately via the writing-plans flow, and
depends on the 05b operator table (parallel workstream) for the roster source.

## Out of MVP

- Per-type quota split; per-line/place operator scoping; bulk provisioning; a
  fleet/health view beyond list statuses; deep decommission audit history.
