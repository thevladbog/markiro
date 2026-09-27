import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  completeDraft,
  draftRecord,
  renderShipping,
  shippingId,
} from "./support/us-shipping-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows saved-version blocking errors and withholds finalization", async () => {
  const { user } = await renderShipping({
    initial: draftRecord(completeDraft),
    canManageQa: true,
    readiness: {
      eventId: shippingId,
      expectedDraftVersion: 1,
      ruleVersion: "shipping-readiness-v1",
      inputDigest: "a".repeat(64),
      state: "incomplete",
      profileCode: "US_FSMA204_PROCESSOR",
      issues: [{ severity: "error", path: "items[0].quantity", code: "over_shipment", line: 1 }],
    },
  });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  const blockers = await screen.findByRole("alert", { name: "Shipping blockers" });
  expect(blockers.textContent).toContain("Line 1 · Quantity");
  expect(blockers.textContent).toContain("Reduce the shipped quantity");
  expect(blockers.textContent).not.toContain("over_shipment");
  expect(blockers.textContent).not.toContain("items[0].quantity");
  expect(screen.queryByRole("button", { name: "Finalize shipment" })).toBeNull();
});

it.each([
  ["en-US", "Shipping blockers", "Line 2 · Quantity", "Check and correct", "Shipping record"],
  ["es-US", "Bloqueos del envío", "Línea 2 · Cantidad", "Revise y corrija", "Registro de envío"],
] as const)(
  "explains every current readiness code and path in %s without raw tokens",
  async (locale, alertName, lineQuantity, fallback, unknownField) => {
    const issues = [
      ["eventDate", "required"],
      ["timeZone", "format"],
      ["shipFromLocationId", "unavailable"],
      ["recipientLocationId", "inactive"],
      ["shipFromLocationId", "incomplete_description"],
      ["recipientLocationId", "wrong_role"],
      ["recipientLocationId", "same_location"],
      ["documentIds", "required"],
      ["items", "required"],
      ["items[0].source", "source_unresolved"],
      ["items[0].coverage", "coverage_unresolved"],
      ["items[0].origin", "origin_missing"],
      ["items[1].quantity", "balance_unknown"],
      ["items[1].quantity", "balance_exhausted"],
      ["items[1].unitOfMeasure", "uom_mismatch"],
      ["items[1].quantity", "over_shipment"],
      ["items[1].lotId", "duplicate"],
      ["items[1].lotId", "status_blocked"],
      ["items[1].tlc", "required"],
      ["items[1].productId", "unavailable"],
      ["items[1].unitOfMeasure", "format"],
      ["future.path", "future_code"],
    ] as const;
    const { user } = await renderShipping({
      locale,
      initial: draftRecord(completeDraft),
      readiness: {
        eventId: shippingId,
        expectedDraftVersion: 1,
        ruleVersion: "shipping-readiness-v1",
        inputDigest: "a".repeat(64),
        state: "incomplete",
        profileCode: "US_FSMA204_PROCESSOR",
        issues: issues.map(([path, code]) => ({
          severity: "error" as const,
          path,
          code,
          line: path.startsWith("items[1].") ? 2 : path.startsWith("items[0].") ? 1 : null,
        })),
      },
    });
    await user.click(
      await screen.findByRole("button", {
        name: locale === "en-US" ? "Check readiness" : "Comprobar preparación",
      }),
    );
    const blockers = await screen.findByRole("alert", { name: alertName });
    const rows = within(blockers).getAllByRole("listitem");
    expect(rows).toHaveLength(issues.length);
    expect(rows[12]?.textContent).toContain(lineQuantity);
    expect(rows[21]?.textContent).toContain(fallback);
    expect(rows[21]?.textContent).toContain(unknownField);
    for (const [path, code] of issues) {
      expect(blockers.textContent).not.toContain(path);
      if (code.includes("_")) expect(blockers.textContent).not.toContain(code);
    }
    for (const row of rows) expect(row.textContent?.length).toBeGreaterThan(40);
  },
);

it("finalizes only a saved complete version with its server digest", async () => {
  const { user, requestBodies } = await renderShipping({
    initial: draftRecord(completeDraft),
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Check readiness" }));
  await user.click(await screen.findByRole("button", { name: "Finalize shipment" }));
  const dialog = screen.getByRole("dialog", { name: "Finalize shipment" });
  expect(dialog.textContent).toContain("100 case");
  expect(dialog.textContent).toContain("does not identify shipped cases");
  await user.click(screen.getByRole("button", { name: "Confirm finalization" }));
  await waitFor(() =>
    expect(requestBodies.some(({ path }) => path.endsWith("/finalize"))).toBe(true),
  );
  const final = requestBodies.find(({ path }) => path.endsWith("/finalize"));
  expect(final?.body).toMatchObject({
    expectedDraftVersion: 1,
    expectedInputDigest: "a".repeat(64),
  });
  expect(await screen.findByRole("heading", { name: "SHP-26-0001" })).toBeTruthy();
});

it.each([
  [
    "en-US",
    "Shipping blockers",
    [
      "Ship-from location — Complete the ship-from location description",
      "Immediate recipient — Complete the recipient location description",
      "Reference documents — Complete the attached document type and number",
      "Line 1 · Product description — Complete the selected product description",
      "Shipping record — Check and correct this field",
    ],
  ],
  [
    "es-US",
    "Bloqueos del envío",
    [
      "Ubicación de origen — Complete la descripción de la ubicación de origen",
      "Destinatario inmediato — Complete la descripción de la ubicación del destinatario",
      "Documentos de referencia — Complete el tipo y número del documento adjunto",
      "Línea 1 · Descripción del producto — Complete la descripción del producto seleccionado",
      "Registro de envío — Revise y corrija este campo",
    ],
  ],
] as const)(
  "gives path-specific incomplete-description repair in %s",
  async (locale, alertName, expected) => {
    const { user } = await renderShipping({
      locale,
      initial: draftRecord(completeDraft),
      readiness: {
        eventId: shippingId,
        expectedDraftVersion: 1,
        ruleVersion: "shipping-readiness-v1",
        inputDigest: "a".repeat(64),
        state: "incomplete",
        profileCode: "US_FSMA204_PROCESSOR",
        issues: [
          "shipFromLocationId",
          "recipientLocationId",
          "documentIds",
          "items[0].productId",
          "futureDescription",
        ].map((path) => ({
          severity: "error" as const,
          path,
          code: "incomplete_description",
          line: path.startsWith("items[") ? 1 : null,
        })),
      },
    });
    await user.click(
      await screen.findByRole("button", {
        name: locale === "en-US" ? "Check readiness" : "Comprobar preparación",
      }),
    );
    const rows = within(await screen.findByRole("alert", { name: alertName })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(expected.length);
    expected.forEach((message, index) => expect(rows[index]?.textContent).toContain(message));
    rows.forEach((row) => {
      expect(row.textContent).not.toContain("incomplete_description");
      expect(row.textContent).not.toContain("source description");
    });
  },
);
