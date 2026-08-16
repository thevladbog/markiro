# Deploy runtime diagnostics review candidate — 16 August 2026

## Decision

The candidate has a closed nine-stage public failure contract, verifies the candidate runtime key-name inventory before host, environment, database, container, service, or active-release mutation, and now has bounded operator recovery documented in the landing publication runbook. The operator procedure compares key names only, preserves the prior Lockbox version, creates a recoverable new version when needed, and reruns the same failed immutable deployment.

This review candidate does not authorize a deployment or a Lockbox change. No live deploy, provider request, Lockbox read or mutation, runtime materialization, form change, push, merge, database operation, or legal-artifact generation was performed.

## Public diagnostic and recovery contract

The only public deployment failure is one allowlisted line:

```text
MARKIRO_DEPLOY_FAILURE <stage>
```

The closed stages are `configuration`, `transfer`, `runtime-inventory`, `reconcile-host`, `runtime-env`, `prepare`, `smoke`, `finalize`, and `rollback`. Remote causes, host paths, registry credentials, Lockbox identifiers, environment values, candidate JSON, and subprocess output remain outside the public diagnostic.

The `runtime-inventory` operator procedure requires:

- extracting only sorted key names from committed `.env.production.example`;
- obtaining only key names from the active Lockbox version without emitting its payload;
- comparing exact unique name sets, never values;
- creating a new recoverable Lockbox version through the protected process while retaining the prior version;
- rerunning the same failed deployment for the same release SHA, without manual reconciliation, environment materialization, migration, service commands, or a replacement candidate.

Secret values must not be copied into terminal output, logs, issues, workflow comments, chat, or evidence. The name-set check does not establish SMTP delivery, captcha validity, database connectivity, or application health; those remain separate release gates.

## TDD evidence

The runbook contract was written first and observed failing:

```text
node --test deploy/production/test/runbook-contract.test.mjs
```

RED result: 12 tests, 9 passed and 3 failed. The missing behavior was the exact nine-stage mapping, the documented pre-mutation inventory order, and the bounded recoverable inventory procedure.

After the runbook change, the required focused candidate suite passed:

```text
node --test deploy/production/test/runbook-contract.test.mjs deploy/yandex/test/runtime-env.test.mjs deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/production/test/workflow-contract.test.mjs
```

GREEN result: 68 passed, 0 failed, 0 skipped.

The preceding implementation tasks separately recorded their RED/GREEN evidence:

- closed stage diagnostics: final focused 25/25 and complete Yandex deploy 44/44;
- read-only runtime inventory: focused 19/19 and complete Yandex deploy 51/51;
- pre-mutation inventory ordering and rollback precedence: focused 56/56 and complete Yandex deploy 53/53.

## Production bundle contract

The initial sandboxed canonical command reached the product suite but could not provide a valid infrastructure result: 314 tests, 303 passed, 11 failed, 0 skipped. The failures were limited to sandbox permissions: one pnpm SQLite `unable to open database file`, three Podman/Docker socket permission denials, and seven loopback `listen EPERM` healthcheck cases.

The plan-authorized single run of the same canonical command outside the sandbox passed:

```text
corepack pnpm test:production-bundle:contract
```

Result: 314 passed, 0 failed, 0 skipped. The wrapper reached the repository product tests; no direct-script fallback was used and the command was not retried after the valid run.

## Review focus and remaining external evidence

Independent review should verify secret non-disclosure, inventory-before-mutation ordering, single-line diagnostics, rollback precedence, direct argv without shell interpolation, and the existing narrow VM service-account scope. Automated tests do not establish SMTP delivery, captcha validity, database connectivity, live application health, provider state, or a successful production deployment.
