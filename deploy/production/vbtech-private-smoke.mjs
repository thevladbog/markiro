import { isIP } from "node:net";

import { runVbtechSmoke } from "./smoke.mjs";

const apexHost = "v-b.tech";
const wwwHost = "www.v-b.tech";

function privateRequestError() {
  return new Error("private v-b request is invalid");
}

function validateLogicalAuthority(value, expected) {
  if (value === expected) return expected;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === expected &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    )
      return expected;
  } catch {}
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
    transport.protocol !== "https:" ||
    !hostname ||
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
  let logical;
  try {
    logical = new URL(url);
  } catch {
    throw privateRequestError();
  }
  if (logical.origin === `https://${apexAuthority}`) return { logical, host: apexAuthority };
  if (logical.origin === `https://${wwwAuthority}`) return { logical, host: wwwAuthority };
  throw privateRequestError();
}

function privateRequestInit(init, host) {
  const { headers: suppliedHeaders, ...options } = init ?? {};
  const headers = new Headers(suppliedHeaders);
  if (headers.has("host") && headers.get("host") !== host) throw privateRequestError();
  headers.set("host", host);
  return { ...options, headers };
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
    async request(url, init) {
      const { logical, host } = logicalRequest(url, apex, www);
      const target = new URL(`${logical.pathname}${logical.search}`, transport);
      return request(target, privateRequestInit(init, host));
    },
  };
}

export async function runPrivateVbtechSmoke(
  { transportOrigin, expectedVbtechReleaseSha },
  client = { request: fetch },
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
