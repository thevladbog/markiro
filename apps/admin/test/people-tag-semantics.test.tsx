import { describe, expect, it } from "vitest";

import { EMPLOYEE_STATUS_TO_PHASE } from "../src/pages/employees/index.js";
import { DELIVERY_STATUS_TO_PHASE } from "../src/pages/team/TeamPage.js";
import { deviceStatusPhase } from "../src/pages/devices/index.js";
import { licenseSlotPhase } from "../src/pages/devices/DeviceLicensingPanel.js";
import { preparationPhase } from "../src/pages/devices/DeviceReplacementPanel.js";

describe("семантика тегов людей и устройств", () => {
  it("отличает действующего сотрудника от выведенного", () => {
    expect(EMPLOYEE_STATUS_TO_PHASE.active).toBe("active");
    expect(EMPLOYEE_STATUS_TO_PHASE.archived).toBe("retired");
  });

  /**
   * Доставка приглашения — конвейер, и у него есть фаза «выполняется».
   * Раньше `sending` и `queued` были одинаково синими с глифом синхронизации.
   */
  it("разводит очередь и отправку по разным фазам", () => {
    expect(DELIVERY_STATUS_TO_PHASE.queued).toBe("planned");
    expect(DELIVERY_STATUS_TO_PHASE.sending).toBe("running");
    expect(DELIVERY_STATUS_TO_PHASE.retrying).toBe("attention");
  });

  it("считает доставленным и отправленным одну фазу завершения", () => {
    expect(DELIVERY_STATUS_TO_PHASE.sent).toBe("done");
    expect(DELIVERY_STATUS_TO_PHASE.delivered).toBe("done");
  });

  it("разводит сбой доставки и отмену", () => {
    expect(DELIVERY_STATUS_TO_PHASE.failed).toBe("failed");
    expect(DELIVERY_STATUS_TO_PHASE.canceled).toBe("retired");
  });

  /**
   * Правило «error → failed, info → planned/running, neutral → none/retired»
   * было механическим упрощением брифа и разошлось со смыслом состояний
   * устройств: см. правку по находке ревью в
   * .superpowers/sdd/briefs/task-10-report.md.
   */
  it("отозванное устройство терминально, но не является ошибкой", () => {
    expect(deviceStatusPhase("revoked")).toBe("retired");
    expect(deviceStatusPhase("revoked")).not.toBe("failed");
  });

  it("устройство не в сети требует внимания, а не считается отсутствующим значением", () => {
    expect(deviceStatusPhase("offline")).toBe("attention");
    expect(deviceStatusPhase("offline")).not.toBe("none");
  });

  it("сохраняет действующее устройство и ожидание сопряжения без изменений", () => {
    expect(deviceStatusPhase("online")).toBe("active");
    expect(deviceStatusPhase("awaiting_pairing")).toBe("planned");
  });

  it("занятый лицензионный слот действует, а не выполняется", () => {
    expect(licenseSlotPhase("assigned")).toBe("active");
    expect(licenseSlotPhase("assigned")).not.toBe("running");
  });

  it("слот, требующий проверки, требует внимания, а не является сбоем", () => {
    expect(licenseSlotPhase("inconsistent")).toBe("attention");
    expect(licenseSlotPhase("inconsistent")).not.toBe("failed");
  });

  it("сохраняет освобождённый и зарезервированный слот без изменений", () => {
    expect(licenseSlotPhase("released")).toBe("retired");
    expect(licenseSlotPhase("reserved")).toBe("planned");
  });

  /**
   * Раньше фаза подготовки замены была статической `running`: правило
   * механически подставляло прежний тон, и отменённая подготовка показывала
   * вращающуюся стрелку рядом с подписью «Отменено». См. правку по находке
   * ревью в .superpowers/sdd/briefs/task-10-report.md.
   */
  it("отменённая подготовка замены терминальна, а не идёт прямо сейчас", () => {
    expect(preparationPhase("cancelled")).toBe("retired");
    expect(preparationPhase("cancelled")).not.toBe("running");
  });

  it("подготовленная замена ждёт решения оператора, а не выполняется", () => {
    expect(preparationPhase("prepared")).toBe("planned");
    expect(preparationPhase("prepared")).not.toBe("running");
  });
});
