# Signer tray status and integration journal design

**Date:** 2026-09-02

**Status:** approved 2026-09-02; implementation plans prepared

**Scope:** `apps/signer`, `apps/admin`, `apps/api`, integration journal DTOs and database indexes

## Purpose

Make Signer's state legible in the Windows notification area and turn the
integration journal into a chronological operational tool rather than an
error-first dump.

The two surfaces serve the same operator question at different levels:

- the tray icon answers whether Signer needs attention now;
- the integration journal explains what happened and when.

Historical errors remain historical facts. This change does not introduce an
acknowledged, resolved, or read state.

## Current problems

### Tray status

Signer paints a coloured badge onto a 128x128 source icon. The colour core uses
roughly one tenth of the source width as its radius. When Windows scales the
image to the common 16x16 notification-area size, the visible colour core is
only about three pixels across and blends into the icon.

The state mapping and tooltip are already correct. The problem is the badge's
effective size and contrast after system scaling, not missing state.

### Integration journal

The API and admin client both deliberately move every failed session ahead of
all other sessions. A failure from weeks ago can therefore appear above a
successful session from today. The journal no longer reads as history.

The route also returns one hard-capped array of up to 50 sessions. It exposes
neither query filters nor pagination metadata. Client-only pagination would
hide this limitation rather than fix it.

## Product rules

1. Current health and historical outcome are different concepts.
2. The default journal order is strictly newest first.
3. Errors stay easy to find through the current-state notice and outcome
   filters. They are not permanently promoted above newer activity.
4. Filters select sessions. Expanding a matching session shows every retained
   session-level event plus a bounded, explicitly labelled set of item-level
   events so diagnostic context is not silently removed or misrepresented.
5. Pagination is performed by the API. The admin never paginates a truncated
   in-memory response.
6. Orphan events continue to appear as one-event synthetic sessions.
7. No manual error acknowledgement or resolution lifecycle is added.

## Tray indicator

### Visual treatment

Keep the badge in the lower-right corner, but design it for the 16x16 rendered
result rather than for the 128x128 source image.

- Target outer diameter at 16x16: 7-8 pixels.
- Target colour-core diameter at 16x16: 5-6 pixels.
- Use a two-tone contour around the colour core: a dark outer edge and a light
  inner edge. At least one edge remains visible against either a light or dark
  Windows tray background.
- Keep the badge fully inside the icon bounds so Windows scaling cannot clip
  it.
- Preserve the existing semantic colours and tooltip text.
- Preserve the blue working/update pulse. The pulse changes badge size and
  brightness only; it does not move the badge.

The badge is intentionally large. At notification-area scale it is a status
signal, not decoration.

### State mapping

| Agent state             | Badge      | Tooltip behaviour                      |
| ----------------------- | ---------- | -------------------------------------- |
| Not paired              | Grey       | Existing unpaired tooltip              |
| Healthy                 | Green      | Existing ready tooltip                 |
| Reconnecting            | Amber      | Existing reconnecting tooltip          |
| Unavailable or degraded | Red        | Existing unavailable/attention tooltip |
| Signing or updating     | Blue pulse | Existing signing/updating tooltip      |

Colour is not the only carrier of meaning: the tooltip continues to name the
state, and notifications retain their existing outage grace period.

### Verification

Rust unit tests must verify badge geometry, the state-to-colour mapping, and
that painting remains confined to the lower-right badge area. A Windows check
at 100%, 125%, and 150% display scaling remains an external acceptance gate;
host Cargo tests cannot prove notification-area rendering.

## Integration journal information architecture

The journal remains a single region on every channel page and retains the
shared session/event model from the integrations brief.

### Current-state notice

If the channel is currently `error`, `silent`, or `unavailable`, show one
compact notice above the journal controls. The notice describes the current
channel state. For `error`, its action selects the Errors tab. For `silent` or
`unavailable`, its action resets the journal to All, the 30-day period, and
page 1 so the operator sees the latest available history without implying that
silence itself produced an error event.

The notice does not claim that an old event is unresolved. When the channel
returns to `working`, the notice disappears while the event stays in history.

### Outcome tabs

Use the shared `DataTabs` component for:

- All
- Errors
- Warnings
- Successful
- In progress

The active tab is a filter, not a second store of data. Tabs do not need badge
counts in the first version; the filtered result count is shown below the
controls.

### Secondary filters

Provide labelled controls for:

- period: 24 hours, 7 days, 30 days, 90 days;
- direction: all, incoming, outgoing, local action.

The default period is 30 days. A 90-day option matches session-level
retention. Full-text search and arbitrary date ranges are excluded from the
first version: they add query and indexing complexity without a demonstrated
operator requirement.

Changing any filter resets the active page to page 1.

### Session list

Render sessions newest first, grouped by calendar day in the organisation's
timezone. Do not create a separate card for every row. Use one journal surface,
day headings, sparse dividers, and semantic status chips.

A collapsed session row shows:

- start time;
- outcome;
- duration or `In progress`;
- event count;
- directions represented in the session;
- a short summary or the most relevant event message.

The row header is a real button with `aria-expanded`. The expanded panel is a
sibling region, not an interactive `li`, so nested protocol details do not
need event-propagation workarounds.

Expanded content shows every retained session-level event and the latest 20
retained item-level events in chronological order. Each event includes time,
direction, outcome, and message. Raw protocol output remains collapsed in a
native `details` element and preserves the exact server text. If older
item-level events were omitted, the panel says exactly how many events exist
and how many are shown; it never presents a truncated sequence as complete.

### Pagination

