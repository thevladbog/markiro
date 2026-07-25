# Operators Roster & Station Access (05b-1) — Design Spec

**Date:** 2026-07-24
**Status:** Design approved (brainstorming); implementation plan pending
**Slice of:** roadmap plan 05b (split: **05b-1 operators** → 05b-2 validation screen + signal system + hardware module)
**Related:** `docs/superpowers/specs/2026-07-24-device-commissioning-design.md`,
`docs/design-briefs/03-admin-panel.md` §7, `docs/design-briefs/04-line-station.md` §1,
`docs/design-briefs/07-device-commissioning.md`

## Problem

The line station (plan 05a) signs operators in **offline** against a locally
mirrored roster (`operators_mirror`, PBKDF2 PIN/badge verification), but **no
server-side source of that roster exists**: `GET /shifts/:id/bundle` returns
`operators: []` with a `TODO(05b)` (`apps/api/src/modules/shifts/shifts.service.ts`).
A freshly installed station therefore has nobody to sign in as — the 05a **F6
deadlock**, deliberately left unfixed rather than bypassed. This slice builds
the roster, its management UI, and the sync that closes F6.

## People model (resolves a naming trap)

Three distinct concepts already exist; this slice must not conflate them:

| Concept       | What it is                                      | Where it lives                                             |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| **Auth user** | cabinet account (admin/manager), email+password | Better Auth `user` + `member.role`                         |
| **Employee**  | a **person** working at the plant               | `employees` + `employee_badges` (merged with pickup kiosk) |
| **Operator**  | an employee **granted line-station access**     | NEW `operator_credentials` (this slice)                    |

**Decision: an operator is not a separate person record.** `employees` is the
single people registry and `employee_badges` the single badge registry; station
access is an optional 1:1 add-on. Rationale: one human carries **one physical
badge** that is used by the pickup kiosk («Для себя»), by the line station, and
**bound in external systems**. A parallel operators/badges pair would duplicate
the person and desynchronize revocation (a lost card revoked in one registry
would keep working in the other).

**Consequences:**

- **Badges belong to employees generally**, not only operators — office staff
  carry them too (kiosk + external systems) without any station access.
- Only employees **with operator credentials** enter the station roster. A
  badge-only employee cannot sign in on the floor.
- **PIN is required** for an operator, **badge is optional** (matches the 05a
  `OperatorMirrorRecord` shape).

## Credential storage (split by purpose)

- **Badge code — plaintext server-side.** It is an **identifier**, not a
  secret: it must be readable to hand to external systems, to match an existing
  corporate card, and to reprint. `employee_badges.badgeCode` (already
  plaintext, with `label`/`revokedAt`) stays as-is. "Print badge" therefore
  works at any time.
- **Badge hash on the station only.** The roster sent to a device carries
  `badgeHash`, computed from the plaintext when the response is built. The
  station hashes a scanned badge and compares — so a floor device that gets
  stolen holds no plaintext badge codes.
- **PIN — hashed always.** The manager types a 4–6 digit PIN in the cabinet;
  the **server hashes it** and stores only `pinHash`. Plaintext PINs never
  reach the station and are never stored. Operators do not change their own PIN
  in MVP (manager sets and resets).

## Hash interop contract (must not drift)

The server hasher must be **byte-for-byte compatible** with
`apps/station/src/lib/crypto.ts`: `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`,
SHA-256, **100000** iterations, **32-byte** derived key, **16-byte** salt,
**standard base64 WITH padding** (a stock PHC encoder strips padding and will
break interop). It is validated against the same known vector as
`apps/station/test/crypto.test.ts`; a parallel server-side test pins it. Verify
uses a constant-time comparison; a malformed stored value returns `false`.

## Data model

New table **`operator_credentials`** (Postgres), 1:1 with an employee:

- `tenantId` → `organization.id`;
- `employeeId` → `employees.id` via the repo's composite `(tenant_id, id)` FK
  pattern; PK on `(tenant_id, employee_id)` so one employee has at most one
  credential set;
- `login` — numeric personnel number, **unique per tenant**;
- `pinHash` — PBKDF2 PHC string;
- `active` — boolean; revoking station access flips it (the employee record and
  their badges are untouched);
