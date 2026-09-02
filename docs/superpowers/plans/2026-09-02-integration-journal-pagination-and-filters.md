# Integration Journal Pagination and Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace error-first integration history with a chronological, filterable, server-paginated journal that preserves complete diagnostic context within explicit detail bounds.

**Architecture:** Read real sessions and orphan events through one tenant-scoped SQL projection ordered by `startedAt DESC, id DESC`; page that projection before loading detail events. The API owns validation, total counts, organisation timezone, event totals, and truncation metadata. The admin owns local filter/page state, renders the shared chronological contract, and never re-sorts or paginates a truncated response.

**Tech Stack:** PostgreSQL, Drizzle ORM and migrations, NestJS, Zod, OpenAPI, React 19, TanStack Query 5, `@markiro/ui`, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-09-02-signer-tray-and-integration-journal-design.md`

## Global Constraints

- Default order is strictly `startedAt DESC, id DESC`; remove error-first ordering from both API and admin.
- Fixed admin page size is 20; API accepts 1-50.
- Default period is 30 days; maximum period is 90 days.
- Outcome filters are `all`, `ok`, `warn`, `error`, and `running`; `running` maps to a null session outcome.
- Direction filters are `all`, `in`, `out`, and `local`.
- Filters select sessions; returned real sessions keep every session-grain event and the latest 20 item-grain events, with exact `eventCount` and `eventsTruncated` metadata.
- Orphan events remain one-event synthetic sessions.
- Every database query is tenant- and channel-scoped.
- Use the organisation timezone with `Europe/Moscow` fallback.
- Do not add acknowledgement, resolution, global-journal, export, free-text search, arbitrary date-range UI, or per-session event pagination.
- Preserve exact raw protocol text and keep it collapsed by default.

## File Structure

- Modify `packages/db/src/schema/integrations.ts`: add composite journal access indexes.
- Create `packages/db/test/integrations-schema.test.ts`: focused schema-index assertions.
- Generate `packages/db/migrations/0110_integration_journal_pagination_indexes.sql`, `packages/db/migrations/meta/0110_snapshot.json`, and update `packages/db/migrations/meta/_journal.json`.
- Create `apps/api/src/modules/integrations/journal-query.ts`: query DTO resolution, date-window validation, and constants.
- Create `apps/api/src/modules/integrations/journal-read.repository.ts`: unified projection, count/page queries, timezone lookup, and bounded event-detail loading.
- Modify `apps/api/src/modules/integrations/dto.ts`: request schema, response metadata, event totals, and OpenAPI schema.
- Modify `apps/api/src/modules/integrations/integrations.controller.ts`: validate and document journal query parameters.
- Modify `apps/api/src/modules/integrations/integrations.service.ts`: delegate journal reads to the focused repository and remove error-first merge logic.
- Create `apps/api/test/integration-journal-query.test.ts`: deterministic query-window tests.
- Modify `apps/api/test/integrations.e2e.test.ts`: route contract, filtering, pagination, ordering, detail bounds, and isolation.
- Modify `apps/admin/src/pages/integrations/api.ts`: typed filter/page request, URL construction, full page response, and cache keys.
- Create `apps/admin/src/pages/integrations/JournalFilters.tsx`: current-state notice, outcome tabs, period/direction controls, and result count.
- Create `apps/admin/src/pages/integrations/JournalSessionRow.tsx`: accessible session disclosure and event detail.
- Replace `apps/admin/src/pages/integrations/JournalList.tsx`: query orchestration, day grouping, states, and pager.
- Create `apps/admin/src/pages/integrations/journal.css`: journal-only office-mode layout and responsive rules.
- Modify `apps/admin/src/pages/integrations/ChannelPage.tsx`: pass current channel state to the journal.
- Modify `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json`: all journal labels and state copy.
- Create `apps/admin/test/integrations-journal.test.tsx`: focused component and request tests.
- Modify `apps/admin/test/integrations-channel.test.tsx`: adopt the new response shape and remove the obsolete error-first assertion.

---

### Task 1: Journal Access Indexes

**Files:**

- Modify: `packages/db/src/schema/integrations.ts:62-112`
- Create: `packages/db/test/integrations-schema.test.ts`
- Create: `packages/db/migrations/0110_integration_journal_pagination_indexes.sql`
- Create: `packages/db/migrations/meta/0110_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**

