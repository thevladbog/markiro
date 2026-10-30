# Synthetic US hosted package prerequisites

**NOT READY TO DEPLOY.** This profile is fixed to `https://us-demo.invalid`.
The strict API and worker documents must name that same origin. The generic
runtime parser admitting another origin does not make this ingress support it.
An external hostname needs separate reviewed rendering and byte attestation.

The API and worker are functional, separate entry points. They verify complete
installed artifacts before reading service material or opening connections.
Generic `/health/ready` stays 503. Deployment readiness is locked with
`us_hosted_provisioning_required`. No package/configuration/material presence
proves migration, seed, fresh tenant membership, object privacy or readiness.

## Build source and provenance

Run `node apps/api/scripts/build-us-hosted-release.mjs` from a clean, committed,
isolated source snapshot with its own offline dependency installation. Use Node24
and repository-declared Corepack/pnpm11.22, `COREPACK_ENABLE_NETWORK=0`. The command
accepts no arguments or environment-selected roots. It refuses dirty source,
existing build trees and an existing `.superpowers/us-hosted-package` stage;
it never deletes those paths. It performs the shared/API builds and the dedicated
US production static build, then writes a complete descriptor and B1 inventory.
Partial output is retained on failure and a later invocation refuses it.

The output contains `app/`, raw deployment files, `dependency-attestation.json`
and `deployment-attestation.json`. Dependency files, link targets and SBOM entries
are hashed separately from B1. They are not an OCI image signature or proof that
an image was built from these bytes. `imageDigestVerified:false`, required
protected image attestation and both acceptance locks remain explicit. Missing
dependency evidence refuses package construction; missing image evidence blocks
image/deployment acceptance. Do not invent image digests or use mutable tags.

A source fixture commit authenticates only its synthetic TEST snapshot. Record
base, exact patch and fixture SHA separately. **Never promote fixture artifacts**
or relabel them as task-release artifacts. The eventual task commit follows full
gates, independent review and staged-byte proof; its real package must match that
exact task SHA before publication.

## Inert installation profile

No build, pull, provisioning or deployment command is dispatched by this package.
Runtime builds require `US_NODE_BASE_SHA256`; Compose requires reviewed runtime
and ingress image digests. Those inputs select immutable artifacts, not runtime
origins, upstreams, credentials or policy. The ingress entrypoint bypasses image
environment substitution. Only ingress publishes port443. API8443, Postgres5432
and HTTPS storage remain private; separately reviewed services must provide the
fixed private DNS aliases on the isolated network.

Operator configuration and secrets are deliberately absent. Fixed bind mounts
use `create_host_path:false`; missing files refuse, without replacement directories
or generated credentials. The two nonsecret config documents go at
`operator/us-synthetic-api.json` and `operator/us-synthetic-worker.json`; each pins
the exact source SHA and raw manifest SHA. Service-specific material goes under
the fixed `operator/api-secrets`, `operator/worker-secrets` and
`operator/ingress-secrets` directories listed by packaged Compose. Paths resolve
from its `deploy/us-synthetic` folder to the package's sibling `app/` and
`operator/` directories. Use regular root-owned files,
0444 or0440 with runtime group10001, protected root-owned ancestors, and read-only
mounts. Do not put secrets in argv, environment, logs, screenshots, package output
or source control. API and worker have different database/storage credentials;
the worker has no API-auth secret or inbound TLS key. Ingress has its separate
public certificate/key and the private API CA, never the API private key.

| Operator directory | Required fixed filenames                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api-secrets`      | `db-ca.pem`, `storage-ca.pem`, `api-db-password`, `api-storage-access-key`, `api-storage-secret-key`, `api-auth-secret`, `api-cert.pem`, `api-key.pem` |
| `worker-secrets`   | `db-ca.pem`, `storage-ca.pem`, `worker-db-password`, `worker-storage-access-key`, `worker-storage-secret-key`                                          |
| `ingress-secrets`  | `public-cert.pem`, `public-key.pem`, `api-ca.pem`                                                                                                      |

The public certificate covers `us-demo.invalid`. The private API certificate
covers `api.us-demo.internal`. CA/name checks are mandatory on the ingress→API,
API/worker→database and API/worker→object-storage connections.

Ingress accepts the fixed Host, verifies its API peer as `api.us-demo.internal`,
forwards the canonical public Host and removes forwarding headers. Native request
guards still enforce exact queries, body limits, origin, fresh authorization and
download semantics. Static files come only from the checked US bundle; unknown
UI/API/RU paths have no fallback. Access logging is disabled for private URLs.

Normal shutdown must await native HTTP/worker settlement before closing clients,
pool and material. Worker `force_exit` is not closure proof. Container timeout or
SIGKILL is not successful draining; retain the failure and investigate pending work.

## Remaining release gates

Separate reviewed contracts are required for migration, seed/provisioning,
tenant/account/role identity, private DB/storage policy, real TLS/DNS, readiness,
backup plus restore, rollback and an operator runbook. No startup auto-migration,
seed bypass, owner conversion, auth reset or public reverse proxy is permitted.
Complete normal password/MFA/fresh-membership viewer verification, exact22 GETs
and audits, isolation/byte invariance, owned resource closure and separate release
enablement are still required. Source, CLI refusal, contract or fixture success
does not accept the viewer, hosting or deployment.