Use the shared `Pager` component below the list.

- Fixed page size: 20 sessions.
- Show `N sessions found` next to the controls.
- Show page X of Y in the pager.
- Hide the pager when no sessions match; the API reports `totalPages: 0` for
  an empty result.
- Preserve the previous page while the next page loads, but mark the list as
  refreshing and prevent duplicate page requests.
- A page that becomes empty after a refresh moves back to the last valid page.

## API contract

Extend `GET /integrations/:type/journal` with validated query parameters:

| Parameter   | Values                                  | Default                |
| ----------- | --------------------------------------- | ---------------------- |
| `page`      | integer, 1 or greater                   | `1`                    |
| `pageSize`  | integer, 1-50                           | `20`                   |
| `outcome`   | `all`, `ok`, `warn`, `error`, `running` | `all`                  |
| `direction` | `all`, `in`, `out`, `local`             | `all`                  |
| `from`      | ISO date-time                           | 30 days before request |
| `to`        | ISO date-time                           | request time           |

`from` must not be later than `to`, and the requested span must not exceed the
90-day session retention window.

The response becomes:

```ts
interface JournalPageDto {
  timeZone: string;
  sessions: JournalSessionDto[];
  pageInfo: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

interface JournalSessionDto {
  // Existing identity, time, outcome, summary, and events fields remain.
  eventCount: number;
  eventsTruncated: boolean;
}
```

Filtering semantics:

- `outcome=running` matches a null session outcome;
- outcome filtering applies to the session or synthetic session outcome;
- direction filtering matches sessions containing at least one event with the
  requested direction;
- time filtering uses session start time or orphan-event time;
- direction matching never removes context from the returned detail subset:
  it still contains every retained session-grain event and the same bounded
  item-grain sequence, not only events with the requested direction.

Ordering is stable: `startedAt DESC, id DESC`. The server removes all
error-first reordering. The admin does not re-sort the response.

The OpenAPI schema, API DTOs, admin DTOs, query keys, and tests change together.
The query key includes page and filters so cached pages cannot overwrite one
another.

## Data access

Pagination must operate on the unified session projection before event detail
is fetched:

1. Build one tenant- and channel-scoped projection of real sessions and orphan
   events.
2. Apply period, outcome, and direction predicates.
3. Count matching projection rows.
4. Order and page the projection.
5. Count all retained events for the real session IDs on that page.
6. Fetch every session-grain event plus the latest 20 item-grain events per
   real session. Keep the returned subset in chronological order.
7. Read the organisation timezone, falling back to `Europe/Moscow` when the
   tenant has no profile row.
8. Map real and synthetic sessions to the shared DTO shape, including exact
   `eventCount` and `eventsTruncated` values.

This prevents the current two-source `limit`, merge, and re-slice behaviour
from producing incomplete later pages.

Add composite indexes supporting the tenant/channel/time access paths for
sessions and events. The migration must be additive and must not rewrite
existing journal records.

## Loading, empty, and error states

- Initial load uses a skeleton matching the day headings and rows.
- A filtered empty state says that no sessions match the selected filters and
  offers `Reset filters`.
- A genuinely empty journal retains the existing first-exchange explanation.
- A page-load failure keeps the controls visible and offers `Retry`.
- A refresh failure leaves the last successful page visible and shows a
  contextual inline warning.
- Filter and pagination state stay local to the channel page in the first
  version; URL persistence is not required.

## Accessibility and localisation

- All new visible strings are added in Russian and English.
- Date and time formatting use the application locale and organisation
  timezone.
- Tabs, filters, row disclosure, protocol details, retry, reset, and pager are
  keyboard accessible.
- Status always has a text label. Colour alone never identifies outcome.
- Focus remains on the activating control when a session is expanded or
  collapsed.
- Respect the existing light/dark tokens and office-mode density.

## Tests

### Signer

- badge geometry remains visible at the expected scaled proportion;
- every agent phase maps to the intended visual state;
- pulse changes only the active badge treatment;
- tooltip and notification behaviour do not regress;
- Cargo workspace tests pass.

### API

- default newest-first ordering across real and synthetic sessions;
- stable tie-breaking by ID;
- tenant and channel isolation for every filter;
- outcome, direction, and period filtering;
- complete session-grain context and the same bounded item-grain detail after
  a direction match;
- complete session-grain events, bounded item-grain events, and honest
  truncation metadata;
- page boundaries, totals, and last-page handling;
- invalid query values return 400;
- the 90-day maximum span is enforced;
- focused e2e coverage plus API package gates.

### Admin

- errors are no longer promoted above newer sessions;
- tabs and secondary filters change the request and reset page number;
- current-state notice applies the expected filter;
- grouped day headings and locale formatting;
- session disclosure and nested protocol details remain operable by mouse and
  keyboard;
- initial, filtered-empty, refresh-error, and page-loading states;
- package test, typecheck, lint, and build gates.

## External acceptance

Automated checks do not prove:

- tray readability on a real Windows notification area at multiple scale
  factors;
- visual rhythm and contrast in both admin themes;
- behaviour against production-sized journal data.

These remain explicit manual acceptance checks after the implementation is
packaged and deployed to a safe environment.

## Non-goals

- Manual acknowledgement, assignment, or resolution of an integration error.
- A global journal across all channels.
- Full-text search or arbitrary date-range selection.
- Changing journal retention periods.
- Changing Signer's agent-state machine, polling, notification grace period,
  or updater behaviour.
- Exporting the admin integration journal in this iteration.
- Per-session pagination of item-level journal detail.
