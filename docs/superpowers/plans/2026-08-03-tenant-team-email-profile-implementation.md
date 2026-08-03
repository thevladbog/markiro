# Tenant Team, Email, and Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the SaaS MVP tenant-team workflow: admin-managed memberships and invitations, durable SMTP email, multi-tenant user profiles, private S3 avatars, and the corresponding cabinet UI.

**Architecture:** Better Auth remains the authority for accounts, sessions, organizations, memberships, and invitation state. Markiro owns policy, tenant metadata, audit, email delivery/outbox, and media lifecycle through focused Nest modules; PostgreSQL constraints close cross-tenant and concurrency gaps. The admin app consumes only Markiro policy routes, while React Email, Nodemailer, pg-boss, and an S3-compatible service are isolated behind typed boundaries.

**Tech Stack:** TypeScript 6, NestJS 11, Better Auth 1.6.23, Drizzle/PostgreSQL 17, pg-boss 12, React 19/Vite 8, React Email 6.9.1, Nodemailer 9.0.3, AWS SDK v3 3.1101.0, Sharp 0.35.3, Mailpit, MinIO, Vitest.

## Global Constraints

- Production public signup is closed; registration requires a pending, unexpired invitation whose normalized email matches.
- Product-facing roles are only `admin` and `manager`; `owner` cannot be created or mutated through ordinary team routes; `member` remains internal and has no cabinet capabilities.
- `admin` and `owner` have `members.manage`; managers retain operational capabilities only.
- A user is global, while role, position, linked employee, login, PIN, and badge remain tenant-local and may differ per tenant.
- Team mutations never archive employees or revoke operator credentials, and employee mutations never remove cabinet memberships.
- SMTP uses Nodemailer with TLS verification; application delivery is durable and at-least-once, with one logical job identity per delivery.
- Mail payloads are encrypted at rest; tenant and global account mail are never exposed across scopes; PII retention is 30 days for successful/canceled/expired records and 90 days for failed records.
- Avatar sources are JPEG/PNG/WebP, at most 5 MiB, 8192 pixels per dimension, 25 million pixels total, one frame/page, 128 MiB worker memory, and a five-second deadline; output is 512x512 WebP.
- The S3 bucket is private; database rows store keys, never presigned URLs; local development uses MinIO and Mailpit.
- Every production behavior begins with a failing test and is committed only after focused and neighboring tests pass.
- Rebuild `@markiro/db` after every schema change because the API consumes `packages/db/dist`.

---

### Task 1: Align cabinet and Better Auth role policy

**Files:**

- Modify: `packages/domain/test/cabinet-access.test.ts`
- Modify: `packages/domain/src/access/cabinet.ts`
- Modify: `packages/db/test/organization-access.test.ts`
- Modify: `packages/db/src/organization-access.ts`

**Interfaces:**

- Produces: `resolveCabinetAccess("admin")` containing `CABINET_CAPABILITY.MEMBERS_MANAGE`.
- Produces: Better Auth `organizationRoles.admin` permission to create invitations and update/delete non-owner members; Markiro routes still enforce target policy.

- [ ] **Step 1: Write failing role tests**

```ts
expect(resolveCabinetAccess("admin").capabilities).toContain(C.MEMBERS_MANAGE);
expect(resolveCabinetAccess("manager").capabilities).not.toContain(C.MEMBERS_MANAGE);
expect(organizationRoles.admin.authorize({ invitation: ["create"] }).success).toBe(true);
expect(organizationRoles.admin.authorize({ member: ["update", "delete"] }).success).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/domain test -- cabinet-access.test.ts && corepack pnpm --filter @markiro/db test -- organization-access.test.ts`

Expected: admin capability and Better Auth mutation assertions fail against the owner-only map.

- [ ] **Step 3: Make the role maps pass**

Add `C.MEMBERS_MANAGE` to the `admin` capability list. Build the Better Auth admin role from `memberAc.statements` plus `invitation: ["create", "cancel"]` and `member: ["create", "update", "delete"]`; keep organization update/delete and owner assignment behind Markiro policy.

