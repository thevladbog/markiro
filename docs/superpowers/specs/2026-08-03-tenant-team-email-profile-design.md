# Tenant Team, Email, and User Profiles — Design Spec

**Date:** 2026-08-03
**Status:** Approved in design discussion; document review pending.
**Slice of:** SaaS MVP tenant administration and account lifecycle.
**Related:** `docs/superpowers/specs/2026-08-03-capability-rbac-design.md`,
`docs/superpowers/specs/2026-07-24-operators-roster-design.md`,
`docs/design-briefs/03-admin-panel.md`, `packages/db/src/auth-config.ts`.

## Problem

The cabinet already has Better Auth email/password sessions, organizations,
memberships, and invitation tables, but it does not yet have a usable SaaS
team-management flow. There is no team page, no invitation delivery, no
invite-only registration path, no password-recovery mail, and no way to express
that a cabinet user is also one of the tenant's employees. The first SaaS
customer will have several users with different rights, so manual database
editing or shared credentials is not an acceptable onboarding path.

The existing identity concepts must also remain distinct. A Better Auth user is
a global cabinet identity, while an employee, operator login, PIN, and badge are
tenant-local production records. A manager may also work as an operator, and
the same physical person may work for more than one tenant. Removing cabinet
access must not accidentally remove floor access, and archiving an employee
must not unexpectedly remove cabinet access.

The SaaS also needs reusable outbound-email and object-storage foundations.
Email must work through an ordinary SMTP mailbox rather than a provider-specific
API. User profiles need structured names and avatar upload now. The same
S3-compatible storage abstraction must later support product images, which are
called for by the admin-panel design brief but do not yet exist in the product
schema or DTOs.

## Goals

1. Let tenant owners and administrators manage the tenant's cabinet team
   without platform-operator intervention.
2. Support invite-only registration, existing-user acceptance, cancellation,
   expiry, resend, delivery state, password recovery, and email verification.
3. Keep Better Auth as the source of truth for users, sessions, memberships,
   and accepted invitation state while putting Markiro policy and auditing
   behind an application service boundary.
4. Link a membership optionally to one tenant-local employee without coupling
   cabinet and operator lifecycles.
5. Support one global user in multiple tenants, with different roles,
   positions, employees, PINs, logins, and badges in each tenant.
6. Introduce reusable React Email templates, generic SMTP delivery through
   Nodemailer, and durable retry through the existing pg-boss infrastructure.
7. Add structured global user profiles and avatar upload through a generic
   S3-compatible object-storage service, using MinIO locally.
8. Keep authorization capability-based so future custom roles and per-user
   grants can replace the initial static role map without rewriting business
   controllers.

## Non-goals

- Public self-service tenant signup, billing, or automatic tenant creation.
- A general custom-role or per-user permission editor.
- Emailing operators who have no cabinet account; operators continue to receive
  their login, PIN, and badge through the tenant's operational process.
- Sharing an employee record or operator credential row across tenants.
- Automatic propagation of a role, PIN, login, badge, or employee status from
  one tenant to another.
- Receiving mail over IMAP or POP3. SMTP is the only protocol needed for this
  outbound slice; inbound mail will be a separate module if a real use case
  appears.
- Product-image upload in this slice. The storage boundary must support it, but
  catalog UI, `product_images`, station caching, and print-form consumption are
  a follow-up.
- Ownership transfer UI. Ownership remains a separate high-risk workflow.

## Decisions superseding the current RBAC spec

The earlier capability RBAC design reserved `members.manage` for `owner`. This
design deliberately changes that decision: routine team administration belongs
to `admin`, and `owner` inherits it. The implementation must update the earlier
specification, centralized capability mapping, Better Auth organization policy,
runbook, and tests together so documentation and code do not disagree.

The intended roles are:

| Role      | Responsibility                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `owner`   | Tenant ownership, recovery of control, future ownership transfer, and every administrator capability. |
| `admin`   | Tenant administration: users, roles below owner, integrations, settings, and machine credentials.     |
| `manager` | Day-to-day production operations.                                                                     |
| `member`  | Technical Better Auth role with no cabinet access; not offered in product UI.                         |

