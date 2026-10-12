import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createUsBrowserClient, UsClientError } from "../src/us/client.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { profile, renderPlanUi } from "./us-plans-fixtures.js";
import {
  deferred,
  renderRequests,
  requestDetail,
  requestSummary,
  requestsFixture,
} from "./us-requests-fixtures.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function newDraft() {
  await userEvent.click(await screen.findByRole("button", { name: "New request" }));
  change("Request number", "SYNTHETIC-001");
  change("Requester name", "Synthetic requester");
  change("Received at", "2026-10-05T05:00");
}
const receipt = {
  httpRequestId: "b0000000-0000-4000-8000-000000000001",
  requestId: requestSummary().id,
  revision: 2,
  status: "open" as const,
};
it("does not turn a rejected create into a second POST", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
  const client = createUsBrowserClient(send);
  await expect(
    client.requests.create({
      requestNumber: "SYNTHETIC-001",
      requesterName: "Synthetic requester",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: "2026-10-05T12:00:00.123Z",
      scope: null,
    }),
  ).rejects.toBeInstanceOf(UsClientError);
  expect(send).toHaveBeenCalledTimes(1);
});
it("guards rendered double Save and keeps an accepted receipt unresolved until canonical GET succeeds", async () => {
  const client = requestsFixture();
  const send = deferred<typeof receipt>();
  vi.mocked(client.requests.create).mockReturnValue(send.promise);
  vi.mocked(client.requests.get)
    .mockRejectedValueOnce(new UsClientError("unavailable"))
    .mockResolvedValue(requestDetail({ revision: 2, requestNumber: "SYNTHETIC-001" }));
  const ui = renderRequests({ client, canManageQa: true });
  await newDraft();
  const save = screen.getByRole("button", { name: "Save request" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(client.requests.create).toHaveBeenCalledTimes(1);
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => send.resolve(receipt));
  expect(await screen.findByText("Accepted, refresh required.")).toBeTruthy();
  expect(ui.props.onEntryChange).toHaveBeenCalledWith({ requestId: receipt.requestId });
  expect(screen.queryByText("Request saved and current.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Check saved request" }));
  expect(await screen.findByText("Request saved and current.")).toBeTruthy();
  expect(client.requests.create).toHaveBeenCalledTimes(1);
});
it("rejects a canonical receipt read that still has the old revision", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.create).mockResolvedValue(receipt);
  renderRequests({ client, canManageQa: true });
  await newDraft();
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(await screen.findByText("Accepted, refresh required.")).toBeTruthy();
  expect(screen.queryByText("Request saved and current.")).toBeNull();
  expect(client.requests.create).toHaveBeenCalledOnce();
});
it("keeps pending ownership through canonical read and blocks selecting another row", async () => {
  const client = requestsFixture();
  const get = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.create).mockResolvedValue(receipt);
  vi.mocked(client.requests.get).mockReturnValue(get.promise);
  const ui = renderRequests({ client, canManageQa: true });
  await newDraft();
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  await waitFor(() => expect(client.requests.get).toHaveBeenCalled());
  expect((screen.getByRole("button", { name: "REQ-1" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => get.resolve(requestDetail({ revision: 2 })));
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(false);
});
it("keeps the pending mutation's card fence through an authority refresh", async () => {
  const client = requestsFixture();
  const update = deferred<typeof receipt>();
  vi.mocked(client.requests.update).mockReturnValue(update.promise);
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(requestDetail())
    .mockResolvedValue(requestDetail({ revision: 2 }));
  const ui = renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  ui.rerenderRequests({ authorityPending: true });
  ui.rerenderRequests({ authorityPending: false });
  expect(client.requests.get).toHaveBeenCalledOnce();
  await act(async () => update.resolve(receipt));
  expect(await screen.findByText("Request saved and current.")).toBeTruthy();
  expect(client.requests.get).toHaveBeenCalledTimes(2);
});
it("leaves an accepted receipt unresolved while authority refresh is pending", async () => {
  const client = requestsFixture();
  const update = deferred<typeof receipt>();
  vi.mocked(client.requests.update).mockReturnValue(update.promise);
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(requestDetail())
    .mockResolvedValue(requestDetail({ revision: 2 }));
  const ui = renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  ui.rerenderRequests({ authorityPending: true });
  await act(async () => update.resolve(receipt));
  expect(client.requests.get).toHaveBeenCalledOnce();
  expect(screen.queryByText("Request saved and current.")).toBeNull();
  ui.rerenderRequests({ authorityPending: false });
  await userEvent.click(await screen.findByRole("button", { name: "Check saved request" }));
  expect(await screen.findByText("Request saved and current.")).toBeTruthy();
});
it("keeps dirty row-selection input when discard is cancelled", async () => {
  const client = requestsFixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "REQ-1" }));
  expect(confirm).toHaveBeenCalled();
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "private@example.test",
  );
});
it("retains text and its parent draft guard when an accepted update loses QA during the canonical read", async () => {
  const client = requestsFixture();
  const get = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(requestDetail())
    .mockReturnValue(get.promise);
  const ui = renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  ui.rerenderRequests({ canManageQa: false });
  await act(async () =>
    get.resolve(requestDetail({ revision: 2, requesterContact: "private@example.test" })),
  );
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "private@example.test",
  );
  expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
  expect(screen.getByText("Request saved and current.")).toBeTruthy();
  expect(ui.props.onDirtyChange).toHaveBeenLastCalledWith(true);
});
it("keeps a draft and blocks actions after a failed forbidden capability refresh", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.update).mockRejectedValue(new UsClientError("forbidden"));
  renderRequests({
    client,
    canManageQa: true,
    entry: { requestId: receipt.requestId },
    onForbidden: async () => {
      throw new Error("synthetic");
    },
  });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(await screen.findByText("The command was rejected. Your input is retained.")).toBeTruthy();
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "private@example.test",
  );
  expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
  expect(client.requests.update).toHaveBeenCalledOnce();
});
it("releases only its pending owner after READ loss and drops a late canonical response", async () => {
  const client = requestsFixture();
  const get = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(requestDetail())
    .mockReturnValue(get.promise);
  const ui = renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  ui.rerenderRequests({ canRead: false });
  await act(async () => get.resolve(requestDetail({ revision: 2 })));
  expect(screen.queryByText("Request saved and current.")).toBeNull();
  expect(vi.mocked(ui.props.onMutationPendingChange).mock.calls).toEqual([[true], [false]]);
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByLabelText("Requester contact (optional)")).toBeNull();
});
it.each(["unavailable", "invalid_response"] as const)(
  "recovers ambiguous create %s with exact-number read, never auto-POST",
  async (code) => {
    const client = requestsFixture();
    vi.mocked(client.requests.create).mockRejectedValue(new UsClientError(code));
    vi.mocked(client.requests.list)
      .mockResolvedValueOnce({ items: [], limit: 25, offset: 0, hasMore: false })
      .mockResolvedValue({
        items: [requestSummary({ requestNumber: "SYNTHETIC-001" })],
        limit: 25,
        offset: 0,
        hasMore: false,
      });
    vi.mocked(client.requests.get).mockResolvedValue(
      requestDetail({ requestNumber: "SYNTHETIC-001" }),
    );
    renderRequests({ client, canManageQa: true });
    await newDraft();
    await userEvent.click(screen.getByRole("button", { name: "Save request" }));
    expect(
      await screen.findByText(
        "The command outcome is unknown. Check saved server state before deciding what to do next.",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check saved request" }));
    await waitFor(() =>
      expect(client.requests.list).toHaveBeenCalledWith({
        requestNumber: "SYNTHETIC-001",
        limit: "25",
        offset: "0",
      }),
    );
    expect(
      await screen.findByText(
        "A saved request with the exact number was found. Review its saved facts; the original command outcome remains unknown.",
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText("Requester name") as HTMLInputElement).value).toBe(
      "Synthetic requester",
    );
    expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
    expect(client.requests.create).toHaveBeenCalledTimes(1);
  },
);
it("keeps an accepted update's previous card explicitly stale when canonical refresh fails", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(requestDetail())
    .mockRejectedValue(new UsClientError("unavailable"));
  renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(await screen.findByText("Accepted, refresh required.")).toBeTruthy();
  expect(screen.getByText("Last successful request — saved facts may be out of date")).toBeTruthy();
  expect(screen.queryByText("Request saved and current.")).toBeNull();
});
it("keeps a no-match create draft blocked until an explicit user decision", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.create).mockRejectedValue(new UsClientError("unavailable"));
  vi.mocked(client.requests.list).mockResolvedValue({
    items: [],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  renderRequests({ client, canManageQa: true });
  await newDraft();
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  await userEvent.click(await screen.findByRole("button", { name: "Check saved request" }));
  expect(
    await screen.findByText("No saved match was found. This does not prove the command failed."),
  ).toBeTruthy();
  expect(client.requests.create).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Continue editing after no match" }));
  expect(client.requests.create).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Save request" })).toBeTruthy();
});
it("requires confirmed discard to select a found create candidate with differing saved requester facts", async () => {
  const client = requestsFixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.mocked(client.requests.create).mockRejectedValue(new UsClientError("unavailable"));
  vi.mocked(client.requests.list)
    .mockResolvedValueOnce({ items: [], limit: 25, offset: 0, hasMore: false })
    .mockResolvedValue({
      items: [requestSummary({ requestNumber: "SYNTHETIC-001" })],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
  vi.mocked(client.requests.get).mockResolvedValue(
    requestDetail({
      requestNumber: "SYNTHETIC-001",
      requesterName: "Previously saved requester",
      requesterContact: "saved@example.test",
    }),
  );
  renderRequests({ client, canManageQa: true });
  await newDraft();
  change("Requester contact (optional)", "draft@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  await userEvent.click(await screen.findByRole("button", { name: "Check saved request" }));
  expect(await screen.findByText("Previously saved requester")).toBeTruthy();
  expect(screen.getByText("saved@example.test")).toBeTruthy();
  expect((screen.getByLabelText("Requester name") as HTMLInputElement).value).toBe(
    "Synthetic requester",
  );
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "draft@example.test",
  );
  await userEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  expect(screen.getByLabelText("Requester name")).toBeTruthy();
  expect(client.requests.create).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
  expect(screen.queryByLabelText("Requester name")).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  expect((screen.getByLabelText("Requester name") as HTMLInputElement).value).toBe(
    "Previously saved requester",
  );
  expect(client.requests.create).toHaveBeenCalledOnce();
});
it.each(["unavailable", "us_request_revision_conflict"] as const)(
  "preserves raw update text and revision on %s until explicit refresh/discard",
  async (code) => {
    const client = requestsFixture();
    const update = deferred<typeof receipt>();
    vi.mocked(client.requests.update).mockReturnValue(update.promise);
    renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
    await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
    change("Requester contact (optional)", "private@example.test");
    const save = screen.getByRole("button", { name: "Save request" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() =>
      expect(client.requests.update).toHaveBeenCalledWith(receipt.requestId, {
        expectedRevision: 1,
        requesterContact: "private@example.test",
      }),
    );
    await act(async () => update.reject(new UsClientError(code)));
    expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
      "private@example.test",
    );
    expect(client.requests.update).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Check saved request" }));
    expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
      "private@example.test",
    );
    expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
  },
);
it("saves scope with authoritative revision and preserves invalid range text", async () => {
  const client = requestsFixture();
  renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit scope" }));
  change("TLC range from", "Z");
  change("TLC range to", "A");
  await userEvent.click(screen.getByRole("button", { name: "Save scope" }));
  expect(client.requests.update).not.toHaveBeenCalled();
  change("TLC range to", "ZZ");
  await userEvent.click(screen.getByRole("button", { name: "Save scope" }));
  await waitFor(() =>
    expect(client.requests.update).toHaveBeenCalledWith(receipt.requestId, {
      expectedRevision: 1,
      scope: { tlcFrom: "Z", tlcTo: "ZZ" },
    }),
  );
});
it("guards actual cabinet navigation for dirty and pending Requests and allows a cancelled discard", async () => {
  const client = requestsFixture();
  vi.spyOn(client, "access").mockResolvedValue({
    capabilities: ["traceability.read", "traceability.qa.manage"],
  });
  const update = deferred<typeof receipt>();
  vi.mocked(client.requests.create).mockReturnValue(update.promise);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Synthetic tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Requests" }));
  await newDraft();
  await userEvent.click(screen.getByRole("button", { name: "Locations" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Requester name")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect((screen.getByRole("button", { name: "Locations" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "← Profile" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => update.reject(new UsClientError("unavailable")));
  expect(client.requests.create).toHaveBeenCalledOnce();
  expect(
    screen.getByText(
      "The command outcome is unknown. Check saved server state before deciding what to do next.",
    ),
  ).toBeTruthy();
});
it("retains a readable draft on QA loss and clears it on READ loss", async () => {
  const ui = renderRequests({ canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  ui.rerenderRequests({ canManageQa: false });
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "private@example.test",
  );
  expect(screen.queryByRole("button", { name: "Save request" })).toBeNull();
  ui.rerenderRequests({ canRead: false });
  expect(screen.queryByLabelText("Requester contact (optional)")).toBeNull();
});
it("guards dirty selection and pending navigation and explains close without fulfilment/cancellation", async () => {
  const client = requestsFixture();
  const close = deferred<typeof receipt>();
  vi.mocked(client.requests.close).mockReturnValue(close.promise);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const ui = renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "private@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalled();
  expect(screen.getByLabelText("Requester contact (optional)")).toBeTruthy();
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Close request" }));
  expect(
    screen.getByText(
      "Closing records internal lifecycle only. It does not confirm fulfilment, submit a response or cancel prepared runs.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  expect(client.requests.close).toHaveBeenCalledOnce();
  expect(client.requests.close).toHaveBeenCalledWith(receipt.requestId, { expectedRevision: 1 });
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => close.reject(new UsClientError("unavailable")));
  await userEvent.click(await screen.findByRole("button", { name: "Check saved request" }));
  expect(client.requests.close).toHaveBeenCalledOnce();
});
it("offers no CRUD controls for closed or auditor cards and leaves frozen history readable", async () => {
  const client = requestsFixture();
  vi.mocked(client.requests.get).mockResolvedValue(
    requestDetail({ status: "closed", closedAt: "2026-10-05T01:00:00.000Z" }),
  );
  renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  expect(await screen.findByText("Synthetic Requester")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit request" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Close request" })).toBeNull();
});

it("remounts a confirmed existing requester draft as a fresh create without the old revision", async () => {
  const client = requestsFixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
  await userEvent.click(await screen.findByRole("button", { name: "Edit request" }));
  change("Requester contact (optional)", "discarded@example.test");
  await userEvent.click(screen.getByRole("button", { name: "New request" }));
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "discarded@example.test",
  );
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "New request" }));
  expect((screen.getByLabelText("Request number") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Requester name") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "",
  );
  change("Request number", "SYNTHETIC-NEW");
  change("Requester name", "New synthetic requester");
  change("Received at", "2026-10-05T05:00");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(client.requests.create).toHaveBeenCalledWith({
    requestNumber: "SYNTHETIC-NEW",
    requesterName: "New synthetic requester",
    requesterOrganization: null,
    requesterContact: null,
    receivedAt: "2026-10-05T12:00:00.000Z",
    dueAt: "2026-10-06T12:00:00.000Z",
    alternateDeadlineReason: null,
    scope: null,
  });
  expect(client.requests.update).not.toHaveBeenCalled();
});

it("resets a confirmed New to New draft and re-arms real cabinet dirty navigation", async () => {
  const client = requestsFixture();
  vi.spyOn(client, "access").mockResolvedValue({
    capabilities: ["traceability.read", "traceability.qa.manage"],
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Synthetic tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Requests" }));
  await newDraft();
  await userEvent.click(screen.getByRole("button", { name: "New request" }));
  expect((screen.getByLabelText("Request number") as HTMLInputElement).value).toBe("SYNTHETIC-001");
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "New request" }));
  expect((screen.getByLabelText("Request number") as HTMLInputElement).value).toBe("");
  change("Requester name", "Second draft requester");
  confirm.mockClear().mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: "Locations" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("Requester name") as HTMLInputElement).value).toBe(
    "Second draft requester",
  );
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Locations" }));
  expect(screen.queryByLabelText("Requester name")).toBeNull();
});