- Consumes: existing `integrationSessions` and `integrationEvents` tables.
- Produces: `integration_sessions_tenant_channel_started_id_idx` and `integration_events_tenant_channel_session_direction_at_id_idx`.

- [ ] **Step 1: Write failing schema-index tests**

Create `packages/db/test/integrations-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { integrationEvents, integrationSessions } from "../src/schema/integrations.js";

function indexColumns(table: Parameters<typeof getTableConfig>[0], name: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  expect(index, `missing ${name}`).toBeDefined();
  return (
    index?.config.columns.map((column) =>
      is(column, IndexedColumn) ? column.name : "expression",
    ) ?? []
  );
}

describe("integration journal indexes", () => {
  it("indexes sessions in tenant, channel, and stable paging order", () => {
    expect(
      indexColumns(integrationSessions, "integration_sessions_tenant_channel_started_id_idx"),
    ).toEqual(["tenant_id", "channel_type", "started_at", "id"]);
  });

  it("indexes orphan, direction, and per-session event reads", () => {
    expect(
      indexColumns(
        integrationEvents,
        "integration_events_tenant_channel_session_direction_at_id_idx",
      ),
    ).toEqual(["tenant_id", "channel_type", "session_id", "direction", "at", "id"]);
  });
});
```

- [ ] **Step 2: Run the focused DB test and confirm failure**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/integrations-schema.test.ts
```

Expected: FAIL because both named indexes are missing.

- [ ] **Step 3: Add the composite indexes to the Drizzle schema**

Keep the existing indexes and add:

```ts
index("integration_sessions_tenant_channel_started_id_idx").on(
  t.tenantId,
  t.channelType,
  t.startedAt.desc(),
  t.id.desc(),
),
```

and:

```ts
index("integration_events_tenant_channel_session_direction_at_id_idx").on(
  t.tenantId,
  t.channelType,
  t.sessionId,
  t.direction,
  t.at.desc(),
  t.id.desc(),
),
```

- [ ] **Step 4: Generate and inspect the additive migration**

Run:

```bash
pnpm --filter @markiro/db db:generate --name integration_journal_pagination_indexes
```

Expected generated SQL:

```sql
CREATE INDEX "integration_sessions_tenant_channel_started_id_idx"
ON "integration_sessions" USING btree
("tenant_id", "channel_type", "started_at" DESC, "id" DESC);

CREATE INDEX "integration_events_tenant_channel_session_direction_at_id_idx"
ON "integration_events" USING btree
("tenant_id", "channel_type", "session_id", "direction", "at" DESC, "id" DESC);
```

Inspect the actual generated SQL. It must contain only the two new indexes and
must not drop, rename, or rewrite existing data.

- [ ] **Step 5: Run DB gates**

```bash
pnpm --filter @markiro/db exec vitest run test/integrations-schema.test.ts
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Commit the indexes and migration**

```bash
git add packages/db/src/schema/integrations.ts packages/db/test/integrations-schema.test.ts packages/db/migrations/0110_integration_journal_pagination_indexes.sql packages/db/migrations/meta/0110_snapshot.json packages/db/migrations/meta/_journal.json
git commit -m "perf(db): index integration journal pagination"
```

### Task 2: Validated Journal Query Model

**Files:**

- Create: `apps/api/src/modules/integrations/journal-query.ts`
- Modify: `apps/api/src/modules/integrations/dto.ts:1-55`
- Create: `apps/api/test/integration-journal-query.test.ts`

**Interfaces:**

- Produces: `listJournalQuerySchema`, `ListJournalQueryDto`, `ResolvedJournalQuery`, `resolveJournalQuery(query, now)`, `JOURNAL_DEFAULT_PAGE_SIZE`, `JOURNAL_MAX_RANGE_DAYS`, and `JOURNAL_ITEM_EVENTS_PER_SESSION_LIMIT`.
- Consumed by: Task 3 controller, service, and repository.

