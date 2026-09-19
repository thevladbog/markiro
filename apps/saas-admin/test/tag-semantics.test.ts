import { describe, expect, it } from "vitest";

import { AGREEMENT_STATUS_TO_PHASE } from "../src/pages/agreements/AgreementsPage.js";
import { invoiceStatusPhase } from "../src/pages/billing/invoice-status.js";
import { BILLING_REQUEST_STATUS_TO_PHASE } from "../src/pages/billing-requests/BillingRequestsPage.js";
import { CATALOG_STATUS_TO_PHASE } from "../src/pages/catalog/CatalogPage.js";
import { grantActivationStatePhase } from "../src/pages/catalog/OfflineGrantActivationPanel.js";
import { PAYMENT_MATCH_STATUS_TO_PHASE } from "../src/pages/payments/PaymentsPage.js";
import { connectionPhase, slotPhase } from "../src/pages/tenants/DeviceLicensingPanel.js";
import { preparationPhase } from "../src/pages/tenants/DeviceReplacementPanel.js";
import { SUBSCRIPTION_STATUS_TO_PHASE } from "../src/pages/tenants/TenantsPage.js";

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

  /**
   * Известный дефект: `StatusChip` в панели подготовки замены устройства получал
   * статический `status="neutral"` при подписи, зависящей от
   * `preparation.state`, — отменённая подготовка выглядела так же, как идущая
   * прямо сейчас операция. `preparationPhase` выводит фазу из состояния;
   * `cancelled` должно оставаться терминальным `retired`, а не читаться как
   * незавершённое `running`.
   */
  it("выводит фазу подготовки замены устройства из состояния и не даёт отменённой фазу running", () => {
    expect(preparationPhase("prepared")).toBe("planned");
    expect(preparationPhase("cancelled")).toBe("retired");
    expect(preparationPhase("cancelled")).not.toBe("running");
  });

  /**
   * Известный дефект: восемь статусов заявки на биллинг получали один и тот же
   * статический `status="neutral"` независимо от `request.status`. Барьер —
   * набор фаз не должен схлопнуться обратно в одно значение.
   */
  it("даёт каждому из восьми статусов заявки на биллинг собственную фазу, а не общий серый", () => {
    expect(BILLING_REQUEST_STATUS_TO_PHASE.new).toBe("planned");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.under_review).toBe("running");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.clarification_required).toBe("attention");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.offer_prepared).toBe("running");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.awaiting_payment).toBe("running");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.in_progress).toBe("running");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.completed).toBe("done");
    expect(BILLING_REQUEST_STATUS_TO_PHASE.cancelled).toBe("retired");
    const distinctPhases = new Set(Object.values(BILLING_REQUEST_STATUS_TO_PHASE));
    expect(distinctPhases.size).toBeGreaterThan(1);
  });

  /**
   * Раньше `unmanaged` был жёлтым (`warn`) наравне с `pending_activation`, хотя
   * это не ожидание активации, а отсутствие управляемой подписки вовсе.
   */
  it("не путает unmanaged-подписку арендатора с ожиданием активации", () => {
    expect(SUBSCRIPTION_STATUS_TO_PHASE.pending_activation).toBe("planned");
    expect(SUBSCRIPTION_STATUS_TO_PHASE.unmanaged).toBe("none");
    expect(SUBSCRIPTION_STATUS_TO_PHASE.unmanaged).not.toBe(
      SUBSCRIPTION_STATUS_TO_PHASE.pending_activation,
    );
  });

  it("даёт superseded и cancelled подписки терминальную retired-фазу", () => {
    expect(SUBSCRIPTION_STATUS_TO_PHASE.superseded).toBe("retired");
    expect(SUBSCRIPTION_STATUS_TO_PHASE.cancelled).toBe("retired");
  });

  /**
   * Раньше `cancelled`/`expired`/`needs_review` схлопывались в один и тот же
   * серый статус — партия, которой нужна ручная проверка, выглядела как обычная
   * отменённая или истёкшая.
   */
  it("даёт офлайн-гранту, ожидающему ручной проверки, фазу attention", () => {
    expect(grantActivationStatePhase("needs_review")).toBe("attention");
    expect(grantActivationStatePhase("needs_review")).not.toBe(
      grantActivationStatePhase("cancelled"),
    );
    expect(grantActivationStatePhase("needs_review")).not.toBe(
      grantActivationStatePhase("expired"),
    );
    expect(grantActivationStatePhase("prepared")).toBe("planned");
    expect(grantActivationStatePhase("confirmed")).toBe("done");
    expect(grantActivationStatePhase("cancelled")).toBe("retired");
    expect(grantActivationStatePhase("expired")).toBe("failed");
  });

  /**
   * Раньше `unmatched` и `rejected` были одним и тем же серым статусом, хотя
   * «нет кандидата на сопоставление» (`none`) и «кандидата отклонил человек»
   * (`retired`) — разные факты.
   */
  it("даёт платежу без кандидата на сопоставление фазу none, а не как у отклонённого", () => {
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.unmatched).toBe("none");
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.unmatched).not.toBe(
      PAYMENT_MATCH_STATUS_TO_PHASE.rejected,
    );
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.suggested).toBe("planned");
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.suggested).not.toBe(
      PAYMENT_MATCH_STATUS_TO_PHASE.unmatched,
    );
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.matched).toBe("done");
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.rejected).toBe("retired");
    expect(PAYMENT_MATCH_STATUS_TO_PHASE.needs_review).toBe("attention");
  });

  /**
   * Раньше `reserved` и `assigned` лицензионного слота схлопывались в одну
   * фазу, хотя «зарезервировано» ещё не занято устройством, а «занято» — идёт
   * прямо сейчас.
   */
  it("не путает лицензионный слот «зарезервировано» с «занято»", () => {
    expect(slotPhase("reserved")).toBe("planned");
    expect(slotPhase("assigned")).toBe("active");
    expect(slotPhase("reserved")).not.toBe(slotPhase("assigned"));
    expect(slotPhase("released")).toBe("retired");
    expect(slotPhase("inconsistent")).toBe("attention");
  });

  /**
   * Раньше офлайн-устройство (`offline`) получало тон, читавшийся как архивная
   * запись, хотя это определённое состояние, требующее внимания, а не
   * терминальный вывод из оборота.
   */
  it("считает офлайн-устройство требующим внимания, а не выведенным из оборота", () => {
    expect(connectionPhase("offline")).toBe("attention");
    expect(connectionPhase("offline")).not.toBe("retired");
    expect(connectionPhase("revoked")).toBe("retired");
    expect(connectionPhase("online")).toBe("active");
    expect(connectionPhase("awaiting_pairing")).toBe("planned");
  });
});
