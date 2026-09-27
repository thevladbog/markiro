import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  bolId,
  completeDraft,
  invoiceId,
  lotId,
  alternateLotId,
  revisionId,
  shippingId,
  draftRecord,
  renderShipping,
  recipientId,
  shipFromId,
} from "./support/us-shipping-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  [
    "en-US",
    /Unit differs from the lot origin/,
    /Balance before replacement: 100 case/,
    /Current recorded lot balance: 100 case/,
  ],
  [
    "es-US",
    /La unidad difiere de la del origen/,
    /Saldo antes del reemplazo: 100 case/,
    /Saldo registrado actual del lote: 100 case/,
  ],
] as const)(
  "uses replacement context and preserves a chosen unit in %s",
  async (locale, warning, previewLabel, wrongCurrentLabel) => {
    const base = draftRecord(
      { ...completeDraft, items: [{ lotId, quantity: "60", unitOfMeasure: "lb" }] },
      2,
    );
    const amendment = {
      ...base,
      id: revisionId,
      revision: 2,
      lifecycle: {
        ...base.lifecycle!,
        rootId: shippingId,
        currentEventId: shippingId,
        pendingDraftId: revisionId,
        previousRevisionId: shippingId,
        lifecycleVersion: 3,
      },
    };
    const { requestedPaths } = await renderShipping({
      initial: amendment,
      eventId: revisionId,
      locale,
      readBalance: async () =>
        Response.json({
          lotId,
          originUom: "case",
          balance: {
            state: "known",
            unitOfMeasure: "case",
            supply: "100",
            used: "0",
            remaining: "100",
          },
        }),
    });
    expect(await screen.findByText(warning)).toBeTruthy();
    expect(screen.getByText(previewLabel)).toBeTruthy();
    expect(screen.queryByText(wrongCurrentLabel)).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: locale === "en-US" ? "Unit" : "Unidad",
        }) as HTMLSelectElement
      ).value,
    ).toBe("lb");
    expect(requestedPaths).toContain(
      `/api/us/traceability/lots/${lotId}/shipping-balance?contextDraftId=${revisionId}&expectedDraftVersion=2`,
    );
  },
);

it("clears saved readiness issues when an origin unit fills an empty draft unit", async () => {
  let resolveRead: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveRead = resolve;
  });
  const initial = draftRecord({
    ...completeDraft,
    items: [{ lotId, quantity: "20", unitOfMeasure: null }],
  });
  const readiness = {
    eventId: shippingId,
    expectedDraftVersion: 1,
    ruleVersion: "shipping-readiness-v1" as const,
    inputDigest: "a".repeat(64),
    state: "incomplete" as const,
    profileCode: "US_FSMA204_PROCESSOR" as const,
    issues: [
      { severity: "error" as const, path: "items[0].unitOfMeasure", code: "required", line: 1 },
    ],
  };
  const { user } = await renderShipping({ initial, readiness, readBalance: async () => pending });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  expect(await screen.findByText(/Unit — Enter or select this required value/)).toBeTruthy();
  await act(async () => {
    resolveRead?.(
      Response.json({
        lotId,
        originUom: "case",
        balance: {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "0",
          remaining: "100",
        },
      }),
    );
    await pending;
  });
  expect((screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement).value).toBe("case");
  expect(screen.queryByText(/Unit — Enter or select this required value/)).toBeNull();
  expect(screen.getByText(/Save changes before checking readiness/)).toBeTruthy();
});

it("ignores a late balance response after the selected lot changes", async () => {
  let resolveRead: ((value: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveRead = resolve;
  });
  const { user } = await renderShipping({
    eventId: null,
    extraLot: true,
    readBalance: async (url) =>
      url.includes(alternateLotId)
        ? Response.json({
            lotId: alternateLotId,
            originUom: "case",
            balance: {
              state: "known",
              unitOfMeasure: "case",
              supply: "50",
              used: "10",
              remaining: "40",
            },
          })
        : pending,
  });
  await user.click(screen.getByRole("button", { name: "Add lot" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), lotId);
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), alternateLotId);
  expect(await screen.findByText(/Current recorded lot balance: 40 case/)).toBeTruthy();
  await act(async () => {
    resolveRead?.(
      Response.json({
        lotId,
        originUom: "case",
        balance: {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "0",
          remaining: "100",
        },
      }),
    );
    await pending;
  });
  expect(screen.getByText(/Current recorded lot balance: 40 case/)).toBeTruthy();
  expect(screen.queryByText(/Current recorded lot balance: 100 case/)).toBeNull();
});

it("does not show a prior lot's known balance while the next lot loads", async () => {
  const pending = new Promise<Response>(() => undefined);
  const { user } = await renderShipping({
    eventId: null,
    extraLot: true,
    readBalance: async (url) =>
      url.includes(alternateLotId)
        ? pending
        : Response.json({
            lotId,
            originUom: "case",
            balance: {
              state: "known",
              unitOfMeasure: "case",
              supply: "100",
              used: "20",
              remaining: "80",
            },
          }),
  });
  await user.click(screen.getByRole("button", { name: "Add lot" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), lotId);
  expect(await screen.findByText(/Current recorded lot balance: 80 case/)).toBeTruthy();
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), alternateLotId);
  expect(screen.queryByText(/Current recorded lot balance: 80 case/)).toBeNull();
  expect(screen.getByText(/Reading current recorded lot balance/)).toBeTruthy();
});

it("saves an existing-lot shipment with exact quantity, recipient and documents", async () => {
  const { user, requestBodies } = await renderShipping({ eventId: null });
  await user.type(screen.getByLabelText("Date shipped"), "2026-09-27");
  await user.selectOptions(screen.getByRole("combobox", { name: "Ship-from" }), shipFromId);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Immediate subsequent recipient" }),
    recipientId,
  );
  await user.click(screen.getByRole("button", { name: "Add lot" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), lotId);
  await user.type(screen.getByLabelText("Quantity"), "100");
  await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "case");
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference document" }), bolId);
  await user.click(screen.getByRole("button", { name: "Attach document" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference document" }), invoiceId);
  await user.click(screen.getByRole("button", { name: "Attach document" }));
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(requestBodies.some(({ body }) => JSON.stringify(body).includes("100"))).toBe(true),
  );
  expect(requestBodies[0]?.body).toMatchObject({ draft: completeDraft });
  expect(JSON.stringify(requestBodies[0]?.body)).not.toMatch(
    /"tlc"|"productId"|"createLot"|"sscc"/i,
  );
  expect(screen.queryByRole("button", { name: /create TLC/i })).toBeNull();
  expect(screen.queryByLabelText(/SSCC/i)).toBeNull();
});

it("provides Spanish field labels and retains identifiers and case units", async () => {
  await renderShipping({ eventId: null, locale: "es-US" });
  expect(screen.getByRole("heading", { name: "Borrador de envío", level: 1 })).toBeTruthy();
  expect(screen.getByLabelText("Fecha de envío")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Guardar borrador" })).toBeTruthy();
});

it("shows current recorded balance and exact draft forecast, defaulting only an empty unit", async () => {
  const { user } = await renderShipping({ eventId: null });
  await user.click(screen.getByRole("button", { name: "Add lot" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Existing lot" }), lotId);
  expect(await screen.findByText(/Current recorded lot balance: 80 case/)).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement).value).toBe("case");
  await user.type(screen.getByLabelText("Quantity"), "60.001");
  expect(await screen.findByText(/Projected after this draft: 19.999 case/)).toBeTruthy();
  expect(screen.getByText(/finalization rechecks/i)).toBeTruthy();
});
