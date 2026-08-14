# Station Shift Identity, Offline Close, and Line Presence — Design Spec

**Date:** 2026-08-14
**Status:** Written design approved; implementation plan prepared
**Related:** `docs/superpowers/specs/2026-07-28-station-sync-design.md`, `docs/superpowers/specs/2026-07-30-station-exceptions-design.md`, `docs/device-key-surface.md`, `docs/architecture.md`

## Problem

The station shift-selection cards currently show little more than the product name, so two shifts for the same product are visually indistinguishable. The work screen also combines two different intents under one `Пауза / завершить` action, even though the current implementation only leaves the screen and deliberately never closes the shift.

Closing from the cabinet is insufficient for the production line. An operator must be able to close a single-device shift without depending on connectivity, while a shift used by more than one device must remain an administrator-controlled action. The close decision also needs a durable production summary and a bounded reason vocabulary when planned and actual quantities differ.

The cabinet already stores `station_devices.last_seen_at`, but an idle station may make no API request for long enough to look offline. The lines view does not aggregate device presence, so an administrator cannot tell whether a production line is reachable.

## Product decisions

1. Shift cards show status, planned date, planned quantity, and operation type in addition to the existing image, product, counterparty, and action.
2. `Пауза` and `Закрыть смену` are separate actions. Pause never changes server or local shift status.
3. Closing is offline-first. Network availability never gates the operator's local completion flow.
4. A station may close only a shift known locally as single-device. Once the server observes a second distinct station participant, the shift becomes permanently administrator-only for closing.
5. Distributed stale knowledge is explicit: a station that went offline before a second device joined may still queue a close. The server rejects that close into an administrator-visible reconciliation conflict without reopening the operator's local work screen.
6. No close reason is required when no plan exists or when the durable local actual equals the plan snapshot. A mismatch requires exactly one fixed reason and no free text.
7. An aggregation shift with an open box cannot be closed. The operator first closes or clears that box using the existing box controls.
8. Line presence is derived from device heartbeat, not from shift participation.

## Fixed close reasons

The transport and storage contract uses stable codes; Russian and English labels remain UI translations.

| Code | Russian label | English label |
| --- | --- | --- |
| `production_defect` | Производственный брак | Production defect |
| `material_shortage` | Недостаток сырья | Material shortage |
| `equipment_stop` | Остановка оборудования | Equipment stop |
| `production_order_changed` | Изменение производственного задания | Production order changed |
| `planned_quantity_error` | Ошибка в плановом количестве | Planned quantity error |
| `other_production_deviation` | Другое производственное отклонение | Other production deviation |

The codes belong in `@markiro/domain` so the station, API, and cabinet cannot drift. The station close DTO accepts `null` only when `plannedQtySnapshot` is null or equals `actualQty`; otherwise one of the six codes is mandatory. The API repeats that validation and never accepts arbitrary text from a device.

## Shift participation and closing authority

### Server model

An additive Postgres migration introduces `shift_device_participants`:

- `tenant_id`, `shift_id`, `device_id` form the unique participant identity;
- `first_entered_at` records first entry;
- `last_entered_at` records the most recent explicit entry;
- composite tenant foreign keys bind both shift and device to the same tenant.

The shift stores an irreversible `station_close_policy` with values `single_device` and `admin_only`, plus nullable `station_close_owner_device_id`. Before any station enters, the owner is null. The first station entry atomically claims the owner and leaves the policy `single_device`. Entry by a different device atomically changes the policy to `admin_only`; it never changes back when a device pauses, disconnects, or is revoked.

The current `POST /shifts/:id/open` remains compatible for older stations. When authenticated as a station it also records the participant. New stations use one entry operation for both planned and active shifts: it opens a planned shift when necessary, records the authenticated device, and returns the effective closing policy. Entering an active shift therefore no longer remains an unreported client-only `onSelected` transition.

The server's final close check uses the union of explicit participant rows and distinct authenticated terminal evidence already stored for scans and boxes. This safely classifies upgraded shifts whose participation predates this feature. It cannot know about a second device whose work has never reached the server; that unavoidable stale-knowledge case is handled as late data or a close reconciliation conflict, never hidden.

### Device contract

The list and bundle responses add a backward-compatible station closing descriptor:

```ts
type StationCloseAccess =
  | { kind: "single_device"; ownerDeviceId: string }
  | { kind: "admin_only" };
```

The station persists it in `shift_mirror`. An omitted descriptor from an older server preserves the last published local value. An explicit `admin_only` always wins and cannot be downgraded by an older cached bundle.

## Durable local close

### Counting the actual

The close flow first stops accepting new scanner input and waits for the existing ordered scan queue to settle. It then reads the durable SQLite state:

- `actualQty`: count of current accepted unique codes in `codes_mirror` for the shift; undo and clear already remove released codes, so the count reflects the operator's final local state;
- `closedBoxCount`: count of non-disassembled closed boxes for the shift and current terminal;
- `openBoxCount`: count of open boxes for the shift and current terminal;
- `plannedQtySnapshot`, product identity, and product name from the mirrored bundle.

