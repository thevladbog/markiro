import { pathToFileURL } from "node:url";

const FAILURE_MESSAGE = "Station pairing CORS verification failed";
const WINDOWS_STATION_ORIGIN = "http://tauri.localhost";

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

export async function verifyStationCors({ apiUrl, fetchImpl = fetch }) {
  try {
    const origin = canonicalProductionOrigin(apiUrl);
    const response = await fetchImpl(`${origin}/station/pair`, {
      method: "OPTIONS",
      redirect: "error",
      headers: {
        Origin: WINDOWS_STATION_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-station-capabilities",
      },
    });

    if (
      response.status !== 204 ||
      response.headers.get("access-control-allow-origin") !== WINDOWS_STATION_ORIGIN
    ) {
      fail();
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
