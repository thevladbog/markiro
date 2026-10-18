// Authenticode for the installer (plan УСТ, owner question П12): the Tauri
// config overlay that makes `tauri build` sign with a code-signing
// certificate already in the Windows certificate store of the build machine.
// The pilot ships unsigned (the release evidence says `NotSigned`); with the
// owner's certificate the build becomes
//
//   node tools/standalone-release/sign-overlay.mjs --thumbprint <SHA-1> \
//     --timestamp-url <RFC 3161 URL of the certificate's CA> > sign.json
//   pnpm --filter @markiro/standalone tauri build \
//     --config src-tauri/tauri.installer.conf.json --config <path>/sign.json --bundles nsis
//
// The certificate itself, its password and the store stay outside the repo.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function buildSignOverlay({ thumbprint, timestampUrl }) {
  const normalized = String(thumbprint ?? "")
    .replaceAll(/\s/g, "")
    .toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    throw new Error("the certificate thumbprint must be 40 hex digits (SHA-1)");
  }
  let url;
  try {
    url = new URL(String(timestampUrl ?? ""));
  } catch {
    throw new Error("the timestamp server must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("the timestamp server must be an http or https URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("the timestamp server URL must not contain credentials");
  }
  return {
    bundle: {
      windows: {
        certificateThumbprint: normalized,
        digestAlgorithm: "sha256",
        timestampUrl: url.href,
        tsp: true,
      },
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: { thumbprint: { type: "string" }, "timestamp-url": { type: "string" } },
    strict: true,
  });
  const overlay = buildSignOverlay({
    thumbprint: values.thumbprint,
    timestampUrl: values["timestamp-url"],
  });
  process.stdout.write(`${JSON.stringify(overlay, null, 2)}\n`);
}
