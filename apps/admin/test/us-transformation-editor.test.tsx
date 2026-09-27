import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  completeDraft,
  emptyTransformationDraft,
  renderTransformation,
  draftRecord,
  productId,
  transformationId,
} from "./support/us-transformation-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("saves an incomplete full draft and preserves decimal and unit strings", async () => {
  const { user, send } = await renderTransformation({ eventId: null });
  await user.type(screen.getByLabelText("Completion date"), "2026-09-27");
  await user.click(screen.getByRole("button", { name: "Add existing FTL lot" }));
  await user.click(screen.getByRole("button", { name: "Add output" }));
  const input = screen.getByRole("group", { name: /Input 1/ });
  const output = screen.getByRole("group", { name: /Output 1/ });
  await user.type(within(input).getByLabelText("Quantity"), "2.50");
  await user.selectOptions(within(input).getByLabelText("Unit"), "kg");
  await user.type(within(output).getByLabelText("Quantity"), "2.50");
  await user.selectOptions(within(output).getByLabelText("Unit"), "kg");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(
      send.mock.calls.some(
        ([url, init]) => url === "/api/us/traceability/transformation" && init?.method === "POST",
      ),
    ).toBe(true),
  );
  const [, init] = send.mock.calls.find(
    ([url, request]) => url === "/api/us/traceability/transformation" && request?.method === "POST",
  )!;
  const body = JSON.parse(String(init?.body)) as {
    draft: typeof completeDraft;
    operationKey: string;
  };
  expect(body.draft.eventDate).toBe("2026-09-27");
  expect(body.draft.inputs[0]).toMatchObject({
    kind: "ftl_lot",
    quantity: "2.50",
    unitOfMeasure: "kg",
  });
  expect(body.draft.outputs[0]).toMatchObject({ quantity: "2.50", unitOfMeasure: "kg" });
  expect(body.draft.outputs[0]).not.toHaveProperty("lotId");
  expect(body.draft.processorLocationId).toBeNull();
  expect(body.operationKey).toMatch(/^[a-f0-9-]{36}$/);
});

it("shows FTL and documented non-FTL input groups with processor owned output source", async () => {
  const draft = {
    ...completeDraft,
    inputs: [
      completeDraft.inputs[0]!,
      { ...completeDraft.inputs[0]!, lotId: "b0000000-0000-4000-8000-000000000006" },
      {
        kind: "non_ftl" as const,
        productId: null,
        sourceLocationId: null,
        reference: "Supplier batch log",
        quantity: "1",
        unitOfMeasure: "case" as const,
      },
    ],
  };
  await renderTransformation({ draft });
  expect(await screen.findByRole("heading", { name: "TRN-26-0001" })).toBeTruthy();
  expect(screen.getAllByRole("group", { name: /Existing FTL lot/ })).toHaveLength(2);
  expect(screen.getByRole("group", { name: /Documented non-FTL input/ })).toBeTruthy();
  expect(screen.getAllByText(/Output TLC source: transformation location/).length).toBeGreaterThan(
    0,
  );
  expect(screen.queryByLabelText("Closed shift")).toBeNull();
  expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
  expect(screen.queryByLabelText("Output lot ID")).toBeNull();
  expect(emptyTransformationDraft.outputs).toHaveLength(0);
});

it("keeps a documented non-FTL input usable with no FTL lot and bilingual field labels", async () => {
  const draft = {
    ...completeDraft,
    inputs: [
      {
        kind: "non_ftl" as const,
        productId: null,
        sourceLocationId: null,
        reference: "Supplier batch log",
        quantity: "1",
        unitOfMeasure: "case" as const,
      },
    ],
  };
  await renderTransformation({ draft, locale: "es-US" });
  expect(await screen.findByRole("heading", { name: "TRN-26-0001" })).toBeTruthy();
  expect(screen.getByRole("group", { name: /Entrada no FTL documentada/ })).toBeTruthy();
  expect(screen.queryByRole("group", { name: /Lote FTL existente/ })).toBeNull();
  expect(screen.getByLabelText("Fecha de finalización")).toHaveProperty("value", "2026-09-27");
  expect(
    screen.getAllByText("Origen del TLC de salida: ubicación de transformación").length,
  ).toBeGreaterThan(0);
});