`admin` and `owner` receive `members.manage`. A future
`tenant.ownership.manage` capability will remain owner-only; no route uses it
in this slice.

## Identity and tenancy model

### Global account

`user` is the global login identity. One user may have memberships in any
number of organizations and uses the same email/password account and global
profile in all of them.

A new `user_profiles` record, keyed 1:1 by `user.id`, stores:

- `firstName` — required;
- `lastName` — required;
- `middleName` — nullable;
- `avatarAssetId` — nullable;
- timestamps.

The application derives a display name from the structured fields and keeps
Better Auth's existing `user.name` synchronized for library and session
compatibility. `user.image` may expose the application's avatar URL at the
session boundary, but the durable reference is the asset id, not an expiring
URL.

The user owns this global profile. Tenant administrators can see it but cannot
edit another user's global name or avatar. Existing accounts without a profile
are sent through profile completion after their next successful sign-in; they
are not silently assigned invented name parts.

### Tenant membership profile

`member` remains the authority for organization membership and cabinet role. A
new `tenant_member_profiles` record, keyed 1:1 by `member.id`, stores:

- `organizationId`, constrained to match the membership;
- `position` — nullable informational job title;
- timestamps.

`position` is tenant-local and may differ for the same user across tenants. It
is intended for team displays, documents, and print forms. It never contributes
to role resolution, capabilities, or any authorization decision.

### Tenant-local employee and operator

`employee` remains a tenant-local person/worker record. Operator login, PIN,
badge assignments, employee status, and production history remain attached to
that local record. A physical person working in tenants A and B therefore has
two employee rows. The same badge code may be assigned independently in both
tenants because active badge uniqueness is already tenant-scoped, but each
tenant provisions and revokes its own assignment.

Cabinet and production lifecycles are independent:

- removing a membership removes cabinet access and its link, but does not
  archive the employee or revoke PIN/badge access;
- archiving an employee disables the relevant production behavior but does not
  remove cabinet membership;
- unlinking the records changes no permissions or credentials;
- an employee may exist without a cabinet account, and a membership may exist
  without an employee.

### Membership-to-employee claim

An optional `cabinet_employee_links` row connects one employee either to a
pending invitation or to an active membership:

- `organizationId`;
- `employeeId`;
- exactly one of `invitationId` or `memberId`;
- timestamps.

Database constraints enforce:

- the employee belongs to the same organization;
- a membership belongs to the same organization;
- an invitation belongs to the same organization;
- one membership has at most one employee;
- one invitation reserves at most one employee;
- one employee is claimed by at most one pending invitation or active
  membership in that tenant;
- exactly one target (`invitationId` xor `memberId`) is present.

This single claim table makes pending reservation and active linkage one
uniqueness domain. Acceptance changes the claim target from the invitation to
the newly created membership. Cancellation, rejection, or expiry removes the
pending claim. A periodic cleanup handles invitations that expire without a
request, while every create/link operation also treats an expired claim as
releasable so stale cleanup cannot block legitimate work.

A 1:1 `tenant_invitation_profiles` application extension row stores the
invitation's optional `position`. On acceptance it is copied into
`tenant_member_profiles`; cancellation/rejection/expiry deletes it. Better Auth
invitation rows remain the authority for email, role, inviter, status, and
expiry, while tenant-specific Markiro metadata stays outside the auth-owned
columns.

## Authorization and mutation boundary

The admin UI uses a Markiro team API, not raw Better Auth organization mutation
methods. `TeamService` is the application policy boundary for invitation,
membership, position, and employee-link mutations. Better Auth remains
responsible for login/session behavior and invitation acceptance/rejection.

Generic Better Auth mutation endpoints must not provide a bypass around the
Markiro boundary. The implementation must either block those public mutation
routes or prove with route-level tests that they traverse the exact same
authorization, self/owner protection, tenant constraints, rate limits,
reservation logic, mail enqueue, and audit hooks. A parallel, less-protected
path is not acceptable.

Every team mutation requires `members.manage`. Additional rules are:

- an admin may invite, update, link, unlink, or remove managers and other
  admins;
- an admin cannot invite or assign `owner`;
- an admin cannot change, unlink, or remove an owner;
- an admin cannot change their own role or remove themselves through team
  management;
- an owner is protected by the same ordinary-team API and cannot be demoted or
  removed there;
- ownership transfer will use a future owner-only workflow;
- `member` is not accepted by product-facing invitation or role DTOs;
- tenant is resolved from the authenticated principal, never trusted from a
  body field;
- every target member, employee, invitation, and claim is re-scoped to that
  tenant server-side.

Email is normalized before lookup. Invitation creation and resend are
rate-limited by actor, tenant, and recipient so a compromised admin session
cannot turn the SMTP account into a bulk-mail relay.

## Invite-only account lifecycle

### Production registration policy

Public production registration is disabled. A person may create a cabinet
account only from a valid invitation. Development and automated-test helpers
may opt into public signup explicitly, but a production-safe default must not
depend on remembering to turn a permissive flag off.

The registration endpoint is gated by a valid, pending, unexpired invitation
and locks the account email to the normalized invited address. Supplying a
different email, changing it client-side, or using a session for another email
fails. The gate must be enforced on the server; hiding the ordinary sign-up
page is not sufficient.

### Creating an invitation

An admin or owner supplies:

- email;
- role: `admin` or `manager`;
- optional tenant-local position;
- optional existing employee from the active tenant.

Creation performs policy checks and employee reservation, creates a Better Auth
invitation valid for seven days, writes the audit event, creates an email
delivery, and enqueues its id. The HTTP response does not wait for SMTP.

The UI exposes two independent states:

- access: pending, accepted, rejected, canceled, or expired;
- delivery: queued, sending, sent, or failed.

SMTP failure never invalidates an otherwise valid invitation. An admin may
resend the same pending invitation; resend refreshes delivery and, by product
decision, extends invitation expiry back to seven days. A canceled, rejected,
accepted, or already expired invitation is not resurrected; creating a new
invitation produces a new one-time link.

### Accepting an invitation

The emailed link contains a high-entropy invitation id and opens a dedicated
cabinet route.

- An existing user signs in and accepts. The signed-in normalized email must
  equal the invitation email.
- A new user sees the invited email as read-only, enters first name, last name,
  optional middle name, and password, then completes registration. Acceptance
  follows automatically.
- A session for a different email must sign out or switch accounts; it cannot
  accept the invitation.
- Canceled, expired, rejected, accepted, or unknown links show a safe state
  without exposing tenant data beyond what a valid link is allowed to reveal.

Acceptance creates the membership through Better Auth, creates the tenant
member profile, changes the employee claim from invitation to member, records
audit, and selects the organization as active. Following a valid invitation
proves possession of that email; after successful acceptance the account's
email is marked verified. If user creation succeeds but acceptance later
fails, the account remains recoverable and the still-valid invitation can be
accepted after sign-in; no duplicate account is created.

The acceptance finalizer must be idempotent. If Better Auth commits acceptance
before an application hook is interrupted, a reconciliation job repairs the
profile/claim and does not create a second membership.

### Cancellation, rejection, and expiry

Cancellation is available to team administrators. Rejection is available to
the invitee. Both invalidate the link, release an employee reservation, cancel
unsent delivery, and create an audit event. Expiry does the same through cleanup
or lazy reconciliation. A mail worker rechecks invitation state immediately
before sending and refuses a canceled, accepted, rejected, or expired link.

### Initial owner provisioning

The first owner is provisioned administratively; production does not expose
tenant creation or owner signup. Provisioning is an idempotent command that
creates the organization, global account/profile if needed, and owner
membership, then sends a one-time activation/setup flow. It does not require a
password on a shell command line and does not instruct operators to edit auth
tables manually.

## Team API and admin UI

The exact route names may follow repository conventions, but the application
contract covers:

- list members with global profile, email, role, tenant position, optional
  employee, employee status, and operator-access indicator;