- [ ] **Step 1: Write failing deterministic query-resolution tests**

Create tests for defaults, explicit values, invalid ordering, and the 90-day
bound:

```ts
import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { listJournalQuerySchema } from "../src/modules/integrations/dto.js";
import { resolveJournalQuery } from "../src/modules/integrations/journal-query.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

it("defaults to page 1, 20 rows, all outcomes/directions, and 30 days", () => {
  const parsed = listJournalQuerySchema.parse({});
  expect(resolveJournalQuery(parsed, NOW)).toEqual({
    page: 1,
    pageSize: 20,
    outcome: "all",
    direction: "all",
    from: new Date("2026-08-03T12:00:00.000Z"),
    to: NOW,
  });
});

it("rejects a window longer than 90 days", () => {
  const parsed = listJournalQuerySchema.parse({
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-09-02T00:00:00.000Z",
  });
  expect(() => resolveJournalQuery(parsed, NOW)).toThrow(BadRequestException);
});
```

Also assert `from > to`, `page=0`, `pageSize=51`, unknown outcome, unknown
direction, and malformed dates are rejected.

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm --filter @markiro/api exec vitest run test/integration-journal-query.test.ts
```

Expected: FAIL because the schema and resolver do not exist.

- [ ] **Step 3: Implement the Zod schema and deterministic resolver**

Add to `dto.ts`:

```ts
export const journalOutcomes = ["all", "ok", "warn", "error", "running"] as const;
export const journalDirections = ["all", "in", "out", "local"] as const;

export const listJournalQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  outcome: z.enum(journalOutcomes).default("all"),
  direction: z.enum(journalDirections).default("all"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ListJournalQueryDto = z.infer<typeof listJournalQuerySchema>;
```

Create `journal-query.ts` with exact constants and a resolver:

```ts
export const JOURNAL_DEFAULT_PAGE_SIZE = 20;
export const JOURNAL_MAX_RANGE_DAYS = 90;
export const JOURNAL_ITEM_EVENTS_PER_SESSION_LIMIT = 20;

export interface ResolvedJournalQuery {
  page: number;
  pageSize: number;
  outcome: ListJournalQueryDto["outcome"];
  direction: ListJournalQueryDto["direction"];
  from: Date;
  to: Date;
}

export function resolveJournalQuery(query: ListJournalQueryDto, now: Date): ResolvedJournalQuery {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to || to.getTime() - from.getTime() > JOURNAL_MAX_RANGE_DAYS * 86_400_000) {
    throw new BadRequestException({ code: "INTEGRATION_JOURNAL_DATE_RANGE_INVALID" });
  }
  return { ...query, from, to };
}
```

- [ ] **Step 4: Run focused tests and API static checks**

```bash
pnpm --filter @markiro/api exec vitest run test/integration-journal-query.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit the query model**

```bash
git add apps/api/src/modules/integrations/dto.ts apps/api/src/modules/integrations/journal-query.ts apps/api/test/integration-journal-query.test.ts
git commit -m "feat(api): define integration journal query"
```

### Task 3: Unified Server Pagination and Detail Bounds

**Files:**

- Create: `apps/api/src/modules/integrations/journal-read.repository.ts`
- Modify: `apps/api/src/modules/integrations/dto.ts:23-45,178-215`
- Modify: `apps/api/src/modules/integrations/integrations.controller.ts:149-160`
- Modify: `apps/api/src/modules/integrations/integrations.service.ts:1-55,425-559`
- Modify: `apps/api/test/integrations.e2e.test.ts:240-315`

**Interfaces:**

- Consumes: `ResolvedJournalQuery` from Task 2 and the two composite indexes from Task 1.
- Produces: `readJournalPage(db, tenantId, type, query): Promise<JournalPageDto>` and the paginated HTTP contract.

- [ ] **Step 1: Replace the obsolete route smoke assertion with failing contract tests**

Add fixtures with deliberately interleaved outcomes and times, then assert:

