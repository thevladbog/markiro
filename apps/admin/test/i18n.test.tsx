import { cleanup, render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";
import i18n from "../src/i18n/index.js";

function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

function Probe() {
  const { t } = useTranslation();
  return <p>{t("auth.login.title")}</p>;
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ru");
});

describe("i18n", () => {
  it("renders Russian by default", () => {
    render(<Probe />);
    expect(screen.getByText("Вход")).toBeDefined();
  });

  it("switches to English on changeLanguage", async () => {
    render(<Probe />);
    expect(screen.getByText("Вход")).toBeDefined();

    await i18n.changeLanguage("en");

    expect(screen.getByText("Sign in")).toBeDefined();
  });

  it("throws instead of silently rendering a missing key (test-env guard)", () => {
    function BrokenProbe() {
      const { t } = useTranslation();
      return <p>{t("auth.login.thisKeyDoesNotExist")}</p>;
    }
    expect(() => render(<BrokenProbe />)).toThrow(/Missing i18n key/);
  });
});

describe("i18n lockstep", () => {
  it("RU and EN have identical key sets", () => {
    expect(flatKeys(ru).sort()).toEqual(flatKeys(en).sort());
  });
});
