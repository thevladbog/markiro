import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { makeRequestPrepareIntent } from "../src/us/requests/command-intent.js";
import { UsClientError, createUsBrowserClient } from "../src/us/client.js";
import {
  deferred,
  renderRequests,
  requestDetail,
  requestRun,
  requestValidation,
  requestsFixture,
} from "./us-requests-fixtures.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const key = "20000000-0000-4000-8000-000000000002";
const body = {
  mode: "export_ready",
  expectedRevision: 1,
  validationDigest: "b".repeat(64),
  idempotencyKey: key,
};
const receipt = {
  httpRequestId: key,
  requestId: requestDetail().id,
  requestRevision: 1,
  runId: requestRun().runId,
  runRevision: 1,
  mode: "export_ready" as const,
  idempotencyKey: key,
  scopedContentDigest: "b".repeat(64),
};
it("freezes the original prepare body for ambiguous replay", () => {
  const intent = makeRequestPrepareIntent(
    "10000000-0000-4000-8000-000000000001",
    3,
    "a".repeat(64),
    "available_records_incomplete",
    key,
  );
  expect(intent.body).toEqual({
    mode: "available_records_incomplete",
    expectedRevision: 3,
    validationDigest: "a".repeat(64),
    idempotencyKey: key,
  });
  expect(Object.isFrozen(intent.body)).toBe(true);
  expect(() =>
    makeRequestPrepareIntent(requestDetail().id, 0, "bad", "export_ready", "bad"),
  ).toThrow();
});
async function ready(client = requestsFixture()) {
  vi.mocked(client.requests.get).mockResolvedValue(requestDetail({ scope: { tlc: "SAVED-TLC" } }));
  const ui = renderRequests({
    client,
    canManageQa: true,
    canExport: true,
    entry: { requestId: requestDetail().id },
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Validation" }));
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await userEvent.click(screen.getByRole("tab", { name: "Package" }));
  return ui;
}
it.each(["pending", "export"])(
  "accepted Prepare canonical read cannot escape a %s authority generation",
  async (transition) => {
    const client = requestsFixture();
    const read = deferred<ReturnType<typeof requestRun>>();
    vi.mocked(client.requests.prepare).mockResolvedValue(receipt);
    vi.mocked(client.requests.getRun)
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue(requestRun());
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    const ui = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
    await screen.findByText("Accepted, refresh required.");
    if (transition === "pending") {
      ui.rerenderRequests({ authorityPending: true });
      ui.rerenderRequests({ authorityPending: false });
    } else {
      ui.rerenderRequests({ canExport: false });
      ui.rerenderRequests({ canExport: true });
    }
    await act(async () => read.resolve(requestRun()));
    expect(ui.props.onEntryChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Frozen run" })).toBeNull();
    expect(screen.getByText("Accepted, refresh required.")).toBeTruthy();
    expect(ui.props.onDirtyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
    await waitFor(() =>
      expect(ui.props.onEntryChange).toHaveBeenCalledWith({
        requestId: receipt.requestId,
        runId: receipt.runId,
      }),
    );
    expect(client.requests.prepare).toHaveBeenNthCalledWith(1, receipt.requestId, body);
    expect(client.requests.prepare).toHaveBeenNthCalledWith(2, receipt.requestId, body);
    expect(client.requests.getRun).toHaveBeenCalledTimes(2);
    expect(uuid).toHaveBeenCalledOnce();
  },
);
it("guards double click before key allocation and selects only the receipt's canonically verified run", async () => {
  const client = requestsFixture();
  const send = deferred<typeof receipt>();
  vi.mocked(client.requests.prepare).mockReturnValue(send.promise);
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  const ui = await ready(client);
  const prepare = screen.getByRole("button", { name: "Prepare Export-ready response" });
  fireEvent.click(prepare);
  fireEvent.click(prepare);
  expect(uuid).toHaveBeenCalledOnce();
  expect(client.requests.prepare).toHaveBeenCalledWith(receipt.requestId, body);
  await act(async () => send.resolve(receipt));
  await waitFor(() =>
    expect(ui.props.onEntryChange).toHaveBeenCalledWith({
      requestId: receipt.requestId,
      runId: receipt.runId,
    }),
  );
  expect(client.requests.getRun).toHaveBeenCalledWith(receipt.runId);
  expect(client.requests.listRuns).not.toHaveBeenCalled();
});
it.each(["unavailable", "invalid_response"] as const)(
  "replays exact body after %s despite refreshed closed revision and changed digest",
  async (code) => {
    const client = requestsFixture();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    vi.mocked(client.requests.prepare)
      .mockRejectedValueOnce(new UsClientError(code))
      .mockResolvedValue(receipt);
    const ui = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
    await screen.findByText(/outcome is unknown/);
    vi.mocked(client.requests.get).mockResolvedValue(
      requestDetail({
        revision: 2,
        status: "closed",
        closedAt: "2026-10-05T01:00:00.000Z",
        lastValidatedAt: "2026-10-05T00:00:00.000Z",
        savedValidation: {
          digest: "c".repeat(64),
          validatedAt: "2026-10-05T00:00:00.000Z",
          matchedRevisionCount: 0,
          findings: [],
          freshness: "not_rechecked",
        },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
    await screen.findByText("2");
    await userEvent.click(screen.getByRole("tab", { name: "Package" }));
    await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
    await waitFor(() =>
      expect(ui.props.onEntryChange).toHaveBeenCalledWith({
        requestId: receipt.requestId,
        runId: receipt.runId,
      }),
    );
    expect(client.requests.prepare).toHaveBeenNthCalledWith(1, receipt.requestId, body);
    expect(client.requests.prepare).toHaveBeenNthCalledWith(2, receipt.requestId, body);
    expect(client.requests.validate).toHaveBeenCalledTimes(1);
  },
);
it("retains accepted key if canonical run fails and replay does not infer latest history", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockResolvedValue(receipt);
  vi.mocked(client.requests.getRun)
    .mockRejectedValueOnce(new UsClientError("unavailable"))
    .mockResolvedValue(requestRun());
  const ui = await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText("Accepted, refresh required.");
  expect(ui.props.onEntryChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
  await waitFor(() =>
    expect(ui.props.onEntryChange).toHaveBeenCalledWith({
      requestId: receipt.requestId,
      runId: receipt.runId,
    }),
  );
  expect(client.requests.prepare).toHaveBeenNthCalledWith(2, receipt.requestId, body);
});
it("conflict leaves explicit recovery, no automatic validation or new key; abandoning requires confirmation", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockRejectedValue(
    new UsClientError("us_request_validation_stale"),
  );
  const ui = await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText(/saved revision changed/i);
  expect(client.requests.validate).toHaveBeenCalledTimes(1);
  expect(client.requests.prepare).toHaveBeenCalledTimes(1);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: "Start a new response" }));
  expect(screen.getByRole("button", { name: "Replay original preparation" })).toBeTruthy();
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Start a new response" }));
  expect(ui.props.onDirtyChange).toHaveBeenLastCalledWith(false);
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it.each([{ scopedContentDigest: "c".repeat(64) }, { requestRevision: 2 }, { runId: "invalid" }])(
  "an invalid success receipt retains the exact original intent %j",
  async (extra) => {
    const client = requestsFixture();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    vi.mocked(client.requests.prepare).mockResolvedValue({ ...receipt, ...extra });
    await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
    await screen.findByText(/outcome is unknown/);
    expect(screen.getByRole("button", { name: "Replay original preparation" })).toBeTruthy();
    expect(client.requests.getRun).not.toHaveBeenCalled();
  },
);
it.each([{ canExport: false }, { canManageQa: false }, { authorityPending: true }])(
  "current authority blocks replay %j",
  async (extra) => {
    const client = requestsFixture();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError("unavailable"));
    const ui = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
    await screen.findByText(/outcome is unknown/);
    ui.rerenderRequests(extra);
    await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
    expect(client.requests.prepare).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { build: "unknown", packageStorage: "configured" },
  { build: "available", packageStorage: "unconfigured" },
] as const)("current request availability blocks original replay %j", async (availability) => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError("unavailable"));
  await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText(/outcome is unknown/);
  vi.mocked(client.requests.get).mockResolvedValue(requestDetail({ availability }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await screen.findByText(
    availability.build === "unknown"
      ? /verified available request build/
      : /Configured request package storage/,
  );
  expect(
    (screen.getByRole("button", { name: "Replay original preparation" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("unknown preparation navigation guard explains memory-only loss and does not silently replace intent", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError("unavailable"));
  const ui = await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText(/outcome is unknown/);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: "New request" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("not durable"));
  expect(ui.props.onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("button", { name: "Replay original preparation" })).toBeTruthy();
});
it("a new response allocates a new key only after explicit abandonment and fresh validation", async () => {
  const client = requestsFixture();
  const nextKey = "20000000-0000-4000-8000-000000000003";
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(key).mockReturnValueOnce(nextKey);
  vi.mocked(client.requests.prepare)
    .mockRejectedValueOnce(new UsClientError("unavailable"))
    .mockResolvedValue({ ...receipt, idempotencyKey: nextKey });
  await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText(/outcome is unknown/);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Start a new response" }));
  expect(uuid).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("tab", { name: "Validation" }));
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await userEvent.click(screen.getByRole("tab", { name: "Package" }));
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  expect(uuid).toHaveBeenCalledTimes(2);
  expect(client.requests.prepare).toHaveBeenNthCalledWith(2, receipt.requestId, {
    ...body,
    idempotencyKey: nextKey,
  });
});
it("a mismatched canonical run does not select the receipt or clear accepted replay", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockResolvedValue(receipt);
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({ scopedContentDigest: "c".repeat(64) }),
  );
  const ui = await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText("Accepted, refresh required.");
  expect(ui.props.onEntryChange).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Replay original preparation" })).toBeTruthy();
});
it("a failed authority refresh on preparation denial blocks replay without sending another command", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError("forbidden"));
  const ui = await ready(client);
  ui.rerenderRequests({
    onForbidden: vi.fn(async () => {
      throw new Error("failed refresh");
    }),
  });
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Replay original preparation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  expect(client.requests.prepare).toHaveBeenCalledTimes(1);
});
it("renders the real JSON deadline as ambiguous and replays the identical frozen transport body", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  const send = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      async (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Deadline")), {
            once: true,
          });
        }),
    )
    .mockResolvedValue(Response.json(receipt));
  vi.mocked(client.requests.prepare).mockImplementation(
    createUsBrowserClient(send).requests.prepare,
  );
  await ready(client);
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByText(/outcome is unknown/)).toBeTruthy();
  vi.useRealTimers();
  await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
  await waitFor(() => expect(client.requests.getRun).toHaveBeenCalledWith(receipt.runId));
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(body);
  expect(send.mock.calls[1]?.[1]?.body).toBe(send.mock.calls[0]?.[1]?.body);
});
it("an ambiguous actual HTTP 500 remains an unresolved original command without exposing server text", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message: "SENSITIVE SERVER DETAIL" }, { status: 500 }));
  vi.mocked(client.requests.prepare).mockImplementation(
    createUsBrowserClient(send).requests.prepare,
  );
  await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await screen.findByText(/outcome is unknown/);
  expect(screen.queryByText("SENSITIVE SERVER DETAIL")).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Replay original preparation" })).toBeTruthy();
});
it("zero matched revisions submit only the explicit incomplete mode and select its canonical receipt", async () => {
  const client = requestsFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.validate).mockResolvedValue(
    requestValidation({ matchedRevisionCount: 0 }),
  );
  vi.mocked(client.requests.prepare).mockResolvedValue({
    ...receipt,
    mode: "available_records_incomplete",
  });
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({ mode: "available_records_incomplete" }),
  );
  const ui = await ready(client);
  await userEvent.click(screen.getByRole("button", { name: "Prepare incomplete response" }));
  await waitFor(() =>
    expect(ui.props.onEntryChange).toHaveBeenCalledWith({
      requestId: receipt.requestId,
      runId: receipt.runId,
    }),
  );
  expect(client.requests.prepare).toHaveBeenCalledWith(receipt.requestId, {
    ...body,
    mode: "available_records_incomplete",
  });
});
it.each([
  [
    "us_request_selection_limit",
    "The complete scope exceeds 500 revisions. Narrow the saved scope; no records were trimmed.",
  ],
  [
    "us_request_snapshot_limit",
    "The complete snapshot exceeds 16 MiB. Narrow the saved scope; no evidence was trimmed.",
  ],
] as const)(
  "Prepare %s gives precise ceiling recovery feedback and retains exact replay intent",
  async (code, notice) => {
    const client = requestsFixture();
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError(code));
    const ui = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
    await screen.findByText(notice);
    expect(screen.queryByText(/saved revision changed/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(ui.props.onDirtyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Replay original preparation" }));
    await screen.findByText(notice);
    expect(client.requests.prepare).toHaveBeenNthCalledWith(1, receipt.requestId, body);
    expect(client.requests.prepare).toHaveBeenNthCalledWith(2, receipt.requestId, body);
    expect(client.requests.validate).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledOnce();
  },
);
