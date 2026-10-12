import { cleanup, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RequestRunDetail } from "../src/us/requests/run-detail.js";
import { renderPlanUi } from "./us-plans-fixtures.js";
import {
  deferred,
  requestDetail,
  requestRun,
  requestsFixture,
  renderRequests,
} from "./us-requests-fixtures.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function evidence(term: string) {
  const label = screen.getByText(term, { selector: "dt" });
  const value = label.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error("Missing definition value");
  return value;
}
it.each([
  ["queued", "export_ready", false],
  ["failed", "export_ready", false],
  ["ready", "available_records_incomplete", false],
  ["ready", "export_ready", false],
  ["ready", "export_ready", true],
] as const)(
  "renders independent server Export-ready for %s / %s / %s through locale changes",
  async (status, mode, exportReady) => {
    const client = requestsFixture();
    vi.mocked(client.requests.getRun).mockResolvedValue(
      requestRun({
        status,
        mode,
        exportReady,
        completedAt: status === "queued" ? null : "2026-10-05T00:01:00.000Z",
        failureCode: status === "failed" ? "us_request_package_storage_timeout" : null,
      }),
    );
    const ui = renderRequests({
      client,
      entry: { requestId: requestDetail().id, runId: requestRun().runId },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
    await screen.findByRole("region", { name: "Frozen run" });
    expect(evidence("Server Export-ready").textContent).toBe(exportReady ? "Yes" : "No");
    vi.mocked(client.requests.get).mockResolvedValue(
      requestDetail({ revision: 2, requesterName: "LIVE EDIT" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
    await userEvent.click(screen.getByRole("tab", { name: "Requester and timing" }));
    await screen.findByText("LIVE EDIT");
    await userEvent.click(screen.getByRole("tab", { name: "Package" }));
    const frozen = await screen.findByRole("region", { name: "Frozen run" });
    expect(evidence("Server Export-ready").textContent).toBe(exportReady ? "Yes" : "No");
    expect(within(frozen).getByText("Synthetic Requester")).toBeTruthy();
    expect(within(frozen).queryByText("LIVE EDIT")).toBeNull();
    await act(async () => {
      await ui.instance.changeLanguage("es-US");
    });
    expect(evidence("Lista para exportar según el servidor").textContent).toBe(
      exportReady ? "Sí" : "No",
    );
  },
);
it.each(["en-US", "es-US"])(
  "%s immutable creator and completed system duration include queue time",
  (locale) => {
    renderPlanUi(
      <RequestRunDetail
        run={requestRun({
          status: "ready",
          createdBy: "frozen-creator-id",
          startedAt: "2026-10-05T00:00:00.000Z",
          generationStartedAt: "2026-10-05T00:01:00.000Z",
          completedAt: "2026-10-05T00:01:10.000Z",
        })}
        timeZone="UTC"
        actorId="live-actor"
        canAct={false}
        canDownload={false}
        storageAvailable
        onRetry={async () => {}}
        onDownload={async () => {}}
      />,
      locale,
    );
    expect(evidence(locale === "en-US" ? "Creator ID" : "ID del creador").textContent).toBe(
      "frozen-creator-id",
    );
    expect(
      evidence(
        locale === "en-US" ? "Completed system elapsed" : "Tiempo total del sistema completado",
      ).textContent,
    ).toBe("70000 ms");
    expect(
      evidence(locale === "en-US" ? "Worker elapsed" : "Tiempo de generación").textContent,
    ).toBe("10000 ms");
  },
);
it("owns an active local estimate timer, freezes terminal duration, and disposes on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:02:00.000Z"));
  const props = {
    timeZone: "UTC",
    actorId: null,
    canAct: false,
    canDownload: false,
    storageAvailable: true,
    onRetry: async () => {},
    onDownload: async () => {},
  };
  const ui = renderPlanUi(<RequestRunDetail {...props} run={requestRun()} />);
  expect(evidence("Local running elapsed estimate").textContent).toBe("120000 ms");
  expect(evidence("Worker elapsed").textContent).toBe("Unavailable");
  expect(
    screen.getByText(
      "This running estimate uses this device’s clock; it is not human effort or a completion-time promise.",
    ),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(evidence("Local running elapsed estimate").textContent).toBe("121000 ms");
  ui.rerender(
    <RequestRunDetail
      {...props}
      run={requestRun({ status: "ready", completedAt: "2026-10-05T00:01:30.000Z" })}
    />,
  );
  expect(evidence("Completed system elapsed").textContent).toBe("90000 ms");
  expect(screen.queryByText("Local running elapsed estimate")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(evidence("Completed system elapsed").textContent).toBe("90000 ms");
  ui.rerender(
    <RequestRunDetail
      {...props}
      run={requestRun({ runId: "b0000000-0000-4000-8000-000000000003" })}
    />,
  );
  expect(vi.getTimerCount()).toBe(1);
  ui.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  ["history", "qa"],
  ["history", "export"],
  ["history", "refresh"],
  ["attempts", "qa"],
  ["attempts", "export"],
  ["attempts", "refresh"],
] as const)(
  "releases interrupted %s pending on retained-read %s changes without clearing a newer owner",
  async (kind, transition) => {
    const client = requestsFixture();
    vi.mocked(client.requests.getRun).mockResolvedValue(
      requestRun({ status: "ready", completedAt: "2026-10-05T00:00:00.000Z" }),
    );
    const page = { items: [], limit: 25, offset: 0, hasMore: false };
    const oldRead = deferred<typeof page>();
    const newRead = deferred<typeof page>();
    const method = kind === "history" ? "listRuns" : "listAttempts";
    vi.mocked(client.requests[method])
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const ui = renderRequests({
      client,
      canManageQa: true,
      canExport: true,
      entry: { requestId: requestDetail().id, runId: requestRun().runId },
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
    const label = kind === "history" ? "Load run history" : "Load attempt history";
    await userEvent.click(await screen.findByRole("button", { name: label }));
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    if (transition === "qa") ui.rerenderRequests({ canManageQa: false });
    else if (transition === "export") ui.rerenderRequests({ canExport: false });
    else ui.rerenderRequests({ authorityPending: true });
    if (transition === "qa") ui.rerenderRequests({ canManageQa: true });
    else if (transition === "export") ui.rerenderRequests({ canExport: true });
    else ui.rerenderRequests({ authorityPending: false });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(vi.mocked(client.requests[method]).mock.calls[0]?.[2]?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: label }));
    await act(async () => oldRead.resolve(page));
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    expect(client.requests[method]).toHaveBeenCalledTimes(2);
    await act(async () => newRead.resolve(page));
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
  },
);
it("renders exact frozen identity, digests, scope and unavailable nullable timing", () => {
  const run = requestRun();
  renderPlanUi(
    <RequestRunDetail
      run={run}
      timeZone="America/Los_Angeles"
      actorId={null}
      canAct={false}
      canDownload={false}
      storageAvailable
      onRetry={async () => {}}
      onDownload={async () => {}}
    />,
  );
  expect(screen.getByText("Synthetic Requester")).toBeTruthy();
  expect(screen.getByText(run.commandDigest)).toBeTruthy();
  expect(screen.getByText(run.scopedContentDigest)).toBeTruthy();
  expect(screen.getByText("0001-日本")).toBeTruthy();
  expect(screen.getByText(/Timing is server evidence/)).toBeTruthy();
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(2);
  expect(screen.getByText(/Not verified/)).toBeTruthy();
});
it("pages saved history in server order without enriching rows or exposing contacts", async () => {
  const client = requestsFixture();
  const run = requestRun();
  vi.mocked(client.requests.listRuns).mockResolvedValue({
    items: [run],
    limit: 25,
    offset: 0,
    hasMore: true,
  });
  renderRequests({ client, entry: { requestId: requestDetail().id } });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await userEvent.click(screen.getByRole("button", { name: "Load run history" }));
  await screen.findByRole("button", { name: `Open run ${run.runId}` });
  expect(client.requests.getRun).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Next history page" }));
  await waitFor(() =>
    expect(client.requests.listRuns).toHaveBeenLastCalledWith(
      requestDetail().id,
      { limit: "25", offset: "25" },
      expect.any(AbortSignal),
    ),
  );
  expect(screen.queryByText("actor@example.test")).toBeNull();
});
it("a late selected run cannot replace a newer selection or tenant", async () => {
  const client = requestsFixture();
  const pending = deferred<ReturnType<typeof requestRun>>();
  vi.mocked(client.requests.getRun).mockReturnValue(pending.promise);
  const ui = renderRequests({
    client,
    entry: { requestId: requestDetail().id, runId: requestRun().runId },
  });
  await waitFor(() => expect(client.requests.getRun).toHaveBeenCalled());
  ui.rerenderRequests({ entry: { requestId: requestDetail().id } });
  await act(async () => pending.resolve(requestRun()));
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  expect(screen.queryByRole("region", { name: "Frozen run" })).toBeNull();
});
it("keeps frozen requester facts after a live request revision changes and retains closed history", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.getRun).mockResolvedValue(
    requestRun({
      status: "ready",
      completedAt: "2026-10-05T00:00:00.000Z",
      provenance: "trusted_synthetic",
      missingFiles: [{ name: "plan.pdf", code: "plan_absent" }],
    }),
  );
  renderRequests({
    client,
    canManageQa: true,
    canExport: true,
    entry: { requestId: requestDetail().id, runId: requestRun().runId },
  });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await screen.findByRole("region", { name: "Frozen run" });
  vi.mocked(client.requests.get).mockResolvedValue(
    requestDetail({
      revision: 2,
      requesterName: "Live Edited Requester",
      status: "closed",
      closedAt: "2026-10-05T01:00:00.000Z",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Close request" })).toBeNull());
  expect(screen.getByText("Synthetic Requester")).toBeTruthy();
  expect(screen.queryByText("Live Edited Requester")).toBeNull();
  expect(screen.getByText(/Trusted synthetic provenance/)).toBeTruthy();
  expect(screen.getByText(/plan.pdf: No Plan/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Load run history" })).toBeTruthy();
});
it("pages attempt evidence in server order with cycles, retryability and nullable timestamps", async () => {
  const client = requestsFixture();
  const second = {
    id: "c0000000-0000-4000-8000-000000000002",
    attemptNumber: 2,
    cycle: 2,
    status: "active" as const,
    startedAt: "2026-10-05T00:10:00.000Z",
    finishedAt: null,
    reportRenderedAt: null,
    failureCode: null,
    retryable: false,
  };
  const first = {
    ...second,
    id: "c0000000-0000-4000-8000-000000000001",
    attemptNumber: 1,
    cycle: 1,
    status: "failed" as const,
    startedAt: "2026-10-05T00:00:00.000Z",
    finishedAt: "2026-10-05T00:01:00.000Z",
    failureCode: "us_request_package_storage_timeout" as const,
    retryable: true,
  };
  vi.mocked(client.requests.listAttempts).mockResolvedValue({
    items: [second, first],
    limit: 25,
    offset: 0,
    hasMore: true,
  });
  renderRequests({ client, entry: { requestId: requestDetail().id, runId: requestRun().runId } });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await userEvent.click(await screen.findByRole("button", { name: "Load attempt history" }));
  await screen.findByText(/us_request_package_storage_timeout/);
  const section = screen.getByRole("region", { name: "Attempt history" });
  const rows = section.querySelectorAll("li");
  expect(rows[0]?.textContent).toContain("Attempt count: 2");
  expect(rows[1]?.textContent).toContain("Retry cycle: 1");
  await userEvent.click(screen.getByRole("button", { name: "Next attempt page" }));
  await waitFor(() =>
    expect(client.requests.listAttempts).toHaveBeenLastCalledWith(
      requestRun().runId,
      { limit: "25", offset: "25" },
      expect.any(AbortSignal),
    ),
  );
});
it("old history rows are cleared when the external selected request changes", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.listRuns).mockResolvedValue({
    items: [requestRun()],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  const ui = renderRequests({ client, entry: { requestId: requestDetail().id } });
  await userEvent.click(await screen.findByRole("tab", { name: "Package" }));
  await userEvent.click(screen.getByRole("button", { name: "Load run history" }));
  await screen.findByRole("button", { name: `Open run ${requestRun().runId}` });
  const id = "a0000000-0000-4000-8000-000000000002";
  vi.mocked(client.requests.get).mockResolvedValue(requestDetail({ id, requestNumber: "REQ-2" }));
  ui.rerenderRequests({ entry: { requestId: id } });
  await screen.findByRole("heading", { name: "REQ-2", level: 2 });
  await userEvent.click(screen.getByRole("tab", { name: "Package" }));
  expect(screen.queryByRole("button", { name: `Open run ${requestRun().runId}` })).toBeNull();
});
