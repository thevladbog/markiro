import { describe, expect, it } from "vitest";

import type { CatalogVersionDto } from "../src/pages/catalog/api.js";
import {
  calculateDocumentTotals,
  createLineFromCatalog,
  documentDraftReducer,
  toInvoiceCreateInput,
  toOfferCreateInput,
  validateDocumentDraft,
  type DocumentDraft,
} from "../src/pages/documents/documentDraft.js";

const plan = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "plan-basic",
  kind: "plan",
  version: 3,
  status: "published",
  nameRu: "Базовый",
  nameEn: "Basic",
  descriptionRu: null,
  descriptionEn: null,
  unit: "месяц",
  billingMode: "recurring",
  billingPeriod: "month",
  unitPrice: "120.00",
  vatRateBps: 2000,
  vatIncluded: true,
  publishedAt: "2026-08-01T00:00:00.000Z",
  publishedByPlatformUserId: "31111111-1111-4111-8111-111111111111",
  plan: {
    maxLines: null,
    maxStations: null,
    maxKiosks: null,
    maxCabinetUsers: null,
    labelEditorEnabled: false,
    publicApiEnabled: false,
    palletsEnabled: false,
    demoDurationDays: null,
  },
} satisfies CatalogVersionDto;

const { plan: ignoredPlan, ...catalogBase } = plan;
void ignoredPlan;

const addon = {
  ...catalogBase,
  id: "12222222-1111-4111-8111-111111111111",
  catalogItemId: "22222222-1111-4111-8111-111111111111",
  catalogItemCode: "addon-lines",
  kind: "addon",
  nameRu: "Дополнительные линии",
  nameEn: "Additional lines",
  unitPrice: "100.00",
  vatIncluded: false,
  addon: { effects: [{ key: "lines", quotaIncrement: 10 }] },
} satisfies CatalogVersionDto;

const service = {
  ...catalogBase,
  id: "13333333-1111-4111-8111-111111111111",
  catalogItemId: "23333333-1111-4111-8111-111111111111",
  catalogItemCode: "service-training",
  kind: "service",
  nameRu: "Обучение",
  nameEn: "Training",
  unit: "час",
  unitPrice: "0.10",
  vatRateBps: null,
  vatIncluded: false,
  service: {},
} satisfies CatalogVersionDto;

function draft(lines: DocumentDraft["lines"] = []): DocumentDraft {
  return {
    tenantId: "41111111-1111-4111-8111-111111111111",
    applicationMode: "automatic",
    date: "2026-09-01",
    lines,
  };
}