The in-memory accepted counter is never authoritative. If `openBoxCount > 0`, the flow returns to work with a precise instruction and does not create a close record.

### SQLite close outbox

An additive runtime migration creates `shift_close_outbox` with one durable row per local close event:

- generated `event_id` primary key;
- `shift_id`, `device_id`, `operator_id`;
- product id and product-name snapshot;
- `planned_qty_snapshot`, `actual_qty`, `closed_box_count`;
- nullable fixed `reason_code`;
- `closed_at` from the device;
- state `pending` or `conflict`, nullable safe `conflict_code`, and nullable
  `last_checked_at` for a bounded reconciliation poll.

Inserting this row is the local commit point. Shift selection overlays queued/conflicted shift ids as locally closed, so a subsequent API refresh, restart, or stale active bundle cannot put the operator back into the shift. The record survives process restart and is removed only after an authoritative server acknowledgement. A conflict row remains durable until administrator reconciliation is observed.

The scan source stays paused from summary opening through the local insert. If counting or insertion fails, the station shows a local-storage error, remains in the shift, and resumes scanning only after the operator dismisses the error. It never pretends the shift closed when the durable record was not written.

## Close synchronization

Shift closures use a dedicated station-only endpoint rather than overloading the already complex scan batch shape. The close drain is part of the existing serialized sync engine and inherits its credential-generation sealing, backoff, restart, and recovery rules.

A pending close becomes eligible only when that shift has no earlier unacknowledged scan, box closure, or exception rows. Work from unrelated shifts does not block it. This preserves the business order: item and box facts reach the server before the close fact.

Each request carries the stable `eventId`; the server stores that id with the authenticated device and a normalized payload digest. Exact redelivery is an acknowledged no-op. Reuse of an event id with a different payload is rejected and audited. The server never trusts tenant or device identity from the body.

On acceptance the server:

1. tenant-scopes and locks the shift;
2. checks that it is active or was already closed by this event;
3. computes the effective participant set;
4. validates the fixed-reason rule against the submitted plan snapshot and local actual;
5. closes a single-device shift and records the close snapshot, source device, operator, and event id;
6. returns an acknowledgement that allows the station to delete the local close row.

If the shift is administrator-only, the server stores a `shift_close_conflict` containing the shift, device, operator, plan, local actual, box count, reason, close time, and rejection code. The shift remains active server-side and the response tells the station to change its local row to `conflict`. Repeated delivery of the same event does not create duplicate conflicts. A conflict row is rechecked through the same idempotent endpoint no more than once every five minutes; after an administrator resolves or dismisses it, the server returns `already_resolved` and the station removes the local row. This reconciliation polling remains independent of scanner work and network availability.

If an administrator already closed the shift, the device event is acknowledged as already resolved and removed locally. Late scans remain accepted under the existing `late_data_at` rule; they do not reopen the shift.

Credential recovery and re-pairing scrub pending/conflicted close records only under the existing safe recovery ownership rules. In-flight close writes participate in the same generation barrier, so an old tenant cannot repopulate SQLite after scrub.

## Station UI

### Shift cards

Each fixed-height card contains:

- product image and product name;
- counterparty when present;
- status badge: `Не начата` for `planned`, `В работе` for `active`;
- planned date formatted in the active locale, or `Без даты`;
- planned quantity as `План: N шт.`, or `План не указан`;
- operation type: `Проверка` or `Агрегация`;
- `Открыть` for planned shifts and `Присоединиться` for active shifts.

The selection screen keeps three cards per page and the existing fixed footer. At 1280×800 it does not scroll or clip actions. Closed and locally-close-pending shifts are excluded.

### Work footer

The footer contains three distinct actions: `Исключения`, `Пауза`, and `Закрыть смену`.

- `Пауза` retains the current pending-sync warning behavior, exits to selection, and leaves the shift active.
- `Закрыть смену` opens the summary flow and visually uses the destructive action treatment.
- For a known `admin_only` shift, the close action explains `Смена открыта на нескольких устройствах. Закрытие доступно в админке.` and cannot create a local close event.

### Close summary

The fixed-viewport dialog shows:

- product and cached image when available;
- planned quantity when present;
- actual accepted item count;
- signed deviation from plan when a plan exists;
- for aggregation, closed box count and average accepted items per closed box; when no box is
  closed, the average is shown as `—`, never as a division-by-zero value;
- an open-box blocker when applicable.

When plan is absent or equals actual, the operator confirms without a reason. When they differ, the same dialog displays the six reasons as a pageless touch grid with exactly one selection required. There is no text input. `Вернуться к работе` cancels and resumes the scan source.

After the durable local insert, the station exits the work screen and briefly confirms: `Смена закрыта. Данные будут синхронизированы автоматически.` This copy is identical online and offline and makes no claim that the server has already acknowledged the event.

## Cabinet reconciliation

