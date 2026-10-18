import assert from "node:assert/strict";

/** Transport is injected: the preparation runner uses loopback TLS only. */
export async function smokePlatform({ request, sourceSha }) {
  const checks = [
    ["saas-admin.localhost", "/login", "GET", 200, "text/html"],
    ["saas-admin.localhost", "/api/platform/tenants", "GET", 401, "application/json"],
    ["saas-admin.localhost", "/api/platform/missing-route", "GET", 404, "application/json"],
    ["saas-admin.localhost", "/api/platform-auth/get-session", "GET", 200, "application/json"],
    ["landing.localhost", "/", "GET", 200, "text/html"],
    ["landing.localhost", "/missing-document", "GET", 404, "text/html"],
    ["landing.localhost", "/api/demo-requests", "POST", 404, "application/json"],
  ];
  for (const host of ["saas-admin.localhost", "landing.localhost"]) {
    for (const path of [
      "/api",
      "/api/unknown",
      "/api/auth/get-session",
      "/api/demo-requests/unknown",
      "/station",
      "/station/sync",
      "/kiosk",
      "/kiosk/sync",
      "/signer-agent",
      "/signer-agent/challenge",
      "/1c_exchange",
      "/openapi.json",
      "/docs",
      "/health",
      "/platform/tenants",
    ])
      checks.push([host, path, "GET", 404]);
  }
  for (const host of ["admin.localhost", "kiosk.localhost"]) {
    for (const path of [
      "/",
      "/api/unknown",
      "/api/auth/get-session",
      "/station/sync",
      "/kiosk/sync",
      "/signer-agent/challenge",
      "/shifts",
      "/products",
      "/1c_exchange",
    ]) {
      checks.push([host, path, "GET", 410, "application/json"]);
      checks.push([host, path, "POST", 410, "application/json"]);
    }
    const notice = await request(host, "/", { headers: { Accept: "text/html" } });
    assert.equal(notice.status, 410);
    assert.match(notice.headers.get("content-type"), /text\/html/u);
    assert.match(await notice.text(), /Онлайн-сервис завершил работу/u);
    const machine = await request(host, "/api/auth/get-session", {
      headers: { Accept: "text/html" },
    });
    assert.equal(machine.status, 410);
    assert.match(machine.headers.get("content-type"), /application\/json/u);
  }
  for (const [host, path, method, status, type] of checks) {
    const result = await request(host, path, { method });
    assert.equal(result.status, status, `${host} ${method} ${path}`);
    assert.equal(
      result.headers.get("location"),
      null,
      `${host} ${method} ${path} must not redirect`,
    );
    assert.equal(result.headers.get("x-markiro-server-profile"), "platform-only");
    assert.equal(result.headers.get("x-markiro-release-sha"), sourceSha);
    if (type)
      assert.ok(result.headers.get("content-type")?.includes(type), `${host} ${path}: ${type}`);
    await result.arrayBuffer();
  }
  return checks.length + 4;
}
