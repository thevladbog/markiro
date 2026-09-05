# US-01 master-data office UI implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for this bounded increment. Preserve the separate publication gate: no commits, pushes, PRs or releases.

**Goal:** Make the existing US parties and locations usable from English/Spanish office lists and forms.

**Architecture:** Keep the independent US entry and session transport. A presentation-only capabilities response is derived from the existing fresh server principal; all business writes still authorize independently. Mount a tenant-keyed master-data workspace only after successful profile loading, with a compact reference sidebar and shared Markiro UI controls. No RU client/router or new dependencies.

**Tech Stack:** Existing Nest/Drizzle, shared Zod contracts/domain, React/i18next and @markiro/ui, Vitest and local Chromium fixture.

**Spec:** docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md; UI handoff and accepted data rules. Visual reference: existing Pencil nodes Ylcdu, JlqVV, zOuSb, GdcWZ, d63MUt. Screens are reference material, not a new design task.

## Global constraints

- Work only in /Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit, codex/us-mvp. Preserve all existing dirty access/server/client work. No primary env/database, hosted resource, commit, push, PR, release, main changes or .pen edits.
- English and U.S. Spanish only; shared UI components/tokens; light/dark, desktop1440 and narrow390. No decorative dashboard metrics or placeholder navigation to unavailable workflows.
- Both profiles allow incomplete descriptions. Name, businessName and active parent required; supplied invalid values are field errors. Archive/restore, never DELETE or cascade. Location partyId immutable. Finalized history unchanged. No P1 identifiers, same-address warnings, lots/events/history backend or fake history panel.
- Only server-granted traceability.master_data.write shows mutation controls. UI capability data is presentation state, never authorization. Server rechecks every write. Stale requests must not restore prior tenant/session state; retain existing MFA/logout safety.
- Only explicit loopback55432 US_TEST_DATABASE_URL with disposable fixtures. Node24 and repository pnpm11.22.0. No dependency install or module-system migration for existing warnings.

## Task 1: Connected parties and locations workspace

**Files:**

- Add packages/platform-contracts/src/traceability/access.ts and test/us-access.test.ts; export from index. Strict response schema usTraceabilityAccessSchema with capabilities array of existing US_CAPABILITY values, max9, unique; no tenant/user/session/role payload.
- Extend apps/api/src/deployment/us-master-data.controller.ts with GET /traceability/access, guarded by existing UsSessionGuard. Return only request.usPrincipal.capabilities (fresh membership and MFA). No database writes or profile setup signal; presentation metadata may be read before profile creation. Empty capabilities for ordinary/unknown roles do not grant business access. Test in existing real MFA us-master-data-http.e2e.test.ts: owner/manager/auditor/unknown transitions, removed membership, missing session, exact shape and OpenAPI.
- Extend apps/admin/src/us/client.ts with access() using shared schema and exact /api/us/traceability/access path; permit only that exact route in vite.us.config.ts. Add focused client and proxy tests. No raw backend issue messages exposed. UI maps a409 on party save to a localized name conflict, other failures to existing safe codes.
- New apps/admin/src/us/master-data/{workspace.tsx,party-form.tsx,location-form.tsx,copy.ts,forms.ts,master-data.css}; smaller supporting modules allowed only within this directory when needed for single responsibilities. Existing app.tsx remains auth/profile owner and imports workspace. Existing us.css changed only to support workspace replacing the sign-in split layout after entry. Add test/us-master-data-ui.test.tsx and forms.test.ts under apps/admin/test; existing us-app tests updated only for integration.

**Interfaces:**

```ts
// Shared response; roles are not accepted from the browser.
usTraceabilityAccessSchema.parse({ capabilities: ["traceability.read"] });
// Client
client.access(): Promise<{ capabilities: UsCapability[] }>;
// Workspace props (parent owns logout serialization and session loss):
type MasterDataProps = {
  client: UsBrowserClient;
  organization: { id: string; name: string };
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  onBack: () => void;
  onSessionLost: () => void;
};
```

The profile summary gets a localized "Open reference data" / "Abrir datos de referencia" button. Entering workspace loads access first; no capabilities means no mutations and a readable denial if READ absent. Workspace has Profile/back, Parties, Locations navigation, organization name and US profile badge, language/theme controls already provided by parent or workspace. No fake future nav. Returning to profile is always possible except while a mutation is settling; leaving workspace on logout/session change unmounts and invalidates loads. Simpler safe boundary: workspace does not itself offer sign-out; user returns to existing profile sign-out. Back is disabled while mutation is pending, avoiding a new concurrent logout path. Session401 invokes parent sessionLost immediately.

**Lists and lifecycle:**

