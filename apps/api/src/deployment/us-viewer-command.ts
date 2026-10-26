import { z } from "zod";
import { loadUsDevelopmentEnv } from "./entry-policy";

const uuid = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .uuid();

/** Exact reserved-identity syntax; no target URL, identity or role overrides. */
export function viewerCommandEnvironment(args: readonly string[], raw: NodeJS.ProcessEnv) {
  const mode = args[0];
  const tenantId = args[2];
  const originalOwnerId = args[4];
  if (
    (mode !== "provision" && mode !== "verify") ||
    args[1] !== "--tenant-id" ||
    args[3] !== "--owner-id" ||
    !uuid.safeParse(tenantId).success ||
    !uuid.safeParse(originalOwnerId).success ||
    typeof tenantId !== "string" ||
    typeof originalOwnerId !== "string" ||
    (mode === "verify"
      ? args.length !== 5
      : args.length !== 6 || args[5] !== "--confirm-local-synthetic-viewer")
  ) {
    throw new Error("us_viewer_arguments_invalid");
  }
  try {
    const env = loadUsDevelopmentEnv(raw);
    if (new URL(env.DATABASE_URL).username !== "markiro_us") throw new Error();
    return { env, mode, tenantId, originalOwnerId };
  } catch {
    throw new Error("us_viewer_environment_invalid");
  }
}

/** Failure-only scalar observation; never receives an exception or command input. */
export function createUsViewerCommandObservation() {
  let phase = 0,
    first = 0,
    hasFailure = false,
    cleanupFailed = false,
    attempted = false;
  const fail = () => {
    if (!hasFailure) {
      hasFailure = true;
      first = phase;
    }
  };
  return {
    enter(value: unknown) {
      phase =
        value === "arguments"
          ? 1
          : value === "stdin"
            ? 2
            : value === "connect"
              ? 3
              : value === "database_identity"
                ? 4
                : value === "store"
                  ? 5
                  : value === "result_output"
                    ? 6
                    : value === "pool_close"
                      ? 7
                      : 0;
    },
    fail,
    closeFailed() {
      fail();
      cleanupFailed = true;
    },
    emitFailure(sink: (line: string) => void) {
      if (!hasFailure || attempted) return;
      attempted = true;
      try {
        sink(`US_VIEWER_PROVISION_OBSERVATION ${first} ${cleanupFailed ? 1 : 0}`);
      } catch {
        // Observation must not mask the original refusal or finally precedence.
      }
    },
  };
}