```ts
const page = await agent
  .get("/integrations/commerceml/journal")
  .query({ page: 1, pageSize: 2, from: "2026-08-01T00:00:00.000Z", to: "2026-09-02T23:59:59.000Z" })
  .expect(200);

expect(page.body.pageInfo).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
expect(page.body.timeZone).toBe("Europe/Moscow");
expect(page.body.sessions.map((session: { id: string }) => session.id)).toEqual([
  newestSuccessfulId,
  olderFailedId,
]);
```

Add separate assertions for:

- page 2 and a page beyond the last page;
- equal `startedAt` values ordered by descending UUID text;
- `outcome=error`, `outcome=running`, and `direction=local`;
- time-window boundaries;
- an orphan event represented as one synthetic session;
- a matched direction returning the session's complete returned detail set;
- all session-grain events plus only the latest 20 item-grain events;
- exact `eventCount` and `eventsTruncated`;
- a second tenant's session never appearing in the first tenant's response;
- invalid page, direction, outcome, date, and over-90-day range returning 400.

- [ ] **Step 2: Run the focused e2e file and confirm failure**

Load the local test environment, rebuild DB output, then run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/integrations.e2e.test.ts
```

Expected: FAIL because the route ignores query parameters and lacks
`pageInfo`, `timeZone`, and event metadata. If the file skips because
`DATABASE_URL` or auth variables are absent, report the skip and do not treat
it as a pass.

- [ ] **Step 3: Extend response DTOs and OpenAPI**

Change the shared response interfaces:

```ts
export interface JournalSessionDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  summary: Record<string, unknown> | null;
  eventCount: number;
  eventsTruncated: boolean;
  events: JournalEventDto[];
}

export interface JournalPageDto {
  timeZone: string;
  sessions: JournalSessionDto[];
  pageInfo: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}
```

Update `journalSessionOpenApiSchema` and `journalPageOpenApiSchema` with the
same required properties and numeric minima. Add `@ApiZodQuery` and
`@ApiZodValidationError` to the controller route.

- [ ] **Step 4: Wire validated query parameters through the controller and service**

Use:

```ts
async journal(
  @Req() req: RequestWithTenant,
  @Param("type") type: IntegrationChannelType,
  @Query(new ZodValidationPipe(listJournalQuerySchema)) query: ListJournalQueryDto,
): Promise<JournalPageDto> {
  return this.integrations.readJournal(req.tenantId!, type, query, new Date());
}
```

Change `IntegrationsService.readJournal` to validate the channel, resolve the
window, and delegate:

```ts
async readJournal(
  tenantId: string,
  type: IntegrationChannelType,
  query: ListJournalQueryDto,
  now: Date,
): Promise<JournalPageDto> {
  safeDescribeChannel(type);
  return readJournalPage(this.db, tenantId, type, resolveJournalQuery(query, now));
}
```

Delete `JOURNAL_PAGE_SIZE`, `JOURNAL_EVENTS_LIMIT`, the two independent source
limits, merged-array sorting, and error-first ordering. Replace the old global
event-bound test with the per-session item-limit assertions from Step 1; no
production caller outside this read path uses the old constant.

- [ ] **Step 5: Implement the unified journal repository**

In `journal-read.repository.ts`, build a `UNION ALL` projection with identical
columns for real sessions and orphan events. Every branch must contain
`tenant_id = tenantId` and `channel_type = type`.

Use these predicates:

```sql
started_at >= :from AND started_at <= :to
AND (:outcome = 'all'
  OR (:outcome = 'running' AND outcome IS NULL)
  OR outcome = :outcome)
AND (:direction = 'all' OR EXISTS (
  SELECT 1 FROM integration_events direction_event
  WHERE direction_event.tenant_id = :tenantId
    AND direction_event.channel_type = :type
    AND direction_event.session_id = integration_sessions.id
    AND direction_event.direction = :direction
))
```

For the orphan branch, apply outcome and direction directly to the event row.
Select the requested page with:

```sql
ORDER BY started_at DESC, id DESC
LIMIT :pageSize OFFSET (:page - 1) * :pageSize
```

Run a count over the same projection. If the paged query returns no rows for a
page greater than 1, still return the real total so the admin can move to the
last valid page.

For real session IDs on the page:

1. group-count all retained events into `eventCount`;
2. fetch every `grain = 'session'` event;
3. fetch item events through `row_number() over (partition by session_id order by at desc, id desc)` and keep ranks 1-20;
4. merge and sort the returned subset by `at ASC, id ASC`;
5. set `eventsTruncated` when the total event count exceeds returned event count.

Read `schema.orgProfiles.timeZone` for the tenant and fall back to
`Europe/Moscow`. Synthetic orphan sessions always have `eventCount: 1` and
`eventsTruncated: false`.

- [ ] **Step 6: Run focused and package API checks**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/integration-journal-query.test.ts test/integrations.e2e.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
git diff --check
```

