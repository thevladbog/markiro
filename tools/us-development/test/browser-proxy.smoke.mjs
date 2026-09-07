import assert from "node:assert/strict";
import test from "node:test";
import { startUsBrowserFixture } from "../browser-fixture.mjs";

test("actual US Vite proxy reaches only the independent API with its configured Host", async () => {
  const fixture = await startUsBrowserFixture(process.env.US_TEST_DATABASE_URL);
  try {
    // Entry execution is exercised by browser-flow.smoke, not a partial module
    // fetch that closes Vite while its dependency crawl is still warming up.
    const deployment = await fetch("http://localhost:5174/api/us/deployment");
    assert.equal(deployment.status, 200);
    assert.deepEqual(await deployment.json(), {
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: ["en-US", "es-US"],
      defaultInterfaceLocale: "en-US",
    });
    for (const route of [
      "/api/us/traceability/profile",
      "/api/us/traceability/access",
      "/api/us/traceability/receiving?limit=50&offset=0",
      "/api/us/traceability/receiving?status=finalized&limit=50&offset=0",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=1",
      "/api/us/traceability/reference-documents?limit=50&offset=0",
      "/api/us/traceability/reference-documents/a0000000-0000-4000-8000-000000000001",
      "/api/us/traceability/lots?limit=50&offset=0",
      "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001",
      "/api/us/traceability/parties?archived=false&limit=50&offset=0",
      "/api/us/traceability/locations?roles=supplier&roles=receive_at",
      "/api/us/traceability/parties/a0000000-0000-4000-8000-000000000001",
      "/api/us/traceability/locations/b0000000-0000-4000-8000-000000000002",
    ]) {
      const response = await fetch(`http://localhost:5174${route}`);
      assert.equal(response.status, 401, `US route must reach session guard: ${route}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.arrayBuffer();
    }
    for (const route of [
      "/api/auth/get-session",
      "/api/boxes",
      "/api/us/boxes",
      "/api/us/traceability/receiving/invalid-id",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=1&tenantId=x",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness/finalize?expectedDraftVersion=1",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize?x=1",
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize/extra",
      "/api/us/traceability/receiving?status=voided",
      "/api/us/traceability/receiving?status=draft&status=finalized",
      "/api/us/traceability/receiving?limit=50&tenantId=x",
      "/api/us/traceability/reference-documents/a0000000-0000-4000-8000-000000000001/attachments",
      "/api/us/traceability/parties-extra",
      "/api/us/traceability/locations/invalid-id",
      "/api/us/traceability/parties/a0000000-0000-4000-8000-000000000001/exports",
      "/api/us/traceability/lots/invalid-id",
      "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/source/unlock",
    ]) {
      const response = await fetch(`http://localhost:5174${route}`);
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
    const finalize = await fetch(
      "http://localhost:5174/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5174" },
        body: "{}",
      },
    );
    assert.equal(finalize.status, 401);
    await finalize.arrayBuffer();
    for (const [command, method] of [
      ["source", "PATCH"],
      ["status", "POST"],
    ]) {
      const response = await fetch(
        `http://localhost:5174/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/${command}`,
        {
          method,
          headers: { "content-type": "application/json", origin: "http://localhost:5174" },
          body: "{}",
        },
      );
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    const denied = await fetch("http://localhost:5174/api/us-auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: fixture.email, password: fixture.password }),
    });
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();
  } finally {
    await fixture.close();
  }
});
