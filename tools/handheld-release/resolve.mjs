import { appendFileSync } from "node:fs";
import process from "node:process";

import { nextHandheldRelease } from "./version.mjs";

/** `null` when the channel has nothing published yet; throws on anything else. */
async function readPublished(channel, fetchImpl = fetch) {
  const response = await fetchImpl(`https://releases.markiro.app/handheld/${channel}/latest.json`, {
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    // Never «assume nothing is published»: that reading restarts the
    // versionCode at 1, and every installed terminal refuses the update.
    throw new Error(`the ${channel} channel pointer answered ${response.status}`);
  }
  return await response.text();
}

export async function resolveRelease({ channel, bump, fetchImpl }) {
  return nextHandheldRelease({
    publishedText: await readPublished(channel, fetchImpl),
    bump,
    channel,
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const next = await resolveRelease({
    channel: process.env.CHANNEL || "stable",
    bump: process.env.BUMP || "patch",
  });
  const output = process.env.GITHUB_OUTPUT;
  const line = `version_name=${next.versionName}\nversion_code=${next.versionCode}\nfirst=${next.first}\n`;
  if (output) appendFileSync(output, line);
  console.log(line.trim());
}