describe("document draft reducer", () => {
  it("adds catalog plan, add-on, and service with their fixed commercial terms", () => {
    const withPlan = documentDraftReducer(draft(), {
      type: "catalog.added",
      version: plan,
      id: "line-plan",
    });
    const withAddon = documentDraftReducer(withPlan, {
      type: "catalog.added",
      version: addon,
      id: "line-addon",
    });
    const result = documentDraftReducer(withAddon, {
      type: "catalog.added",
      version: service,
      id: "line-service",
    });

    expect(result.lines).toEqual([
      {
        id: "line-plan",
        kind: "plan",
        catalogVersionId: plan.id,
        catalogItemCode: "plan-basic",
        version: 3,
        nameRu: "Базовый",
        nameEn: "Basic",
        quantity: 1,
        unit: "месяц",
        agreedUnitPrice: "120.00",
        vatRateBps: 2000,
        vatIncluded: true,
        activationPolicy: "immediate",
      },
      expect.objectContaining({
        id: "line-addon",
        kind: "addon",
        agreedUnitPrice: "100.00",
        vatIncluded: false,
        activationPolicy: "immediate",
      }),
      expect.objectContaining({
        id: "line-service",
        kind: "service",
        agreedUnitPrice: "0.10",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: null,
      }),
    ]);
  });

  it("increments the existing line for a repeated catalog version unless explicitly separate", () => {
    const initial = documentDraftReducer(draft(), {
      type: "catalog.added",
      version: plan,
      id: "line-plan",
    });
    const combined = documentDraftReducer(initial, {
      type: "catalog.added",
      version: plan,
      id: "unused-id",
    });
    const separate = documentDraftReducer(combined, {
      type: "catalog.added",
      version: plan,
      separate: true,
      id: "line-plan-second",
    });

    expect(combined.lines).toHaveLength(1);
    expect(combined.lines[0]?.quantity).toBe(2);
    expect(separate.lines).toMatchObject([
      { id: "line-plan", quantity: 2 },
      { id: "line-plan-second", quantity: 1 },
    ]);
  });

  it("keeps separate version lines uniquely addressable after removing an earlier line", () => {
    const first = documentDraftReducer(draft(), {
      type: "catalog.added",
      version: plan,
      separate: true,
      id: "plan-v1",
    });
    const second = documentDraftReducer(first, {
      type: "catalog.added",
      version: plan,
      separate: true,
      id: "plan-v2",
    });
    const afterRemoval = documentDraftReducer(second, { type: "line.removed", id: "plan-v1" });
    const third = documentDraftReducer(afterRemoval, {
      type: "catalog.added",
      version: plan,
      separate: true,
      id: "plan-v3",
    });
    const edited = documentDraftReducer(third, {
      type: "line.priceChanged",
      id: "plan-v2",
      price: "99.99",
    });

    expect(third.lines.map((line) => line.id)).toEqual(["plan-v2", "plan-v3"]);
    expect(edited.lines).toMatchObject([
      { id: "plan-v2", agreedUnitPrice: "99.99" },
      { id: "plan-v3", agreedUnitPrice: "120.00" },
    ]);
  });

  it("rejects an added catalog line without an action-boundary identity", () => {
    const missingId = {
      type: "catalog.added",
      version: plan,
      separate: true,
    } as unknown as Parameters<typeof documentDraftReducer>[1];

    expect(() => documentDraftReducer(draft(), missingId)).toThrow("document_line_id_required");
  });

  it("removes a line and only moves it inside the visible boundaries", () => {
    const initial = draft([
      createLineFromCatalog(plan, "line-plan"),
      createLineFromCatalog(addon, "line-addon"),
      createLineFromCatalog(service, "line-service"),
    ]);
    const topStayedPut = documentDraftReducer(initial, {
      type: "line.moved",
      id: "line-plan",
      direction: -1,
    });
    const moved = documentDraftReducer(topStayedPut, {
      type: "line.moved",
      id: "line-addon",
      direction: 1,
    });
    const bottomStayedPut = documentDraftReducer(moved, {
      type: "line.moved",
      id: "line-addon",
      direction: 1,
    });
    const removed = documentDraftReducer(bottomStayedPut, { type: "line.removed", id: "line-service" });

    expect(topStayedPut.lines.map((line) => line.id)).toEqual([
      "line-plan",
      "line-addon",
      "line-service",
    ]);
    expect(moved.lines.map((line) => line.id)).toEqual([
      "line-plan",
      "line-service",
      "line-addon",
    ]);
    expect(bottomStayedPut.lines.map((line) => line.id)).toEqual(moved.lines.map((line) => line.id));
    expect(removed.lines.map((line) => line.id)).toEqual(["line-plan", "line-addon"]);
  });

  it("keeps an invalid entered quantity so validation can show its line error", () => {
    const changed = documentDraftReducer(draft([createLineFromCatalog(plan, "line-plan")]), {
      type: "line.quantityChanged",
      id: "line-plan",
      quantity: 0,
    });

    expect(changed.lines[0]?.quantity).toBe(0);
    expect(validateDocumentDraft(changed)).toMatchObject({
      "lines.line-plan.quantity": "quantity_must_be_positive_integer",
    });
  });

  it("changes only plan and add-on activation policies", () => {
    const initial = draft([
      createLineFromCatalog(plan, "line-plan"),
      createLineFromCatalog(addon, "line-addon"),
      createLineFromCatalog(service, "line-service"),
    ]);
    const planChanged = documentDraftReducer(initial, {
      type: "line.policyChanged",
      id: "line-plan",
      policy: "after_current",
    });
    const addonChanged = documentDraftReducer(planChanged, {
      type: "line.policyChanged",
      id: "line-addon",
      policy: "immediate",
    });
    const serviceUnchanged = documentDraftReducer(addonChanged, {
      type: "line.policyChanged",
      id: "line-service",
      policy: "immediate",
    });

    expect(serviceUnchanged.lines).toMatchObject([
      { id: "line-plan", activationPolicy: "after_current" },
      { id: "line-addon", activationPolicy: "immediate" },
      { id: "line-service", activationPolicy: null },
    ]);
  });
});