- [ ] **Step 4: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/domain test && corepack pnpm --filter @markiro/db test && corepack pnpm --filter @markiro/domain typecheck && corepack pnpm --filter @markiro/db typecheck`

Commit: `feat(auth): allow tenant admins to manage members`

### Task 2: Add durable team, mail, audit, and media schema

**Files:**

- Create: `packages/db/src/schema/team.ts`
- Create: `packages/db/src/schema/mail.ts`
- Create: `packages/db/src/schema/media.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/test/tenant-team-schema.test.ts`
- Create: `packages/db/test/mail-media-schema.test.ts`
- Create: `packages/db/migrations/0027_tenant_team_mail_media.sql`
- Generate: `packages/db/migrations/meta/0027_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**

- Produces tables: `user_profiles`, `tenant_member_profiles`, `tenant_invitation_profiles`, `cabinet_employee_links`, `tenant_audit_events`, `email_deliveries`, `email_outbox`, and `media_assets`.
- `emailDeliveries.status`: `queued | sending | retrying | sent | failed | canceled`.
- `mediaAssets.status`: `staging | active | deleting`.

- [ ] **Step 1: Write schema contract tests**

Assert exported tables and constraints through `getTableConfig`, including a single employee-claim uniqueness domain and XOR invitation/member targets:

```ts
const links = getTableConfig(schema.cabinetEmployeeLinks);
expect(links.checks.map((item) => item.name)).toContain("cabinet_employee_links_target_xor");
expect(links.uniqueConstraints.map((item) => item.name)).toContain(
  "cabinet_employee_links_tenant_employee_uq",
);
expect(schema.emailDeliveries.tenantId).toBeDefined();
expect(schema.emailDeliveries.userId).toBeDefined();
expect(schema.mediaAssets.ownerUserId).toBeDefined();
```

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/db test -- tenant-team-schema.test.ts mail-media-schema.test.ts`

Expected: imports/exports do not exist.

- [ ] **Step 3: Define focused Drizzle tables**

Use UUID primary keys for Markiro-owned rows, Better Auth text IDs for account/member/invitation references, timezone-aware timestamps, enum columns for state, and composite uniqueness needed by same-tenant foreign keys. `email_outbox.delivery_id` is unique and cascades with its delivery. `email_deliveries` has a scope XOR check (`tenant_id` xor `user_id`), encrypted payload bytes plus nonce/tag, attempt id/deadline, sanitized error fields, and terminal timestamps. `media_assets` records generated key, checksum, dimensions, byte size, owner user, and state before upload.

- [ ] **Step 4: Generate and inspect migration**

Run: `corepack pnpm --filter @markiro/db db:generate --name tenant_team_mail_media`

Add explicit composite foreign keys in the generated SQL where Drizzle cannot express Better Auth same-tenant references. Verify migration contains no destructive change to existing auth/employee tables.

- [ ] **Step 5: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/db build && corepack pnpm --filter @markiro/db test && corepack pnpm --filter @markiro/db typecheck && git diff --check`

Commit: `feat(db): add team mail and media lifecycle schema`

### Task 3: Add the typed React Email workspace

**Files:**

- Create: `packages/email/package.json`
- Create: `packages/email/tsconfig.json`
- Create: `packages/email/src/index.ts`
- Create: `packages/email/src/layout.tsx`
- Create: `packages/email/src/invitation.tsx`
- Create: `packages/email/src/password-reset.tsx`
- Create: `packages/email/src/email-verification.tsx`
- Create: `packages/email/emails/invitation-preview.tsx`
- Create: `packages/email/test/render.test.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `renderEmail(input: EmailTemplateInput): Promise<{ subject: string; html: string; text: string }>`.
- `EmailTemplateInput` is a discriminated union for `organization-invitation`, `password-reset`, and `email-verification`.

- [ ] **Step 1: Add package manifest and failing renderer tests**

Pin `react-email`, `@react-email/ui`, `react`, and `react-dom` exactly. Tests assert escaped names, exact raw fallback links, preview text, subject, HTML, and useful plain text:

```tsx
const output = await renderEmail({
  kind: "organization-invitation",
  recipientName: "<Admin>",
  organizationName: "Завод",
  inviterName: "Ирина",
  actionUrl: "https://cabinet.example/invitations/inv_1",
  expiresAt: new Date("2026-08-10T00:00:00Z"),
});
expect(output.html).toContain("&lt;Admin&gt;");
expect(output.text).toContain("https://cabinet.example/invitations/inv_1");
expect(output.subject).toContain("Завод");
```

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/email test`

Expected: renderer module is missing.

- [ ] **Step 3: Implement components and typed renderer**

Use `render()` for HTML and `toPlainText()` from `react-email`. Keep transport and credentials out of the package. Export preview fixtures only from the preview directory, not the production entrypoint.

