import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("i18n lockstep", () => {
  it("RU and EN have identical key sets", () => {
    expect(flatKeys(ru).sort()).toEqual(flatKeys(en).sort());
  });

  it("localizes the automatic badge-recognition recovery explanation", () => {
    expect(en.login.badgeExplanation).toBe(
      "The station recognizes the code automatically. If the operator was just added, the roster will refresh from the server.",
    );
    expect(ru.login.badgeExplanation).toBe(
      "Станция распознает код автоматически. Если сотрудник добавлен только что, список обновится с сервера.",
    );
  });

  it("tells operators that previously synchronized sign-in remains available after refresh failure", () => {
    expect(en.login.rosterRefreshUnavailable).toBe(
      "Could not refresh the operator list. Check the connection or sign in with previously synchronized data.",
    );
    expect(ru.login.rosterRefreshUnavailable).toBe(
      "Не удалось обновить список операторов. Проверьте связь или войдите с ранее синхронизированными данными.",
    );
  });

  it("keeps every closed updater terminal distinct from transient origin availability", () => {
    expect(en.updates.errors["check-failed"]).toBe(
      "Could not reach either update source. Local work continues.",
    );
    expect(ru.updates.errors["check-failed"]).toBe(
      "Не удалось связаться ни с одним источником обновлений. Локальная работа продолжается.",
    );
    expect(en.updates.errors["policy-denied"]).toBe(
      "Update policy rejected this release. Installation was stopped; Station work continues.",
    );
    expect(ru.updates.errors["policy-denied"]).toBe(
      "Политика обновлений отклонила этот релиз. Установка остановлена, работа станции продолжается.",
    );
    expect(en.updates.errors["candidate-invalid"]).toBe(
      "This update request is no longer current. Check again.",
    );
    expect(ru.updates.errors["candidate-invalid"]).toBe(
      "Этот запрос обновления больше не актуален. Проверьте обновления ещё раз.",
    );
    expect(en.updates.errors["check-superseded"]).toBe(
      "A newer update check replaced this one. Check again.",
    );
    expect(ru.updates.errors["check-superseded"]).toBe(
      "Эту проверку заменила более новая. Проверьте обновления ещё раз.",
    );
    expect(en.updates.errors["internal-error"]).toBe(
      "The update service encountered an internal error. Station work continues.",
    );
    expect(ru.updates.errors["internal-error"]).toBe(
      "Внутренняя ошибка службы обновлений. Работа станции продолжается.",
    );
  });
});
