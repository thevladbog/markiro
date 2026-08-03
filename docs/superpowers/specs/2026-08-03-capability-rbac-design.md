# Capability-Based Cabinet RBAC — Design Spec

**Date:** 2026-08-03
**Status:** Authorization baseline implemented; team-management amendment pending.
**Slice of:** MVP stabilization baseline (P0 authorization boundary).
**Related:** `docs/architecture.md`, `docs/design-briefs/03-admin-panel.md`, `docs/superpowers/specs/2026-07-24-operators-roster-design.md`.

## Problem

Cabinet authentication currently establishes a Better Auth session and an active organization, but it does not establish authorization. `TenantGuard` accepts the session's `activeOrganizationId`, and `SessionOnlyGuard` only distinguishes a human session from a device API key. Neither guard verifies the user's current membership in that organization or checks `member.role` before a controller action runs.

As a result, an ordinary organization `member` can currently call the same cabinet endpoints as an administrator, including integration settings, public API key issuance, device enrollment, employee badge management, and tenant configuration. The admin UI mirrors this behavior: it checks for a session and active organization but has no permission-aware navigation or route boundary.

Production operators are not Better Auth organization members. They are domain employees who authenticate at a station with operator credentials. Cabinet RBAC must not conflate these two identities or change station, kiosk, public API, or 1C machine authentication.

## Goals

1. Make the server the authoritative authorization boundary for every cabinet endpoint.
2. Give managers full access to day-to-day operations without access to integrations, tenant internals, or machine credentials.
3. Give administrators all manager permissions plus integrations, tenant settings, and credential management.
4. Give administrators organization membership and peer-administrator management while protecting the owner and the administrator's own membership from the routine team API.
5. Reserve ownership transfer and recovery for the organization owner.
6. Deny cabinet access to the Better Auth `member` role and to unknown roles.
7. Keep controller policy expressed in capabilities rather than role names, so later custom roles and per-user grants do not require controller rewrites.
8. Leave device and machine authentication behavior unchanged.

## Non-goals

- Building custom-role or per-user permission-management UI in this slice.
- Storing individual permission grants in the database in this slice.
- Changing operator badges, station sessions, kiosk credentials, public API authentication, or 1C exchange authentication.
- Introducing cross-request authorization caching.
- Adding organization-member management UI if it does not already exist; this design only reserves and enforces its permission boundary.

## Identity model

There are two separate human concepts:

- A **cabinet user** is a Better Auth `user` with a row in the organization's `member` table. The membership carries one or more comma-separated Better Auth roles in `member.role`; the roles recognized in this slice are `owner`, `admin`, `manager`, and `member`.
- A production **operator** is a domain employee who works at a station using a badge/PIN flow. An operator does not need a Better Auth account or cabinet access.

Better Auth's organization creator remains `owner`. The Better Auth organization configuration gains `manager` as an accepted organization role. Its custom access-control configuration keeps Better Auth's default organization statement vocabulary and preserves the default owner policy. Admin receives the invitation/member primitives needed by the application team-management boundary; manager and member do not. Generic Better Auth mutation endpoints must be blocked or proven to traverse the same owner/self protection, tenant checks, reservation, rate-limit, mail, and audit policy as the application API; they may not become a weaker parallel path. Because Better Auth requires `apiKey.create` even for server-side org-owned key issuance, `admin` also receives that one internal plugin permission. The built-in `/api/auth/api-key/*` HTTP management surface is blocked so this internal permission cannot bypass the audited cabinet controllers. The static role configuration is passed to both server and organization client plugins. `member` remains a valid technical role but receives no cabinet permissions and is not offered as a selectable cabinet role in product UI. The complete team lifecycle and safeguards are specified in `docs/superpowers/specs/2026-08-03-tenant-team-email-profile-design.md`.

## Capability model

Controllers declare capabilities, never roles. The initial capability vocabulary is intentionally small but separates read and write access where a future read-only role is likely:

- `operations.read`
- `operations.write`
- `integrations.read`
- `integrations.write`
- `tenant.settings.manage`
- `credentials.manage`
- `members.manage`
- `tenant.ownership.manage`

The initial role-to-capability mapping is centralized in code:

| Role         | Effective capabilities                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `manager`    | `operations.read`, `operations.write`                                                                                                 |
| `admin`      | all manager capabilities, `integrations.read`, `integrations.write`, `tenant.settings.manage`, `credentials.manage`, `members.manage` |
| `owner`      | all admin capabilities, `tenant.ownership.manage`                                                                                     |
| `member`     | none                                                                                                                                  |
| unknown role | none                                                                                                                                  |

Role inheritance is resolved by one `AuthorizationService`; it is not duplicated in controllers or the UI. For a multi-role membership, the resolver trims and normalizes the comma-separated role list and returns the union of capabilities from recognized roles. Unknown role entries add no capabilities and never grant fallback access. The service exposes a stable capability-resolution interface. A later implementation may resolve capabilities from database-backed roles and individual grants while preserving controller annotations and client contracts.

## Route classification

### Operational access (`operations.read` / `operations.write`)

Managers, administrators, and owners can use the operational cabinet surface:

- products and GTIN checks;
- counterparties and their operational SSCC configuration;
- lines and label templates;
- employees, operators, and badge lifecycle;
- shifts and shift bundles;
- boxes, box exceptions, and conflicts;
- pickup reasons, orders, rejections, resolution, and export;
- kiosk records, configuration, and product assortment.

Read handlers require `operations.read`; mutations require `operations.write`. An endpoint that performs both a read and an operational state transition is classified as a write.

### Integration access (`integrations.read` / `integrations.write`)

Only administrators and owners can access:

- integration configuration and status;
- integration journals;
- import candidates and link/hide/unhide actions;
- product external-link removal;
- integration credential changes.

Integration credential mutations require both `integrations.write` and `credentials.manage`. Permission requirements use all-of semantics when a handler declares more than one capability.

The machine-facing `/1c_exchange` flow is not a cabinet route and retains its dedicated authentication.

### Tenant settings (`tenant.settings.manage`)

Only administrators and owners can change or inspect the organization profile and tenant-level SSCC settings. These settings affect tenant-wide behavior and are not day-to-day production operations.

### Machine credentials (`credentials.manage`)

Only administrators and owners can:

- list, create, or revoke public API keys;
- create, enroll, or revoke station devices;
- issue kiosk enrollment or pairing credentials.

Creating and configuring a kiosk and assigning its assortment remain operational. Turning that kiosk into an authenticated machine is an administrative credential operation.

Better Auth's generic HTTP API-key management endpoints are not part of the product API and remain unreachable. Application controllers are the only human-facing path for issuing or revoking station/public credentials; device verification continues through the server-side plugin API.

### Organization members (`members.manage`)

Administrators and owners can invite/remove managers and administrators and assign or revoke administrator-level access. The routine team API cannot invite, demote, unlink, or remove an owner, and an administrator cannot change or remove their own membership through that API. Ownership transfer is a separate future workflow guarded by `tenant.ownership.manage`.

## Server authorization flow

For a cabinet request, the server performs the following steps in order:

1. Authenticate the Better Auth session and resolve the active organization.
2. Load the user's current `member` row scoped by both `userId` and `activeOrganizationId`.
3. Reject a missing membership instead of trusting a stale `activeOrganizationId` alone.
4. Normalize the membership role and resolve its effective capabilities through `AuthorizationService`.
5. Attach a typed cabinet principal containing `userId`, `tenantId`, role, and capabilities to the request.
6. Evaluate the capabilities declared by the handler through `@RequirePermissions(...)`.

The cabinet boundary is implemented as a composed guard/decorator layer over the existing tenant resolution rather than embedding role checks in business services. Existing `SessionOnlyGuard` usages are migrated to this boundary. Mixed controllers used by both sessions and devices explicitly allow a station while requiring the corresponding capability from a session caller. Station-only roster and scan-ingest routes explicitly reject Better Auth sessions; their API-key behavior remains unchanged.

