import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MasterDataWorkspace } from "../src/us/master-data/workspace.js";
import { profile, renderPlanUi } from "./us-plans-fixtures.js";
import { requestDetail, requestSummary, requestsFixture } from "./us-requests-fixtures.js";
import { UsClientError } from "../src/us/client.js";
import { getRequestCopy } from "../src/us/requests/copy.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  ["en-US", "timeout", "Parties"],
  ["es-US", "timeout", "Partes"],
  ["en-US", "accepted", "← Profile"],
  ["es-US", "accepted", "← Perfil"],
])("%s real parent guards clean Close %s recovery via %s", async (locale, outcome, exit) => {
  const client = requestsFixture();
  const copy = getRequestCopy(locale);
  const back = vi.fn();
  vi.spyOn(client, "access").mockResolvedValue({
    capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
  });
  if (outcome === "timeout")
    vi.mocked(client.requests.close).mockRejectedValue(new UsClientError("unavailable"));
  else
    vi.mocked(client.requests.get)
      .mockResolvedValueOnce(requestDetail())
      .mockRejectedValue(new UsClientError("unavailable"));
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={back}
      onSessionLost={vi.fn()}
    />,
    locale,
  );
  await userEvent.click(await screen.findByRole("button", { name: copy.title }));
  await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
  await userEvent.click(screen.getByRole("button", { name: copy.close }));
  await userEvent.click(screen.getByRole("button", { name: copy.confirmClose }));
  const notice = outcome === "timeout" ? copy.ambiguous : copy.acceptedRefresh;
  await screen.findByText(notice);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await userEvent.click(screen.getByRole("button", { name: exit }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByRole("heading", { name: copy.title, level: 1 })).toBeTruthy();
  expect(screen.getByText(notice)).toBeTruthy();
  expect(back).not.toHaveBeenCalled();
  expect(client.requests.close).toHaveBeenCalledExactlyOnceWith(requestDetail().id, {
    expectedRevision: 1,
  });
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: exit }));
  if (outcome === "accepted") expect(back).toHaveBeenCalledOnce();
  else expect(screen.queryByRole("heading", { name: copy.title, level: 1 })).toBeNull();
});
it.each(["en-US", "es-US"])(
  "%s canonical Close reconciliation clears the real parent guard without another POST",
  async (locale) => {
    const client = requestsFixture();
    const copy = getRequestCopy(locale);
    vi.spyOn(client, "access").mockResolvedValue({
      capabilities: ["traceability.read", "traceability.qa.manage"],
    });
    vi.mocked(client.requests.get)
      .mockResolvedValueOnce(requestDetail())
      .mockRejectedValueOnce(new UsClientError("unavailable"))
      .mockResolvedValue(
        requestDetail({ revision: 2, status: "closed", closedAt: "2026-10-05T01:00:00.000Z" }),
      );
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
    await userEvent.click(screen.getByRole("button", { name: copy.close }));
    await userEvent.click(screen.getByRole("button", { name: copy.confirmClose }));
    await screen.findByText(copy.acceptedRefresh);
    await userEvent.click(screen.getByRole("button", { name: copy.checkSaved }));
    await screen.findByText(copy.savedCurrent);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(
      screen.getByRole("button", { name: locale === "en-US" ? "Parties" : "Partes" }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: copy.title, level: 1 })).toBeNull();
    expect(client.requests.close).toHaveBeenCalledOnce();
  },
);
it.each(["en-US", "es-US"])(
  "opens read-only processor Requests in %s with heading focus and existing branding",
  async (locale) => {
    renderPlanUi(
      <MasterDataWorkspace
        client={requestsFixture()}
        profile={profile}
        organization={{ id: "tenant", name: "Tenant" }}
        onBack={vi.fn()}
        onSessionLost={vi.fn()}
      />,
      locale,
    );
    const name = locale === "en-US" ? "Requests" : "Solicitudes";
    await userEvent.click(await screen.findByRole("button", { name }));
    expect(await screen.findByRole("heading", { name, level: 1 })).toBe(document.activeElement);
    expect(document.querySelector(".us-brand-mark")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New request|Nueva solicitud/ })).toBeNull();
  },
);
it("does not offer Requests to a generic profile", async () => {
  renderPlanUi(
    <MasterDataWorkspace
      client={requestsFixture()}
      profile={{ ...profile, code: "US_GENERIC_LOT_TRACEABILITY" }}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Parties" });
  expect(screen.queryByRole("button", { name: "Requests" })).toBeNull();
});

it("clears Requests navigation and projections after forbidden read confirms lost READ", async () => {
  const client = requestsFixture();
  vi.spyOn(client, "access")
    .mockResolvedValueOnce({ capabilities: ["traceability.read"] })
    .mockResolvedValue({ capabilities: [] });
  vi.mocked(client.requests.list).mockRejectedValue(new UsClientError("forbidden"));
  renderPlanUi(
    <MasterDataWorkspace
      client={client}
      profile={profile}
      organization={{ id: "tenant", name: "Tenant" }}
      onBack={vi.fn()}
      onSessionLost={vi.fn()}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Requests" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Requests" })).toBeNull());
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Requests" })).toBeNull();
});