- `createdAt` / `updatedAt`.

`employees` and `employee_badges` are **not modified**.

## API

**Cabinet (session-authenticated, `TenantGuard`)** — module
`apps/api/src/modules/operators/`:

- grant/replace station access for an employee (`login` + PIN → server hashes);
- reset PIN; change `login`; activate/deactivate access;
- list operators (employee name + login + active + badge presence). Responses
  never contain `pinHash` or a plaintext PIN.

**Station (device api-key, `TenantGuard`)**:

- **`GET /station/operators`** — tenant-scoped roster of **active** operators:
  `operatorId` (= employeeId), `name` (= `employees.fullName`), `role`, `login`,
  `pinHash`, `badgeHash | null`, `active`. `badgeHash` is derived from the
  employee's active badge code when the response is built. **Role mapping:**
  `employees.role` is nullable free text while the station record requires a
  `role`, so a null falls back to the literal `"operator"` — the field is a
  display/audit label only (no floor authorization in this slice).
- `GET /shifts/:id/bundle` — the `operators: []` mock is replaced by the same
  query (one shared service method, two consumers), so the 05a bundle contract
  is honoured and each shift download refreshes the roster. The e2e that
  currently pins `operators: []` is updated.

## Station sync (this is the F6 fix)

The roster arrives as part of **station initialization, immediately after
binding** — i.e. before any sign-in can be attempted:

```text
enroll/pair (05a enrollment today; brief-07 pairing later)
      │  device credential + place
      ▼
initialization sync  ──▶  GET /station/operators  ──▶  operators_mirror
      │                                                (later: products, templates)
      ▼
operator sign-in now possible (badge / login+PIN)
```

Refresh: re-run the same sync whenever the device is online at start, and on
every shift-bundle download. **Known offline limitation:** an operator hired
while the station is offline cannot sign in until the device syncs again —
inherent to the offline-first model, accepted.

## Station-side delta to 05a

- `operators_mirror` and `OperatorMirrorRecord` gain a **`login`** column
  (05a has none), plus the SQLite migration entry.
- `verifyOperatorPin` changes from "compare the PIN against every active
  operator" to **look up by `login`, then verify the PIN**. This is not only
  the brief-07 sign-in path — it is correctness: with 4-digit PINs and dozens of
  operators, PIN collisions across the roster are inevitable, so PIN-alone
  identification is unsound.
- Badge sign-in is unchanged (hash a scan, match `badgeHash`).

## Admin UI (brief 03 §7)

On the employee card:

- **"Station access"** block — grant access (personnel number + PIN), reset
  PIN, enable/disable. Shows nothing sensitive when access exists (no PIN
  readback).
- **Badges** stay a general employee block (issue / revoke / print) — available
  to any employee, operator or not.
- The operators list view is the roster filter over employees with access.
- RU/EN in lockstep; existing design-system components and destructive-confirm
  patterns for reset/disable.

## Testing

- **Unit:** server hasher against the station's known vector (interop), PHC
  parse/format edge cases, malformed value → `false`, constant-time compare.
- **API e2e (executed against Postgres):** grant/reset/deactivate access;
  `login` uniqueness per tenant (409); cross-tenant isolation on every route;
  `GET /station/operators` succeeds with a device api-key, is rejected without
  auth, and never returns other tenants' operators; bundle returns a non-empty
  roster; PIN/plaintext never present in any response body.
- **Station:** `login`+PIN verification (right/wrong PIN, unknown login,
  inactive operator excluded), badge verification unchanged, initialization sync
  populates `operators_mirror`.
- **Round-trip:** a PIN hashed by the server verifies on the station (the test
  that would have caught a hash drift).

## Scope boundary

**In:** `operator_credentials` + migration, server hasher, operators module,
`GET /station/operators`, bundle wiring, station `login` delta + init sync,
admin station-access UI.

**Out (05b-2 and later):** validation work screen, signal system, hardware
module (serial scanner, ZPL/TSPL printing), floor authorization by role
(exceptions/disassembly — plan 06), operator self-service PIN change, generated
PINs, print-badge template work beyond reusing the existing pipeline, and the
brief-07 pairing rework (this slice deliberately works with 05a enrollment so
F6 closes independently).
