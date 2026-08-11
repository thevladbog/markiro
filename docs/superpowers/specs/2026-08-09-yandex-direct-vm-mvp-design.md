# Yandex Direct-VM MVP Deployment

**Date:** 2026-08-09
**Status:** Approved for implementation
**Supersedes:** The ALB/SWS/ARL, managed-certificate, cloud-observability,
audit-trail, deployment-controller/OIDC, serial-console and rollback-rehearsal
parts of the production rollout for the one-customer MVP.

## Decision

The MVP uses one public application VM, Managed PostgreSQL and private Object
Storage. GitHub-hosted Actions deploys the immutable Docker Compose bundle to
the VM through ordinary key-authenticated SSH. The existing Caddy container
terminates TLS directly and obtains ACME certificates for the admin and kiosk
domains.

This is a deliberate reduction in platform controls and rollout ceremony. The
priority is a small, understandable and recoverable first production system.

```text
admin/kiosk client
  -> Cloud DNS A record
  -> reserved public address on app VM
  -> Caddy ports 80/443
  -> API and static applications in Docker Compose
  -> Managed PostgreSQL and private media Object Storage

protected GitHub-hosted deploy job
  -> pinned SSH host key and protected private key
  -> docker compose pull / migrate / up
  -> local and public smoke
```

## Retained resources

- the existing application VM and its reserved public address;
- the production VPC with only the application and data subnets/security
  groups required by the VM and PostgreSQL;
- the existing Managed PostgreSQL cluster and application database;
- the private versioned media bucket;
- the Terraform state bucket and state-backend secret;
- the runtime and SMTP secrets required by the application;
- the KMS key while retained disks, PostgreSQL or buckets depend on it;
- the public `markiro.app` DNS zone and the admin/kiosk records;
- the application service account and the minimum permissions needed for
  runtime secrets, media objects, logging to local Docker logs and image pulls.

The app VM, PostgreSQL, media bucket, state bucket and KMS key are protected
resources. Any plan that replaces or destroys one of them is rejected.

## Removed resources

- Application Load Balancer, HTTP router, virtual host, backend group and target
  group;
- the ALB reserved address, subnet and security group;
- Smart Web Security and Advanced Rate Limiter profiles;
- both Certificate Manager certificates and validation records;
- Cloud Logging groups, Monitoring dashboard/spec wiring and application-side
  custom monitoring timers;
- both Audit Trails and their IAM grants;
- the audit service account and deployment-controller service account/OIDC
  credential when no retained dependency remains;
- the retired runner registration secret and any remaining runner/controller
  IAM bindings;
- the audit bucket after its writers are stopped and its object/version
  inventory is explicitly reviewed.

The audit bucket is removed in a separate final cleanup because deleting its
objects and versions is irreversible. It must not block the first application
deployment.

## Direct ingress

The existing direct Caddy configuration is retained. The VM security group
allows public TCP 80 and 443 and key-only SSH on TCP 22. Port 8080 is no longer
an external or ALB-facing application boundary.

Caddy redirects HTTP to HTTPS, serves `admin.markiro.app` and
`kiosk.markiro.app` as separate authorities, preserves their route isolation,
and stores ACME state in the existing persistent Caddy volumes. DNS A records
for both names point to the app VM reserved address.

The accepted MVP SSH exposure is public port 22 with password, root and
keyboard-interactive authentication disabled, a dedicated deploy account,
strict host-key checking and a protected Ed25519 private key. This avoids a
bastion, VPN, self-hosted runner and dynamic cloud-control plane lookup.

## Deployment workflow

`Publish production images` continues to build, test and publish digest-pinned
API and edge images and a release manifest.

`Deploy production` becomes one protected GitHub-hosted job:

1. validate the successful release run, SHA and manifest;
2. materialize the protected SSH private key and pinned `known_hosts` data in a
   temporary directory with mode `0600`;
3. connect to the configured app public address without Yandex OIDC or serial
   console calls;
4. transfer the bounded deployment bundle, authenticate to GHCR, pull exact
   image digests, run the migration and start Compose;
5. run local readiness and public admin/kiosk smoke checks;
6. remove all temporary credentials unconditionally.

There is no rollback-rehearsal prerequisite, controller/cleanup environment,
runner lifecycle, ALB health gate, DNS-convergence artifact chain or custom
deployment receipt for the MVP. A failed deploy remains recoverable by running
the previous digest-pinned release through the same workflow or by the operator
using the offline SSH recovery key.

## Terraform transition

The change is executed as one reviewed production plan followed by one apply.
It must:

- update the app security group and DNS records;
- keep the existing app VM and its public address in place;
- remove ingress, cloud-observability and obsolete IAM resources;
- retain the database, media/state storage and encryption dependencies;
- contain no unrelated replacement.

The apply is blocked if the plan contains replacement or deletion of the app
VM, PostgreSQL cluster/database, media bucket, state bucket or KMS key. Public
DNS changes are applied only when the direct Caddy deployment is ready to
answer ACME and health requests.

## Rollout and cleanup order

1. Merge the code, contracts and runbooks while the current public records stay
   unchanged.
2. Produce and review the exact Terraform transition plan.
3. Apply the security-group and retained-resource-safe cleanup transition.
4. Deploy the current release to the app VM and verify local readiness.
5. Publish both DNS A records to the VM address and verify TLS plus admin/kiosk
   public smoke.
6. Stop Audit Trails, inventory the audit bucket, then remove its objects,
   versions, bucket and now-unused audit identity as the separately recorded
   irreversible cleanup.

## Stop condition

The simplification gets one implementation PR, one reviewed infrastructure
apply and one normal deploy attempt. If the direct path still requires a new
controller, runner, OIDC exchange, serial-console parser, ALB workaround or
multi-stage evidence workflow, stop and deploy the same Compose bundle manually
over the already configured SSH path instead of adding orchestration.

## Acceptance

- repository contracts reject reintroduced ALB/SWS/ARL, managed certificate,
  runner/controller and rehearsal dependencies;
- Terraform formatting and validation pass with the pinned provider;
- the production plan proves the protected resources are retained;
- the ordinary GitHub-hosted SSH deploy succeeds with exact image digests;
- both domains obtain valid TLS and pass public route/readiness smoke;
- the final inventory contains only the documented retained resources plus any
  audit bucket temporarily retained for explicit destructive cleanup.

Automated contracts do not prove the live Terraform apply, SSH connection, DNS,
TLS or public smoke. Those remain separately reported external checks.
