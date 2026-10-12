import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { UsClientError } from "../src/us/client.js";
import {
  deferred,
  renderRequests,
  requestDetail,
  requestsFixture,
  requestValidation,
} from "./us-requests-fixtures.js";
import { RequestValidation, matchingRequestValidation } from "../src/us/requests/validation.js";
import { RequestCard } from "../src/us/requests/card.js";
import { renderPlanUi } from "./us-plans-fixtures.js";
import { profile } from "./us-plans-fixtures.js";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { liveFinalized } from "./support/us-receiving-command-fixture.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function savedScopeDetail(overrides: Partial<ReturnType<typeof requestDetail>> = {}) {
  return requestDetail({ scope: { tlc: "SAVED-TLC" }, ...overrides });
}
function savedScopeClient() {
  const client = requestsFixture();
  vi.mocked(client.requests.get).mockResolvedValue(savedScopeDetail());
  return client;
}
async function validationTab() {
  await userEvent.click(await screen.findByRole("tab", { name: "Validation" }));
}
async function packageTab() {
  await userEvent.click(screen.getByRole("tab", { name: "Package" }));
}
const manage = { canManageQa: true, canExport: true, entry: { requestId: savedScopeDetail().id } };
it.each(["en-US", "es-US"])(
  "%s saved shell without scope disables Validate and explains saving scope",
  async (locale) => {
    renderRequests({ ...manage }, locale);
    await userEvent.click(
      await screen.findByRole("tab", { name: locale === "en-US" ? "Validation" : "Validación" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: locale === "en-US" ? "Validate current sources" : "Validar fuentes actuales",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        locale === "en-US"
          ? "Save a scope before validating current sources."
          : "Guarde un alcance antes de validar las fuentes actuales.",
      ),
    ).toBeTruthy();
  },
);
it.each(["en-US", "es-US"])(
  "%s scope_required race gives scope recovery instead of revision conflict",
  async (locale) => {
    const client = savedScopeClient();
    vi.mocked(client.requests.get).mockResolvedValue(
      savedScopeDetail({ scope: { tlc: "SAVED-TLC" } }),
    );
    vi.mocked(client.requests.validate).mockRejectedValue(
      new UsClientError("us_request_scope_required"),
    );
    renderRequests({ client, ...manage }, locale);
    await userEvent.click(
      await screen.findByRole("tab", { name: locale === "en-US" ? "Validation" : "Validación" }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: locale === "en-US" ? "Validate current sources" : "Validar fuentes actuales",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      locale === "en-US"
        ? "Save a scope before validating current sources."
        : "Guarde un alcance antes de validar las fuentes actuales.",
    );
    expect(client.requests.validate).toHaveBeenCalledOnce();
  },
);
it("historical not_rechecked and its saved acknowledgement never enable preparation", async () => {
  const client = savedScopeClient();
  const value = requestValidation();
  vi.mocked(client.requests.get).mockResolvedValue(
    savedScopeDetail({
      lastValidatedAt: value.validatedAt,
      savedValidation: {
        digest: value.digest,
        validatedAt: value.validatedAt,
        findings: [],
        matchedRevisionCount: 1,
        freshness: "not_rechecked",
      },
      warningAcknowledgement: {
        digest: value.digest,
        reason: "Reviewed",
        actorId: "qa",
        acknowledgedAt: value.validatedAt,
      },
    }),
  );
  renderRequests({ client, ...manage });
  await validationTab();
  expect(screen.getByText(/Saved validation — not rechecked/)).toBeTruthy();
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it.each(["unavailable", "unknown"] as const)(
  "%s build blocks Validate but not saved warning acknowledgement",
  async (build) => {
    const client = savedScopeClient();
    const value = requestValidation();
    vi.mocked(client.requests.get).mockResolvedValue(
      savedScopeDetail({
        availability: { build, packageStorage: "configured" },
        lastValidatedAt: value.validatedAt,
        savedValidation: {
          digest: value.digest,
          validatedAt: value.validatedAt,
          matchedRevisionCount: 1,
          findings: [
            {
              code: "review",
              severity: "warning",
              sourceRecord: "metadata:plan",
              message: "Review",
            },
          ],
          freshness: "not_rechecked",
        },
      }),
    );
    renderRequests({ client, ...manage });
    await validationTab();
    expect(
      (screen.getByRole("button", { name: "Validate current sources" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
      target: { value: "Reviewed" },
    });
    expect(
      (screen.getByRole("button", { name: "Acknowledge warnings" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
    expect(client.requests.acknowledgeWarnings).toHaveBeenCalledWith(value.requestId, {
      expectedRevision: 1,
      digest: value.digest,
      reason: "Reviewed",
    });
  },
);
it.each(["unconfigured", "invalid"] as const)(
  "request %s storage allows Validate and blocks Prepare",
  async (packageStorage) => {
    const client = savedScopeClient();
    vi.mocked(client.requests.get).mockResolvedValue(
      savedScopeDetail({ availability: { build: "available", packageStorage } }),
    );
    renderRequests({ client, ...manage });
    await validationTab();
    await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
    expect(await screen.findByText("Fresh validation of captured request revision")).toBeTruthy();
    await packageTab();
    expect(
      (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  },
);
it("groups exact findings and sends saved digest/revision with a strict reason; acknowledgement cannot waive errors", async () => {
  const client = savedScopeClient();
  const value = requestValidation({
    findings: [
      {
        code: "error_code",
        severity: "error",
        sourceRecord: "metadata:request",
        message: "Error",
        revision: 2,
        fieldKey: "event.date",
      },
      { code: "warn_code", severity: "warning", sourceRecord: "metadata:plan", message: "Warning" },
      { code: "info_code", severity: "info", sourceRecord: "metadata:build", message: "Info" },
    ],
  });
  vi.mocked(client.requests.validate).mockResolvedValue(value);
  const saved = savedScopeDetail({
    lastValidatedAt: value.validatedAt,
    savedValidation: {
      digest: value.digest,
      validatedAt: value.validatedAt,
      matchedRevisionCount: 1,
      findings: value.findings,
      freshness: "not_rechecked",
    },
    warningAcknowledgement: {
      digest: value.digest,
      reason: "Reviewed",
      actorId: "qa",
      acknowledgedAt: value.validatedAt,
    },
  });
  vi.mocked(client.requests.get).mockResolvedValueOnce(savedScopeDetail()).mockResolvedValue(saved);
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  expect(await screen.findByRole("heading", { name: "Errors" })).toBeTruthy();
  expect(screen.getByText("event.date")).toBeTruthy();
  expect(screen.getByText("metadata:request")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "ab" },
  });
  expect(
    (screen.getByRole("button", { name: "Acknowledge warnings" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: " Reviewed " },
  });
  expect(
    (screen.getByRole("button", { name: "Acknowledge warnings" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "Reviewed" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
  await waitFor(() =>
    expect(client.requests.acknowledgeWarnings).toHaveBeenCalledWith(saved.id, {
      expectedRevision: 1,
      digest: value.digest,
      reason: "Reviewed",
    }),
  );
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(client.requests.prepare).not.toHaveBeenCalled();
});
it.each(["us_request_selection_limit", "us_request_snapshot_limit", "unavailable"] as const)(
  "shows %s without trimming or treating technical failure as incomplete",
  async (code) => {
    const client = savedScopeClient();
    vi.mocked(client.requests.validate).mockRejectedValue(new UsClientError(code));
    renderRequests({ client, ...manage });
    await validationTab();
    await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await packageTab();
    expect(
      (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(client.requests.validate).toHaveBeenCalledTimes(1);
  },
);
it("zero-match valid evidence allows only the explicit incomplete response", async () => {
  const client = savedScopeClient();
  vi.mocked(client.requests.validate).mockResolvedValue(
    requestValidation({ matchedRevisionCount: 0 }),
  );
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it.each([{ requestId: "20000000-0000-4000-8000-000000000002" }, { revision: 2 }])(
  "rejects mismatched fresh validation %j",
  async (extra) => {
    const client = savedScopeClient();
    vi.mocked(client.requests.validate).mockResolvedValue(requestValidation(extra));
    renderRequests({ client, ...manage });
    await validationTab();
    await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
    await screen.findByRole("alert");
    await packageTab();
    expect(
      (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  },
);
it("requires fresh ID/revision/digest to match captured saved evidence", () => {
  const response = requestValidation();
  const fresh = { requestId: response.requestId, revision: 1, response };
  const detail = savedScopeDetail({
    lastValidatedAt: response.validatedAt,
    savedValidation: {
      digest: "c".repeat(64),
      validatedAt: response.validatedAt,
      matchedRevisionCount: 1,
      findings: [],
      freshness: "not_rechecked",
    },
  });
  expect(matchingRequestValidation(detail, fresh)).toBeNull();
});
it("preserves common actions and default fallback, with keyboard-selected slot only inside the selected panel", async () => {
  const ui = renderPlanUi(
    <RequestCard detail={savedScopeDetail()} timeZone="UTC">
      <button>Common action</button>
    </RequestCard>,
  );
  await userEvent.click(screen.getByRole("tab", { name: "Validation" }));
  expect(within(screen.getByRole("tabpanel")).getByText("No saved validation.")).toBeTruthy();
  ui.rerender(
    <RequestCard
      detail={savedScopeDetail()}
      timeZone="UTC"
      validationContent={<button>Validation command</button>}
      packageContent={<button>Package command</button>}
    >
      <button>Common action</button>
    </RequestCard>,
  );
  screen.getByRole("tab", { name: "Validation" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(
    within(screen.getByRole("tabpanel")).getByRole("button", { name: "Package command" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Validation command" })).toBeNull();
  expect(
    within(screen.getByRole("tabpanel")).queryByRole("button", { name: "Common action" }),
  ).toBeNull();
});
it("does not waive errors after saved warnings are acknowledged", async () => {
  const response = requestValidation({
    findings: [
      { code: "blocked", severity: "error", sourceRecord: "metadata:plan", message: "Blocked" },
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  const client = savedScopeClient();
  vi.mocked(client.requests.get).mockResolvedValue(
    savedScopeDetail({
      lastValidatedAt: response.validatedAt,
      savedValidation: {
        digest: response.digest,
        validatedAt: response.validatedAt,
        matchedRevisionCount: 1,
        findings: response.findings,
        freshness: "not_rechecked",
      },
      warningAcknowledgement: {
        digest: response.digest,
        reason: "Reviewed",
        actorId: "qa",
        acknowledgedAt: response.validatedAt,
      },
    }),
  );
  vi.mocked(client.requests.validate).mockResolvedValue(response);
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("source navigation passes exact request/run return identity and obeys the raw draft guard", async () => {
  const eventId = "10000000-0000-4000-8000-000000000001";
  const response = requestValidation({
    findings: [
      {
        code: "missing",
        severity: "error",
        sourceRecord: `receiving:${eventId}:3:item:2`,
        eventId,
        revision: 3,
        lineNo: 2,
        message: "Missing",
      },
    ],
  });
  const client = savedScopeClient();
  vi.mocked(client.requests.get).mockResolvedValue(
    savedScopeDetail({
      lastValidatedAt: response.validatedAt,
      savedValidation: {
        digest: response.digest,
        validatedAt: response.validatedAt,
        matchedRevisionCount: 1,
        findings: response.findings,
        freshness: "not_rechecked",
      },
    }),
  );
  const entry = { requestId: savedScopeDetail().id, runId: "b0000000-0000-4000-8000-000000000002" };
  const ui = renderRequests({ client, ...manage, entry });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Edit request" }));
  fireEvent.change(screen.getByLabelText("Requester name"), {
    target: { value: "Raw changed name" },
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: "Open source revision" }));
  expect(ui.props.onOpenSource).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue("Raw changed name")).toBeTruthy();
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Open source revision" }));
  expect(ui.props.onEntryChange).toHaveBeenCalledWith(entry);
  expect(ui.props.onOpenSource).toHaveBeenCalledWith({
    type: "receiving",
    eventId,
    revision: 3,
    lineSide: "items",
    lineNo: 2,
  });
});
it("a refresh failure invalidates fresh evidence even while old saved data remains visible", async () => {
  const client = savedScopeClient();
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(savedScopeDetail())
    .mockRejectedValue(new UsClientError("unavailable"));
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await userEvent.click(screen.getByRole("button", { name: "Refresh request" }));
  await screen.findByText("Last successful request — saved facts may be out of date");
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("a capability refresh during Validate invalidates its eventual response", async () => {
  const client = savedScopeClient();
  const response = deferred<ReturnType<typeof requestValidation>>();
  vi.mocked(client.requests.validate).mockReturnValue(response.promise);
  const ui = renderRequests({ client, ...manage });
  await validationTab();
  fireEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  ui.rerenderRequests({ authorityPending: true });
  ui.rerenderRequests({ authorityPending: false });
  await act(async () => response.resolve(requestValidation()));
  expect(screen.queryByText("Fresh validation of captured request revision")).toBeNull();
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare incomplete response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("strict acknowledgement reason rejects 2001 characters and errors remain readable", () => {
  const detail = savedScopeDetail();
  const response = requestValidation({
    findings: [
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  renderPlanUi(
    <RequestValidation
      detail={detail}
      fresh={{ requestId: detail.id, revision: 1, response }}
      canAct
      pending={false}
      onValidate={vi.fn()}
      onAcknowledge={vi.fn()}
      onOpenSource={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "a".repeat(2001) },
  });
  expect(
    (screen.getByRole("button", { name: "Acknowledge warnings" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("Validate clears a historical warning acknowledgement even when its digest is unchanged", async () => {
  const client = savedScopeClient();
  const response = requestValidation({
    findings: [
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  vi.mocked(client.requests.get).mockResolvedValue(
    savedScopeDetail({
      lastValidatedAt: response.validatedAt,
      savedValidation: {
        digest: response.digest,
        validatedAt: response.validatedAt,
        matchedRevisionCount: 1,
        findings: response.findings,
        freshness: "not_rechecked",
      },
      warningAcknowledgement: {
        digest: response.digest,
        reason: "Historical review",
        actorId: "qa",
        acknowledgedAt: response.validatedAt,
      },
    }),
  );
  vi.mocked(client.requests.validate).mockResolvedValue(response);
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  expect(screen.queryByText(/Historical review/)).toBeNull();
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("returns from an exact event source through the existing workspace with the accepted request/run identity", async () => {
  const client = savedScopeClient();
  vi.spyOn(client, "access").mockResolvedValue({
    capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
  });
  vi.spyOn(client, "getReceivingRecord").mockResolvedValue(liveFinalized);
  const response = requestValidation({
    findings: [
      {
        code: "source_pin",
        severity: "info",
        sourceRecord: `receiving:${liveFinalized.id}:${liveFinalized.revision}:item:1`,
        message: "Pinned source",
      },
    ],
  });
  vi.mocked(client.requests.validate).mockResolvedValue(response);
  vi.mocked(client.requests.get).mockResolvedValue(
    savedScopeDetail({
      lastValidatedAt: response.validatedAt,
      savedValidation: {
        digest: response.digest,
        validatedAt: response.validatedAt,
        matchedRevisionCount: 1,
        findings: response.findings,
        freshness: "not_rechecked",
      },
    }),
  );
  vi.spyOn(crypto, "randomUUID").mockReturnValue("20000000-0000-4000-8000-000000000002");
  const ui = renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Requests" }));
  await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  await packageTab();
  await userEvent.click(screen.getByRole("button", { name: "Prepare Export-ready response" }));
  await waitFor(() =>
    expect(
      ui.container.querySelector("[data-selected-run]")?.getAttribute("data-selected-run"),
    ).toBe("b0000000-0000-4000-8000-000000000002"),
  );
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Open source revision" }));
  await waitFor(() => expect(client.getReceivingRecord).toHaveBeenCalledWith(liveFinalized.id));
  await userEvent.click(await screen.findByRole("button", { name: "Back to Requests" }));
  await screen.findByRole("heading", { name: "Requests", level: 1 });
  expect(ui.container.querySelector("[data-selected-run]")?.getAttribute("data-selected-run")).toBe(
    "b0000000-0000-4000-8000-000000000002",
  );
  await validationTab();
  expect(screen.getByText(/Saved validation — not rechecked/)).toBeTruthy();
});
it("retains only an already captured fresh validation through successful acknowledgement of its exact digest", async () => {
  const client = savedScopeClient();
  const response = requestValidation({
    findings: [
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  const saved = savedScopeDetail({
    lastValidatedAt: response.validatedAt,
    savedValidation: {
      digest: response.digest,
      validatedAt: response.validatedAt,
      matchedRevisionCount: 1,
      findings: response.findings,
      freshness: "not_rechecked",
    },
    warningAcknowledgement: {
      digest: response.digest,
      reason: "Reviewed current evidence",
      actorId: "qa",
      acknowledgedAt: response.validatedAt,
    },
  });
  vi.mocked(client.requests.validate).mockResolvedValue(response);
  vi.mocked(client.requests.get).mockResolvedValueOnce(savedScopeDetail()).mockResolvedValue(saved);
  renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "Reviewed current evidence" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
  await waitFor(() => expect(client.requests.get).toHaveBeenCalledTimes(2));
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(client.requests.validate).toHaveBeenCalledTimes(1);
  expect(client.requests.prepare).not.toHaveBeenCalled();
});
it("acknowledging saved-only evidence never manufactures a fresh Validate", async () => {
  const client = savedScopeClient();
  const response = requestValidation({
    findings: [
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  const saved = savedScopeDetail({
    lastValidatedAt: response.validatedAt,
    savedValidation: {
      digest: response.digest,
      validatedAt: response.validatedAt,
      matchedRevisionCount: 1,
      findings: response.findings,
      freshness: "not_rechecked",
    },
  });
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(saved)
    .mockResolvedValue({
      ...saved,
      warningAcknowledgement: {
        digest: response.digest,
        reason: "Reviewed",
        actorId: "qa",
        acknowledgedAt: response.validatedAt,
      },
    });
  renderRequests({ client, ...manage });
  await validationTab();
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "Reviewed" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
  await waitFor(() => expect(client.requests.get).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/Saved validation — not rechecked/)).toBeTruthy();
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(client.requests.validate).not.toHaveBeenCalled();
});
it.each(["digest", "validatedAt", "reason", "revision", "read_failure", "ack_failure"] as const)(
  "acknowledgement %s mismatch/failure invalidates captured fresh validation",
  async (mismatch) => {
    const client = savedScopeClient();
    const response = requestValidation({
      findings: [
        { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
      ],
    });
    const saved = savedScopeDetail({
      revision: mismatch === "revision" ? 2 : 1,
      lastValidatedAt:
        mismatch === "validatedAt" ? "2026-10-05T00:01:00.000Z" : response.validatedAt,
      savedValidation: {
        digest: mismatch === "digest" ? "c".repeat(64) : response.digest,
        validatedAt: mismatch === "validatedAt" ? "2026-10-05T00:01:00.000Z" : response.validatedAt,
        matchedRevisionCount: 1,
        findings: response.findings,
        freshness: "not_rechecked",
      },
      warningAcknowledgement: {
        digest: mismatch === "digest" ? "c".repeat(64) : response.digest,
        reason: mismatch === "reason" ? "Other reason" : "Reviewed",
        actorId: "qa",
        acknowledgedAt: "2026-10-05T00:02:00.000Z",
      },
    });
    vi.mocked(client.requests.get).mockResolvedValueOnce(savedScopeDetail());
    if (mismatch === "read_failure")
      vi.mocked(client.requests.get).mockRejectedValue(new UsClientError("unavailable"));
    else vi.mocked(client.requests.get).mockResolvedValue(saved);
    vi.mocked(client.requests.validate).mockResolvedValue(response);
    renderRequests({ client, ...manage });
    await validationTab();
    await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
    await screen.findByText("Fresh validation of captured request revision");
    if (mismatch === "ack_failure")
      vi.mocked(client.requests.acknowledgeWarnings).mockRejectedValue(
        new UsClientError("unavailable"),
      );
    fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
      target: { value: "Reviewed" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Acknowledge warnings" }) as HTMLButtonElement)
          .disabled,
      ).toBe(mismatch === "read_failure"),
    );
    await packageTab();
    expect(
      (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  },
);
it("an authority transition during the acknowledgement read discards its captured fresh proof", async () => {
  const client = savedScopeClient();
  const response = requestValidation({
    findings: [
      { code: "review", severity: "warning", sourceRecord: "metadata:plan", message: "Review" },
    ],
  });
  const saved = savedScopeDetail({
    lastValidatedAt: response.validatedAt,
    savedValidation: {
      digest: response.digest,
      validatedAt: response.validatedAt,
      matchedRevisionCount: 1,
      findings: response.findings,
      freshness: "not_rechecked",
    },
    warningAcknowledgement: {
      digest: response.digest,
      reason: "Reviewed",
      actorId: "qa",
      acknowledgedAt: response.validatedAt,
    },
  });
  const read = deferred<ReturnType<typeof requestDetail>>();
  vi.mocked(client.requests.get)
    .mockResolvedValueOnce(savedScopeDetail())
    .mockReturnValue(read.promise);
  vi.mocked(client.requests.validate).mockResolvedValue(response);
  const ui = renderRequests({ client, ...manage });
  await validationTab();
  await userEvent.click(screen.getByRole("button", { name: "Validate current sources" }));
  await screen.findByText("Fresh validation of captured request revision");
  fireEvent.change(screen.getByLabelText("Warning acknowledgement reason"), {
    target: { value: "Reviewed" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Acknowledge warnings" }));
  await waitFor(() => expect(client.requests.get).toHaveBeenCalledTimes(2));
  ui.rerenderRequests({ authorityPending: true });
  ui.rerenderRequests({ authorityPending: false });
  await act(async () => read.resolve(saved));
  expect(ui.props.onMutationPendingChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByText("Fresh validation of captured request revision")).toBeNull();
  await packageTab();
  expect(
    (screen.getByRole("button", { name: "Prepare Export-ready response" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
