# Offline grants P1D.2 activation acceptance

Scope: engineering evidence for exact-device pilot activation. This record does
not authorize a production cohort, deploy code, activate strict mode on a customer
device or establish physical acceptance.

## Acceptance matrix

| Criterion                                                   | Current-source evidence                                                                                                                                           | Status |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Strict request and response contracts; 1–200 unique devices | Platform-contract schemas and focused tests                                                                                                                       | PASS   |
| Platform-only authority                                     | `offlineGrants.activate` is limited to `platform_admin`; controller is registered only in the platform-auth module                                                | PASS   |
| Immutable 30-minute preparation                             | PostgreSQL constraints, snapshot digest, exact members and idempotent prepare integration test                                                                    | PASS   |
| Two-person confirmation                                     | Preparer self-confirm is denied; a second current platform administrator confirms                                                                                 | PASS   |
| Fresh authority check                                       | Confirmation reloads policy, subscription, owner, credential epoch, assignment, configuration, report, grant, keyset and entitlement revision under ordered locks | PASS   |
| No commercial mutation                                      | Integration test compares subscription plan identity and preparation compares policy/subscription/configuration row counts                                        | PASS   |
| Exact runtime scope                                         | Active binding overlays strict for the selected device; missing, revoked or invalid binding resolves the base policy                                              | PASS   |
| Existing client compatibility                               | Station, Handheld and kiosk request/response contracts are unchanged; mode changes on the existing authenticated configuration refresh                            | PASS   |
| Recovery                                                    | Stable mutation request IDs, needs-review state, cancellation and retained frozen work/evidence paths                                                             | PASS   |
| Additive deployment                                         | Migration 0152 creates activation state and nullable configuration provenance without seeding policies or customer data                                           | PASS   |

## Verification record

The following checks were run against current source in an isolated worktree and,
where applicable, a fresh PostgreSQL 16 database:

- Platform contracts: 328 passed; test, typecheck, lint and build passed.
- DB activation migration and schema tests: 7 passed against a fresh PostgreSQL
  16 database. The complete DB package passed 553 tests in 104 files; typecheck,
  lint and build passed.
- API activation, issuer, policy, route and OpenAPI focused tests: 64 passed in
  two runs. The complete API package passed 4,225 tests and skipped 51 opt-in
  external-service cases. Two Signer tests initially failed because the optional
  token-encryption key was absent; the whole 7-test file passed after supplying a
  valid isolated test key. API typecheck, lint and build passed.
- SaaS activation/readiness/catalog focused DOM tests: 63 passed. The complete
  SaaS Admin package passed 480 tests; typecheck, lint and build passed.
- Existing recovery regressions passed for Station (1), kiosk (2) and Handheld
  `GrantTransportTest` (Gradle build successful). No native DTO was changed.
- Production bundle contracts: 564 passed with Docker and loopback access.
- CI affected-path contracts: 19 passed. Repository Prettier and `git diff
--check` passed.

## External gates

| Gate                                             | Status  |
| ------------------------------------------------ | ------- |
| Production migration and deployment              | NOT RUN |
| Production cohort selection and confirmation     | NOT RUN |
| Selected Station on Windows with scanner/printer | NOT RUN |
| Industrial Handheld vendor scanner               | NOT RUN |
| Installed kiosk device and reconnect recovery    | NOT RUN |
| Customer pilot throughput and acceptance         | NOT RUN |
