import { execFile } from "node:child_process";
import { isIP } from "node:net";
import process from "node:process";

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIG_TIMEOUT_MS = 5_000;
const DIG_OUTPUT_LIMIT = 128 * 1024;

function runDig(args) {
  return new Promise((resolve) => {
    execFile(
      "dig",
      args,
      { encoding: "utf8", maxBuffer: DIG_OUTPUT_LIMIT, timeout: DIG_TIMEOUT_MS },
      (error, stdout) => resolve({ code: error ? 1 : 0, stdout: error ? "" : stdout }),
    );
  });
}

function normalizeAddress(value, type) {
  const address = value.trim();
  if (type === "A" && isIP(address) === 4)
    return address
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  if (type === "AAAA" && isIP(address) === 6)
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  throw new Error(`${type} address is invalid`);
}

function parseResponse(output, type, requireAuthoritative, label) {
  const status = output.match(/status:\s*([A-Z]+),/i)?.[1]?.toUpperCase() ?? "missing";
  if (status !== "NOERROR")
    throw new Error(`${label} ${type} status is ${status}, expected NOERROR`);
  const flags =
    output
      .match(/^;; flags:\s*([^;]*);/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  if (requireAuthoritative && !flags.includes("aa"))
    throw new Error(`authoritative ${type} response does not have the AA flag`);
  const answers = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith(";")) continue;
    const match = line.match(/^\S+\s+\d+\s+IN\s+(\S+)\s+(.+?)\s*$/i);
    if (!match) throw new Error(`${type} DNS response contains a malformed answer`);
    if (match[1].toUpperCase() !== type)
      throw new Error(
        `${label} ${type} response contains unsupported ${match[1].toUpperCase()} data`,
      );
    answers.push(normalizeAddress(match[2], type));
  }
  return [...new Set(answers)].sort();
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeApproved(values, type) {
  const normalized = values.map((value) => normalizeAddress(value, type));
  if (new Set(normalized).size !== normalized.length)
    throw new Error(`approved ${type} set contains a duplicate address`);
  return normalized.sort();
}

function parseList(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is invalid`);
  if (value === "none") return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) throw new Error(`${name} is invalid`);
  return items;
}

function requireServer(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:._-]+$/.test(value) || value.startsWith("-"))
    throw new Error(`${name} is invalid`);
  return value;
}

export function dnsOptionsFromEnvironment(environment) {
  if (!DOMAIN_PATTERN.test(environment.MARKIRO_DOMAIN ?? ""))
    throw new Error("MARKIRO_DOMAIN is invalid");
  const options = {
    domain: environment.MARKIRO_DOMAIN,
    authoritativeServer: requireServer(
      environment.MARKIRO_AUTHORITATIVE_DNS_SERVER,
      "MARKIRO_AUTHORITATIVE_DNS_SERVER",
    ),
    publicResolvers: parseList(
      environment.MARKIRO_PUBLIC_DNS_RESOLVERS,
      "MARKIRO_PUBLIC_DNS_RESOLVERS",
    ).map((value) => requireServer(value, "MARKIRO_PUBLIC_DNS_RESOLVERS")),
    approvedA: normalizeApproved(
      parseList(environment.MARKIRO_APPROVED_DNS_A, "MARKIRO_APPROVED_DNS_A"),
      "A",
    ),
    approvedAaaa: normalizeApproved(
      parseList(environment.MARKIRO_APPROVED_DNS_AAAA, "MARKIRO_APPROVED_DNS_AAAA"),
      "AAAA",
    ),
  };
  if (options.publicResolvers.length === 0)
    throw new Error("MARKIRO_PUBLIC_DNS_RESOLVERS is invalid");
  if (options.approvedA.length === 0 && options.approvedAaaa.length === 0)
    throw new Error("at least one approved A or AAAA address is required");
  return options;
}

export async function verifyDnsOnce(options, dependencies) {
  const approved = {
    A: normalizeApproved(options.approvedA, "A"),
    AAAA: normalizeApproved(options.approvedAaaa, "AAAA"),
  };
  const scopes = [
    {
      label: "authoritative",
      server: options.authoritativeServer,
      recursion: "+norecurse",
      requireAuthoritative: true,
    },
    ...options.publicResolvers.map((server) => ({
      label: `public resolver ${server}`,
      server,
      recursion: "+recurse",
      requireAuthoritative: false,
    })),
  ];

  for (const scope of scopes) {
    for (const type of ["A", "AAAA"]) {
      const result = await dependencies.runDig([
        `@${scope.server}`,
        scope.recursion,
        "+noall",
        "+comments",
        "+answer",
        options.domain,
        type,
      ]);
      if (result.code !== 0) throw new Error(`${scope.label} ${type} query failed`);
      const actual = parseResponse(result.stdout, type, scope.requireAuthoritative, scope.label);
      if (!sameSet(actual, approved[type]))
        throw new Error(`${scope.label} ${type} answer set differs from the approved set`);
    }
  }
}

export async function verifyDnsConvergence(options, supplied = {}) {
  const dependencies = {
    runDig,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...supplied,
  };
  const attempts = options.verificationAttempts ?? 30;
  const intervalMs = options.verificationIntervalMs ?? 2_000;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await verifyDnsOnce(options, dependencies);
      return;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await dependencies.sleep(intervalMs);
  }
  throw new Error(
    `DNS verification failed after ${attempts} attempts (last cause: ${lastError?.message ?? "unknown"})`,
  );
}

if (import.meta.main) {
  try {
    await verifyDnsConvergence(dnsOptionsFromEnvironment(process.env));
    console.log("DNS answer sets verified");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
