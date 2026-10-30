# Restore Timeweb DaData configuration

This operation changes only the API's optional `DADATA_TOKEN` and
`DADATA_SECRET`. It uses the accepted image and product source. It does not run
migrations, publish images, restart PostgreSQL or the edge, or enable catalog
writers. Never edit an existing runtime snapshot or replay a completed
recovery/upgrade operation to change credentials.

## Prepare and review

Use a reviewed commit C and its successful main-push CI attempt 1, including
all required platform jobs actually passing. Pin a lightweight tag named
`configuration-dadata-<full C>` directly to C. Verify that C remains an ancestor
of main, and that neither a moved/annotated tag nor a same-named branch can
supply authority. Unrelated main advancement does not change this pinned source.
Never substitute another SHA's CI, a skipped platform job or a rerun.

Before any protected-environment policy write, obtain the user's authorization
for the concrete single tag rule after C, CI and the exact rule are reviewable.
The rule is a `tag` rule for that complete name, never a wildcard. Preserve the
existing rules, reviewers, prevent-self-review and bypass controls byte-for-byte
where represented by the API. Native run approval is a separate gate. The
source-rule addition applies to every workflow using `production-deploy`; it is
not implied by merely authorizing the eventual native run.

Install C's exact transitive `.mjs` source closure under
`/opt/markiro-platform/configuration-executors/<executorSha>` with private owned
0700 directories and regular single-link 0600 files. `sourceClosure` in
`deploy/platform/dadata-transport.mjs` produces the hashes. Verify the hashes
before importing a project module and again before each child command. The
apply transport independently verifies its own closure before import.

Use the trusted `prepareConfigurationOperation` function in
`deploy/platform/host/dadata-prepare.mjs`. Its in-process `verifySources` is fixed
reviewed code, never a callback supplied by operation JSON. Input contains a
fresh UUID, reviewed executor SHA/CI, accepted source metadata and the restored
DaData credentials. Seed metadata must include all retained immutable guards,
exact core/worker identities and the accepted PostgreSQL/schema proof. Read
credentials from a protected source and deliver them privately through stdin;
never put them in argv, shell history, tracked files or logs.

Preparation holds the canonical deployment lock. It verifies the accepted
forward journal and current configuration chain, creates a new private runtime
snapshot and captures private before-container/inventory plus invariant files.
It renders both complete Compose configurations and permits only the two DaData
fields to differ. It checks every retained worker's archived successful native
bootstrap receipts. An unapplied prepared directory does not change current
runtime authority. Preserve any failed partial preparation and choose no new
operation until its exact outcome is understood.

Review the returned operation UUID, plan SHA256, old/new Compose hashes, source
closure, pinned source/tag proof and tests. Inspect the plan's complete guard inventory. Old source,
image, configuration, schema and catalog records remain immutable. The token
value is not review output. A token-only status check is insufficient: validate
real provider suggestions before proceeding.

## Protected application

After the exact tag rule has been authorized, applied and independently read
back, dispatch `configure-platform-dadata.yml` on that exact immutable tag with
`executor_ci_run_id`, `executor_ci_run_attempt=1`, `operation_id` and
`plan_sha256`. It shares `timeweb-platform-production` concurrency and the
existing `production-deploy` environment. Obtain its independent native
approval; do not rerun the run or bypass environment rules.

The executor rechecks the exact tag, main ancestry, CI and native approval, then holds the
canonical host lock. It permits only the exact API Compose replacement. A
`config-pending.json` marker blocks other current-source consumers. Every other
container, image, network, mount, catalog row and journal must remain unchanged.
Known failures can restore the saved old environment in the same guarded
process. Returning old configuration records the newly recreated API ID; it
never claims the deleted original container survived. Unknown daemon outcome,
unknown ownership or persistence uncertainty retains pending evidence and the
lock for reconciliation.

Healthy completion requires three nonempty real provider responses through the
deployed compiled API client and unchanged invariants. The executor writes a
terminal receipt and `config-index.json`, then retires pending state. Preserve
all snapshots, recipes, receipts and source closures for recovery.

## Current-source consumers and acceptance

`resolveConfigurationRuntime` verifies the immutable successor chain.
`resolveBoundConfigurationRuntime` additionally binds a new operation to its
exact head. Catalog bootstrap schema 2 carries this binding; a schema 1
operation refuses a current configuration successor or pending marker.

A fresh operator backup uses `withCurrentConfigurationSource` from
`deploy/platform/backup/configuration-source.mjs` and passes its opaque context
as `configurationSource` to `createDatabaseBackup` and `verifyDatabaseRestore`.
The existing worker image/executor descriptor keeps its own provenance. The
real backup runtime refuses a pending/accepted successor without this held
source context, before issuing Docker commands, and rechecks it at each command.
Historical failed-upgrade factories are not current-runtime factories. Update
any independently installed dated nightly wrapper and its acceptance handoff;
repository tests do not prove that an external wrapper was updated or a fresh
backup was restored.

After the native run, independently read back the terminal receipt/head,
verify health and unchanged host/schema/catalog/worker state, and exercise
organization, address and bank suggestions through authenticated SaaS endpoints
and the browser. Report unavailable browser/session coverage explicitly. A
successful client probe alone does not verify the entire authenticated UI path.
