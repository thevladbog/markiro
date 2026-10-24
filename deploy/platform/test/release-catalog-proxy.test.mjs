import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";
const caddy = readFileSync("deploy/platform/Caddyfile", "utf8");
const block = (name) => {
  const at = caddy.indexOf(`(${name}) {`);
  assert.notEqual(at, -1, name);
  return caddy.slice(at, caddy.indexOf("\n}", at) + 2);
};
test("release edge delegates only to pinned private resolver, strips caller authority, leaves cache semantics to resolver", () => {
  const upstream = block("releases_upstream");
  assert.match(upstream, /rewrite \* \/internal\/release-catalog\{path\}\?/);
  assert.match(upstream, /reverse_proxy api:3000/);
  assert.doesNotMatch(upstream, /reverse_proxy https:|MARKIRO_RELEASES_BUCKET|\?Cache-Control/);
  for (const h of ["Authorization", "Cookie", "Origin", "X-Markiro-*", "X-Release-*", "X-Amz-*"])
    assert.ok(upstream.includes(`header_up -${h}`), h);
  assert.match(upstream, /status 5xx[\s\S]*Cache-Control no-store/);
});
test("ordinary sites block internal paths before catchalls; machine publishing remains guarded API", () => {
  const deny = block("deny_internal");
  assert.match(deny, /path_regexp.*internal/);
  assert.match(deny, /respond 404/);
  for (const name of ["saas_admin_routes", "landing_routes", "retired_routes"])
    assert.ok(block(name).indexOf("import deny_internal") < block(name).indexOf("handle "));
  assert.match(block("saas_admin_routes"), /path \/api\/release-publisher\/\*/);
});
test("API is one private process with exclusive journal/cache binds and no public ports", () => {
  const base = load(readFileSync("deploy/platform/compose.yml", "utf8")),
    compact = load(readFileSync("deploy/platform/compose.compact.yml", "utf8"));
  for (const services of [base.services, compact.services])
    for (const [name, svc] of Object.entries(services))
      if (name !== "edge") assert.equal(svc.ports, undefined);
  assert.equal(base.services.api.deploy.replicas, 1);
  assert.equal(base.services.api.volumes, undefined, "disabled catalog has no production binds");
  const catalog = load(readFileSync("deploy/platform/compose.catalog.yml", "utf8"));
  assert.deepEqual(Object.keys(catalog.services), ["api"]);
  const volumes = catalog.services.api.volumes;
  for (const name of ["cache", "journal"])
    assert.ok(
      volumes.some(
        (v) =>
          v.type === "bind" &&
          v.target === `/opt/markiro-platform/release-catalog/${name}` &&
          v.source === v.target &&
          v.bind.create_host_path === false,
      ),
    );
  for (const name of ["edge", "migrate"])
    assert.ok(
      !(base.services[name].volumes ?? []).some((v) =>
        String(v.target ?? v).includes("release-catalog"),
      ),
    );
  assert.deepEqual(compact.services.api.networks, ["default", "database"]);
  assert.equal(compact.networks.database.internal, true);
});

