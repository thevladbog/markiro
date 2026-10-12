import { afterEach, expect, it, vi } from "vitest";
import { startRequestPolling } from "../src/us/requests/polling.js";
import {
  deferred,
  requestRun,
  requestDetail,
  requestsFixture,
  renderRequests,
} from "./us-requests-fixtures.js";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { UsClientError } from "../src/us/client.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(extra: Partial<Parameters<typeof startRequestPolling>[0]> = {}) {
  vi.useFakeTimers();
  const options = {
    read: vi.fn(async () => requestRun()),
    onValue: vi.fn(),
    onPause: vi.fn(),
    onError: vi.fn(() => "transient" as const),
    owns: () => true,
    isVisible: () => true,
    now: () => Date.now(),
    ...extra,
  };
  return { options, poll: startRequestPolling(options) };
}
it("rejects a late response after stop", async () => {
  const pending = deferred<ReturnType<typeof requestRun>>();
  const { poll, options } = setup({ read: () => pending.promise });
  await vi.advanceTimersByTimeAsync(2000);
  poll.stop();
  pending.resolve(requestRun());
  await Promise.resolve();
  expect(options.onValue).not.toHaveBeenCalled();
});
it("waits two seconds after each completion without overlapping reads", async () => {
  const pending = deferred<ReturnType<typeof requestRun>>();
  const read = vi.fn(() => pending.promise);
  const { poll } = setup({ read });
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(requestRun());
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  poll.stop();
});
it.each(["hidden", "authority"] as const)("stops before reading on %s", async (reason) => {
  const { options } = setup({
    isVisible: () => reason !== "hidden",
    owns: () => reason !== "authority",
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(options.read).not.toHaveBeenCalled();
  expect(options.onPause).toHaveBeenCalledWith(reason);
});
it("stops exactly at the third consecutive error, with success resetting the count", async () => {
  const read = vi
    .fn(async () => requestRun())
    .mockRejectedValueOnce(1)
    .mockRejectedValueOnce(2)
    .mockResolvedValueOnce(requestRun())
    .mockRejectedValue(3);
  const { options } = setup({ read });
  await vi.advanceTimersByTimeAsync(12000);
  expect(read).toHaveBeenCalledTimes(6);
  expect(options.onValue).toHaveBeenCalledTimes(1);
  expect(options.onPause).toHaveBeenCalledWith("errors");
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(6);
});
it("stops on a mapped authority error without consuming the transient allowance", async () => {
  const { options } = setup({
    read: async () => {
      throw 1;
    },
    onError: () => "stop",
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(options.onPause).toHaveBeenCalledWith("authority");
});
it("pauses at five minutes and an explicit restart gets a new window", async () => {
  const { options } = setup();
  await vi.advanceTimersByTimeAsync(300000);
  expect(options.read).toHaveBeenCalledTimes(149);
  expect(options.onPause).toHaveBeenCalledWith("budget");
  const resumed = startRequestPolling(options);
  await vi.advanceTimersByTimeAsync(2000);
  expect(options.read).toHaveBeenCalledTimes(150);
  resumed.stop();
});
it("publishes a terminal result once and stops", async () => {
  const { options } = setup({
    read: async () => requestRun({ status: "ready", completedAt: "2026-10-05T00:00:00.000Z" }),
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(options.onValue).toHaveBeenCalledTimes(1);
  expect(options.onPause).toHaveBeenCalledWith("terminal");
});
it("the selected view stops a deferred poll on unmount and never polls history rows", async () => {
  vi.useFakeTimers();
  const client = requestsFixture();
  const pending = deferred<ReturnType<typeof requestRun>>();
  vi.mocked(client.requests.getRun)
    .mockResolvedValueOnce(requestRun())
    .mockReturnValue(pending.promise);
  let unmount = () => {};
  await act(async () => {
    unmount = renderRequests({
      client,
      entry: { requestId: requestDetail().id, runId: requestRun().runId },
    }).unmount;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(client.requests.getRun).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(client.requests.getRun).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => pending.resolve(requestRun()));
  expect(client.requests.listRuns).not.toHaveBeenCalled();
  expect(vi.mocked(client.requests.getRun).mock.calls[1]?.[1]?.aborted).toBe(true);
});
it("hidden view aborts a read and requires explicit visible resume", async () => {
  vi.useFakeTimers();
  const client = requestsFixture();
  const pending = deferred<ReturnType<typeof requestRun>>();
  vi.mocked(client.requests.getRun)
    .mockResolvedValueOnce(requestRun())
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(requestRun());
  await act(async () => {
    renderRequests({ client, entry: { requestId: requestDetail().id, runId: requestRun().runId } });
  });
  fireEvent.click(screen.getByRole("tab", { name: "Package" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () =>
    pending.resolve(requestRun({ status: "ready", completedAt: "2026-10-05T00:00:00.000Z" })),
  );
  expect(screen.queryByText("Ready")).toBeNull();
  expect(vi.mocked(client.requests.getRun).mock.calls[1]?.[1]?.aborted).toBe(true);
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(client.requests.getRun).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Resume automatic updates" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(client.requests.getRun).toHaveBeenCalledTimes(3);
});
it("a polling session rejection stops reads and clears saved projections", async () => {
  vi.useFakeTimers();
  const client = requestsFixture();
  vi.mocked(client.requests.getRun)
    .mockResolvedValueOnce(requestRun())
    .mockRejectedValue(new UsClientError("session_required"));
  const onSessionLost = vi.fn();
  await act(async () => {
    renderRequests({
      client,
      onSessionLost,
      entry: { requestId: requestDetail().id, runId: requestRun().runId },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(onSessionLost).toHaveBeenCalledOnce();
  expect(screen.queryByRole("table")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(client.requests.getRun).toHaveBeenCalledTimes(2);
});
it.each(["budget", "errors", "hidden"] as const)(
  "%s pause survives completed validation until explicit Resume",
  async (reason) => {
    vi.useFakeTimers();
    const client = requestsFixture();
    vi.mocked(client.requests.get).mockResolvedValue(
      requestDetail({ scope: { tlc: "SAVED-TLC" } }),
    );
    if (reason === "errors")
      vi.mocked(client.requests.getRun)
        .mockResolvedValueOnce(requestRun())
        .mockRejectedValue(new UsClientError("unavailable"));
    await act(async () => {
      renderRequests({
        client,
        canManageQa: true,
        canExport: true,
        entry: { requestId: requestDetail().id, runId: requestRun().runId },
      });
    });
    fireEvent.click(screen.getByRole("tab", { name: "Package" }));
    let show = () => {};
    if (reason === "hidden") {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      fireEvent(document, new Event("visibilitychange"));
      show = () => {
        visibility.mockReturnValue("visible");
        fireEvent(document, new Event("visibilitychange"));
      };
    } else
      await act(async () => {
        await vi.advanceTimersByTimeAsync(reason === "budget" ? 300000 : 6000);
      });
    expect(screen.getByRole("button", { name: "Resume automatic updates" })).toBeTruthy();
    const reads = vi.mocked(client.requests.getRun).mock.calls.length;
    vi.mocked(client.requests.getRun).mockResolvedValue(requestRun());
    fireEvent.click(screen.getByRole("tab", { name: "Validation" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
    });
    expect(client.requests.validate).toHaveBeenCalledOnce();
    expect(screen.getByText("Fresh validation of captured request revision")).toBeTruthy();
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(client.requests.getRun).toHaveBeenCalledTimes(reads);
    fireEvent.click(screen.getByRole("tab", { name: "Package" }));
    expect(
      (screen.getByRole("button", { name: "Resume automatic updates" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Resume automatic updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(client.requests.getRun).toHaveBeenCalledTimes(reads + 1);
  },
);
it.each(["refresh", "selection"] as const)(
  "an explicit %s clears a stopped window and polls the owned selected run",
  async (action) => {
    vi.useFakeTimers();
    const client = requestsFixture();
    vi.mocked(client.requests.getRun)
      .mockResolvedValueOnce(requestRun())
      .mockRejectedValue(new UsClientError("unavailable"));
    let ui: ReturnType<typeof renderRequests> | null = null;
    await act(async () => {
      ui = renderRequests({
        client,
        entry: { requestId: requestDetail().id, runId: requestRun().runId },
      });
    });
    fireEvent.click(screen.getByRole("tab", { name: "Package" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.getByRole("button", { name: "Resume automatic updates" })).toBeTruthy();
    const nextRun = requestRun({ runId: "b0000000-0000-4000-8000-000000000003" });
    vi.mocked(client.requests.getRun).mockResolvedValue(
      action === "selection" ? nextRun : requestRun(),
    );
    await act(async () => {
      if (action === "refresh")
        fireEvent.click(screen.getByRole("button", { name: "Refresh selected run" }));
      else ui?.rerenderRequests({ entry: { requestId: requestDetail().id, runId: nextRun.runId } });
    });
    expect(screen.queryByRole("button", { name: "Resume automatic updates" })).toBeNull();
    const reads = vi.mocked(client.requests.getRun).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(client.requests.getRun).toHaveBeenCalledTimes(reads + 1);
    expect(client.requests.getRun).toHaveBeenLastCalledWith(
      action === "selection" ? nextRun.runId : requestRun().runId,
      expect.any(AbortSignal),
    );
  },
);
