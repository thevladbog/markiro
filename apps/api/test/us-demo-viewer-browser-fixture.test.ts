import { createServer } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import * as fixture from "./support/us-demo-viewer-browser-fixture";

describe("viewer browser failure-only boundaries", () => {
  it("keeps dependent browser normal order while held context does not block independent cleanup or cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const calls: string[] = [];
    let failContext!: () => void, drained!: () => void;
    const server = {
      close: async () => {
        calls.push("server");
      },
    };
    const browser = {
      close: async () => {
        calls.push("client");
      },
    };
    const context = {
      close: () => {
        calls.push("context");
        return new Promise<void>((_, reject) => {
          failContext = () => reject(new Error("sentinel-private"));
        });
      },
    };
    const owner = fixture.viewerOwnedShutdown({
      normal: () => fixture.closeViewerBrowserSession(server, context, browser),
      terminate: () => {
        calls.push("owned-kill");
        failContext();
        drained();
      },
      kill: () => {
        calls.push("owned-kill-again");
      },
      drained: new Promise<void>((done) => {
        drained = done;
      }),
    });
    const close = fixture
      .disposeViewerBrowserResources([
        { phase: "browser", dispose: owner },
        {
          phase: "vite",
          dispose: () => {
            calls.push("vite");
          },
        },
        {
          phase: "application",
          dispose: () => {
            calls.push("api");
          },
        },
        {
          phase: "installation",
          dispose: () => {
            calls.push("installation");
          },
        },
      ])
      .catch((error: unknown) => error);
    try {
      expect(calls).toEqual(["context", "vite", "api"]);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(calls).toEqual([
        "context",
        "vite",
        "api",
        "owned-kill",
        "client",
        "server",
        "installation",
      ]);
      expect(await close).toBeInstanceOf(AggregateError);
      expect(inspect(await close)).not.toContain("sentinel-private");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a same-tick late handle before the timer callback can run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const cancel = vi.fn(),
      close = vi.fn(async () => {});
    const owner = new fixture.ViewerSetupDeadline(cancel);
    let release!: () => void;
    const work = owner.run(
      "browser",
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
      close,
    );
    const failed = expect(work).rejects.toThrow("browser");
    await Promise.resolve();
    const clock = vi.spyOn(performance, "now").mockReturnValue(60_000);
    try {
      release();
      await failed;
      await owner.drain();
      expect(close).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("fails a pending native initialize at its single 900000 cap without restoring setup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = new fixture.ViewerSetupDeadline(() => {});
    let release!: () => void;
    const work = owner.initialize(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const failed = expect(work).rejects.toThrow("initialize");
    try {
      await vi.advanceTimersByTimeAsync(900_000);
      await failed;
      expect(() => owner.remaining()).toThrow();
      release();
      await owner.drain();
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("late owner shutdown uses the existing disposal deadline instead of resetting it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const end = performance.now() + 60_000;
    let drain!: () => void;
    const calls: string[] = [];
    const close = fixture.viewerOwnedShutdown(
      {
        normal: () => {
          calls.push("normal");
        },
        terminate: () => {
          calls.push("TERM");
        },
        kill: () => {
          calls.push("KILL");
        },
        drained: new Promise<void>((done) => {
          drain = done;
        }),
      },
      () => end,
    );
    try {
      await vi.advanceTimersByTimeAsync(49_000);
      const failed = expect(close()).rejects.toThrow("disposal");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual(["normal", "TERM"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toEqual(["normal", "TERM", "KILL"]);
      drain();
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
  it("latches common setup expiry, cancels once, closes late acquisition and forbids next stage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const cancel = vi.fn(),
      close = vi.fn(async () => {}),
      next = vi.fn();
    let release!: (value: { close(): Promise<void> }) => void;
    const owner = new fixture.ViewerSetupDeadline(cancel);
    const work = owner.run(
      "installation",
      () =>
        new Promise<{ close(): Promise<void> }>((done) => {
          release = done;
        }),
      (value) => value.close(),
    );
    const failed = expect(work).rejects.toThrow("installation");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(cancel).toHaveBeenCalledTimes(1);
      await expect(owner.run("application", async () => next())).rejects.toThrow();
      release({ close });
      await owner.drain();
      owner.stop();
      expect(close).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("observes late rejection and same-tick fulfillment without leaking original errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      for (const rejectLate of [false, true]) {
        const owner = new fixture.ViewerSetupDeadline(() => {});
        let settle!: () => void;
        const close = vi.fn(async () => {});
        const work = owner.run(
          "browser",
          () =>
            new Promise<object>((resolve, reject) => {
              settle = () => (rejectLate ? reject(new Error("sentinel-private")) : resolve({}));
            }),
          close,
        );
        const caught = work.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        settle();
        await owner.drain();
        expect(inspect(await caught)).not.toContain("sentinel-private");
        expect(close).toHaveBeenCalledTimes(rejectLate ? 0 : 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("charges one common budget and only one bounded native initialize pause", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = new fixture.ViewerSetupDeadline(() => {});
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      let release!: () => void;
      const initialization = owner.initialize(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      );
      await vi.advanceTimersByTimeAsync(800_000);
      release();
      await initialization;
      expect(owner.remaining()).toBe(50_000);
      await expect(owner.initialize(async () => {})).rejects.toThrow("initialize");
      expect(() => owner.finish()).toThrow();
    } finally {
      owner.stop();
      vi.useRealTimers();
    }
  });
  it("attempts all independent closers and retains late dependency cleanup after disposal deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const installation = vi.fn(),
      other = vi.fn(() => {
        throw new Error("sentinel-private");
      });
    const closing = fixture.disposeViewerBrowserResources([
      { phase: "context", dispose: () => pending },
      { phase: "vite", dispose: other },
      { phase: "installation", dispose: installation },
    ]);
    const caught = closing.catch((error: unknown) => error);
    try {
      expect(other).toHaveBeenCalledTimes(1);
      expect(installation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inspect(await caught)).toContain("disposal incomplete");
      expect(installation).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(installation).toHaveBeenCalledTimes(1);
      expect(inspect(await caught)).not.toContain("sentinel-private");
    } finally {
      release();
      vi.useRealTimers();
    }
  });
  it("uses exact owned normal TERM KILL order once, drains before installation and permanently fails force", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const calls: string[] = [];
    let drain!: () => void;
    const close = fixture.viewerOwnedShutdown({
      normal: () => {
        calls.push("normal");
      },
      terminate: () => {
        calls.push("TERM");
      },
      kill: () => {
        calls.push("KILL");
      },
      drained: new Promise<void>((done) => {
        drain = done;
      }),
    });
    const first = close();
    expect(close()).toBe(first);
    const caught = first.catch((error: unknown) => error);
    const installation = vi.fn();
    const disposal = fixture
      .disposeViewerBrowserResources([
        { phase: "browser", dispose: close },
        { phase: "installation", dispose: installation },
      ])
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(55_000);
      expect(calls).toEqual(["normal", "TERM", "KILL"]);
      expect(installation).not.toHaveBeenCalled();
      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(await caught).toBeInstanceOf(Error);
      expect(await disposal).toBeInstanceOf(AggregateError);
      expect(installation).toHaveBeenCalledTimes(1);
    } finally {
      drain();
      vi.useRealTimers();
    }
  });
  it("starts independent cleanup even when an earlier owned close remains pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const next = vi.fn();
    const closing = fixture.disposeViewerBrowserResources([
      { phase: "context", dispose: () => pending },
      { phase: "vite", dispose: next },
    ]);
    try {
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await closing;
    }
  });
  it.each([
    ["amended", "2026-06-10", "Amended · Jun 10, 2026"],
    ["void", "2026-08-10", "Void · Aug 10, 2026"],
  ] as const)(
    "matches exact combined %s history node and rejects wrong historical identity",
    (status, eventDate, text) => {
      const expected: fixture.ViewerHistoryExpectation = {
        eventId: "a0000000-0000-4000-8000-000000000001",
        rootId: "a0000000-0000-4000-8000-000000000001",
        type: "receiving",
        eventNumber: "REC-26-0001",
        revision: 1,
        status,
        eventDate,
        previousRevisionId: null,
        nextRevisionId: status === "amended" ? "a0000000-0000-4000-8000-000000000002" : null,
      };
      const row = {
        ...expected,
        reason: "Synthetic history",
        createdAt: "2026-10-22T00:00:00.000Z",
      };
      const page = { items: [row], nextCursor: null };
      expect(fixture.viewerHistoryPresentation(page, expected)).toEqual({
        eventLabel: "Event REC-26-0001 · rev 1",
        statusDate: text,
      });
      for (const wrong of [
        { eventId: "b0000000-0000-4000-8000-000000000001" },
        { rootId: "b0000000-0000-4000-8000-000000000001" },
        { revision: 2 },
        { status: "draft" },
        { eventDate: "2026-06-09" },
        { eventNumber: "REC-26-0002" },
      ])
        expect(() =>
          fixture.viewerHistoryPresentation({ ...page, items: [{ ...row, ...wrong }] }, expected),
        ).toThrow();
      expect(() =>
        fixture.viewerHistoryPresentation({ ...page, items: [row, row] }, expected),
      ).toThrow();
      expect(() => fixture.viewerHistoryPresentation({ ...page, items: [] }, expected)).toThrow();
    },
  );
  it("drops auth call logs, causes, DOM, hostile getters and unknown phase values", async () => {
    const secret = "sentinel-password-token-factor";
    for (const error of [
      new Error(`fill(${secret})`, { cause: secret }),
      {
        get message() {
          throw new Error(secret);
        },
      },
      secret,
    ]) {
      let caught: unknown;
      try {
        await fixture.viewerBrowserPhase("authentication", async () => {
          throw error;
        });
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Viewer browser failed: authentication");
      expect(inspect(caught, { depth: 10 })).not.toContain(secret);
      expect(Object.hasOwn(caught as Error, "cause")).toBe(false);
    }
    expect(fixture.viewerBrowserFailure(secret).message).toBe("Viewer browser failed: unknown");
  });

  it("continues every owned disposal boundary and emits only finite failures", async () => {
    for (let failed = 0; failed < 6; failed++) {
      const closed: string[] = [];
      const phases = [
        "context",
        "browser",
        "vite",
        "application",
        "private-stores",
        "installation",
      ] as const;
      const stages = phases.map((phase, index) => ({
        phase,
        async dispose() {
          closed.push(phase);
          if (index === failed) throw new Error("sentinel-private");
        },
      }));
      let failure: unknown;
      try {
        await fixture.disposeViewerBrowserResources(stages);
      } catch (error) {
        failure = error;
      }
      expect(closed).toEqual(phases);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(inspect(failure, { depth: 10 })).not.toContain("sentinel-private");
    }
  });

  it("refuses before import/acquisition/listen when actual CI identity is absent", async () => {
    vi.stubEnv("CI", "false");
    try {
      await expect(fixture.startUsDemoViewerBrowserFixture()).rejects.toThrow(
        "us_demo_viewer_ci_only",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses an occupied invocation-owned ephemeral port without closing its owner", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Owned ephemeral address missing");
      await expect(fixture.requireViewerFreePort(address.port, "127.0.0.1")).rejects.toThrow(
        "Viewer browser failed: ports",
      );
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(server.listening).toBe(false);
  });
});
