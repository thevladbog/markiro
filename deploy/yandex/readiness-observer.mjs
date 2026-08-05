import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

export const READY_URL = "http://127.0.0.1:3000/health/ready";
export const REQUEST_TIMEOUT_MS = 2_000;

function requiredUnavailable() {
  return { category: "required_unavailable", exitCode: 1 };
}

export function readinessCategory(report, responseOk) {
  if (
    !responseOk ||
    !report ||
    typeof report !== "object" ||
    !report.checks ||
    typeof report.checks !== "object"
  )
    return "required_unavailable";
  if (report.status === "ok") return "ok";
  if (report.status !== "degraded") return "required_unavailable";
  if (report.checks.smtp?.status === "degraded") return "smtp_degraded";
  if (report.checks.storage?.status === "degraded") return "storage_degraded";
  return "required_unavailable";
}

export async function observeReadiness({
  clock = { timeout: AbortSignal.timeout },
  fetch = globalThis.fetch,
} = {}) {
  try {
    const response = await fetch(READY_URL, { signal: clock.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      return requiredUnavailable();
    }
    const category = readinessCategory(await response.json(), true);
    return { category, exitCode: category === "required_unavailable" ? 1 : 0 };
  } catch {
    return requiredUnavailable();
  }
}

if (isMainModule(import.meta.url)) {
  const observation = await observeReadiness();
  process.stdout.write(`${observation.category}\n`);
  process.exitCode = observation.exitCode;
}