- [ ] **Step 4: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/email test && corepack pnpm --filter @markiro/email typecheck && corepack pnpm --filter @markiro/email build`

Commit: `feat(email): add transactional React Email templates`

### Task 4: Add mail configuration, encryption, and delivery repository

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/modules/mail/mail.types.ts`
- Create: `apps/api/src/modules/mail/mail-crypto.service.ts`
- Create: `apps/api/src/modules/mail/mail-delivery.service.ts`
- Create: `apps/api/src/modules/mail/mail-transport.service.ts`
- Create: `apps/api/src/modules/mail/mail.module.ts`
- Create: `apps/api/test/mail-env.test.ts`
- Create: `apps/api/test/mail-crypto.test.ts`
- Create: `apps/api/test/mail-delivery.service.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes `@markiro/email` renderer inputs.
- Produces `MailDeliveryService.enqueue(tx, input)` that inserts delivery and outbox rows in the caller transaction.
- Produces `MailTransportService.send(rendered, recipient)` backed by one Nodemailer transporter.

- [ ] **Step 1: Write failing env and AES-GCM tests**

Test required SMTP settings, port 465 secure inference, port 587 STARTTLS, and a base64 32-byte payload key. For crypto, assert ciphertext does not contain the action URL, round-trips with the correct delivery-id AAD, and fails with another delivery id.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- mail-env.test.ts mail-crypto.test.ts`

Expected: env keys and services do not exist.

- [ ] **Step 3: Implement configuration and transport**

Pin Nodemailer 9.0.3 and its types. Configure `createTransport({ host, port, secure, auth, requireTLS: !secure, tls: { rejectUnauthorized: true }, connectionTimeout, greetingTimeout, socketTimeout })`. `verify()` updates a degraded health state but does not abort module startup.

- [ ] **Step 4: Implement scoped delivery persistence**

Normalize recipient email, encrypt template input with AES-256-GCM and delivery-id AAD, store no message body, and insert a unique outbox row in the same supplied transaction. Allowlisted error storage contains only category, SMTP class/code, attempt count, and sanitized bounded text.

- [ ] **Step 5: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/db build && corepack pnpm --filter @markiro/api test -- mail-env.test.ts mail-crypto.test.ts mail-delivery.service.test.ts && corepack pnpm --filter @markiro/api typecheck`

Commit: `feat(api): add encrypted durable mail delivery`

### Task 5: Publish outbox and deliver mail through pg-boss

**Files:**

- Create: `apps/api/src/modules/mail/mail-jobs.service.ts`
- Create: `apps/api/src/modules/mail/mail-retention.service.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/mail-jobs.service.test.ts`
- Create: `apps/api/test/mail-retention.e2e.test.ts`

**Interfaces:**

- Produces queue `send-email-delivery` with pg-boss singleton key `delivery:<uuid>`.
- Produces scheduled jobs `dispatch-email-outbox`, `reconcile-email-deliveries`, and `prune-email-deliveries`.

- [ ] **Step 1: Write failing dispatcher and claim tests**

Cover replay after enqueue-before-publish, `FOR UPDATE SKIP LOCKED` claims, queued/retrying-to-sending CAS, advisory lock ownership, stale attempt deadlines, invalid invitation cancellation, success payload erasure, retry classification, and permanent failure.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- mail-jobs.service.test.ts`

Expected: job service is absent.

- [ ] **Step 3: Implement dispatcher and worker**

Pass only `deliveryId` to pg-boss. Hold `pg_try_advisory_lock(hashtextextended(deliveryId, 0))` on one checked-out PostgreSQL session across the bounded SMTP call, but hold no transaction. Re-read invitation state after acquiring the lock. Mark `sent`, erase encrypted payload, and release the session lock in `finally`; schedule exponential retries only for transient categories.

- [ ] **Step 4: Implement reconciliation and retention**

Republish queued rows missing publication, reclaim `sending` only after deadline and free lock, purge encrypted terminal payloads within 24 hours, delete successful/canceled/expired metadata after 30 days, and failed metadata after 90 days.

