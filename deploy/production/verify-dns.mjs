import { execFile } from "node:child_process";
import { isIP } from "node:net";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

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

function normalizeDnsName(value) {
  return value.replace(/[.]$/, "").toLowerCase();
}

function isDnsNameAtOrBelow(name, possibleAncestor) {
  const normalizedName = normalizeDnsName(name);
  const normalizedAncestor = normalizeDnsName(possibleAncestor);
  return (
    normalizedAncestor === "" ||
    normalizedName === normalizedAncestor ||
    normalizedName.endsWith(`.${normalizedAncestor}`)
  );
}

function isValidDnsName(value, allowRoot = false) {
  const normalized = normalizeDnsName(value);
  return (allowRoot && normalized === "") || DOMAIN_PATTERN.test(normalized);
}

function isValidSoaData(value) {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 7) return false;
  if (!isValidDnsName(fields[0]) || !isValidDnsName(fields[1])) return false;
  return fields.slice(2).every((field) => {
    if (!/^\d+$/.test(field)) return false;
    return BigInt(field) <= 4_294_967_295n;
  });
}

function parseHeader(output) {
  if (typeof output !== "string") return { status: "missing", flags: [] };
  const lines = output.split("\n");
  const header = lines.find((line) => line.startsWith(";; ->>HEADER<<-"));
  const status = header?.match(/(?:^|,\s*)status:\s*([A-Z]+)(?:,|$)/i)?.[1]?.toUpperCase();
  const flagsLine = lines.find((line) => line.startsWith(";; flags:"));
  const flags =
    flagsLine
      ?.match(/^;; flags:\s*([^;]*);/)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const counts = flagsLine?.match(
    /;\s*QUERY:\s*(\d+),\s*ANSWER:\s*(\d+),\s*AUTHORITY:\s*(\d+),\s*ADDITIONAL:\s*(\d+)\s*$/i,
  );
  return {
    status: status ?? "missing",
    flags,
    queryCount: counts ? Number(counts[1]) : undefined,
    answerCount: counts ? Number(counts[2]) : undefined,
    authorityCount: counts ? Number(counts[3]) : undefined,
  };
}

function parseResponse(
  output,
  type,
  requireAuthoritative,
  requireRecursion,
  label,
  domain,
  approved,
) {
  if (/^(?:;;\s*)?Warning:/im.test(output))
    throw new Error(`${label} ${type} dig output contains a parser warning`);
  if (/^;;\s*Truncated\b/im.test(output))
    throw new Error(`${label} ${type} dig output contains a truncation retry diagnostic`);
  const { status, flags, queryCount, answerCount, authorityCount } = parseHeader(output);
  if (status !== "NOERROR")
    throw new Error(`${label} ${type} status is ${status}, expected NOERROR`);
  if (!flags.includes("qr")) throw new Error(`${label} ${type} response does not have the QR flag`);
  if (flags.includes("tc")) throw new Error(`${label} ${type} response has the TC flag`);
  if (requireAuthoritative && !flags.includes("aa"))
    throw new Error(`authoritative ${type} response does not have the AA flag`);
  if (requireRecursion && !flags.includes("ra"))
    throw new Error(`${label} ${type} response does not have the RA flag`);
  if (queryCount !== 1 || answerCount === undefined || authorityCount === undefined)
    throw new Error(`${label} ${type} response has malformed DNS section counts`);
  const records = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith(";")) continue;
    const match = line.match(/^(\S+)\s+\d+\s+IN\s+(\S+)\s+(.+?)\s*$/i);
    if (!match) throw new Error(`${label} ${type} DNS response contains a malformed record`);
    records.push({ owner: match[1], type: match[2].toUpperCase(), value: match[3] });
  }
  if (records.length !== answerCount + authorityCount)
    throw new Error(`${label} ${type} DNS section counts do not match the emitted records`);
  const answers = [];
  for (const record of records.slice(0, answerCount)) {
    if (normalizeDnsName(record.owner) !== normalizeDnsName(domain))
      throw new Error(`${label} ${type} answer owner does not match the requested domain`);
    if (record.type !== type)
      throw new Error(`${label} ${type} response contains unsupported ${record.type} data`);
    answers.push(normalizeAddress(record.value, type));
  }
  if (approved.length === 0) {
    if (answerCount !== 0)
      throw new Error(`${label} ${type} NODATA response contains answer records`);
    const authority = records.slice(answerCount, answerCount + authorityCount);
    const soaRecords = authority.filter((record) => record.type === "SOA");
    if (soaRecords.length === 0)
      throw new Error(`${label} ${type} NODATA response does not contain an SOA record`);
    const unsupportedAuthority = authority.find((record) => record.type !== "SOA");
    if (unsupportedAuthority)
      throw new Error(
        `${label} ${type} NODATA authority contains unsupported ${unsupportedAuthority.type} data`,
      );
    if (
      soaRecords.some(
        (record) => !isValidDnsName(record.owner, true) || !isValidSoaData(record.value),
      )
    )
      throw new Error(`${label} ${type} NODATA response contains malformed SOA data`);
    if (soaRecords.some((record) => !isDnsNameAtOrBelow(domain, record.owner)))
      throw new Error(
        `${label} ${type} NODATA SOA owner is not the requested domain or its ancestor`,
      );
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
      requireRecursion: false,
    },
    ...options.publicResolvers.map((server) => ({
      label: `public resolver ${server}`,
      server,
      recursion: "+recurse",
      requireAuthoritative: false,
      requireRecursion: true,
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
        "+authority",
        options.domain,
        type,
      ]);
      if (result.code !== 0) throw new Error(`${scope.label} ${type} query failed`);
      const actual = parseResponse(
        result.stdout,
        type,
        scope.requireAuthoritative,
        scope.requireRecursion,
        scope.label,
        options.domain,
        approved[type],
      );
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
      return { attempt: attempt + 1 };
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await dependencies.sleep(intervalMs);
  }
  throw new Error(
    `DNS verification failed after ${attempts} attempts (last cause: ${lastError?.message ?? "unknown"})`,
  );
}

if (isMainModule(import.meta.url)) {
  try {
    await verifyDnsConvergence(dnsOptionsFromEnvironment(process.env));
    console.log("DNS answer sets verified");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
