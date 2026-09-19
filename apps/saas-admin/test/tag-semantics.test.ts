import { describe, expect, it } from "vitest";

import { AGREEMENT_STATUS_TO_PHASE } from "../src/pages/agreements/AgreementsPage.js";
import { invoiceStatusPhase } from "../src/pages/billing/invoice-status.js";
import { CATALOG_STATUS_TO_PHASE } from "../src/pages/catalog/CatalogPage.js";

describe("семантика тегов платформенной панели", () => {
  it("даёт подписанному договору тон завершения", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.signed).toBe("done");
  });

  /**
   * Расторгнутый договор получал `warn`, а с ним — глиф дубликата.
   * Расторжение это вывод из оборота, а не предупреждение.
   */
  it("не даёт расторгнутому договору глиф дубликата", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.terminated).toBe("retired");
  });

  it("оставляет черновик договора черновиком", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.draft).toBe("draft");
  });

  it("считает частичную оплату поводом для внимания", () => {
    expect(invoiceStatusPhase("partially_paid")).toBe("attention");
    expect(invoiceStatusPhase("paid")).toBe("done");
    expect(invoiceStatusPhase("cancelled")).toBe("retired");
    expect(invoiceStatusPhase("draft")).toBe("draft");
  });

  /**
   * Опубликованная позиция каталога — действующая, а не завершённая:
   * она прямо сейчас продаётся.
   */
  it("считает опубликованную позицию каталога действующей", () => {
    expect(CATALOG_STATUS_TO_PHASE.published).toBe("active");
    expect(CATALOG_STATUS_TO_PHASE.draft).toBe("draft");
    expect(CATALOG_STATUS_TO_PHASE.retired).toBe("retired");
  });
});
