import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// «Исходящих соединений в интернет нет» (spec §1.1, §10.10): the update comes
// as a file and is checked locally, so nothing the standalone product links
// may reach out. These contracts fail on a new network crate, an updater or
// an HTTP plugin until a person has checked it reaches nothing but the
// site's own host and named it here.

const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

/** Every package name in the standalone workspace's Cargo.lock, once each, sorted. */
function lockedCrates(lock) {
  return [...new Set([...lock.matchAll(/^name = "([^"]+)"$/gmu)].map((match) => match[1]))].sort();
}

/** Crates that speak a network protocol, resolve names or wrap sockets and TLS. */
const NETWORK =
  /^(?:reqwest|ureq|curl.*|isahc|surf|attohttpc|hyper.*|h2|h3.*|quinn.*|tungstenite|tokio-tungstenite|async-tungstenite|.*websocket.*|native-tls|openssl.*|hickory.*|trust-dns.*|axum.*|tower-http|tokio-rustls|rustls.*|webpki.*|socket2|mio|if-addrs|url|cookie.*|ipnet|tauri-plugin-.*|tokio-native-tls|async-native-tls|sentry.*|opentelemetry.*|tonic.*|lettre|minreq|tiny_http|actix.*|warp|ssh2|git2|ws)$/u;

// What the workspace links today: the host's own HTTPS server (axum, hyper,
// tokio-rustls), the shell's client pinned to that host (reqwest with
// rustls; quinn and the platform verifier come with reqwest and are never
// used: the client speaks HTTP/1.1 and HTTP/2 over a pinned certificate),
// the host's listing of its own addresses (if-addrs) and the single-instance
// plugin (a local pipe, no network).
const KNOWN = [
  "axum",
  "axum-core",
  "cookie",
  "hyper",
  "hyper-rustls",
  "hyper-util",
  "if-addrs",
  "ipnet",
  "mio",
  "openssl-probe",
  "quinn",
  "quinn-proto",
  "quinn-udp",
  "reqwest",
  "rustls",
  "rustls-native-certs",
  "rustls-pki-types",
  "rustls-platform-verifier",
  "rustls-platform-verifier-android",
  "rustls-webpki",
  "socket2",
  "tauri-plugin-single-instance",
  "tokio-rustls",
  "tower-http",
  "url",
  "webpki-root-certs",
];

test("the standalone workspace links no network crate beyond the ones it has", async () => {
  const crates = lockedCrates(await text("apps/standalone/Cargo.lock"));
  assert.deepEqual(
    crates.filter((name) => NETWORK.test(name)),
    KNOWN,
  );
});

test("no updater and no HTTP plugin in the shell, the host or the webview", async () => {
  for (const path of ["apps/standalone/src-tauri/Cargo.toml", "apps/standalone/host/Cargo.toml"]) {
    assert.doesNotMatch(await text(path), /tauri-plugin-(?:updater|http|upload|websocket)/u, path);
  }
  const webview = JSON.parse(await text("apps/standalone/package.json"));
  const dependencies = Object.keys({ ...webview.dependencies, ...webview.devDependencies });
  assert.deepEqual(
    dependencies.filter((name) => /^@tauri-apps\/plugin-/u.test(name)),
    [],
  );
  for (const path of [
    "apps/standalone/src-tauri/tauri.conf.json",
    "apps/standalone/src-tauri/tauri.installer.conf.json",
  ]) {
    const config = JSON.parse(await text(path));
    assert.equal(config.plugins?.updater, undefined, path);
    assert.equal(config.bundle?.createUpdaterArtifacts, undefined, path);
  }
});

test("the guide for IT keeps its promise", async () => {
  assert.match(
    await text("docs/runbooks/standalone-install.md"),
    /Исходящих соединений в интернет нет/u,
  );
});
