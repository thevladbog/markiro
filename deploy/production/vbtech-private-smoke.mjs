import { isIP } from "node:net";

import { loopbackTlsRequest } from "./loopback-tls-request.mjs";
import { runVbtechSmoke } from "./smoke.mjs";

const apexHost = "v-b.tech";
const wwwHost = "www.v-b.tech";
const SAFE_REQUEST_INIT_KEYS = new Set(["method", "body", "headers", "redirect"]);

function privateRequestError() {
  return new Error("private v-b request is invalid");
}

function validateLogicalAuthority(value, expected) {
  if (value === expected || value === `https://${expected}`) return expected;
  throw new Error("private v-b logical authority is invalid");
}

function validateTransportOrigin(value) {
  let transport;
  try {
    transport = new URL(value);
  } catch {
    throw new Error("private v-b transport origin is invalid");
  }
  const hostname = transport.hostname.replace(/^\[|\]$/g, "");
  if (
    typeof value !== "string" ||
    value !== transport.origin ||
    transport.protocol !== "https:" ||
    !hostname ||
    hostname.endsWith(".") ||
    isIP(hostname) !== 0 ||
    !transport.origin ||
    hostname === apexHost ||
    hostname === wwwHost ||
    transport.port ||
    transport.pathname !== "/" ||
    transport.search ||
    transport.hash ||
    transport.username ||
    transport.password
  )
    throw new Error("private v-b transport origin is invalid");
  return transport;
}

function logicalRequest(url, apexAuthority, wwwAuthority) {
  if (typeof url === "string" && url.includes("#")) throw privateRequestError();
  const rawAuthority =
    typeof url === "string"
      ? /^https:\/\/(v-b\.tech|www\.v-b\.tech)(?=[/?#]|$)/.exec(url)?.[1]
      : undefined;
  let logical;
  try {
    logical = new URL(url);
  } catch {
    throw privateRequestError();
  }
  if (
    logical.protocol !== "https:" ||
    logical.username ||
    logical.password ||
    logical.hash ||
    logical.port ||
    (typeof url === "string" && rawAuthority === undefined)
  )
    throw privateRequestError();
  const authority = rawAuthority || logical.hostname;
  if (authority === apexAuthority && logical.origin === `https://${apexAuthority}`)
    return { logical, host: apexAuthority };
  if (authority === wwwAuthority && logical.origin === `https://${wwwAuthority}`)
    return { logical, host: wwwAuthority };
  throw privateRequestError();
}

function transportTarget(transport, logical) {
  const target = new URL(transport);
  target.pathname = logical.pathname;
  target.search = logical.search;
  return target;
}

function privateRequestInit(init, host) {
  if (init !== undefined && (init === null || typeof init !== "object"))
    throw privateRequestError();
  const options = init || {};
  if (Reflect.ownKeys(options).some((key) => !SAFE_REQUEST_INIT_KEYS.has(key)))
    throw privateRequestError();
  const suppliedHeaders = options.headers;
  const headers = new Headers(suppliedHeaders);
  if (headers.has("host") && headers.get("host") !== host) throw privateRequestError();
  headers.set("host", host);
  return {
    ...(Object.hasOwn(options, "method") ? { method: options.method } : {}),
    ...(Object.hasOwn(options, "body") ? { body: options.body } : {}),
    ...(Object.hasOwn(options, "redirect") ? { redirect: options.redirect } : {}),
    headers,
  };
}

export function privateVbtechRequestClient({
  transportOrigin,
  apexAuthority,
  wwwAuthority,
  request,
}) {
  const transport = validateTransportOrigin(transportOrigin);
  const apex = validateLogicalAuthority(apexAuthority, apexHost);
  const www = validateLogicalAuthority(wwwAuthority, wwwHost);
  if (typeof request !== "function") throw privateRequestError();

  return {
    async request(url, init, signal) {
      const { logical, host } = logicalRequest(url, apex, www);
      const target = transportTarget(transport, logical);
      return request(target, privateRequestInit(init, host), signal);
    },
  };
}

export async function runPrivateVbtechSmoke(
  { transportOrigin, expectedVbtechReleaseSha },
  client = { request: loopbackTlsRequest },
) {
  if (typeof client?.request !== "function") throw privateRequestError();
  const privateClient = privateVbtechRequestClient({
    transportOrigin,
    apexAuthority: apexHost,
    wwwAuthority: wwwHost,
    request: client.request.bind(client),
  });
  await runVbtechSmoke(
    {
      vbtechBaseUrl: `https://${apexHost}`,
      vbtechWwwBaseUrl: `https://${wwwHost}`,
      expectedVbtechReleaseSha,
      vbtechSubmissionState: "disabled",
    },
    privateClient,
  );
  return {
    scope: "private-routing-content-only",
    publicDns: "not-verified",
    vbtechTls: "not-verified",
  };
}
