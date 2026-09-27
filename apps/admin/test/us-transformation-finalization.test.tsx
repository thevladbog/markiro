import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  completeDraft,
  completeReadiness,
  draftRecord,
  finalizedRecord,
  renderTransformation,
  revisionDraftRecord,
  revisionId,
  transformationId,
} from "./support/us-transformation-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps a definitely rejected new draft editable when there is no saved record to reload", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (String(input) === "/api/us/traceability/transformation" && init?.method === "POST")
      return Response.json({ code: "transformation_reference_not_found" }, { status: 404 });
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send, eventId: null });
  await user.type(screen.getByLabelText("Completion date"), "2026-09-27");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
  expect(screen.getByLabelText("Completion date")).toHaveProperty("disabled", false);
  await user.clear(screen.getByLabelText("Completion date"));
  await user.type(screen.getByLabelText("Completion date"), "2026-09-26");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(
      send.mock.calls.filter(([url]) => String(url) === "/api/us/traceability/transformation"),
    ).toHaveLength(2),
  );
  const commands = send.mock.calls
    .filter(([url]) => String(url) === "/api/us/traceability/transformation")
    .map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as { operationKey: string; draft: { eventDate: string } },
    );
  expect(commands[1]?.operationKey).not.toBe(commands[0]?.operationKey);
  expect(commands[1]?.draft.eventDate).toBe("2026-09-26");
});

