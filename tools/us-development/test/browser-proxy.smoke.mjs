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
    const profile = await fetch("http://localhost:5174/api/us/traceability/profile");
    assert.equal(profile.status, 401);
    assert.equal(profile.headers.get("cache-control"), "no-store");
    await profile.arrayBuffer();
    for (const route of ["/api/auth/get-session", "/api/boxes", "/api/us/boxes"]) {
      const response = await fetch(`http://localhost:5174${route}`);
      assert.equal(response.status, 404);
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
