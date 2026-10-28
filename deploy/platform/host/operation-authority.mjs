import { ensure } from "../backup/schemas.mjs";

export const DISPATCH_BOUND_AUTHORITY = "protected-dispatch-once";
export const operationAuthorityFields = (value) =>
  value.version === 2 ? ["authority"] : ["expiresAt"];

// A dispatch-bound operation is consumed once by its exact protected run. This
// policy does not authorize a caller: live GitHub, source and held-state guards
// still authenticate every mutation. Legacy records retain their old contract.
export function validateOperationAuthority(value, now = Date.now()) {
  ensure(Number.isSafeInteger(now));
  if (value.version === 2) {
    ensure(value.authority === DISPATCH_BOUND_AUTHORITY && !Object.hasOwn(value, "expiresAt"));
    return;
  }
  ensure(value.version === 1 && !Object.hasOwn(value, "authority"));
  const end = Date.parse(value.expiresAt);
  ensure(
    typeof value.expiresAt === "string" &&
      Number.isSafeInteger(end) &&
      new Date(end).toISOString() === value.expiresAt &&
      end > now &&
      end - now <= 3600000,
  );
}

export function historicalOperationNow(value, now = Date.now()) {
  if (value.version === 2) {
    validateOperationAuthority(value, now);
    return now;
  }
  ensure(value.version === 1);
  const historical = Date.parse(value.expiresAt) - 1;
  validateOperationAuthority(value, historical);
  return historical;
}

// These are compiled dependencies, never callbacks or command patterns from an
// operation JSON. Cleanup/metadata requests retain their existing authority.
export async function runWithForwardAuthority(request, options) {
  await options.verify();
  const args = request.args;
  const application = Array.isArray(args) && args.includes("compose") && args.includes("up");
  if (options.decision?.version === 2 && application) {
    validateOperationAuthority(options.decision);
    ensure(request.executable === "/usr/bin/docker" && typeof options.authorize === "function");
    ensure(Array.isArray(options.composeFiles) && [2, 3].includes(options.composeFiles.length));
    const prefix = [
      "--host",
      "unix:///var/run/docker.sock",
      "compose",
      "--project-name",
      "markiro-platform",
      ...options.composeFiles.flatMap((path) => ["--file", path]),
    ];
    ensure(prefix.every((value, i) => args[i] === value));
    const service = args.at(-1);
    ensure(["api", "edge"].includes(service));
    const tail = [
      "up",
      "-d",
      ...(service === "api" ? ["--wait"] : []),
      "--no-deps",
      ...(options.allowRecreate === true ? ["--force-recreate"] : []),
      service,
    ];
    ensure(
      args.length === prefix.length + tail.length &&
        tail.every((value, i) => args[prefix.length + i] === value),
    );
    // Authority is observed after all asynchronous source/physical work. The
    // synchronous freshness/abort callback is then repeated at actual spawn.
    await options.authorize();
  }
  options.recheck?.();
  return options.run(request, options.recheck);
}
