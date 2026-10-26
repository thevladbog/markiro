import { carryAdmissionReadFailure } from "./host/admission-read-failure.mjs";
import { validatePlatformCiEvidence } from "./release-evidence.mjs";

/** Only GitHub HTTPS, no redirects, fixed attempt and complete bounded pagination. */
export async function fetchPlatformCi(expected, token, request = fetch) {
  try {
    if (
      typeof expected.repository !== "string" ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.exec(expected.repository)?.[0] !== expected.repository ||
      typeof expected.sourceSha !== "string" ||
      /^[a-f0-9]{40}$/.exec(expected.sourceSha)?.[0] !== expected.sourceSha ||
      typeof expected.runId !== "string" ||
      /^[1-9][0-9]*$/.exec(expected.runId)?.[0] !== expected.runId ||
      !Number.isSafeInteger(Number(expected.runId)) ||
      typeof token !== "string" ||
      !token
    )
      throw new Error();
    const base = `https://api.github.com/repos/${expected.repository}/actions/runs/${expected.runId}`;
    async function get(url) {
      const response = await request(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error();
      return response.json();
    }
    const latest = await get(base);
    if (!Number.isSafeInteger(latest.run_attempt) || latest.run_attempt < 1) throw new Error();
    const attemptBase = `${base}/attempts/${latest.run_attempt}`;
    const run = await get(attemptBase);
    if (run.run_attempt !== latest.run_attempt) throw new Error();
    const jobs = { total_count: undefined, jobs: [] };
    for (let page = 1; ; page++) {
      const value = await get(`${attemptBase}/jobs?per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(value.total_count) ||
        value.total_count < 1 ||
        value.total_count > 10000 ||
        !Array.isArray(value.jobs)
      )
        throw new Error();
      jobs.total_count ??= value.total_count;
      if (
        value.total_count !== jobs.total_count ||
        value.jobs.length !== Math.min(100, jobs.total_count - jobs.jobs.length)
      )
        throw new Error();
      jobs.jobs.push(...value.jobs);
      if (jobs.jobs.length === jobs.total_count) break;
    }
    const identity = validatePlatformCiEvidence(run, jobs, expected);
    // The initial selected run must itself have the same successful provenance.
    validatePlatformCiEvidence(latest, jobs, expected);
    return { run, jobs, identity };
  } catch (error) {
    const failure = new Error("platform CI verification failed");
    carryAdmissionReadFailure(error, failure);
    throw failure;
  }
}
