import { cleanup, render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../src/i18n/index.js";

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
