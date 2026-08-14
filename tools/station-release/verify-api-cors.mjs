import { pathToFileURL } from "node:url";

const FAILURE_MESSAGE = "Station CORS verification failed";
const WINDOWS_STATION_ORIGIN = "http://tauri.localhost";

export const STATION_PREFLIGHTS = Object.freeze([
  { path: "/station/pair", method: "POST", headers: "content-type,x-station-capabilities" },
  {
    path: "/station/identity",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/station/operators",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/station/products/00000000-0000-0000-0000-000000000000/image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    method: "GET",
    headers: "x-api-key,x-station-capabilities",
  },
  {
    path: "/station/scans",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  { path: "/shifts", method: "GET", headers: "content-type,x-api-key,x-station-capabilities" },
  { path: "/shifts", method: "POST", headers: "content-type,x-api-key,x-station-capabilities" },
  {
    path: "/shifts/cors-probe/open",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/shifts/cors-probe/bundle",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  {
    path: "/shifts/cors-probe/reference-bundle",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
  { path: "/products", method: "GET", headers: "content-type,x-api-key,x-station-capabilities" },
  {
    path: "/products/gtin-check",
    method: "POST",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
]);

function fail() {
  throw new Error(FAILURE_MESSAGE);
}

function canonicalProductionOrigin(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    fail();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    apiUrl !== url.origin
  ) {
    fail();
  }

  return url.origin;
}

function allowsCommaSeparatedValue(value, required) {
  return value
    ?.split(",")
    .some((candidate) => candidate.trim().toLowerCase() === required.toLowerCase());
}

function allowsPreflight(response, preflight) {
  return (
    response.status === 204 &&
    response.headers.get("access-control-allow-origin") === WINDOWS_STATION_ORIGIN &&
    allowsCommaSeparatedValue(
      response.headers.get("access-control-allow-methods"),
      preflight.method,
    ) &&
    preflight.headers
      .split(",")
      .every((header) =>
        allowsCommaSeparatedValue(response.headers.get("access-control-allow-headers"), header),
      )
  );
}

export async function verifyStationCors({ apiUrl, fetchImpl = fetch }) {
  try {
    const origin = canonicalProductionOrigin(apiUrl);
    for (const preflight of STATION_PREFLIGHTS) {
      const response = await fetchImpl(`${origin}${preflight.path}`, {
        method: "OPTIONS",
        redirect: "error",
        headers: {
          Origin: WINDOWS_STATION_ORIGIN,
          "Access-Control-Request-Method": preflight.method,
          "Access-Control-Request-Headers": preflight.headers,
        },
      });

      if (!allowsPreflight(response, preflight)) {
        fail();
      }
    }
  } catch {
    fail();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  verifyStationCors({ apiUrl: process.argv[2] }).catch(() => {
    console.error(FAILURE_MESSAGE);
    process.exitCode = 1;
  });
}