it("returns from a saved scope lot to the selected request with main heading focus", async () => {
  const client = requestsFixture();
  const lotId = "10000000-0000-4000-8000-000000000001";
  const productId = "10000000-0000-4000-8000-000000000002";
  vi.mocked(client.requests.get).mockResolvedValue(requestDetail({ scope: { lotId } }));
  vi.spyOn(client, "getLot").mockResolvedValue({
    id: lotId,
    productId,
    tlc: "SYNTHETIC-TLC",
    source: null,
    assignmentBasis: "imported",
    sourceLockedAt: null,
    status: "active",
    revision: 1,
    createdBy: "qa",
    updatedBy: "qa",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  });
  renderPlanUi(
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
  await userEvent.click(await screen.findByRole("button", { name: "Open saved scope lot" }));
  await screen.findByText("SYNTHETIC-TLC");
  expect(screen.getAllByRole("button", { name: /Back to Requests/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: /Back to Requests/ }));
  expect(await screen.findByRole("heading", { level: 1, name: "Requests" })).toBe(
    document.activeElement,
  );
  expect(await screen.findByText("Synthetic Requester")).toBeTruthy();
  expect(client.requests.get).toHaveBeenLastCalledWith(
    requestSummary().id,
    expect.any(AbortSignal),
  );
});
it.each(["en-US", "es-US"])(
  "%s real workspace exit warns about original preparation loss; cancel retains exact replay body",
  async (locale) => {
    const client = requestsFixture();
    vi.mocked(client.requests.get).mockResolvedValue(
      requestDetail({ scope: { tlc: "SAVED-TLC" } }),
    );
    const copy = getRequestCopy(locale);
    vi.spyOn(client, "access").mockResolvedValue({
      capabilities: ["traceability.read", "traceability.qa.manage", "traceability.export.read"],
    });
    const key = "20000000-0000-4000-8000-000000000002";
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(key);
    vi.mocked(client.requests.prepare).mockRejectedValue(new UsClientError("unavailable"));
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
    await userEvent.click(screen.getByRole("tab", { name: copy.validationTab }));
    await userEvent.click(screen.getByRole("button", { name: copy.validate }));
    await screen.findByText(copy.freshValidation);
    await userEvent.click(screen.getByRole("tab", { name: copy.packageTab }));
    await userEvent.click(screen.getByRole("button", { name: copy.prepareReady }));
    await screen.findByText(copy.ambiguous);
    await userEvent.click(screen.getByRole("tab", { name: copy.validationTab }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const parties = locale === "en-US" ? "Parties" : "Partes";
    await userEvent.click(screen.getByRole("button", { name: parties }));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        locale === "en-US" ? "original preparation key and body" : "clave y cuerpo originales",
      ),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(locale === "en-US" ? "not durable" : "no es duradero"),
    );
    expect(screen.getByRole("heading", { level: 1, name: copy.title })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: copy.packageTab }));
    await userEvent.click(screen.getByRole("button", { name: copy.replayPreparation }));
    await screen.findByText(copy.ambiguous);
    const exact = {
      mode: "export_ready",
      expectedRevision: 1,
      validationDigest: "b".repeat(64),
      idempotencyKey: key,
    };
    expect(client.requests.prepare).toHaveBeenNthCalledWith(1, requestDetail().id, exact);
    expect(client.requests.prepare).toHaveBeenNthCalledWith(2, requestDetail().id, exact);
    expect(uuid).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: parties }));
    expect(screen.queryByRole("heading", { level: 1, name: copy.title })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: copy.title }));
    await userEvent.click(await screen.findByRole("button", { name: "REQ-1" }));
    await userEvent.click(screen.getByRole("tab", { name: copy.packageTab }));
    expect(screen.queryByRole("button", { name: copy.replayPreparation })).toBeNull();
  },
);
it.each(["en-US", "es-US"])(
  "%s request workspace exit still guards and retains raw drafts on cancellation",
  async (locale) => {
    const client = requestsFixture();
    const copy = getRequestCopy(locale);
    vi.spyOn(client, "access").mockResolvedValue({
      capabilities: ["traceability.read", "traceability.qa.manage"],
    });
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
    await userEvent.click(screen.getByRole("button", { name: copy.editRequest }));
    fireEvent.change(screen.getByLabelText(copy.requesterName), {
      target: { value: "Synthetic raw draft retained" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const parties = locale === "en-US" ? "Parties" : "Partes";
    await userEvent.click(screen.getByRole("button", { name: parties }));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        locale === "en-US"
          ? "Discard unsaved request changes"
          : "Descartar los cambios de la solicitud sin guardar",
      ),
    );
    expect(screen.getByDisplayValue("Synthetic raw draft retained")).toBeTruthy();
    expect(client.requests.update).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: parties }));
    expect(screen.queryByDisplayValue("Synthetic raw draft retained")).toBeNull();
  },
);
