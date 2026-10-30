import { canonical, ensure, keys } from "./backup/schemas.mjs";
import { REPOSITORY } from "./admission-github.mjs";

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const tagName = (sourceSha) => `configuration-dadata-${sourceSha}`;
const base = `https://api.github.com/repos/${REPOSITORY}`;
function reader(token, request) {
  ensure(
    typeof token === "string" && token.length > 0 && token.length <= 16384 && !/\s/u.test(token),
  );
  return async (path, { absent = false } = {}) => {
    const response = await request(`${base}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (absent) {
      ensure(response.status === 404);
      return;
    }
    ensure(response.ok);
    return response.json();
  };
}

/** Bind configuration code to either current main or an exact lightweight, merged tag. */
export async function verifyConfigurationSource(
  { sourceSha, sourceRef = "refs/heads/main" },
  token,
  { request = fetch } = {},
) {
  try {
    ensure(sha(sourceSha));
    const name = tagName(sourceSha);
    const tagged = sourceRef === `refs/tags/${name}`;
    ensure(tagged || sourceRef === "refs/heads/main");
    const read = reader(token, request);
    const main = await read("/git/ref/heads/main");
    ensure(
      main.ref === "refs/heads/main" && main.object?.type === "commit" && sha(main.object.sha),
    );
    const mainSha = main.object.sha;
    if (!tagged) ensure(mainSha === sourceSha);
    else {
      const checkTag = async () => {
        const tag = await read(`/git/ref/tags/${name}`);
        ensure(
          tag.ref === sourceRef && tag.object?.type === "commit" && tag.object.sha === sourceSha,
        );
        // Actions run.head_branch alone cannot distinguish a branch from a tag.
        await read(`/git/ref/heads/${name}`, { absent: true });
      };
      await checkTag();
      const path = `/compare/${sourceSha}...${mainSha}?per_page=1`;
      const comparison = await read(path);
      const checkComparison = (value) => {
        ensure(value.base_commit?.sha === sourceSha && value.merge_base_commit?.sha === sourceSha);
        ensure(
          Number.isSafeInteger(value.total_commits) &&
            value.total_commits >= 0 &&
            value.total_commits <= 10000,
        );
        ensure(value.ahead_by === value.total_commits && value.behind_by === 0);
        ensure(value.status === (mainSha === sourceSha ? "identical" : "ahead"));
        ensure((value.total_commits === 0) === (mainSha === sourceSha));
        ensure(
          Array.isArray(value.commits) && value.commits.length === Math.min(1, value.total_commits),
        );
      };
      checkComparison(comparison);
      // A paginated comparison's first commit need not be its head. Fetch the exact
      // last page by bounded total and bind it to the captured main commit.
      const last =
        comparison.total_commits > 1
          ? await read(`${path}&page=${comparison.total_commits}`)
          : comparison;
      checkComparison(last);
      ensure(last.total_commits === comparison.total_commits);
      if (mainSha !== sourceSha) ensure(last.commits[0]?.sha === mainSha);
      await checkTag();
    }
    const finalMain = await read("/git/ref/heads/main");
    ensure(finalMain.ref === main.ref && canonical(finalMain.object) === canonical(main.object));
    return Object.freeze({ sourceSha, sourceRef, mainSha });
  } catch {
    const error = new Error("Configuration source provenance rejected.");
    error.code = "ERR_CONFIGURATION_SOURCE";
    throw error;
  }
}

/** Independent live source check at both transport and host boundaries. */
export async function verifyConfigurationDispatchSource(dispatch, token, { request = fetch } = {}) {
  try {
    keys(dispatch, ["toolingSha", "runId", "runAttempt"]);
    ensure(
      sha(dispatch.toolingSha) &&
        /^[1-9][0-9]{0,19}$/u.test(dispatch.runId) &&
        dispatch.runAttempt === "1",
    );
    const read = reader(token, request);
    const path = `/actions/runs/${dispatch.runId}`;
    const run = await read(path);
    const check = (value) => {
      ensure(
        Number.isSafeInteger(value.id) &&
          String(value.id) === dispatch.runId &&
          value.run_attempt === 1,
      );
      ensure(value.head_sha === dispatch.toolingSha && value.head_branch === run.head_branch);
      ensure(value.head_branch === "main" || value.head_branch === tagName(dispatch.toolingSha));
      ensure(
        value.event === "workflow_dispatch" &&
          value.path === ".github/workflows/configure-platform-dadata.yml",
      );
      ensure(
        value.repository?.full_name === REPOSITORY &&
          value.head_repository?.full_name === REPOSITORY,
      );
      ensure(value.status === "in_progress" && value.conclusion === null);
    };
    check(run);
    const proof = await verifyConfigurationSource(
      {
        sourceSha: dispatch.toolingSha,
        sourceRef: run.head_branch === "main" ? "refs/heads/main" : `refs/tags/${run.head_branch}`,
      },
      token,
      { request },
    );
    check(await read(path));
    return proof;
  } catch {
    const error = new Error("Configuration source provenance rejected.");
    error.code = "ERR_CONFIGURATION_SOURCE";
    throw error;
  }
}