Expected: every configured command exits 0. Report database-backed skips
separately.

- [ ] **Step 7: Commit the API contract and repository**

```bash
git add apps/api/src/modules/integrations/journal-read.repository.ts apps/api/src/modules/integrations/dto.ts apps/api/src/modules/integrations/integrations.controller.ts apps/api/src/modules/integrations/integrations.service.ts apps/api/test/integrations.e2e.test.ts
git commit -m "feat(api): paginate integration journal"
```

### Task 4: Typed Admin Journal Client

**Files:**

- Modify: `apps/admin/src/pages/integrations/api.ts:73-145`
- Create: `apps/admin/test/integrations-journal.test.tsx`
- Modify: `apps/admin/test/integrations-channel.test.tsx:72-150`

**Interfaces:**

- Consumes: Task 3 `JournalPageDto` wire shape.
- Produces: `JournalPeriod`, `JournalOutcomeFilter`, `JournalDirectionFilter`, `JournalQuery`, `journalQueryKey(type, query)`, and `useChannelJournal(type, query)`.

- [ ] **Step 1: Write a failing hook probe test for URL and cache-key behaviour**

Render a component that calls:

```tsx
useChannelJournal("commerceml", {
  page: 2,
  pageSize: 20,
  outcome: "error",
  direction: "local",
  period: "7d",
});
```

Freeze time at `2026-09-02T12:00:00.000Z`, then assert the request URL contains
`page=2`, `pageSize=20`, `outcome=error`, `direction=local`,
`from=2026-08-26T12:00:00.000Z`, and `to=2026-09-02T12:00:00.000Z`. Render a
second probe with a different outcome and assert it receives a distinct query
cache entry.

- [ ] **Step 2: Run the focused admin test and confirm failure**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-journal.test.tsx
```

Expected: FAIL because `useChannelJournal` does not accept a query and the
response lacks page metadata.

- [ ] **Step 3: Implement typed request and response shapes**

Use:

```ts
export type JournalPeriod = "24h" | "7d" | "30d" | "90d";
export type JournalOutcomeFilter = "all" | "ok" | "warn" | "error" | "running";
export type JournalDirectionFilter = "all" | "in" | "out" | "local";

export interface JournalQuery {
  page: number;
  pageSize: number;
  outcome: JournalOutcomeFilter;
  direction: JournalDirectionFilter;
  period: JournalPeriod;
}