The shifts surface displays an administrator-only close conflict on the affected active shift. Its details include product, line, device, operator, planned snapshot, local actual, box count, selected reason, and local close time. The administrator can close through the existing cabinet close action or dismiss the device attempt with an audited resolution. Resolving it makes the next station sync acknowledge and remove the local conflict marker.

This is distinct from code-ownership conflicts and from online presence. The UI may share cabinet primitives, but the data and resolution semantics stay shift-specific.

## Line presence

Presence reuses `station_devices.last_seen_at`, which the station guard already updates only after successful device authentication. A new station-only `POST /station/heartbeat` returns 204 and carries no business data.

- The station calls it every 60 seconds while paired, including idle, login, selection, and work screens.
- A failed heartbeat is silent and not durably queued; the next interval retries. It never affects scanning or close synchronization.
- Revoked credentials fail closed and enter the existing credential-recovery path.
- A station is online when its latest authenticated heartbeat is no older than 2 minutes.

`GET /lines` returns an additive presence summary derived tenant-safely from assigned, paired, non-revoked station devices:

```ts
interface LinePresenceDto {
  status: "online" | "offline" | "unassigned";
  onlineStations: number;
  totalStations: number;
  lastSeenAt: Date | null;
}
```

A line is online when at least one assigned station is online. The cabinet renders `В сети · 1 из 2 станций`, `Не в сети · последняя связь 14:32`, or `Станции не назначены`, and polls the list once per minute. Status is textual as well as colored.

## Security and authorization

- Entry, heartbeat, and close-sync routes require a current paired station credential and derive tenant, device, and assigned line server-side.
- Cabinet sessions cannot call station-only close-sync or heartbeat routes.
- A station can enter only a shift visible under its line-scoped station list rules.
- Every participation, close, conflict, and resolution query is tenant-scoped in the statement itself.
- Operator ids are validated against the tenant's station-eligible operator set when the close reaches the server; an unknown historical operator is retained as device evidence but cannot be attributed to another tenant.
- Exact audit tests cover actor, tenant, device, operator, shift, plan, actual, reason, result, and conflict metadata.
- `docs/device-key-surface.md`, route inventory, OpenAPI, CORS inventory, and production station CORS verification are updated together.

## Compatibility and rollout

- All Postgres and SQLite changes are additive migrations; applied migrations are never rewritten.
- Old stations continue using `open` and never submit close events. Their station-authenticated opens still record participation after the API deploy.
- An omitted close-access descriptor preserves a previously mirrored value; a station with no prior value treats closing as administrator-only.
- API deploy precedes the Station beta. The new Station remains compatible while the API rolls because it fails closed on missing close authority and keeps pause available.
- Heartbeat and line presence are additive; older stations still update `last_seen_at` whenever they call any authenticated API route, but only the new beta provides reliable idle presence.

## Testing and acceptance

### Automated

- Domain tests for the six reason codes and conditional reason validation.
- Postgres schema/migration tests for tenant keys, participant uniqueness, irreversible administrator-only policy, close-event idempotency, and conflict uniqueness.
- API unit and database e2e tests for first/second device entry, old `open` compatibility, tenant denial, session denial, exact redelivery, payload mismatch, administrator-only conflict, already-admin-closed acknowledgement, reason rules, and audit fields.
- SQLite migration and mirror tests for legacy rows, pending close persistence, restart, conflict retention, and credential scrub.
- Sync tests prove shift-scoped prerequisite ordering, unrelated-shift independence, retry/backoff, restart during delivery, credential rejection, and no acknowledgement before server confirmation.
- Station component tests cover card metadata, locale formatting, pause, close summary, plan match/no-plan/mismatch, fixed reasons, open-box blocking, administrator-only copy, storage failure, and success copy.
- Heartbeat tests cover interval cleanup, credential rejection, idle updates, two-minute threshold, multi-device line aggregation, tenant isolation, admin polling, and all three presence labels.
- Screen-gallery and fixed-viewport assertions cover 1280×800 without scrolling or clipped actions.
- Relevant package typecheck, lint, tests, builds, formatting, migration checks, route/OpenAPI inventories, and production contract checks run before release.

### External gates

- A real Windows Station beta verifies touch targets, scanner focus during open/cancel/close, restart with a pending closure, and image/statistics rendering at 1280×800.
- A real offline exercise closes a shift, restarts Station, reconnects, and verifies exactly one server close.
- A two-device exercise makes a shift administrator-only and verifies the stale offline close becomes one cabinet reconciliation conflict.
- Production deployment verifies live heartbeat freshness and line status transitions without exposing credentials or relying on browser `navigator.onLine`.

## Out of scope

- Reopening a closed shift from Station.
- Closing a multi-device shift from any station.
- Custom tenant-configured close reasons or free-form operator text.
- Using heartbeat as a safety interlock for production work; presence is informational only.
- Treating a paused device as having left the participant set; multi-device history remains irreversible for closing authority.
- Replacing the existing late-data and code-conflict models with close reconciliation.