Authorization fails closed:

- no or expired session returns `401`;
- no active organization, missing membership, or insufficient capability returns `403`;
- `member` and unknown roles resolve to no capabilities;
- every cabinet handler must explicitly declare either required permission metadata or a membership-only bootstrap policy;
- role changes and membership removal take effect on the next request because membership is loaded per request.

No secret value is included in denial logs. Sensitive credential creation/revocation and authorization denials produce structured security logs with tenant, actor, action, and outcome.

## Client authorization flow

The API exposes `GET /access/me` for an authenticated organization member. It carries an explicit membership-only policy rather than a product capability requirement and returns the active membership roles and effective capability list. A valid `member` receives an empty list so the client can render an intentional no-access state; a missing membership receives `403`.

After session and active-organization resolution, the admin application loads this access document and uses it to:

- filter navigation;
- protect direct route entry;
- hide or disable capability-specific actions;
- show a dedicated "no cabinet access" state for `member`;
- handle a server `403` without treating it as a network failure.

Client checks are usability controls only. They do not replace server checks, and the client does not contain a second role-to-capability matrix.

## Existing membership rollout

No schema migration is required because `member.role` is already text. Before enforcement is enabled, an inventory of existing memberships must identify users currently stored as `member`. Users who are intended to operate the cabinet are explicitly promoted to `manager`, `admin`, or `owner`; remaining members intentionally lose the cabinet access they previously received by omission.

API and admin UI changes ship together from the monorepo. The authorization layer is not placed behind a permissive fallback flag: an unknown or unclassified cabinet route stays denied until it is classified. Device and machine paths receive explicit regression coverage before rollout.

## Testing

### Unit tests

- Exact capabilities for `manager`, `admin`, `owner`, `member`, unknown roles, and supported multi-role values.
- Inheritance: admin includes manager; owner includes admin.
- All-of semantics for handlers requiring multiple capabilities.
- Membership lookup is scoped to both user and active organization.
- A deleted membership or role change is visible on the next request.

### Guard and API tests

- `401` without a valid human session.
- `403` for a stale active organization, missing membership, `member`, unknown role, and insufficient capability.
- Manager succeeds on representative operational reads and writes.
- Manager receives `403` on integrations, tenant settings, public API keys, device enrollment, and kiosk pairing credentials.
- Admin succeeds on operational, administrative, and team-management routes, including management of peer admins, but cannot target the owner or self.
- Owner succeeds on all capability groups.
- Cross-tenant membership cannot authorize the active tenant.
- An architectural metadata test fails when a cabinet handler has neither a required capability declaration nor an explicit membership-only policy.

### Client tests

- Navigation reflects the capability list returned by `/access/me`.
- Direct URLs cannot reveal an unauthorized page.
- `member` sees the no-access state.
- A server-side `403` is handled correctly even if client state is stale.

### Regression tests

- Station API-key scan, roster, product, and shift flows remain usable.
- Kiosk bootstrap and order flows remain usable.
- Public API authentication remains usable while key management is admin-only.
- 1C exchange retains its dedicated authentication and behavior.

## Acceptance criteria

- A manager can complete every supported operational cabinet workflow.
- A manager cannot read or mutate integrations, tenant internals, or machine credentials, including through direct HTTP requests.
- An admin can perform manager workflows and administer integrations, tenant settings, and credentials.
- An admin can manage organization membership and peer administrators but cannot target the owner or self.
- An owner can perform admin workflows and remains the protected authority for future ownership transfer and recovery.
- A `member` cannot enter the cabinet, and an unknown role never gains fallback access.
- Removing membership or changing a role affects the next request.
- Every cabinet handler has an explicit permission or membership-only access policy.
- Existing station, kiosk, public API, and 1C machine flows pass regression tests unchanged.
