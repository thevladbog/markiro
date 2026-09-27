import { describe, expect, it } from "vitest";

import { nextSyncRetryMs, syncFailureOf } from "../src/app/host-link.js";
import { HostError } from "../src/host/client.js";
import { LocalDbError } from "../src/local/executor.js";
import { SyncFeedError } from "../src/local/reference-sync.js";

describe("nextSyncRetryMs", () => {
  it("waits 2, 4, 8, 16 and 32 s, then 60 s before every later retry", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100].map((attempt) => nextSyncRetryMs(attempt))).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });
});

describe("syncFailureOf", () => {
  it("blames the host, this computer or the feed", () => {
    expect(
      syncFailureOf(new HostError({ kind: "transport", code: "unreachable", message: "down" })),
    ).toBe("host");
    expect(
      syncFailureOf(new HostError({ kind: "api", code: "internal", status: 500, message: "oops" })),
    ).toBe("host");
    // The host answered, but not in a shape this build reads: the feed's failure.
    expect(
      syncFailureOf(
        new HostError({ kind: "transport", code: "invalid_response", message: "GET /v1/changes" }),
      ),
    ).toBe("feed");
    expect(syncFailureOf(new LocalDbError("statement_failed", "disk full"))).toBe("local");
    expect(syncFailureOf(new SyncFeedError("the host went back twice"))).toBe("feed");
    // Anything the run did not expect is the feed's to explain.
    expect(syncFailureOf(new Error("unexpected"))).toBe("feed");
  });
});