- Parties default active, search submit, active/archived/all selector, limit50 previous/next pagination without fabricated totals. Table columns name/legal name/contact/status/actions. Open party card includes its own paged locations and Add location prefilled to this party. Read-only users can open details but see no create/edit/archive/restore actions.
- Locations search, active/archived/all, server-backed party search selector and six role toggles (AND). Rows show name/business name/party/city-region/roles/readiness. Parent names resolved through tenant-scoped getParty when absent, deduplicated per current page; no assumption that first50parties covers all parents. Creation parent search is active-only with explicit pagination/search, so >50parents remain selectable. Read/edit existing parents individually even if archived.
- Loading, empty, error/retry and stale states explicit. Changing filter invalidates earlier loads. Mutation failures preserve form input; failed saves do not close or optimistically fabricate data. After successful write refetch current list; success/failure announced with role=status/alert. No cross-account cache or localStorage besides existing theme.
- Archive/restore confirmation explains party archive does not archive children and copied historical descriptions remain unchanged. Only archive action remains on an active location whose parent is archived; edit/restore disabled with explanation. An archived child explains that its parent must be restored first. A permission403 refreshes capabilities. The distinct party_archived403 refreshes the affected parent and preserves form input with a recovery path instead of incorrectly claiming write access changed.

**Forms:**

- Party side dialog: name, legalName, contactName, contactPhone, contactEmail, notes. Name required; optional blank→null. Use shared create/PATCH schemas and field-safe localized errors. Do not expose Zod/raw backend prose directly. On409 party name gets localized conflict.
- Location grouped identity, description and roles. Parent active/searchable on create, read-only on edit; business name initially from selected party but editable. Internal/business names required. Optional blank→null; phone/ZIP retain text; street vs coordinates mutually exclusive. Switching address kind clears hidden incompatible fields explicitly on submit. Default countryUS on creation, country text two-letter ISO input with format hint (do not restrict valid foreign countries to three choices). Six role checkboxes.
- Missing description fields show a named explanatory incomplete list, not required-input blocks; supplied invalid formats block save. Draft validation and readiness derive from shared domain/contracts, not duplicated rules. No automatic country recognition/geocoding/legal classification. On edit PATCH sends editable values but never partyId or derived/server fields. Archive/restore use archive-only PATCH.
- Shared accessible dialog/drawer if available: title, focus trap, Escape close when idle, return focus, scrollable body and reachable footer. Unsaved edits require discard confirmation before close/back/navigation. Pending mutation cannot be canceled into a false saved/unsaved state. Avoid inline component declarations that remount focused inputs.

- Final-review refinements: each mutation owns its busy lifetime through the refresh; conflicting entry points and editable form controls stay disabled during that lifetime. Parent-filter display must match the applied party ID even after search results change. Read-only cards expose every saved business field and named description gaps; opening another party resets child pagination and old child rows.

- [x] Read affected source/tests and exported Pencil images. Write focused failing contract/HTTP/client and UI tests before implementation.

```tsx
await user.click(screen.getByRole("button", { name: "Add party", exact: true }));
await user.type(screen.getByLabel("Name", { exact: true }), "Synthetic supplier");
await user.click(screen.getByRole("button", { name: "Save party", exact: true }));
expect(
  await screen.findByRole("button", { name: "Synthetic supplier", exact: true }),
).toBeVisible();
// Read-only and stale-session tests must assert absence of mutation controls,
// not merely a mocked child component or a mocked permission function.
```

- [x] Implement contracts/access, then pure form mapping/validation and workspace/forms. Tests must cover both profiles' incomplete save, supplied invalid formats, conflicts preserving input, archive-only under archived parent, immutable partyId, filtered pagination, read-only controls, stale load discard,401session loss,403refresh, ES labels and keyboard dialog behavior.
- [x] Run focused RED/GREEN; build contracts before API/client consumers. Run contracts suite/types/lint/build; fullUSAPI and APItypes/lint/build; focusedUI/client tests plus admin types/lint/bothbuilds. Controller runs final fulladmin, Chromium and isolation to avoid duplicate broad runs. No commits.
- [x] Report exact tests/results, changed files and remaining limits to the task report. Do not dispatch reviewers/subagents. Controller owns public status docs, independent review and browser screenshots.

## Controller integration gate

Review implementation against accepted rules and visual references. Run fulladmin, USAPI if amended after worker tests, isolation17 and proxy smoke, and real Chromium access→reference→party→location draft→archive/restore, English/Spanish,1440/390, both themes. Inspect safe screenshots. No new UI acceptance claim from DOM tests alone. Keep US-01 partial for downstream finalization/history and other explicitly deferred slices; no publication.

Checkpoint 2026-09-05: task review, one consolidated final fix and scoped re-review completed; no remaining Critical/Important findings. Full admin1071, focused64, contracts131, USAPI143, isolation17, real proxy1 and Chromium1 passed. One Minor residual, US01-UI-01 (same-page parent A → archived rejection → B → stale A reselection), is retained for the next correction; server denial and input preservation remain intact. See [foundation evidence and remaining work](../../us/master-data-foundation.md). This is a local checkpoint, not a complete US-01 slice or release.