it("retains exact create payload on a timeout and reads current state after the same-intent retry", async () => {
  let attempts = 0,
    reads = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/us/traceability/transformation" && init?.method === "POST") {
      attempts++;
      if (attempts === 1) throw new TypeError("timeout");
      const payload = JSON.parse(String(init.body)) as { draft: typeof completeDraft };
      return Response.json(draftRecord(payload.draft));
    }
    if (url === `/api/us/traceability/transformation/${transformationId}`) {
      reads++;
      return Response.json(draftRecord({ ...emptyTransformationDraft, notes: "Retried" }));
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ eventId: null, send });
  await user.type(screen.getByLabelText("Notes"), "Retried");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry same operation" })).toBeTruthy(),
  );
  await user.click(screen.getByRole("button", { name: "Retry same operation" }));
  await waitFor(() => expect(reads).toBe(1));
  expect(attempts).toBe(2);
  const bodies = send.mock.calls
    .filter(([url]) => String(url) === "/api/us/traceability/transformation")
    .map(([, init]) => String(init?.body));
  expect(bodies[0]).toBe(bodies[1]);
  expect(screen.queryByRole("button", { name: "Retry same operation" })).toBeNull();
});

it("keeps local edits and blocks commands after a stale draft-version conflict", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}` && init?.method === "PUT")
      return Response.json({ code: "transformation_draft_conflict" }, { status: 409 });
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(draftRecord());
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send });
  await user.type(await screen.findByLabelText("Notes"), "Local note");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(screen.getByText(/saved version changed/)).toBeTruthy());
  expect(screen.getByLabelText("Notes")).toHaveProperty("value", "Local note");
  expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Reload current record" })).toBeTruthy();
});

it("does not abandon an uncertain saved-command payload when reload is cancelled", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (
      String(input) === `/api/us/traceability/transformation/${transformationId}` &&
      init?.method === "PUT"
    )
      throw new TypeError("timeout");
    if (String(input) === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(draftRecord());
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ send });
  await user.type(await screen.findByLabelText("Notes"), "Uncertain note");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry same operation" })).toBeTruthy(),
  );
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Reload current record" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("operation may still complete"));
  expect(screen.getByRole("button", { name: "Retry same operation" })).toBeTruthy();
  expect(screen.getByLabelText("Notes")).toHaveProperty("value", "Uncertain note");
});

it("locks amendment output identity and requires QA plus write capability to save revision two", async () => {
  const revisionId = "b0000000-0000-4000-8000-000000000007";
  const record = {
    ...draftRecord(completeDraft),
    id: revisionId,
    revision: 2,
    draftVersion: 1,
    lifecycle: {
      ...draftRecord().lifecycle,
      pendingDraftId: revisionId,
      currentEventId: transformationId,
      previousRevisionId: transformationId,
      amendmentReason: "Correction",
      lifecycleVersion: 2,
    },
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input) === `/api/us/traceability/transformation/${revisionId}`)
      return Response.json(record);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const rendered = await renderTransformation({ eventId: revisionId, send, canManageQa: false });
  expect(await screen.findByRole("heading", { name: "TRN-26-0001" })).toBeTruthy();
  expect(screen.getByLabelText("Traceability lot code (TLC)")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
  rendered.rerender(rendered.view(true, true));
  expect(screen.getByLabelText("Traceability lot code (TLC)")).toHaveProperty("disabled", true);
  expect(
    within(screen.getByRole("group", { name: /Output 1/ })).getByLabelText("Quantity"),
  ).toBeTruthy();
});

it("offers current-record recovery after create acknowledgement when its GET fails", async () => {
  let reads = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/us/traceability/transformation" && init?.method === "POST")
      return Response.json(draftRecord());
    if (url === `/api/us/traceability/transformation/${transformationId}`) {
      reads++;
      return reads === 1 ? Response.json({}, { status: 503 }) : Response.json(draftRecord());
    }
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ eventId: null, send });
  await user.type(screen.getByLabelText("Notes"), "Create then recover");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(screen.getByText(/current record could not be loaded/)).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "Reload current record" }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByRole("heading", { name: "TRN-26-0001" })).toBeTruthy();
});

it("keeps intervening non-FTL row edits during a delayed coverage lookup", async () => {
  let resolveProfile!: (value: Response) => void;
  const profilePromise = new Promise<Response>((resolve) => {
    resolveProfile = resolve;
  });
  const product = {
    id: productId,
    name: "Apples",
    gtin14: null,
    archived: false,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const profile = {
    productId,
    revision: 1,
    productName: "Apples",
    brandName: null,
    commodity: null,
    variety: null,
    packagingSizeValue: null,
    packagingSizeUom: null,
    packagingStyle: null,
    defaultQuantityUom: null,
    coverageStatus: "not_covered",
    coverageRationale: "Outside FTL",
    ftlCategory: null,
    ftlSourceUrl: null,
    ftlSourceVersion: null,
    reviewedBy: "qa",
    reviewedAt: "2026-09-27T00:00:00.000Z",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/us/traceability/catalog/products?")) {
      const offset = Number(new URL(url, "https://office.test").searchParams.get("offset"));
      return Response.json({ items: [product], limit: 50, offset });
    }
    if (url === `/api/us/traceability/products/${productId}`) return profilePromise;
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const rendered = await renderTransformation({ eventId: null, send });
  await rendered.user.click(screen.getByRole("button", { name: "Add documented non-FTL input" }));
  const line = screen.getByRole("group", { name: /Documented non-FTL input/ });
  await waitFor(() =>
    expect(
      within(line).getByLabelText("Product").querySelector(`option[value="${productId}"]`),
    ).toBeTruthy(),
  );
  await rendered.user.selectOptions(within(line).getByLabelText("Product"), productId);
  await rendered.user.type(
    within(line).getByLabelText("Source document or reference"),
    "Updated while loading",
  );
  resolveProfile(Response.json(profile));
  await waitFor(() =>
    expect(within(line).getByLabelText("Product")).toHaveProperty("value", productId),
  );
  expect(within(line).getByLabelText("Source document or reference")).toHaveProperty(
    "value",
    "Updated while loading",
  );
});

it("explains an FTL-covered product in the documented non-FTL picker", async () => {
  const product = {
    id: productId,
    name: "Apples",
    gtin14: null,
    archived: false,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/us/traceability/catalog/products?"))
      return Response.json({ items: [product], limit: 50, offset: 0 });
    if (url === `/api/us/traceability/products/${productId}`)
      return Response.json({
        productId,
        revision: 1,
        productName: "Apples",
        brandName: null,
        commodity: null,
        variety: null,
        packagingSizeValue: null,
        packagingSizeUom: null,
        packagingStyle: null,
        defaultQuantityUom: null,
        coverageStatus: "covered",
        coverageRationale: "FTL",
        ftlCategory: "Fresh fruit",
        ftlSourceUrl: "https://www.fda.gov",
        ftlSourceVersion: "2026",
        reviewedBy: "qa",
        reviewedAt: "2026-09-27T00:00:00.000Z",
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
      });
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const { user } = await renderTransformation({ eventId: null, send });
  await user.click(screen.getByRole("button", { name: "Add documented non-FTL input" }));
  const line = screen.getByRole("group", { name: /Documented non-FTL input/ });
  await waitFor(() =>
    expect(
      within(line).getByLabelText("Product").querySelector(`option[value="${productId}"]`),
    ).toBeTruthy(),
  );
  await user.selectOptions(within(line).getByLabelText("Product"), productId);
  expect(
    await screen.findByText("This product is reviewed as FTL. Choose an existing FTL lot instead."),
  ).toBeTruthy();
  expect(within(line).getByLabelText("Product")).toHaveProperty("value", "");
});

it("discards a pending non-FTL profile selection after role loss", async () => {
  let resolveProfile!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveProfile = resolve;
  });
  const product = {
    id: productId,
    name: "Apples",
    gtin14: null,
    archived: false,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/us/traceability/catalog/products?"))
      return Response.json({ items: [product], limit: 50, offset: 0 });
    if (url === `/api/us/traceability/products/${productId}`) return pending;
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  const rendered = await renderTransformation({ eventId: null, send });
  await rendered.user.click(screen.getByRole("button", { name: "Add documented non-FTL input" }));
  const line = screen.getByRole("group", { name: /Documented non-FTL input/ });
  await waitFor(() =>
    expect(
      within(line).getByLabelText("Product").querySelector(`option[value="${productId}"]`),
    ).toBeTruthy(),
  );
  await rendered.user.selectOptions(within(line).getByLabelText("Product"), productId);
  rendered.rerender(rendered.view(false, false));
  resolveProfile(
    Response.json({
      productId,
      revision: 1,
      productName: "Apples",
      brandName: null,
      commodity: null,
      variety: null,
      packagingSizeValue: null,
      packagingSizeUom: null,
      packagingStyle: null,
      defaultQuantityUom: null,
      coverageStatus: "not_covered",
      coverageRationale: "Outside FTL",
      ftlCategory: null,
      ftlSourceUrl: null,
      ftlSourceVersion: null,
      reviewedBy: "qa",
      reviewedAt: "2026-09-27T00:00:00.000Z",
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    }),
  );
  await waitFor(() =>
    expect(within(line).getByLabelText("Product")).toHaveProperty("disabled", true),
  );
  expect(within(line).getByLabelText("Product")).toHaveProperty("value", "");
});
