import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserSmoke, navigateLocalPage } from "../browser-smoke.mjs";

for (const screenshotFails of [false, true]) {
  test(`browser failure preserves diagnostics and original error: screenshotFails=${screenshotFails}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "platform-browser-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = new Error("email input did not appear");
    const listeners = new EventEmitter();
    let closed = false;
    let screenshots = 0;
    const page = {
      on: (name, callback) => {
        listeners.on(name, callback);
      },
      off: (name, callback) => listeners.off(name, callback),
      goto: async () => {
        listeners.emit("pageerror", new Error("module initialization failed"));
        listeners.emit("response", {
          url: () => "https://saas-admin.localhost:1234/assets/chunk.js?secret=omit",
          status: () => 404,
        });
        listeners.emit("requestfailed", {
          url: () => "https://saas-admin.localhost:1234/assets/app.js?token=never-record",
          method: () => "GET",
          resourceType: () => "script",
          failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
        });
      },
      locator: () => ({
        waitFor: async () => {
          throw original;
        },
      }),
      screenshot: async () => {
        screenshots++;
        if (screenshotFails) throw new Error("screenshot unavailable");
      },
    };
    const chromium = {
      launch: async () => ({
        newContext: async () => ({ newPage: async () => page }),
        close: async () => {
          closed = true;
        },
      }),
    };
    await assert.rejects(
      browserSmoke(1234, directory, { chromium }),
      (error) => error === original,
    );
    const raw = await readFile(join(directory, "platform-browser-failure.json"), "utf8");
    assert.equal(raw.includes("never-record"), false);
    assert.deepEqual(JSON.parse(raw), {
      errors: ["module initialization failed"],
      failedResponses: [{ path: "/assets/chunk.js", status: 404 }],
      failedRequests: [
        { path: "/assets/app.js", resourceType: "script", error: "net::ERR_CONNECTION_RESET" },
      ],
    });
    assert.equal(screenshots, 1);
    assert.equal(closed, true);
  });
}

test("initial navigation retries only an explicit network-change failure", async () => {
  let calls = 0;
  let delays = 0;
  const response = { status: () => 200 };
  const page = {
    goto: async () => {
      if (++calls === 1) throw new Error("page.goto: net::ERR_NETWORK_CHANGED");
      return response;
    },
  };
  assert.equal(
    await navigateLocalPage(page, "https://saas-admin.localhost:1234/login", async () => {
      delays++;
    }),
    response,
  );
  assert.equal(calls, 2);
  assert.equal(delays, 1);
});

for (const message of [
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_CONNECTION_REFUSED",
  "Timeout 30000ms exceeded.",
]) {
  test(`navigation preserves failure and bounds attempts: ${message}`, async () => {
    const error = new Error(message);
    let calls = 0;
    const page = {
      goto: async () => {
        calls++;
        throw error;
      },
    };
    await assert.rejects(
      navigateLocalPage(page, "https://saas-admin.localhost:1234/login", async () => {}),
      (e) => e === error,
    );
    assert.equal(calls, message === "net::ERR_NETWORK_CHANGED" ? 3 : 1);
  });
}

test("HTTP failure responses are returned unchanged and never retried", async () => {
  let calls = 0;
  const response = { status: () => 503 };
  assert.equal(
    await navigateLocalPage(
      {
        goto: async () => {
          calls++;
          return response;
        },
      },
      "https://saas-admin.localhost:1234/login",
    ),
    response,
  );
  assert.equal(calls, 1);
});

test("initial render reloads only when local static modules hit a network change", async () => {
  const listeners = new Map();
  let calls = 0;
  let waits = 0;
  const page = {
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    goto: async () => {
      calls++;
      if (calls === 1)
        listeners.get("requestfailed")?.({
          url: () => "https://saas-admin.localhost:1234/assets/Login.js",
          method: () => "GET",
          resourceType: () => "script",
          failure: () => ({ errorText: "net::ERR_NETWORK_CHANGED" }),
        });
      return { status: () => 200 };
    },
  };
  await navigateLocalPage(
    page,
    "https://saas-admin.localhost:1234/login",
    async () => {
      waits++;
    },
    async () => {
      if (calls === 1) {
        const error = new Error("email input did not appear");
        error.name = "TimeoutError";
        throw error;
      }
    },
  );
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  assert.equal(listeners.size, 0);
});

for (const scenario of [
  { name: "plain render timeout", emitFailure: false },
  { name: "different transport error", errorText: "net::ERR_CONNECTION_RESET" },
  { name: "foreign origin", url: "https://api.markiro.ru/assets/Login.js" },
  { name: "different local port", url: "https://saas-admin.localhost:4321/assets/Login.js" },
  { name: "non-asset path", url: "https://saas-admin.localhost:1234/api/module.js" },
  { name: "POST", method: "POST" },
  { name: "XHR", resourceType: "xhr" },
  { name: "HTTP error", httpError: true },
  { name: "application error", pageError: true },
  { name: "readiness assertion", assertion: true },
  { name: "persistent network changes", expectedCalls: 3 },
]) {
  test(`initial render preserves failure: ${scenario.name}`, async () => {
    const events = new EventEmitter();
    let calls = 0;
    const original = new Error(
      scenario.assertion ? "assertion: net::ERR_NETWORK_CHANGED" : "render did not finish",
    );
    original.name = scenario.assertion ? "AssertionError" : "TimeoutError";
    const page = {
      on: (...args) => events.on(...args),
      off: (...args) => events.off(...args),
      goto: async () => {
        calls++;
        if (scenario.emitFailure !== false)
          events.emit("requestfailed", {
            url: () => scenario.url ?? "https://saas-admin.localhost:1234/assets/Login.js",
            method: () => scenario.method ?? "GET",
            resourceType: () => scenario.resourceType ?? "script",
            failure: () => ({ errorText: scenario.errorText ?? "net::ERR_NETWORK_CHANGED" }),
          });
        if (scenario.pageError) events.emit("pageerror", new Error("broken application"));
        if (scenario.httpError) events.emit("response", { status: () => 503 });
        return { status: () => 200 };
      },
    };
    await assert.rejects(
      navigateLocalPage(
        page,
        "https://saas-admin.localhost:1234/login",
        async () => {},
        async () => {
          throw original;
        },
      ),
      (error) => error === original,
    );
    assert.equal(calls, scenario.expectedCalls ?? 1);
    assert.equal(events.eventNames().length, 0, "scoped render listeners are always removed");
  });
}

const localLogin = "https://saas-admin.localhost:1234/login";
function documentFailurePage(scenario = {}) {
  const events = new EventEmitter();
  const mainFrame = {};
  const original = new Error("page.goto: net::ERR_NETWORK_CHANGED");
  let calls = 0;
  const fail = () => {
    const request = {
      url: () => scenario.url ?? localLogin,
      method: () => scenario.method ?? "GET",
      resourceType: () => scenario.resourceType ?? "document",
      failure: () => ({ errorText: scenario.errorText ?? "net::ERR_NETWORK_CHANGED" }),
      ...(scenario.missingFrame ? {} : { frame: () => (scenario.subframe ? {} : mainFrame) }),
      ...(scenario.missingNavigationFlag
        ? {}
        : { isNavigationRequest: () => scenario.navigation ?? true }),
    };
    events.emit("requestfailed", request);
    if (scenario.pageError) events.emit("pageerror", new Error("application failed"));
    if (scenario.httpError) events.emit("response", { status: () => 503 });
  };
  const page = {
    ...(scenario.missingMainFrame ? {} : { mainFrame: () => mainFrame }),
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
    goto: async () => {
      calls++;
      if (!scenario.afterNavigation && (calls === 1 || scenario.persistent)) {
        fail();
        throw original;
      }
      return { status: () => 200 };
    },
  };
  return { page, events, original, fail, calls: () => calls };
}
test("initial document network change retries with real requestfailed ordering and readiness listeners", async () => {
  const f = documentFailurePage();
  let waits = 0;
  let ready = 0;
  const response = await navigateLocalPage(
    f.page,
    localLogin,
    async () => {
      waits++;
    },
    async () => {
      ready++;
    },
  );
  assert.equal(response.status(), 200);
  assert.equal(f.calls(), 2);
  assert.equal(waits, 1);
  assert.equal(ready, 1);
  assert.equal(f.events.eventNames().length, 0);
});
for (const scenario of [
  { name: "foreign document", url: "https://foreign.example/login" },
  { name: "different port", url: "https://saas-admin.localhost:4321/login" },
  { name: "different path", url: "https://saas-admin.localhost:1234/api/login" },
  { name: "different query", url: localLogin + "?other=1" },
  { name: "POST", method: "POST" },
  { name: "XHR", resourceType: "xhr" },
  { name: "not navigation", navigation: false },
  { name: "missing navigation flag", missingNavigationFlag: true },
  { name: "iframe document", subframe: true },
  { name: "missing request frame", missingFrame: true },
  { name: "missing page main frame", missingMainFrame: true },
  { name: "different request error", errorText: "net::ERR_CONNECTION_RESET" },
  { name: "concurrent application error", pageError: true },
  { name: "concurrent HTTP error", httpError: true },
  { name: "persistent network change", persistent: true, attempts: 3 },
  { name: "document failure after navigation", afterNavigation: true },
]) {
  test(`document navigation preserves failure: ${scenario.name}`, async () => {
    const f = documentFailurePage(scenario);
    let waits = 0;
    await assert.rejects(
      navigateLocalPage(
        f.page,
        localLogin,
        async () => {
          waits++;
        },
        async () => {
          if (scenario.afterNavigation) {
            f.fail();
            throw f.original;
          }
        },
      ),
      (error) => error === f.original,
    );
    assert.equal(f.calls(), scenario.attempts ?? 1);
    assert.equal(waits, (scenario.attempts ?? 1) - 1);
    assert.equal(f.events.eventNames().length, 0);
  });
}
