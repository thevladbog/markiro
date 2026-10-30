# Restore DaData through a protected configuration successor

Status: implementation scope approved by the user on 2026-10-30; production
execution remains subject to reviewed source, CI and native protected approval.

## Verified problem

The accepted Timeweb API has no `DADATA_TOKEN` or `DADATA_SECRET`. The host
snapshot allowlist also rejects these keys. The recovered provider token passes
organization, address and bank suggestion requests. Keep credentials private;
never store their values or reversible representations in this plan or Git.

The accompanying allowlist regression fix permits a private runtime snapshot and
keeps both keys outside Compose interpolation. It does not change production.

## Why an existing phase cannot apply the change

The current prepared-target v2 deployment requires an unoccupied target. Recovery and forward
recovery require their exact failed predecessor. The existing upgrade requires
the original accepted recovery and no previous upgrade index. Production already
has a successful forward activation and accepted release catalogs. These records
must remain immutable; replaying a recovery phase is not a configuration update.
A container replacement also changes identities used by backup and catalog guards.

## Authorized restoration and additional operational scope

Restore only the optional DaData server configuration. Preserve the accepted API
image and product source, edge, PostgreSQL, schema/migration identity, release
catalogs, mounts, networks and retained workers. No migrations, new images, DNS,
IAM, database edits, or credential changes to another integration are needed.

The necessary extension is a protected configuration-successor operation with a
verified current-runtime resolver. The extension needs review before execution.

## Implementation sequence

1. Add an immutable configuration-successor admission contract under
   `deploy/platform/host/`. Bind a fresh UUID, accepted predecessor bytes,
   current container ID/image/recipe, current configuration fingerprint, catalog
   acceptance, reviewed executor SHA and successful CI. Reject stale, unknown,
   incomplete or reused authority. Retain historical records unchanged.
2. Prepare a new private runtime snapshot through the fixed allowlist. Compare
   complete old/new environments and allow only `DADATA_TOKEN` and optional
   `DADATA_SECRET` to differ. Require a token if a secret is set. Deliver restored
   values through private stdin/protected files, never argv, frontend inputs,
   source files, workflow artifacts or logs.
3. Extend the protected platform deployment workflow with this operation. Use
   `production-deploy`, independent native approval, the existing production
   concurrency group, exact reviewed source/CI and pinned SSH transport. Acquire
   the established host lock before observations or mutation; refuse an active
   operation or an unknown termination outcome.
4. Implement a durable prepare/apply/accept state machine. Recheck complete host
   inventory and predecessor immediately before mutation. Replace only the API
   using the same image and recipe except the two approved environment fields.
   Preserve the verified old recipe and private configuration for rollback.
   Remove/recreate containers only through the journaled operation. Never mount the
   catalog in two running API instances. Preserve edge/PostgreSQL and both
   accepted stopped catalog workers. On failure, retain evidence and restore the
   verified old API only when termination and ownership are certain.
5. Add a current-runtime resolver that validates the immutable successor chain.
   Use it in backup, catalog and future deployment admission. A new API identity
   is accepted only through verified terminal successor evidence; historical
   predecessor checks remain enforced. Keep the original state/config files.
6. Verify health and real authenticated SaaS organization, address and bank
   suggestions. Verify unchanged PostgreSQL/schema/migration, catalog state,
   journal guards and retained workers. Publish a secret-free terminal receipt
   and preserve recovery evidence. A configured status alone is insufficient.
7. Merge the reviewed implementation after required CI, prepare the concrete
   immutable operation, dispatch once and obtain native independent approval.
   After success, run external authenticated checks through the deployed API and
   browser; report any surface not exercised.

## Required tests and review focus

- Original omission: a valid DaData snapshot fails before the allowlist fix and
  passes after it; credentials never enter interpolation or public descriptors.
- Admission rejects any environment delta beyond the two DaData keys, a secret
  without a token, changed images/recipe/mounts/networks, stale predecessor,
  unknown containers, reused operation and incomplete catalogs.
- Simulate failure before stop, after stop, after create, after start and during
  health/suggestions; prove exclusive catalog ownership and safe old-API return.
- Unknown process termination retains the lock and prevents competing cleanup.
- Resolver rejects forged, reordered, incomplete and conflicting successor chains;
  backup and catalog tests exercise both old and accepted successor identities.
- Check secret redaction in errors, child output, receipts and transport failures.
- Run focused Node contracts, all affected platform/production contract suites,
  formatting, source-closure checks and required native CI. A synthetic test is
  not live production or browser acceptance.