- list invitations with access and delivery states;
- create/resend/cancel an invitation;
- update an admin/manager role;
- update informational position;
- link/unlink an employee;
- remove a membership.

The "Team" page is visible to `admin` and `owner`. `manager` and `member` do
not see it, and direct requests return `403`.

Members and invitations are displayed separately. The invitation form is a
short sequence: email and role, optional position and employee, then review and
send. The employee selector includes only active-tenant employees not already
claimed by a membership or pending invitation. Server validation remains
authoritative if the list becomes stale.

Rows show global name/avatar, email, role, tenant position, linked employee,
employee status, and whether station access exists. Invitation rows separately
show pending/expired state and queued/sent/failed delivery. A failed delivery
offers resend without requiring the admin to recreate the invitation.

Owner and self-protected actions are absent or disabled with an explanation.
The server still enforces every restriction if client capability state is
stale.

## Email architecture

### Template package

Add a pnpm workspace package named `@markiro/email`, following React Email's
pnpm/Turborepo monorepo layout. It contains no SMTP credentials, Better Auth
adapter, database access, or network transport. It exports typed renderers that
produce subject, HTML, and plain-text bodies.

The initial templates are:

1. organization invitation / first-owner activation variant;
2. password reset;
3. email verification.

Shared components provide Markiro layout, preview text, typography, buttons,
fallback raw links, support/footer copy, and localization-ready content. Every
template has local preview fixtures and tests for required dynamic fields,
escaped untrusted data, HTML output, and useful plain text.

### SMTP transport

The API uses Nodemailer directly. `@nestjs-modules/mailer` is intentionally not
added: it wraps Nodemailer and adds template-engine abstractions that React
Email already replaces.

One transporter is created per API process from generic configuration:

```text
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASSWORD
SMTP_FROM_EMAIL
SMTP_FROM_NAME
SMTP_REPLY_TO        # optional
MAIL_PAYLOAD_ENCRYPTION_KEY
```

Port 465 uses implicit TLS (`secure=true`); port 587 uses STARTTLS. Production
never disables certificate verification. Required config is validated at
startup. A network/authentication `verify()` failure marks mail health degraded
but does not stop the entire API during a transient mail outage.

### Durable delivery

Email sending is asynchronous through pg-boss:

```text
domain/auth event
      -> email delivery record
      -> pg-boss job containing only delivery id
      -> load/decrypt template data and revalidate source state
      -> @markiro/email renders HTML + text
      -> Nodemailer sends through SMTP
```

`email_deliveries` persists UI/operations state independently of pg-boss job
retention. It records kind, recipient, source reference, status, attempt/error
classification, and timestamps. Sensitive template properties such as reset or
verification links are encrypted at rest behind the delivery id and removed
after successful delivery or terminal expiry. Jobs and logs never contain SMTP
passwords, invitation/reset tokens, signed object URLs, or complete message
bodies.

Transient SMTP errors retry with bounded exponential backoff. Permanent errors
become `failed` and are visible to an authorized administrator. Resend creates a
new delivery attempt for the still-valid source rather than mutating history.

SMTP is inherently at-least-once at the application boundary: if the server
accepts a message and the connection fails before acknowledgement is observed,
a retry may produce a duplicate. Delivery ids prevent normal duplicate enqueue,
but the product does not promise impossible exactly-once SMTP semantics.

### Local email

Mailpit is part of the standard local container stack. The API uses Mailpit's
SMTP endpoint, and developers inspect rendered messages and links in its web
UI. Local mail does not leave the machine. Automated tests use a fake transport
unless a dedicated Mailpit integration test is being run.

## Password recovery and email verification

Better Auth's password-reset and verification callbacks enqueue the same durable
mail deliveries instead of sending inside the HTTP request. Reset and
verification links are one-time, short-lived, and invalidated according to
Better Auth's token lifecycle. User-facing responses do not reveal whether an
arbitrary address has an account.

Invite-based registration marks the exact invited address verified only after
successful acceptance. Initial-owner activation also verifies possession.
Changing email in the future will require a new verification flow and is not
implicitly authorized by an existing tenant admin.