- [ ] **Step 5: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/api test -- mail-jobs.service.test.ts mail-retention.e2e.test.ts && corepack pnpm --filter @markiro/api typecheck`

Commit: `feat(api): deliver queued email through pg-boss`

### Task 6: Implement the tenant Team policy API

**Files:**

- Create: `apps/api/src/modules/team/dto.ts`
- Create: `apps/api/src/modules/team/team-policy.ts`
- Create: `apps/api/src/modules/team/team.service.ts`
- Create: `apps/api/src/modules/team/team.controller.ts`
- Create: `apps/api/src/modules/team/team.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/team-policy.test.ts`
- Create: `apps/api/test/team.e2e.test.ts`

**Interfaces:**

- Routes: `GET /team`, `POST /team/invitations`, `POST /team/invitations/:id/resend`, `DELETE /team/invitations/:id`, `PATCH /team/members/:id`, `PUT|DELETE /team/members/:id/employee`, and `DELETE /team/members/:id`.
- All routes require `members.manage`; tenant and actor come from `RequestWithTenant`.

- [ ] **Step 1: Write target-policy unit tests**

```ts
expect(
  canMutateTeamTarget({ actorId: "a", actorRole: "admin", targetId: "b", targetRole: "manager" }),
).toBe(true);
expect(
  canMutateTeamTarget({ actorId: "a", actorRole: "admin", targetId: "a", targetRole: "admin" }),
).toBe(false);
expect(
  canMutateTeamTarget({ actorId: "a", actorRole: "admin", targetId: "o", targetRole: "owner" }),
).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- team-policy.test.ts`

Expected: policy module is missing.

- [ ] **Step 3: Write database/API RED tests**

Cover admin and owner access, manager/member 403, no owner/member role in DTO, actor self-protection, owner protection, cross-tenant IDs, one employee claim, pending reservation release, multi-tenant role/position independence, and removal leaving employee/badge/operator rows untouched.

- [ ] **Step 4: Implement list and mutations**

Create invitations by direct insertion into the Better Auth invitation table inside one Drizzle transaction with profile, employee claim, tenant audit, encrypted delivery, and outbox. Generate invitation IDs with `crypto.randomUUID()`, normalize email, set seven-day expiry, and rate-limit by actor/tenant/recipient. Cancellation acquires the same mail advisory lock and returns HTTP 409 `{ code: "delivery_in_flight" }` without mutation if a sender owns it.

- [ ] **Step 5: Block raw Better Auth team mutation routes**

In `mountAuth`, return 404 for raw organization invitation/member create/update/delete routes. Leave session and read-only organization selection routes available; dedicated Markiro invitation acceptance/rejection routes are added in Task 7.

- [ ] **Step 6: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/db build && corepack pnpm --filter @markiro/api test -- team-policy.test.ts team.e2e.test.ts authorization.e2e.test.ts && corepack pnpm --filter @markiro/api typecheck`

Commit: `feat(api): add tenant team management policy`

### Task 7: Gate registration and finalize invitation acceptance

**Files:**

- Modify: `packages/db/src/auth-config.ts`
- Modify: `packages/db/src/auth-config.ts` companion `Auth` type
- Modify: `apps/api/src/auth/auth.setup.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/modules/invitations/dto.ts`
- Create: `apps/api/src/modules/invitations/invitations.service.ts`
- Create: `apps/api/src/modules/invitations/invitations.controller.ts`
- Create: `apps/api/src/modules/invitations/invitations.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/invitations.e2e.test.ts`
- Modify: `apps/api/test/auth.e2e.test.ts`

**Interfaces:**

- Public-safe route: `GET /invitations/:id` returns only invitation state, masked organization name, role, and locked email for a valid link.
- Route: `POST /invitations/:id/register` accepts structured name/password and internally invokes Better Auth signup for the invitation email.
- Session routes: `POST /invitations/:id/accept` and `POST /invitations/:id/reject`.

- [ ] **Step 1: Write invitation lifecycle RED tests**