it.each(["update", "close"] as const)(
  "fences a pre-command list after accepted %s with failed canonical read until explicit recovery",
  async (operation) => {
    const client = requestsFixture();
    const oldList = deferred<Awaited<ReturnType<typeof client.requests.list>>>();
    const before = { items: [requestSummary()], limit: 25, offset: 0, hasMore: false };
    const afterDetail = requestDetail({
      revision: 2,
      ...(operation === "close"
        ? { status: "closed", closedAt: "2026-10-05T01:00:00.000Z" }
        : { requesterContact: "updated@example.test" }),
    });
    const after = {
      items: [
        requestSummary({ revision: 2, status: afterDetail.status, closedAt: afterDetail.closedAt }),
      ],
      limit: 25,
      offset: 0,
      hasMore: false,
    };
    vi.mocked(client.requests.list)
      .mockResolvedValueOnce(before)
      .mockReturnValueOnce(oldList.promise)
      .mockResolvedValue(after);
    vi.mocked(client.requests.get)
      .mockResolvedValueOnce(requestDetail())
      .mockRejectedValueOnce(new UsClientError("unavailable"))
      .mockResolvedValue(afterDetail);
    renderRequests({ client, canManageQa: true, entry: { requestId: receipt.requestId } });
    await screen.findByText("Synthetic Requester");
    await userEvent.click(screen.getByRole("button", { name: "Refresh server state" }));
    await waitFor(() => expect(client.requests.list).toHaveBeenCalledTimes(2));
    if (operation === "update") {
      await userEvent.click(screen.getByRole("button", { name: "Edit request" }));
      change("Requester contact (optional)", "updated@example.test");
      await userEvent.click(screen.getByRole("button", { name: "Save request" }));
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Close request" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    }
    expect(await screen.findByText("Accepted, refresh required.")).toBeTruthy();
    await act(async () => oldList.resolve(before));
    expect(screen.getByText("Last successful list — deadlines may be out of date")).toBeTruthy();
    expect((screen.getByRole("button", { name: "REQ-1" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("Loading requests…")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Refresh server state" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Check saved request" }));
    expect(await screen.findByText("Request saved and current.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText("Last successful list — deadlines may be out of date")).toBeNull(),
    );
    expect(client.requests.list).toHaveBeenCalledTimes(3);
    expect((screen.getByRole("button", { name: "REQ-1" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      operation === "update" ? client.requests.update : client.requests.close,
    ).toHaveBeenCalledOnce();
  },
);
