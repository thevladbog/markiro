import { canonical, ensure, keys } from "./backup/schemas.mjs";
import { canonicalId } from "./release-admission.mjs";
import { REPOSITORY } from "./admission-github.mjs";
// One strict phase table for receiver, executor, loader and outcome validation.
const phases = Object.freeze({
  prepare: Object.freeze({
    kind: "platform-upgrade-host-operation",
    status: "backup-verified",
    sshPhase: "prepare",
  }),
  activate: Object.freeze({
    kind: "platform-upgrade-host-operation",
    status: "healthy",
    sshPhase: "activate",
  }),
  "return-old": Object.freeze({
    kind: "platform-upgrade-host-operation",
    status: "returned-old",
    sshPhase: "prepare",
  }),
  "post-migration-prepare": Object.freeze({
    kind: "platform-forward-recovery-host-operation",
    status: "backup-verified",
    sshPhase: "prepare",
  }),
  "post-migration-activate": Object.freeze({
    kind: "platform-forward-recovery-host-operation",
    status: "healthy",
    sshPhase: "activate",
  }),
});
export function upgradePhase(value) {
  ensure(typeof value === "string" && Object.hasOwn(phases, value));
  return phases[value];
}
const login = (value) =>
  typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
const user = (value) =>
  value?.type === "User" && Number.isSafeInteger(value.id) && value.id > 0 && login(value.login);
export function validateUpgradeDispatch(value) {
  keys(value, ["toolingSha", "runId", "runAttempt"]);
  ensure(typeof value.toolingSha === "string" && /^[a-f0-9]{40}$/u.test(value.toolingSha));
  // GitHub's review-history endpoint is run-scoped, with no attempt identity.
  // Every protected phase therefore needs a new run, never a rerun.
  ensure(canonicalId(value.runId) && value.runAttempt === "1");
  return value;
}
export function validateUpgradeAuthorization(value) {
  keys(value, ["actorId", "actorLogin", "reviewerId", "reviewerLogin", "environmentId"]);
  ensure([value.actorId, value.reviewerId, value.environmentId].every(canonicalId));
  ensure(login(value.actorLogin) && login(value.reviewerLogin));
  ensure(
    value.actorId !== value.reviewerId &&
      value.actorLogin.toLowerCase() !== value.reviewerLogin.toLowerCase(),
  );
  return value;
}
export function verifyUpgradeDispatch(dispatch, token, options) {
  return verifyProtectedDispatch(
    dispatch,
    token,
    options,
    ".github/workflows/upgrade-platform.yml",
    "upgrade",
  );
}
export function verifyConfigurationDispatch(dispatch, token, options) {
  return verifyProtectedDispatch(
    dispatch,
    token,
    options,
    ".github/workflows/configure-platform-dadata.yml",
    "configuration",
  );
}
export function verifyCatalogBootstrapDispatch(dispatch, token, options) {
  return verifyProtectedDispatch(
    dispatch,
    token,
    options,
    ".github/workflows/bootstrap-release-catalog.yml",
    "catalog bootstrap",
  );
}
async function verifyProtectedDispatch(
  dispatch,
  token,
  { actorLogin, request = fetch },
  workflowPath,
  label,
) {
  try {
    validateUpgradeDispatch(dispatch);
    ensure(login(actorLogin));
    ensure(
      typeof token === "string" && token.length > 0 && token.length <= 16384 && !/\s/u.test(token),
    );
    const base = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${dispatch.runId}`;
    const read = async (url) => {
      const response = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      ensure(response.ok);
      return response.json();
    };
    const check = (run) => {
      ensure(
        Number.isSafeInteger(run.id) && String(run.id) === dispatch.runId && run.run_attempt === 1,
      );
      ensure(
        run.head_sha === dispatch.toolingSha &&
          (run.head_branch === "main" ||
            (workflowPath === ".github/workflows/bootstrap-release-catalog.yml" &&
              run.head_branch === `catalog-bootstrap-${dispatch.toolingSha}`)) &&
          run.event === "workflow_dispatch",
      );
      ensure(
        run.path === workflowPath &&
          run.repository?.full_name === REPOSITORY &&
          run.head_repository?.full_name === REPOSITORY,
      );
      ensure(run.status === "in_progress" && run.conclusion === null);
      ensure(user(run.actor) && user(run.triggering_actor) && run.actor.login === actorLogin);
      ensure(
        run.actor.id === run.triggering_actor.id && run.actor.login === run.triggering_actor.login,
      );
      return { actorId: String(run.actor.id), actorLogin: run.actor.login };
    };
    const actor = check(await read(base));
    ensure(canonical(check(await read(`${base}/attempts/1`))) === canonical(actor));
    const approvals = await read(`${base}/approvals`);
    // A single-phase workflow requires one unambiguous approval. A rejected,
    // duplicate or other-environment history is not accepted as authorization.
    ensure(Array.isArray(approvals) && approvals.length === 1);
    const approval = approvals[0];
    ensure(approval.state === "approved" && user(approval.user));
    ensure(Array.isArray(approval.environments) && approval.environments.length === 1);
    const environment = approval.environments[0];
    ensure(
      environment.name === "production-deploy" &&
        Number.isSafeInteger(environment.id) &&
        environment.id > 0,
    );
    const proof = {
      ...actor,
      reviewerId: String(approval.user.id),
      reviewerLogin: approval.user.login,
      environmentId: String(environment.id),
    };
    validateUpgradeAuthorization(proof);
    ensure(canonical(check(await read(base))) === canonical(actor));
    return Object.freeze(proof);
  } catch {
    const error = new Error(`Protected ${label} dispatch rejected.`);
    error.code = "ERR_UPGRADE_DISPATCH";
    throw error;
  }
}

/** Writer fencing uses complete active-workflow pagination, not a current-head listing. */
export async function assertNoCatalogPeers(dispatch, token, request = fetch) {
  validateUpgradeDispatch(dispatch);
  let total,
    seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs?status=in_progress&per_page=100&page=${page}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    ensure(response.ok);
    const value = await response.json();
    ensure(
      Number.isSafeInteger(value.total_count) &&
        value.total_count >= 1 &&
        value.total_count <= 1000 &&
        Array.isArray(value.workflow_runs),
    );
    total ??= value.total_count;
    ensure(
      total === value.total_count &&
        value.workflow_runs.length === Math.min(100, total - seen.size),
    );
    for (const run of value.workflow_runs) {
      ensure(
        Number.isSafeInteger(run.id) &&
          run.id > 0 &&
          !seen.has(run.id) &&
          typeof run.path === "string" &&
          run.status === "in_progress",
      );
      seen.add(run.id);
      const production =
        /^\.github\/workflows\/(?:deploy-production|deploy-platform|recover-platform|upgrade-platform|release-images|release-platform-images|station-beta-release|station-stable-release|handheld-release|stage-handheld-catalog|standalone-release|signer-stable-release|signer-download-repair|station-release-reseed|bootstrap-release-catalog|configure-platform-dadata)\.yml$/u.test(
          run.path,
        );
      ensure(!production || String(run.id) === dispatch.runId);
    }
    if (seen.size === total) {
      ensure(seen.has(Number(dispatch.runId)));
      return;
    }
  }
  throw new Error("Catalog writer fencing rejected.");
}