Cover ordinary `/api/auth/sign-up/email` returning 404, invalid/expired/canceled links revealing no tenant details, locked invited email, wrong signed-in email 403, existing-user acceptance, new-user registration plus acceptance, second-tenant acceptance, idempotent finalizer, and verified email after acceptance.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- auth.e2e.test.ts invitations.e2e.test.ts`

Expected: public signup still succeeds and invitation routes are absent.

- [ ] **Step 3: Implement guarded signup and Better Auth bridge**

Block the raw signup route at `mountAuth`; inside the invitation service call the typed Better Auth `signUpEmail` endpoint only after locking and validating the invitation. Invoke Better Auth `acceptInvitation`/`rejectInvitation` internally with request headers so it retains its membership and session-cookie semantics.

- [ ] **Step 4: Implement idempotent finalizer**

After Better Auth acceptance, transactionally upsert `user_profiles`, `tenant_member_profiles`, move the employee claim from invitation to member, mark the exact account email verified, and write audit. A scheduled reconciler finds accepted invitations with missing extension rows and applies the same idempotent function.

- [ ] **Step 5: Wire reset and verification callbacks**

Pass `sendResetPassword` and `sendVerificationEmail` callbacks into `buildAuth`; callbacks enqueue global user-scoped deliveries and never send inside the request. Keep enumeration-safe Better Auth responses.

- [ ] **Step 6: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/db build && corepack pnpm --filter @markiro/api test -- auth.e2e.test.ts invitations.e2e.test.ts && corepack pnpm --filter @markiro/api typecheck`

Commit: `feat(auth): add invite-only account lifecycle`

### Task 8: Add private S3 storage and avatar profile API

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/modules/storage/object-storage.service.ts`
- Create: `apps/api/src/modules/storage/storage.module.ts`
- Create: `apps/api/src/modules/profile/dto.ts`
- Create: `apps/api/src/modules/profile/avatar-processor.ts`
- Create: `apps/api/src/modules/profile/avatar-worker.ts`
- Create: `apps/api/src/modules/profile/profile.service.ts`
- Create: `apps/api/src/modules/profile/profile.controller.ts`
- Create: `apps/api/src/modules/profile/profile.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/storage-env.test.ts`
- Create: `apps/api/test/avatar-processor.test.ts`
- Create: `apps/api/test/profile.e2e.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces `ObjectStorageService.put/delete/presignRead/ensureBucket` around AWS SDK v3.
- Routes: `GET|PATCH /profile`, `POST /profile/avatar`, `DELETE /profile/avatar`, `GET /profile/avatar-url`.

- [ ] **Step 1: Write storage config and avatar RED tests**

Use real JPEG/PNG/WebP fixtures and generated hostile metadata fixtures. Assert rejection of 5 MiB overflow, unsupported content, animation, dimensions above 8192, more than 25M pixels, timeout, and worker memory exit; assert orientation/metadata removal and 512x512 WebP output.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- storage-env.test.ts avatar-processor.test.ts`

Expected: config and processor are absent.

- [ ] **Step 3: Implement S3 boundary and bounded processor**

Pin AWS SDK v3, Sharp, Multer, and types. Configure endpoint, region, credentials, `forcePathStyle`, and TLS without exposing credentials. Use a worker thread with `resourceLimits.maxOldGenerationSizeMb = 128`, terminate after 5 seconds, set Sharp input limits before decode, reject multi-page input, auto-orient, resize with cover, strip metadata, and emit WebP.

- [ ] **Step 4: Implement durable avatar lifecycle**

Commit `media_assets(staging)` before upload; upload to `users/{userId}/avatars/{assetId}.webp`; then transactionally switch `user_profiles.avatarAssetId`, mark new active, and old deleting. On failure keep the old avatar. Scheduled reconciliation deletes stale staging/deleting objects and metadata idempotently.

- [ ] **Step 5: Implement profile ownership and signed reads**

Only `req.userId` can mutate its global profile/avatar. Team list may return avatar presence but never an unscoped object key. Generate read URLs for at most five minutes after checking ownership.

- [ ] **Step 6: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/db build && corepack pnpm --filter @markiro/api test -- storage-env.test.ts avatar-processor.test.ts profile.e2e.test.ts && corepack pnpm --filter @markiro/api typecheck`

Commit: `feat(api): add user profile and private avatars`

### Task 9: Build Team, invitation, and profile cabinet flows

**Files:**

- Create: `apps/admin/src/pages/team/api.ts`
- Create: `apps/admin/src/pages/team/TeamPage.tsx`
- Create: `apps/admin/src/pages/team/InvitationForm.tsx`
- Create: `apps/admin/src/pages/team/MemberActions.tsx`
- Create: `apps/admin/src/pages/invitations/api.ts`
- Create: `apps/admin/src/pages/invitations/InvitationPage.tsx`
- Create: `apps/admin/src/pages/profile/api.ts`
- Create: `apps/admin/src/pages/profile/ProfilePage.tsx`
- Modify: `apps/admin/src/auth/client.ts`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/layout/Header.tsx`
- Modify: `apps/admin/src/pages/auth/Register.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/team.test.tsx`
- Create: `apps/admin/test/invitation-lifecycle.test.tsx`
- Create: `apps/admin/test/profile.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Adds `/team` guarded by `members.manage`, `/invitations/:id` outside the active-tenant shell, and `/profile` for any signed-in cabinet user.

