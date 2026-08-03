# Cabinet RBAC rollout

This runbook enables capability-based cabinet authorization without changing
station, kiosk, public API, or 1C machine authentication. Run it for each
environment separately. The deployment operator and the role-change approver
must be different people when production change controls require separation of
duties.

The authorization design is documented in
[`Capability-Based Cabinet RBAC`](../superpowers/specs/2026-08-03-capability-rbac-design.md).
No schema migration or permissive authorization flag is part of this rollout.

## Before the maintenance window

- Select one tested application revision. Record its immutable commit SHA and
  the immediately preceding known-good application revision.
- Confirm that both the API image and admin image can be built and deployed
  from that same selected SHA. Do not mix an RBAC API with an older admin, or
  an RBAC admin with an older API.
- Prepare owner, admin, manager, and member smoke accounts in each organization
  affected by the rollout. Keep device and machine smoke credentials in the
  approved secret store; do not copy them into tickets, command history, or
  this repository.
- Reserve a protected path outside the repository for the membership backup
  and approval record. These artifacts contain personal and authorization data.

## 1. Back up membership rows

Before inventorying or changing a role, export the complete `member` table
from the target database. For example, with `DATABASE_URL` supplied by the
deployment secret manager:

```sh
pg_dump --dbname="$DATABASE_URL" --data-only --table='public.member' --column-inserts --file='/secure/backup/member-before-cabinet-rbac.sql'
test -s '/secure/backup/member-before-cabinet-rbac.sql'
```

Record the backup location, database/environment identifier, UTC timestamp,
and operator in the change record. Do not continue if `pg_dump` fails or the
artifact is empty. The backup is for recovery from an incorrect data change;
an application authorization regression is rolled back by application
revision as described below.

## 2. Inventory and approve role changes

Run this read-only inventory against the target database:

```sql
SELECT
  m.id AS membership_id,
  m.organization_id,
  o.name AS organization_name,
  u.email,
  m.role
FROM member AS m
JOIN organization AS o ON o.id = m.organization_id
JOIN "user" AS u ON u.id = m.user_id
ORDER BY o.name, u.email;
```

For every intended cabinet user whose current role is `member`, add one row to
the protected approval record with the environment, `membership_id`,
`organization_id`, current role, explicit target role (`manager`, `admin`, or
`owner`), approver, and approval timestamp. Treat `manager` as the default
least-privilege cabinet role; `admin` and especially `owner` require explicit
justification. Also record every `member` intentionally left unchanged: that
role will receive an empty capability set and no cabinet access.

Re-run the inventory immediately before the update and reconcile it with the
approval record. Stop on a missing membership, changed organization, changed
current role, duplicate id, or unapproved row. Never identify update targets
by email alone and never update all members in an organization.

## 3. Apply explicit promotions

Apply one separately approved batch per target role. The normal least-privilege
promotion from `member` to `manager` is:

```sql
BEGIN;

UPDATE member
SET role = 'manager'
WHERE id = ANY($1::text[])
  AND role = 'member'
RETURNING id, organization_id, user_id, role;

COMMIT;
```

`$1` is a parameterized `text[]` supplied by the deployment operator through
the database driver; it is the exact approved list of membership ids. Never
interpolate ids into SQL. Execute `BEGIN` and the `UPDATE ... RETURNING` first,
then compare the returned ids and row count with the approved manager batch
before allowing the driver to issue `COMMIT`. The returned row count must equal
the approved inventory count, and every returned id must be approved. On any
mismatch, issue `ROLLBACK`, investigate, repeat the read-only inventory, and
obtain fresh approval before retrying.

If an approved batch targets `admin` or `owner`, use a separately reviewed
statement with the same `id = ANY($1::text[])` and `role = 'member'`
constraints, changing only the literal target role. Do not combine target
roles into a `CASE`, and do not reuse one id array across target roles. After
all commits, run the inventory again and attach the reconciled output to the
change record.

## 4. Deploy one revision

Deploy the API and admin from the recorded commit SHA as one release. Confirm
the running image/release metadata for both components reports that exact SHA
before continuing. Do not route users to either new component while the other
component is still on a different revision.

## 5. Smoke cabinet roles

Use a fresh login or a new request after every role change; membership is
reloaded on each API request.

- **Owner:** `GET /access/me` reports the owner role and all capabilities;
  representative operations, integrations, tenant settings, credential
  management, and owner-only Better Auth organization mutations succeed.
- **Admin:** operational, integration, tenant-settings, and credential
  actions succeed; an owner-only Better Auth organization/member mutation is
  denied and leaves data unchanged.
- **Manager:** representative operational reads and writes succeed; direct
  requests for integrations, tenant settings, public API key management,
  station enrollment, and kiosk pairing credentials return `403`.
- **Member:** `GET /access/me` succeeds with an empty capability list, the
  admin shows the intentional no-access state, and a direct cabinet operation
  returns `403`.

For each role, verify both the UI path and one direct API request. Confirm a
server `403` does not become a generic network error or reveal the protected
page. Record endpoint, expected result, actual status, revision, organization,
and UTC timestamp; never record session cookies or returned secrets.

## 6. Smoke device and machine authentication

Use dedicated smoke fixtures and non-destructive calls where available. Any
write smoke must use uniquely labeled test data and its established cleanup
procedure.

- **Station:** with a station `x-api-key`, exercise `GET /station/operators`,
  `GET /products`, `POST /products/gtin-check`, `GET /shifts`, one shift bundle
  or open/create path, and `POST /station/scans`. Confirm a Better Auth session
  cannot call the station-only roster or scan endpoints.
- **Kiosk:** with an `x-kiosk-token`, exercise `GET /kiosk/bootstrap` and
  `POST /kiosk/orders`; verify queue/response behavior is unchanged.
- **Public API:** authenticate a representative public API request with an
  existing public key and confirm invalid or revoked credentials are rejected.
  Do not mint or print a production key merely for the smoke.
- **1C:** exercise the established `/1c_exchange` authentication and
  `checkauth` session flow, then the non-destructive exchange probe appropriate
  to the deployed channel. Follow the
  [1C exchange acceptance checklist](../1c-exchange-acceptance-checklist.md)
  when a real 1C instance is part of the release window.

Do not continue the rollout if any station, kiosk, public API, or 1C call has
changed authentication behavior.

## 7. Complete or roll back

Complete the release only after all role and machine smokes pass and the
post-change inventory matches the approved record.

On an authorization regression, stop rollout traffic and roll back **both the
API and admin to the same recorded known-good application revision**. Verify
their running revision metadata matches, then repeat the cabinet and machine
smokes against the rollback. Do not broadly promote remaining `member` rows,
do not make email-only or organization-wide role updates, and do not add or
enable a permissive authorization flag. Restore membership data from the
protected backup only for a separately diagnosed and approved data-change
error; it is not the rollback mechanism for application behavior.