export interface JournalPageResponse {
  timeZone: string;
  sessions: JournalSessionDto[];
  pageInfo: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
```

Add `eventCount` and `eventsTruncated` to `JournalSessionDto`. Build wire
`from` and `to` inside the query function at request time, while the stable
TanStack key contains the semantic `period` value:

```ts
export function journalQueryKey(type: string, query: JournalQuery) {
  return ["integrations", type, "journal", query] as const;
}
```

Use TanStack's `placeholderData: (previous) => previous` so page changes retain
the previous page while `isFetching` communicates refresh.

- [ ] **Step 4: Update legacy channel fixtures to the new response envelope**

Replace `{ sessions: journalSessions }` with:

```ts
{
  timeZone: "Europe/Moscow",
  sessions: journalSessions,
  pageInfo: {
    page: 1,
    pageSize: 20,
    totalItems: journalSessions.length,
    totalPages: journalSessions.length === 0 ? 0 : 1,
  },
}
```

Add `eventCount` and `eventsTruncated` to journal session fixtures. Remove the
test that expects failed sessions to be promoted; Task 5 replaces it with a
chronology assertion in the focused journal test.

- [ ] **Step 5: Run focused admin checks**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-journal.test.tsx test/integrations-channel.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git diff --check
```

Expected: the hook probe and existing channel tests pass.

- [ ] **Step 6: Commit the client contract**

```bash
git add apps/admin/src/pages/integrations/api.ts apps/admin/test/integrations-journal.test.tsx apps/admin/test/integrations-channel.test.tsx
git commit -m "feat(admin): query paginated integration journal"
```

### Task 5: Chronological Journal Interface

**Files:**

- Create: `apps/admin/src/pages/integrations/JournalFilters.tsx`
- Create: `apps/admin/src/pages/integrations/JournalSessionRow.tsx`
- Replace: `apps/admin/src/pages/integrations/JournalList.tsx`
- Create: `apps/admin/src/pages/integrations/journal.css`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx:771`
- Modify: `apps/admin/src/i18n/ru.json:2931-2950`
- Modify: `apps/admin/src/i18n/en.json` corresponding journal section
- Modify: `apps/admin/test/integrations-journal.test.tsx`

**Interfaces:**

- Consumes: `useChannelJournal(type, query)`, `ChannelState`, `DataTabs`, `Select`, `Alert`, `Button`, `EmptyState`, `StatusChip`, and `Pager`.
- Produces: `JournalList({ type, channelState })`, accessible filters, grouped session rows, and all specified UI states.

- [ ] **Step 1: Add failing UI behaviour tests**

Cover these observable behaviours in `integrations-journal.test.tsx`:

```ts
it("keeps successful newer sessions above older errors", async () => {
  renderJournal({ sessions: [newerOk, olderError] });
  const rows = await screen.findAllByTestId("journal-session");
  expect(rows.map((row) => row.getAttribute("data-session-id"))).toEqual([
    newerOk.id,
    olderError.id,
  ]);
});

it("applies an outcome tab and resets to page one", async () => {
  renderJournal({ initialPage: 3 });
  await userEvent.click(await screen.findByRole("tab", { name: "Ошибки" }));
  expect(lastJournalRequest()).toMatchObject({ page: 1, outcome: "error" });
});
```

Also test:

- period and direction controls;
- error current-state notice selecting the Errors tab;
- silent notice resetting to All/30d/page 1;
- organisation-timezone day grouping;
- result count and Pager navigation;
- page correction when the refreshed page exceeds `totalPages`;
- chronological event details, exact raw protocol text, and keyboard disclosure;
- truncation copy using `eventCount` and `eventsTruncated`;
- initial skeleton, genuine empty, filtered empty with Reset, initial error with Retry, and refresh error preserving stale data;
- duplicate page clicks disabled while fetching.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-journal.test.tsx
```

Expected: FAIL because the controls, metadata, grouping, states, and accessible
row structure do not exist.

- [ ] **Step 3: Build the filters and current-state notice**

`JournalFilters` receives one value object and one change callback:

```ts
interface JournalFiltersProps {
  channelState: ChannelState;
  value: Pick<JournalQuery, "outcome" | "direction" | "period">;
  totalItems: number;
  disabled: boolean;
  onChange: (patch: Partial<JournalQuery>) => void;
  onReset: () => void;
}
```

Render outcome choices through `DataTabs` and period/direction through labelled
`Select` components. Use `Alert.action` with a secondary `Button` for current
`error`, `silent`, or `unavailable` channel states. Keep status text and action
labels distinct in Russian and English.

- [ ] **Step 4: Build an accessible session row and event timeline**

Use a semantic list item containing a real button and sibling panel:

```tsx
<li className="mk-journal-session" data-testid="journal-session" data-session-id={session.id}>
  <button
    type="button"
    className="mk-journal-session__toggle"
    aria-expanded={expanded}
    aria-controls={panelId}
    onClick={() => setExpanded((value) => !value)}
  >
    {/* time, summary, duration, directions, event count, StatusChip */}
  </button>
  {expanded ? <div id={panelId}>{/* chronological event list */}</div> : null}
</li>
```

Do not put `role="button"` on the `li`. Keep the raw protocol response in a
native collapsed `details`. If `eventsTruncated`, render translated copy such
as `Показаны последние {{shown}} из {{total}} построчных событий` before the
event list.

- [ ] **Step 5: Replace journal orchestration and states**

Keep local state:

```ts
const [query, setQuery] = useState<JournalQuery>({
  page: 1,
  pageSize: 20,
  outcome: "all",
  direction: "all",
  period: "30d",
});
```

When outcome, direction, or period changes, force `page: 1`. When successful
data reports `query.page > totalPages`, set the page to
`Math.max(1, totalPages)`. Group only the current page's already ordered
sessions with `Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeZone: data.timeZone })`.

Render:

- skeleton only when `isPending` and no cached data;
- Retry alert when the initial request fails;
- stale rows plus warning when a refetch fails;
- genuine empty when page 1 has no sessions and filters are defaults;
- filtered empty with Reset otherwise;
- `Pager` only when `totalItems > 0`;
- `aria-busy` and disabled controls while the next request is fetching.

Pass the current channel state from `ChannelPage`:

```tsx
<JournalList type={type} channelState={channel.state} />
```

- [ ] **Step 6: Add office-mode styles and responsive behaviour**

Import `./journal.css` from `JournalList.tsx`. Use existing tokens only:

- one `Card`, not one card per session;
- `var(--sp-*)` spacing, `var(--line)` sparse dividers, and existing radii;
- day headings separated by whitespace;
- tab and filter controls wrap below 900px;
- session header metadata uses a responsive grid and collapses to one column below 640px;
- visible `:focus-visible` outline using `var(--focus-ring-w) solid
var(--focus-ring)` with `var(--focus-ring-offset)`;
- no colour-only outcome indicator;
- skeleton animation disabled under `prefers-reduced-motion: reduce`.

- [ ] **Step 7: Add Russian and English copy**

Add keys for outcome tabs, period/direction labels and options, current-state
notices/actions, result count, duration, event count, truncation, pagination,
refreshing, Retry, Reset, filtered empty, and refresh failure. Re-read every
new string for plain operational language and preserve the existing exact raw
protocol label.

- [ ] **Step 8: Run focused and package admin checks**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-journal.test.tsx test/integrations-channel.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 9: Commit the journal interface**

```bash
git add apps/admin/src/pages/integrations/JournalFilters.tsx apps/admin/src/pages/integrations/JournalSessionRow.tsx apps/admin/src/pages/integrations/JournalList.tsx apps/admin/src/pages/integrations/journal.css apps/admin/src/pages/integrations/ChannelPage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/integrations-journal.test.tsx
git commit -m "feat(admin): redesign integration journal"
```

### Task 6: Cross-Package Verification and Manual Acceptance

**Files:**

- Modify only if verification exposes a scoped defect in files already listed above.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: release-ready automated evidence and a separate manual acceptance checklist.

- [ ] **Step 1: Rebuild DB output before consumer checks**

```bash
pnpm --filter @markiro/db build
```

- [ ] **Step 2: Run focused contract checks together**

```bash
pnpm --filter @markiro/db exec vitest run test/integrations-schema.test.ts
pnpm --filter @markiro/api exec vitest run test/integration-journal-query.test.ts test/integrations.e2e.test.ts
pnpm --filter @markiro/admin exec vitest run test/integrations-journal.test.tsx test/integrations-channel.test.tsx
```

Expected: all configured tests pass; database-dependent skips are reported as
skips, not passes.

- [ ] **Step 3: Run package gates**

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm format:check
git diff --check
```

- [ ] **Step 4: Refresh the local code graph**

If `graphify-out/graph.json` exists in the execution checkout, run:

```bash
graphify update .
```

Do not add `graphify-out/` to the commit.

- [ ] **Step 5: Inspect the final diff and commit any verification-only fix**

Stage only scoped files. If verification required a correction, commit it as:

```bash
git commit -m "fix(integrations): close journal verification gaps"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 6: Perform manual admin acceptance separately**

In a safe environment with production-like data, verify light and dark themes,
Russian and English, 20-row pages, all filters, day grouping in the configured
organisation timezone, a session with more than 20 item events, raw protocol
details, keyboard navigation, and a new event arriving during refetch. Record
this evidence separately from automated tests.