## Object storage and avatars

### Storage boundary

Add an `ObjectStorageService` around the S3 protocol. Local development uses
MinIO in Docker Compose. Production may use MinIO or another S3-compatible
service without changing domain callers.

Configuration includes endpoint, region, bucket, access key, secret key,
path-style/TLS options, and public application base URL where needed. Production
configuration is mandatory. A transient storage outage degrades the storage
health check and file operations but does not invalidate existing sessions or
team data.

The bucket is private. Durable database records contain object keys and asset
metadata, never expiring presigned URLs. Access is authorized against the owning
aggregate before a short-lived read URL is issued. Keys are generated by the
server; client filenames never become paths.

Suggested namespaces make ownership and lifecycle legible:

```text
users/{userId}/avatars/{assetId}.webp
tenants/{tenantId}/products/{productId}/{assetId}.webp   # follow-up
```

A generic `media_assets` record stores object key, content type, byte size,
checksum, dimensions, and timestamps. Ownership remains explicit through the
referencing aggregate (`user_profiles.avatarAssetId`; future
`product_images.assetId`) rather than through an unsafe polymorphic download
endpoint.

### Avatar upload

Avatar upload is included in this slice and is optional for the user. The API
receives the image so it can enforce policy and normalize it before storage:

- accepted source formats: JPEG, PNG, and WebP;
- maximum source size: 5 MiB;
- decode and validate actual content, not only filename/MIME headers;
- auto-orient, strip EXIF/metadata, resize to 512 x 512, and encode WebP;
- compute checksum and store dimensions/size;
- update the profile only after the new object is durable;
- delete the previous asset asynchronously after the database switch;
- collect upload orphans left by interrupted operations.

Only the account owner can upload or delete the global avatar. Tenant admins
may view it through team data but cannot replace it.

### Product-image follow-up

The same service will later back a tenant-scoped `product_images` collection
with multiple images, primary-image selection, ordering, alt text, and explicit
`(tenantId, productId)` ownership. The cabinet will use authorized signed URLs;
server-side print generation will read through service credentials. If station
or kiosk UI later needs images offline, product bundles will download and cache
them rather than retaining expiring URLs.

This follow-up is intentionally recorded but not implemented in the current
slice.

## Audit and observability

Audit events cover:

- invitation created, resent, canceled, accepted, rejected, and expired;
- delivery queued, sent, retrying, and terminally failed;
- membership role changed or membership removed;
- employee linked/unlinked and pending reservation changed;
- tenant position changed;
- global profile completed/changed;
- avatar uploaded, replaced, or deleted;
- initial tenant/owner provisioned.

Events include actor, tenant where applicable, target ids, action, outcome,
safe before/after fields, request id, and job/delivery id. They never include
passwords, PINs, SMTP credentials, auth tokens, invitation/reset URLs, object
credentials, signed URLs, or message bodies.

Operational health distinguishes API, database/queue, SMTP, and object storage.
Mail and storage failures are observable without making unrelated production
operations unavailable.

## Local development and deployment

The standard local stack contains PostgreSQL, Mailpit, and MinIO. Startup
creates required local buckets idempotently. Local defaults point API SMTP to
Mailpit and object storage to MinIO; credentials are development-only and do
not become production defaults.

Production rollout order is:

1. provision SMTP and S3 secrets/buckets;
2. deploy database migrations and rebuild `@markiro/db` so API consumes the
   new compiled schema;
3. deploy API workers and health checks;
4. deploy admin UI and invite routes together;
5. provision the first tenant/owner through the administrative command;
6. run a real activation, invitation, reset, and avatar smoke test.

Public registration remains closed throughout. Migration and rollout do not
send surprise email to existing accounts. Existing users complete structured
profiles on sign-in before using profile-dependent UI.

## Failure behavior

- SMTP unavailable: invitation/access record remains valid; delivery retries
  and UI shows failure after exhaustion.
- Mail render failure: terminal delivery error with no SMTP attempt; source
  invitation remains valid.
- Invitation canceled while queued: worker recheck cancels delivery without
  sending.