- [ ] **Step 1: Write route/navigation RED tests**

Assert Team appears for admin/owner and is absent for manager/member; direct manager route renders forbidden. Assert public registration no longer presents a free email field and directs users through invitation links.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/admin test -- access-routing.test.tsx team.test.tsx`

Expected: route and navigation are missing.

- [ ] **Step 3: Implement Team queries and mutations**

Display members and invitations separately with name/avatar, email, role, informational position, employee/status/operator-access, access state, and delivery state. Invitation form collects email, admin/manager role, optional position, and only unclaimed active employees. Hide owner/self actions and handle 409 `delivery_in_flight` by keeping the action pending and retrying after a bounded delay.

- [ ] **Step 4: Implement invitation screens**

Render intentional pending, wrong-account, expired, canceled, rejected, accepted, and unknown states. Existing users sign in then accept; new users enter first/last/middle name and password with email read-only, then register and accept.

- [ ] **Step 5: Implement global profile**

Allow structured-name updates and optional avatar upload/replace/delete. Use multipart upload to the API; display only returned signed URLs; surface storage failures without losing the current image or form data.
The signed-in shell queries `GET /profile` before profile-dependent UI and redirects legacy accounts with missing structured fields to `/profile?complete=1`; successful save returns them to their originally requested route.

- [ ] **Step 6: Verify GREEN and commit**

Run: `corepack pnpm --filter @markiro/admin test && corepack pnpm --filter @markiro/admin typecheck && corepack pnpm --filter @markiro/admin build`

Commit: `feat(admin): add team invitations and profile flows`

### Task 10: Add local Mailpit/MinIO, first-owner provisioning, and full verification

**Files:**

- Modify: `docker-compose.dev.yml`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`
- Create: `apps/api/src/cli/provision-tenant-owner.ts`
- Modify: `apps/api/package.json`
- Create: `apps/api/test/provision-tenant-owner.e2e.test.ts`
- Create: `apps/admin/test/team-mailpit.e2e.test.tsx`
- Modify: `docs/runbooks/cabinet-rbac-rollout.md`

**Interfaces:**

- Local ports: Mailpit SMTP `1025`, Mailpit UI `8025`, MinIO S3 `9000`, MinIO console `9001`.
- CLI: `pnpm --silent --filter @markiro/api provision:tenant-owner -- --email <address> --tenant-name <name> --tenant-slug <slug>`; no password argument. Silent mode prevents the package runner from echoing forbidden input before the CLI can reject it.

- [ ] **Step 1: Write provisioning RED test**

Run the command function twice and assert one organization, one user/profile, one owner membership, and one activation delivery. Assert no password is accepted or logged.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @markiro/api test -- provision-tenant-owner.e2e.test.ts`

Expected: command is absent.

- [ ] **Step 3: Add local services and defaults**

Add pinned Mailpit and MinIO images, persistent volumes, health checks, a one-shot bucket initializer, and development-only credentials. Extend `.env.example` with SMTP, payload encryption, and S3 settings. CI uses fake transports/object storage except focused container integration tests.

- [ ] **Step 4: Implement idempotent first-owner provisioning**

Create organization, account/profile, owner membership, and one-time activation delivery transactionally. Generate setup token internally and mail it; print only tenant/user IDs and delivery ID.

- [ ] **Step 5: Run focused real-infrastructure smoke tests**

Run PostgreSQL migrations, start Mailpit/MinIO, create an invitation, inspect the captured email through Mailpit API, follow the link, and upload/replace/delete an avatar against MinIO.

- [ ] **Step 6: Run the complete verification gate**

Run:

```bash
corepack pnpm format:check
corepack pnpm --filter @markiro/db db:migrate
corepack pnpm turbo lint typecheck test build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit 0. Existing known lint/test warnings may be reported but no new warning is introduced.

- [ ] **Step 7: Commit, review, publish, and open PR**

Commit: `feat: deliver SaaS tenant team lifecycle`

Push `codex/tenant-team-implementation`, open a ready PR against `main`, publish it immediately so CI runs, process actionable review threads, and repeat the verification gate after every fix.