it.each(["en-US", "es-US"] as const)(
  "renders bounded downstream blockers and truncation in %s",
  async (locale) => {
    const original = finalizedRecord();
    const blocker = {
      lotId: "d0000000-0000-4000-8000-000000000001",
      eventId: "d0000000-0000-4000-8000-000000000002",
      rootId: "d0000000-0000-4000-8000-000000000003",
      revision: 4,
    };
    const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/api/us/traceability/transformation/${transformationId}`)
        return Response.json(original);
      if (url.endsWith("/amend"))
        return Response.json(
          { code: "traceability_downstream_blocked", blockers: [blocker], hasMore: true },
          { status: 409 },
        );
      return Response.json({}, { status: 503 });
    });
    const { user } = await renderTransformation({ send, canManageQa: true, locale });
    await user.click(
      await screen.findByRole("button", {
        name: locale === "en-US" ? "Start amendment" : "Iniciar modificación",
      }),
    );
    await user.type(
      screen.getByLabelText(locale === "en-US" ? "QA reason" : "Motivo de calidad"),
      "Correct quantity",
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: locale === "en-US" ? "Confirm" : "Confirmar",
      }),
    );
    const list = await screen.findByRole("list", {
      name: locale === "en-US" ? "Downstream blockers" : "Bloqueos posteriores",
    });
    expect(list.textContent).toContain(blocker.lotId);
    expect(list.textContent).toContain(blocker.eventId);
    expect(list.textContent).toContain(blocker.rootId);
    expect(list.textContent).toContain(locale === "en-US" ? "Revision 4" : "Revisión 4");
    expect(
      screen.getByText(
        locale === "en-US"
          ? "More downstream blockers exist; this list is limited."
          : "Existen más bloqueos posteriores; esta lista es limitada.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: locale === "en-US" ? "Retry same operation" : "Reintentar la misma operación",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: locale === "en-US" ? "Reload current record" : "Volver a cargar el registro actual",
      }),
    ).toBeTruthy();
  },
);

it.each([
  "transformation_not_found",
  "transformation_reference_not_found",
  "transformation_not_draft",
  "transformation_draft_conflict",
  "transformation_lifecycle_conflict",
  "transformation_operation_conflict",
  "transformation_readiness_changed",
  "transformation_output_identity_locked",
  "transformation_lot_conflict",
  "transformation_genealogy_cycle",
  "transformation_pending_amendment",
  "event_incomplete",
])("requires definite recovery, without same-intent retry, for %s", async (code) => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(finalizedRecord());
    if (url.endsWith("/amend"))
      return Response.json(
        {
          code,
          ...(code === "transformation_pending_amendment" ? { pendingDraftId: revisionId } : {}),
          ...(code === "event_incomplete" ? { issues: [] } : {}),
        },
        { status: code.endsWith("not_found") ? 404 : 409 },
      );
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Start amendment" }));
  await user.type(screen.getByLabelText("QA reason"), "Correct quantity");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
  expect(screen.queryByText(/outcome is unknown/)).toBeNull();
  expect(screen.getByRole("button", { name: "Reload current record" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start amendment" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Reload current record" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start amendment" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
});

it("keeps finalization QA only and closes confirmation when QA access is lost", async () => {
  const rendered = await renderTransformation({ draft: completeDraft, canManageQa: true });
  await rendered.user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Finalize transformation" })).toBeTruthy(),
  );
  await rendered.user.click(screen.getByRole("button", { name: "Finalize transformation" }));
  expect(screen.getByRole("dialog", { name: "Finalize transformation" })).toBeTruthy();
  rendered.rerender(rendered.view(true, false));
  expect(screen.queryByRole("dialog", { name: "Finalize transformation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Finalize transformation" })).toBeNull();
  expect(rendered.send.mock.calls.some(([url]) => String(url).endsWith("/finalize"))).toBe(false);
});

it("retries an uncertain finalize with the exact operation key and payload", async () => {
  let attempts = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(draftRecord(completeDraft));
    if (url.endsWith("/readiness?expectedDraftVersion=1")) return Response.json(completeReadiness);
    if (url.endsWith("/finalize") && init?.method === "POST") {
      attempts++;
      throw new TypeError("network timeout");
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ draft: completeDraft, canManageQa: true, send });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await user.click(await screen.findByRole("button", { name: "Finalize transformation" }));
  expect(screen.getByText(/1 inputs, 1 outputs, 1 documents/)).toBeTruthy();
  expect(screen.getByText(/does not link Cases/)).toBeTruthy();
  await user.click(
    screen
      .getByRole("dialog", { name: "Finalize transformation" })
      .querySelector("button:last-child")!,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry same operation" })).toBeTruthy(),
  );
  await user.click(screen.getByRole("button", { name: "Retry same operation" }));
  await waitFor(() => expect(attempts).toBe(2));
  const commands = send.mock.calls.filter(([url]) => String(url).endsWith("/finalize"));
  expect(String(commands[0]?.[1]?.body)).toBe(String(commands[1]?.[1]?.body));
  expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({
    expectedDraftVersion: 1,
    expectedInputDigest: completeReadiness.inputDigest,
  });
});

it("sends QA original-draft void with both lifecycle and draft versions and no-lot warning", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(draftRecord());
    if (url.endsWith("/void") && init?.method === "POST") throw new TypeError("timeout");
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Void transformation" }));
  expect(screen.getByText(/No output lots were created/)).toBeTruthy();
  await user.type(screen.getByLabelText("QA reason"), "Incorrect source record");
  await user.click(
    screen.getByRole("dialog", { name: "Void transformation" }).querySelector("button:last-child")!,
  );
  await waitFor(() =>
    expect(send.mock.calls.some(([url]) => String(url).endsWith("/void"))).toBe(true),
  );
  const [, init] = send.mock.calls.find(([url]) => String(url).endsWith("/void"))!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    expectedLifecycleVersion: 1,
    expectedDraftVersion: 1,
    reason: "Incorrect source record",
  });
});

it("opens the server-created revision two through a fresh GET after amendment", async () => {
  const original = finalizedRecord();
  const revision = revisionDraftRecord();
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (
      url === `/api/us/traceability/transformation/${transformationId}/amend` &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as { operationKey: string };
      return Response.json({
        receiptVersion: 1,
        command: "transformation.amend",
        operationKey: body.operationKey,
        inputDigest: "a".repeat(64),
        eventId: revisionId,
        record: revision,
      });
    }
    if (
      url === `/api/us/traceability/transformation/${revisionId}/readiness?expectedDraftVersion=1`
    )
      return Response.json({ ...completeReadiness, eventId: revisionId });
    if (url === `/api/us/traceability/transformation/${revisionId}`) return Response.json(revision);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(original);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Start amendment" }));
  await user.type(screen.getByLabelText("QA reason"), "Correct quantity");
  await user.click(
    screen.getByRole("dialog", { name: "Start amendment" }).querySelector("button:last-child")!,
  );
  await waitFor(() => expect(screen.getByText("Revision 2 · Draft")).toBeTruthy());
  expect(
    send.mock.calls.some(
      ([url]) => String(url) === `/api/us/traceability/transformation/${revisionId}`,
    ),
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Check readiness" }));
  await user.click(await screen.findByRole("button", { name: "Finalize transformation" }));
  expect(screen.getByText(/Existing output lot identities remain fixed/)).toBeTruthy();
  expect(screen.queryByText(/Output lots will be created by the server/)).toBeNull();
});

it("does not replace an uncertain void operation with a finalize command", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(draftRecord(completeDraft));
    if (url.endsWith("/readiness?expectedDraftVersion=1")) return Response.json(completeReadiness);
    if (url.endsWith("/void") && init?.method === "POST") throw new TypeError("timeout");
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send, draft: completeDraft, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await user.click(screen.getByRole("button", { name: "Void transformation" }));
  await user.type(screen.getByLabelText("QA reason"), "Incorrect source");
  await user.click(
    screen.getByRole("dialog", { name: "Void transformation" }).querySelector("button:last-child")!,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry same operation" })).toBeTruthy(),
  );
  const finalize = screen.queryByRole("button", { name: "Finalize transformation" });
  if (finalize) await user.click(finalize);
  const confirm = screen.queryByRole("dialog", { name: "Finalize transformation" });
  if (confirm) await user.click(confirm.querySelector("button:last-child")!);
  expect(send.mock.calls.some(([url]) => String(url).endsWith("/finalize"))).toBe(false);
  const voidBodies = send.mock.calls
    .filter(([url]) => String(url).endsWith("/void"))
    .map(([, init]) => String(init?.body));
  expect(voidBodies).toHaveLength(1);
});

it("protects a typed lifecycle reason from navigation and retains it across QA loss", async () => {
  const rendered = await renderTransformation({ canManageQa: true });
  await rendered.user.click(await screen.findByRole("button", { name: "Void transformation" }));
  await rendered.user.type(screen.getByLabelText("QA reason"), "Investigate lot evidence");
  await waitFor(() => expect(rendered.onDirtyChange).toHaveBeenLastCalledWith(true));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await rendered.user.click(screen.getByRole("button", { name: "Back to events" }));
  expect(confirm).toHaveBeenCalled();
  expect(rendered.onClose).not.toHaveBeenCalled();
  rendered.rerender(rendered.view(true, false));
  expect(screen.queryByRole("dialog", { name: "Void transformation" })).toBeNull();
  rendered.rerender(rendered.view(true, true));
  expect(screen.getByLabelText("QA reason")).toHaveProperty("value", "Investigate lot evidence");
});