- Acceptance finalizer interrupted: idempotent reconciliation repairs member
  profile/employee claim.
- Employee archived while invitation pending: acceptance may create cabinet
  membership, but the link retains archived status visibly and grants no
  production access.
- Employee claimed concurrently: database uniqueness yields a domain conflict;
  no second link or invitation reservation is created.
- S3 unavailable during upload: existing avatar stays active and profile data
  is unchanged.
- Database update fails after new object upload: object is recorded for orphan
  cleanup; old avatar remains active.
- Old-object deletion fails after replacement: new avatar remains active and
  deletion retries asynchronously.

## Testing

### Unit and package tests

- Role/capability update: admin and owner have `members.manage`; manager and
  member do not.
- Owner/self target-policy matrix for every team mutation.
- Email normalization, invitation expiry, resend, and delivery-state mapping.
- React Email templates render escaped HTML and useful plain text with required
  links/content.
- SMTP error classification and retry policy with a fake Nodemailer transport.
- Avatar decoding, real-format validation, metadata stripping, resize, and
  object-key generation.

### Database and API tests

- One user can join multiple tenants with different roles and positions.
- Each membership links only to an employee in the same tenant.
- The same physical badge/login value may be provisioned independently in
  different tenants, while same-tenant uniqueness remains intact.
- Pending invitations reserve an employee; cancel/reject/expire releases it;
  acceptance converts the claim exactly once.
- Concurrent invitations cannot reserve the same employee.
- Removing membership leaves employee, operator credential, and badge rows
  unchanged; archiving employee leaves membership unchanged.
- Admin manages managers and peer admins but cannot target owner or self.
- Manager/member receive `403`; cross-tenant ids receive a safe rejection.
- Raw Better Auth mutation routes cannot bypass application policy.
- Public signup without a valid invitation fails in production configuration.
- Existing-user and new-user acceptance require exact normalized email.
- Mail worker skips invalidated invitations and records retry/failure state.
- Avatar access is owner-authorized, cross-user/tenant reads fail, and failed
  replacement preserves the previous asset.

### Browser E2E

- Admin creates an invitation linked to an employee.
- Test follows the actual email from Mailpit, registers a new user with locked
  email and structured name, and lands in the correct tenant.
- Existing user signs in and accepts an invitation to a second tenant.
- Wrong-account, expired, canceled, already-used, and failed-delivery states
  render intentional UI.
- Admin changes a peer role/position, links/unlinks an employee, and removes a
  membership; protected owner/self controls remain unavailable.
- User uploads, replaces, and removes an avatar backed by local MinIO.

### Regression and verification gate

- Existing station, kiosk, public API, and 1C authentication continue to work.
- Operator-only employees require no email and receive no invitation mail.
- Formatting, lint, typecheck, unit/API/browser tests, and production builds all
  pass.
- CI uses local/fake infrastructure and never sends external email or writes to
  production object storage.

## Acceptance criteria

- A production tenant has no public signup path and can onboard its first owner
  administratively without manual auth-table edits or shell-visible password.
- An owner or admin can invite an admin/manager, optionally record a position
  and reserve an employee, and observe delivery status without waiting for
  SMTP.
- A new invitee registers with locked email and structured name; an existing
  user accepts after login; both produce exactly one membership.
- Admins can manage peer admins and managers but cannot affect owner or self.
- Cabinet membership and tenant-local employee/operator access remain
  independent in all mutations and failure cases.
- One global user works in multiple tenants with distinct membership role,
  position, employee, login, PIN, and badge assignments.
- Invitation, reset, and verification email render through `@markiro/email`,
  retry through pg-boss, and send through generic Nodemailer SMTP.
- Mailpit and MinIO provide complete local email and object-storage workflows.
- Users can maintain global structured names and upload a normalized private
  avatar; tenant admins cannot edit another user's global profile.
- Security-sensitive team/profile actions are capability-checked, tenant-scoped,
  audited, and unavailable through a weaker Better Auth route.
- The object-storage boundary is explicitly reusable for a later product-image
  collection without changing avatar or tenant isolation semantics.