describe("exact preview totals", () => {
  it("splits a VAT-included 120.00 price at 20 percent without floating-point arithmetic", () => {
    expect(calculateDocumentTotals([createLineFromCatalog(plan, "line-plan")])).toEqual({
      subtotal: "100.00",
      vatTotal: "20.00",
      total: "120.00",
    });
  });

  it("adds VAT to a VAT-excluded 100.00 price at 20 percent", () => {
    expect(calculateDocumentTotals([createLineFromCatalog(addon, "line-addon")])).toEqual({
      subtotal: "100.00",
      vatTotal: "20.00",
      total: "120.00",
    });
  });

  it("uses offer backend half-up rounding for a 0.03 VAT-excluded price", () => {
    const offerLine = {
      ...createLineFromCatalog(addon, "line-addon"),
      agreedUnitPrice: "0.03",
    };

    expect(calculateDocumentTotals("offer", [offerLine])).toEqual({
      subtotal: "0.03",
      vatTotal: "0.01",
      total: "0.04",
    });
  });

  it("uses exact cents for mixed VAT lines and decimal quantities", () => {
    const serviceLine = { ...createLineFromCatalog(service, "line-service"), quantity: 3 };

    expect(
      calculateDocumentTotals([createLineFromCatalog(plan, "line-plan"), serviceLine]),
    ).toEqual({
      subtotal: "100.30",
      vatTotal: "20.00",
      total: "120.30",
    });
  });
});

describe("document draft validation and request adapters", () => {
  it("blocks missing tenant, empty or oversized lines, invalid money, and missing plan or add-on policy", () => {
    const invalidPlan = {
      ...createLineFromCatalog(plan, "line-plan"),
      agreedUnitPrice: "12.5",
      activationPolicy: null,
    };
    const invalidAddon = {
      ...createLineFromCatalog(addon, "line-addon"),
      activationPolicy: null,
    };
    const tooManyLines = Array.from({ length: 101 }, (_, index) => ({
      ...createLineFromCatalog(service, `line-${index}`),
    }));

    expect(validateDocumentDraft({ ...draft([invalidPlan, invalidAddon]), tenantId: "" })).toMatchObject({
      tenantId: "tenant_required",
      "lines.line-plan.agreedUnitPrice": "money_must_have_two_decimal_places",
      "lines.line-plan.activationPolicy": "activation_policy_required",
      "lines.line-addon.activationPolicy": "activation_policy_required",
    });
    expect(validateDocumentDraft(draft())).toEqual({ lines: "at_least_one_line_required" });
    expect(validateDocumentDraft(draft(tooManyLines))).toEqual({ lines: "too_many_lines" });
  });

  it("maps invoice and offer policies at their backend boundary while keeping services null", () => {
    const source = draft([
      { ...createLineFromCatalog(plan, "line-plan"), activationPolicy: "immediate" },
      { ...createLineFromCatalog(addon, "line-addon"), activationPolicy: "after_current" },
      createLineFromCatalog(service, "line-service"),
    ]);

    expect(toInvoiceCreateInput(source)).toEqual({
      tenantId: source.tenantId,
      dueDate: "2026-09-01",
      applicationMode: "automatic",
      lines: [
        expect.objectContaining({ kind: "plan", activationPolicy: "immediate" }),
        expect.objectContaining({ kind: "addon", activationPolicy: "after_current" }),
        expect.objectContaining({ kind: "service", activationPolicy: null }),
      ],
    });
    expect(toOfferCreateInput(source)).toEqual({
      tenantId: source.tenantId,
      expiresAt: "2026-09-01",
      lines: [
        expect.objectContaining({ kind: "plan", activationPolicy: "immediately" }),
        expect.objectContaining({ kind: "addon", activationPolicy: "after_current" }),
        expect.objectContaining({ kind: "service", activationPolicy: null }),
      ],
    });
  });

  it("rejects a manual policy before it can become an immediate offer policy", () => {
    const source = draft([
      { ...createLineFromCatalog(plan, "line-plan"), activationPolicy: "manual" },
    ]);

    expect(() => toOfferCreateInput(source)).toThrow("offer_manual_activation_policy_unsupported");
  });
});
