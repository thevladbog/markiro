import { canonicalId } from "./release-admission.mjs";
import { withAdmissionReadStage } from "./host/admission-read-failure.mjs";

export const REPOSITORY = "thevladbog/markiro";
const BASE = `https://api.github.com/repos/${REPOSITORY}/actions`;
const safeNumber = (value) => Number.isSafeInteger(value) && value > 0;
function requireTrue(value) {
  if (!value) throw new Error("invalid GitHub admission response");
}
async function boundedBytes(response, limit, reject, details = {}) {
  requireTrue(response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    const length = response.headers.get("content-length");
    if (length !== null) {
      requireTrue(/^[0-9]+$/.test(length));
      if (Number(length) > limit)
        reject("body-limit", { ...details, status: response.status, limitBytes: limit });
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        reject("body-limit", {
          ...details,
          status: response.status,
          limitBytes: limit,
          bytesSeen: Math.min(size, 2097153),
        });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** No API redirects; signed download URLs receive no authentication on any hop. */
export function githubTransport(token, request = fetch) {
  async function api(path) {
    requireTrue(
      typeof token === "string" &&
        token.length > 0 &&
        typeof path === "string" &&
        /^\/(?:runs|artifacts)\/[0-9]+(?:[/?][A-Za-z0-9_/?=&-]*)?$/.exec(path)?.[0] === path,
    );
    return request(`${BASE}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }
  async function json(path) {
    return withAdmissionReadStage(
      typeof path === "string" && path.startsWith("/artifacts/")
        ? "artifact-metadata"
        : "publisher",
      async (reject) => {
        const response = await api(path);
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          reject("http", { status: response.status });
        }
        const bytes = await boundedBytes(response, 2 * 1024 * 1024, reject);
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          reject("validation");
        }
      },
    );
  }
  return {
    json,
    async ciRequest(url) {
      requireTrue(typeof url === "string" && url.startsWith(`${BASE}/runs/`));
      const value = await json(url.slice(BASE.length));
      return { ok: true, json: async () => value };
    },
    async download(artifactId) {
      return withAdmissionReadStage("artifact-download", async (reject) => {
        requireTrue(canonicalId(artifactId));
        let response = await api(`/artifacts/${artifactId}/zip`);
        if (response.status !== 302) {
          await response.body?.cancel().catch(() => undefined);
          reject("http", { status: response.status });
        }
        for (let hop = 0; hop < 4; hop++) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          requireTrue(typeof location === "string");
          let url;
          try {
            url = new URL(location);
          } catch {
            reject("validation", { redirectCount: hop });
          }
          requireTrue(url.protocol === "https:" && !url.username && !url.password);
          response = await request(url.href, {
            redirect: "manual",
            signal: AbortSignal.timeout(30000),
            headers: {},
          });
          if (response.status === 200)
            return boundedBytes(response, 1024 * 1024, reject, { redirectCount: hop + 1 });
          if (![301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            reject("http", { status: response.status, redirectCount: hop + 1 });
          }
        }
        await response.body?.cancel();
        reject("redirect", { redirectCount: 4 });
      });
    },
  };
}
function validatePublisher(run, expected) {
  requireTrue(
    run &&
      safeNumber(run.id) &&
      safeNumber(run.run_attempt) &&
      String(run.id) === expected.workflowRunId &&
      String(run.run_attempt) === expected.workflowRunAttempt &&
      run.name === "Publish platform images" &&
      [
        ".github/workflows/release-platform-images.yml",
        ".github/workflows/release-platform-images.yml@refs/heads/main",
      ].includes(run.path) &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === expected.sourceSha &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      safeNumber(run.repository.id) &&
      safeNumber(run.head_repository.id) &&
      run.repository.id === run.head_repository.id,
  );
}
/** A fresh current snapshot must still name the already validated attempt/repository. */
export async function recheckPublisher(expected, selected, transport) {
  const current = await transport.json(`/runs/${expected.workflowRunId}`);
  validatePublisher(current, expected);
  requireTrue(
    current.repository.id === selected.repository.id &&
      current.head_repository.id === selected.head_repository.id,
  );
}

export async function fetchPublisher(expected, transport) {
  const base = `/runs/${expected.workflowRunId}`;
  const latest = await transport.json(base);
  validatePublisher(latest, expected);
  const attemptBase = `${base}/attempts/${expected.workflowRunAttempt}`;
  const run = await transport.json(attemptBase);
  validatePublisher(run, expected);
  requireTrue(
    latest.repository.id === run.repository.id &&
      latest.head_repository.id === run.head_repository.id,
  );
  let total;
  const jobs = [];
  for (let page = 1; ; page++) {
    const value = await transport.json(`${attemptBase}/jobs?per_page=100&page=${page}`);
    requireTrue(
      value &&
        safeNumber(value.total_count) &&
        value.total_count <= 10000 &&
        Array.isArray(value.jobs),
    );
    total ??= value.total_count;
    requireTrue(
      value.total_count === total && value.jobs.length === Math.min(100, total - jobs.length),
    );
    jobs.push(...value.jobs);
    if (jobs.length === total) break;
  }
  const ids = new Set();
  const required = new Set(["build", "publish"]);
  for (const job of jobs) {
    requireTrue(
      job &&
        safeNumber(job.id) &&
        !ids.has(job.id) &&
        job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === expected.sourceSha,
    );
    ids.add(job.id);
    if (["build", "publish"].includes(job.name)) {
      requireTrue(
        required.has(job.name) && job.status === "completed" && job.conclusion === "success",
      );
      required.delete(job.name);
    }
  }
  requireTrue(required.size === 0);
  await recheckPublisher(expected, run, transport);
  return run;
}
export function validateArtifact(value, run, artifactId, now = Date.now()) {
  requireTrue(
    value &&
      safeNumber(value.id) &&
      String(value.id) === artifactId &&
      value.name === `markiro-platform-release-${run.id}-${run.run_attempt}` &&
      value.expired === false &&
      typeof value.expires_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.exec(value.expires_at)?.[0] ===
        value.expires_at &&
      Date.parse(value.expires_at) > now &&
      new Date(value.expires_at).toISOString() ===
        (value.expires_at.includes(".")
          ? value.expires_at
          : value.expires_at.replace("Z", ".000Z")) &&
      safeNumber(value.size_in_bytes) &&
      value.size_in_bytes <= 1024 * 1024 &&
      typeof value.digest === "string" &&
      /^sha256:[a-f0-9]{64}$/.exec(value.digest)?.[0] === value.digest &&
      value.workflow_run?.id === run.id &&
      value.workflow_run.head_sha === run.head_sha &&
      value.workflow_run.head_branch === "main" &&
      value.workflow_run.repository_id === run.repository.id &&
      value.workflow_run.head_repository_id === run.head_repository.id,
  );
  return { id: artifactId, sha256: value.digest.slice(7), size: value.size_in_bytes };
}
