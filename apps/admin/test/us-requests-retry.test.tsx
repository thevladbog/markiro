import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { makeRequestRetryIntent } from "../src/us/requests/command-intent.js";
import { UsClientError } from "../src/us/client.js";
import {
  requestDetail,
  requestRun,
  requestsFixture,
  renderRequests,
} from "./us-requests-fixtures.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { profile, renderPlanUi } from "./us-plans-fixtures.js";
import { getRequestCopy } from "../src/us/requests/copy.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const key = "20000000-0000-4000-8000-000000000002";
const failed = () =>
  requestRun({
    status: "failed",
    lifecycleVersion: 4,
    completedAt: "2026-10-05T00:00:00.000Z",
    failureCode: "us_request_worker_unknown_failure",
  });

it("a canonically ready retry result clears the pending publication notice", async () => {
  const { client } = await open();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.retry).mockResolvedValue({
    httpRequestId: key,
    runId: failed().runId,
    cycle: 2,
    lifecycleVersion: 5,
    requestedBy: "synthetic-actor",
    idempotencyKey: key,
  });
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({
      status: "ready",
      completedAt: "2026-10-05T00:01:00.000Z",
      lifecycleVersion: 5,
      retryCycle: 2,
    }),
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Retry reason" }), "Checked failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry failed run" }));
  await screen.findByText("Ready");
  expect(screen.queryByText(/publication is still pending/)).toBeNull();
});
it("freezes strict retry body and original lifecycle", () => {
  const intent = makeRequestRetryIntent(requestRun().runId, 4, "Operator checked failure", key);
  expect(intent.body).toEqual({
    expectedLifecycleVersion: 4,
    reason: "Operator checked failure",
    idempotencyKey: key,
  });
  expect(Object.isFrozen(intent.body)).toBe(true);
  expect(() => makeRequestRetryIntent(requestRun().runId, 0, "bad", key)).toThrow();
});
async function open(extra = {}) {
  const client = requestsFixture();
  vi.mocked(client.requests.getRun).mockResolvedValue(failed());
  const ui = renderRequests({
    client,
    canManageQa: true,
    canExport: true,
    entry: { requestId: requestDetail().id, runId: failed().runId },
    ...extra,
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await screen.findByRole("textbox", { name: "Retry reason" });
  return { client, ui };
}
it("replays ambiguous retries with exact key/body despite newer lifecycle and records acceptance separately", async () => {
  const { client } = await open();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.retry)
    .mockRejectedValueOnce(new UsClientError("unavailable"))
    .mockResolvedValue({
      httpRequestId: key,
      runId: failed().runId,
      cycle: 2,
      lifecycleVersion: 5,
      requestedBy: "synthetic-actor",
      idempotencyKey: key,
    });
  await userEvent.type(screen.getByRole("textbox", { name: "Retry reason" }), "Checked failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry failed run" }));
  await screen.findByText(/Retry outcome is unknown/);
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({ lifecycleVersion: 5, retryCycle: 2 }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh selected run" }));
  await waitFor(() => expect(client.requests.getRun).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button", { name: "Replay original retry" }));
  await screen.findByText(/Retry accepted/);
  expect(client.requests.retry).toHaveBeenNthCalledWith(1, failed().runId, {
    expectedLifecycleVersion: 4,
    reason: "Checked failure",
    idempotencyKey: key,
  });
  expect(client.requests.retry).toHaveBeenNthCalledWith(2, failed().runId, {
    expectedLifecycleVersion: 4,
    reason: "Checked failure",
    idempotencyKey: key,
  });
  await waitFor(() => expect(client.requests.getRun).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("Ready")).toBeNull();
});
it("accepted retry retains replay state if canonical read fails and never creates a new response", async () => {
  const { client } = await open();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
  vi.mocked(client.requests.retry).mockResolvedValue({
    httpRequestId: key,
    runId: failed().runId,
    cycle: 2,
    lifecycleVersion: 5,
    requestedBy: "synthetic-actor",
    idempotencyKey: key,
  });
  vi.mocked(client.requests.getRun).mockRejectedValue(new UsClientError("unavailable"));
  await userEvent.type(screen.getByRole("textbox", { name: "Retry reason" }), "Checked failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry failed run" }));
  await screen.findByText(/Retry accepted/);
  expect(screen.getByRole("button", { name: "Replay original retry" })).toBeTruthy();
  expect(client.requests.prepare).not.toHaveBeenCalled();
  expect(client.requests.validate).not.toHaveBeenCalled();
  expect(screen.queryByText("Ready")).toBeNull();
});
it("recognized retry conflict is a rejection with explicit refresh, not an unknown success", async () => {
  const { client } = await open();
  vi.mocked(client.requests.retry).mockRejectedValue(
    new UsClientError("us_request_worker_retry_conflict"),
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Retry reason" }), "Checked failure");
  await userEvent.click(screen.getByRole("button", { name: "Retry failed run" }));
  await screen.findByText(/original retry was rejected/);
  expect(screen.queryByText(/Retry outcome is unknown/)).toBeNull();
  expect(client.requests.getRun).toHaveBeenCalledTimes(1);
  expect(client.requests.prepare).not.toHaveBeenCalled();
});
it.each([{ canManageQa: false }, { canExport: false }])(
  "current capability denies retry %j",
  async (extra) => {
    const { client } = await open(extra);
    expect(
      (screen.getByRole("button", { name: "Retry failed run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.requests.retry).not.toHaveBeenCalled();
  },
);
it("a different session actor cannot retry even with current capabilities", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.getRun).mockResolvedValue(failed());
  vi.mocked(client.session).mockResolvedValue({
    user: { id: "other-actor", name: "Other", email: "other@example.test", twoFactorEnabled: true },
    activeOrganizationId: "tenant",
  });
  renderRequests({
    client,
    canManageQa: true,
    canExport: true,
    entry: { requestId: requestDetail().id, runId: failed().runId },
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  expect(
    ((await screen.findByRole("button", { name: "Retry failed run" })) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(client.requests.retry).not.toHaveBeenCalled();
});
it.each(["en-US", "es-US"])(
  "real outer %s exit cancel retains original retry body/key",
  async (locale) => {
    const client = requestsFixture();
    const copy = getRequestCopy(locale);
    vi.mocked(client.requests.getRun).mockResolvedValue(failed());
    vi.mocked(client.requests.listRuns).mockResolvedValue({
      items: [failed()],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
    vi.spyOn(client, "access").mockResolvedValue({
      capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
    });
    vi.mocked(client.requests.retry).mockRejectedValue(new UsClientError("unavailable"));
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    renderPlanUi(
      <MasterDataWorkspace
        client={client}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={vi.fn()}
        onSessionLost={vi.fn()}
      />,
      locale,
    );
    await userEvent.click(await screen.findByRole("button", { name: copy.title }));
    await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
    await userEvent.click(screen.getByRole("tab", { name: copy.packageTab }));
    await userEvent.click(screen.getByRole("button", { name: copy.loadRuns }));
    await userEvent.click(
      await screen.findByRole("button", { name: `${copy.openRun} ${failed().runId}` }),
    );
    await userEvent.type(
      await screen.findByRole("textbox", { name: copy.retryReason }),
      "Checked failure",
    );
    await userEvent.click(screen.getByRole("button", { name: copy.retryRun }));
    await screen.findByText(copy.retryAmbiguous);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(
      screen.getByRole("button", { name: locale === "en-US" ? "Parties" : "Partes" }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(locale === "en-US" ? "retry key and body" : "un reintento"),
    );
    await userEvent.click(screen.getByRole("button", { name: copy.replayRetry }));
    await screen.findByText(copy.retryAmbiguous);
    const body = { expectedLifecycleVersion: 4, reason: "Checked failure", idempotencyKey: key };
    expect(client.requests.retry).toHaveBeenNthCalledWith(1, failed().runId, body);
    expect(client.requests.retry).toHaveBeenNthCalledWith(2, failed().runId, body);
    expect(uuid).toHaveBeenCalledOnce();
  },
);