test(
  "actual Caddy strips query/authority, rejects encoded internal paths and fails closed on API outage",
  { skip: !process.env.CATALOG_CADDY_TEST_IMAGE },
  async (t) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { randomUUID } = await import("node:crypto");
    const { request } = await import("node:http");
    const rawGet = (url, init = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          url,
          { headers: init.headers, ...(init.rawPath ? { path: init.rawPath } : {}) },
          (res) => {
            const chunks = [];
            res.on("data", (b) => chunks.push(b));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: new Map(Object.entries(res.headers)),
                text: async () => Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    const root = await mkdtemp(join(tmpdir(), "catalog-caddy-")),
      name = `markiro-catalog-caddy-${randomUUID()}`;
    let started = false;
    const docker = (args) => {
      const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
      return r.stdout.trim();
    };
    t.after(async () => {
      if (started) docker(["rm", "-f", name]);
      await rm(root, { recursive: true, force: true });
    });
    let config = caddy.replace(/^\{[\s\S]*?\n\}/, "{\n admin off\n auto_https off\n}");
    config = config.slice(0, config.indexOf("http://{$MARKIRO_SAAS_ADMIN_DOMAIN}:8080"));
    config = config.replaceAll("api:3000", "127.0.0.1:19091");
    config += `\nhttp://releases.test:8080 {\n import releases_routes\n handle_errors {\n header Cache-Control no-store\n respond 503\n }\n}\nhttp://saas.test:8080 {\n import saas_admin_routes\n}\nhttp://landing.test:8080 {\n import landing_routes\n}\nhttp://retired.test:8080 {\n import retired_routes\n}\nhttp://down.test:8080 {\n reverse_proxy 127.0.0.1:19092\n handle_errors {\n header Cache-Control no-store\n respond 503\n }\n}\nhttp://:19091 {\n respond \`{"uri":"{uri}","auth":"{header.Authorization}","cookie":"{header.Cookie}","routing":"{header.X-Markiro-Internal}","range":"{header.Range}"}\` 200\n}\n`;
    config = config.replaceAll("{$MARKIRO_LANDING_DOMAIN}", "landing.test");
    await writeFile(join(root, "Caddyfile"), config);
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "markiro.task=immutable-release-catalog-20261024",
      "--read-only",
      "--tmpfs",
      "/config",
      "--tmpfs",
      "/data",
      "-p",
      "127.0.0.1::8080",
      "-v",
      `${join(root, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      process.env.CATALOG_CADDY_TEST_IMAGE,
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile",
    ]);
    started = true;
    const port = docker(["port", name, "8080/tcp"]).split(":").at(-1);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        await rawGet(url, { headers: { Host: "releases.test" } });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const r = await rawGet(url + "/station/stable/latest.json?versionId=attacker%2Fencoded", {
      headers: {
        Host: "releases.test",
        Authorization: "Bearer fake",
        Cookie: "fake",
        Origin: "https://evil.test",
        "X-Markiro-Internal": "fake",
        Range: "bytes=0-1",
      },
    });
    assert.equal(r.status, 200);
    const received = await r.text();
    assert.ok(received, JSON.stringify({ headers: [...r.headers], logs: docker(["logs", name]) }));
    assert.deepEqual(JSON.parse(received), {
      uri: "/internal/release-catalog/station/stable/latest.json",
      auth: "",
      cookie: "",
      routing: "",
      range: "bytes=0-1",
    });
    for (const host of ["saas.test", "landing.test", "retired.test", "releases.test"])
      for (const path of [
        "/internal/release-catalog/station/download",
        "/api/internal/release-catalog/station/download",
        "/%69nternal/release-catalog/station/download",
        "/api/%69nternal/release-catalog/station/download",
        "/%2569nternal/release-catalog/station/download",
        "/api/platform/../internal/release-catalog/station/download",
      ]) {
        const response = await rawGet(url + path, {
          headers: { Host: host, "X-Markiro-Internal": "true" },
        });
        assert.equal(response.status, 404, `${host}${path}`);
      }
    for (const path of [
      "/%73tation/stable/latest.json",
      "/station%2fstable/latest.json",
      "/station%252fstable/latest.json",
      "/station/beta/%2e%2e/stable/latest.json",
      "/station/stable/%6catest.json",
      "/station//stable/latest.json",
      "/station/./stable/latest.json",
      "/station/beta/../stable/latest.json",
      "/Station/stable/latest.json",
      "/station/stable/releases/1.0.0/file%2eexe",
    ]) {
      const response = await rawGet(url, { rawPath: path, headers: { Host: "releases.test" } });
      assert.equal(response.status, 404, `noncanonical release path ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
    }
    const down = await rawGet(url + "/station/download", { headers: { Host: "down.test" } });
    assert.equal(down.status, 503);
    assert.equal(down.headers.get("cache-control"), "no-store");
  },
);
