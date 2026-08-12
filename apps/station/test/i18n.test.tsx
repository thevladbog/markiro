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
});
