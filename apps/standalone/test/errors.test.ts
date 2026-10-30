import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HostError, TRANSPORT_CODES } from "../src/host/client.js";
import { DEVICE_ERROR_CODES, DeviceError } from "../src/host/device.js";
import { API_ERROR_CODES, errorMessageKey } from "../src/host/errors.js";
import i18n from "../src/i18n/index.js";

function apiError(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 400, message: code, details });
}

// See test/protocol.test.ts: bind the module's URL before it is used, so the
// jsdom test environment does not rewrite a literal `new URL(..., import.meta.url)`.
const testModuleUrl = import.meta.url;

describe("error messages", () => {
  it("have a text for every code the shell and the host send", () => {
    const keys = [
      ...TRANSPORT_CODES.map((code) =>
        errorMessageKey(new HostError({ kind: "transport", code, message: code })),
      ),
      ...API_ERROR_CODES.map((code) => errorMessageKey(apiError(code))),
      ...(["device", "session", "password"] as const).map((credential) =>
        errorMessageKey(apiError("unauthorized", { credential })),
      ),
      ...DEVICE_ERROR_CODES.map((code) => errorMessageKey(new DeviceError(code, code))),
    ];
    for (const key of keys) {
      expect(i18n.exists(key), key).toBe(true);
    }
  });

  it("say that a host which did not answer in time did not answer in time", () => {
    const timeout = new HostError({ kind: "transport", code: "timeout", message: "timeout" });
    expect(errorMessageKey(timeout)).toBe("errors.transport.timeout");
    expect(i18n.t("errors.transport.timeout")).toBe("Хост не ответил вовремя.");
  });

  it("explains host backup identity and Windows restoration without internal terms", () => {
    expect(i18n.t("yandex.errors.identity_missing")).toBe(
      "Файл с идентификатором, сертификатом и ключом хоста отсутствует или не прошёл проверку. Создайте новую резервную копию на хосте. Если ошибка повторится, обратитесь в поддержку Маркиро.",
    );
    expect(i18n.t("yandex.identityIncluded")).toBe(
      "В составе копии указаны идентификатор, сертификат и ключ хоста.",
    );
    expect(i18n.t("yandex.restoreReady")).toBe(
      "Копия скачана и проверена. Для восстановления нужны права администратора Windows. Перед заменой данных программа повторит проверку базы и данных хоста.",
    );
  });

  it("describes the information included in a saved activation request", () => {
    expect(i18n.t("office.about.license.activation.hint")).toBe(
      "Сохраните запрос и отправьте файл в Маркиро для выпуска лицензии. Он содержит название и ИНН организации, сведения о хосте и лицензии. В запрос также могут входить зашифрованные сведения об использовании программы и компьютере.",
    );
  });

  it("keeps pending records recoverable through pairing as the same device", () => {
    expect(i18n.t("shell.unsent.body", { records: 2 })).toBe(
      "На этом компьютере остались неотправленные записи смен: 2. После сброса подключения они сохранятся на диске этого ПК. Если восстановить подключение этого устройства к прежнему хосту, автоматическая отправка может возобновиться. Если выбрать «Подключить как новое устройство», прежние записи автоматически не отправятся.",
    );
    expect(i18n.t("shell.unsent.bodyUnknown")).toBe(
      "Не удалось посчитать неотправленные записи смен. После сброса подключения они сохранятся на диске этого ПК. Если восстановить подключение этого устройства к прежнему хосту, автоматическая отправка может возобновиться. Если выбрать «Подключить как новое устройство», прежние записи автоматически не отправятся.",
    );
    expect(i18n.t("floor.unpair.unsent", { n: 2 })).toBe(
      "Не отправлено на хост записей: 2. После отвязки они сохранятся на диске этого компьютера. Если восстановить подключение этого устройства к прежнему хосту, автоматическая отправка может возобновиться. Если выбрать «Подключить как новое устройство», прежние записи автоматически не отправятся. Лучше дождаться отправки или сначала разобрать очередь.",
    );
    expect(i18n.t("floor.unpair.unsentUnknown")).toBe(
      "Не удалось посчитать неотправленные записи. Если они есть, после отвязки они сохранятся на диске этого компьютера. Если восстановить подключение этого устройства к прежнему хосту, автоматическая отправка может возобновиться. Если выбрать «Подключить как новое устройство», прежние записи автоматически не отправятся.",
    );
    expect(i18n.t("errors.device.unsent_facts")).toBe(
      "Сброс подключения остановлен: на компьютере могут оставаться неотправленные данные смен. Дождитесь отправки или подтвердите сброс: данные сохранятся на диске этого ПК. Если восстановить подключение этого устройства к прежнему хосту, автоматическая отправка может возобновиться. Если выбрать «Подключить как новое устройство», прежние записи автоматически не отправятся.",
    );
  });

  it("prefer the rejected credential for unauthorized answers", () => {
    expect(errorMessageKey(apiError("unauthorized", { credential: "password" }))).toBe(
      "errors.unauthorized.password",
    );
    expect(errorMessageKey(apiError("unauthorized"))).toBe("errors.api.unauthorized");
  });

  it("fall back to a generic text for anything unknown", () => {
    expect(errorMessageKey(apiError("from_a_newer_host"))).toBe("errors.unknown");
    expect(errorMessageKey(new Error("boom"))).toBe("errors.unknown");
    expect(errorMessageKey("boom")).toBe("errors.unknown");
  });

  it("list exactly the host's error codes (proto/fixtures/error-codes.json)", () => {
    const fixture = z
      .object({ codes: z.array(z.string()) })
      .parse(
        JSON.parse(
          readFileSync(new URL("../proto/fixtures/error-codes.json", testModuleUrl), "utf8"),
        ),
      );
    expect([...API_ERROR_CODES].sort()).toEqual([...fixture.codes].sort());
  });
});
