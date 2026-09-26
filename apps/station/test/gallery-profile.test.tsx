import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { resolveGalleryRequest } from "../src/dev/gallery-fixtures.js";
import { galleryProfile } from "../src/dev/gallery-profile.js";
import { StationScreenGallery } from "../src/dev/StationScreenGallery.js";

afterEach(() => {
  cleanup();
});

describe("gallery profiles", () => {
  it("reads the landing profile from the address and leaves other requests unchanged", () => {
    expect(
      resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&locale=ru&profile=landing"),
    ).toEqual({ state: "work-aggregation", locale: "ru", profile: "landing" });
    expect(resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&locale=ru")).toEqual({
      state: "work-aggregation",
      locale: "ru",
    });
    expect(
      resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&profile=unknown"),
    ).toEqual({ state: "work-aggregation", locale: "ru" });
  });

  it("keeps the instructions profile identical to the original demo data", () => {
    const ru = galleryProfile("instructions", "ru");
    const en = galleryProfile("instructions", "en");
    expect([
      ru.productName,
      ru.counterpartyName,
      ru.station,
      ru.line,
      ru.operator,
      ru.shift,
    ]).toEqual([
      "Тестовый товар А",
      "ООО «Тестовый производитель»",
      "Демо-станция 01",
      "Тестовая линия А",
      "Оператор Тестов",
      "Смена ДЕМО-01",
    ]);
    expect([en.productName, en.line, en.shift]).toEqual([
      "Sample product A",
      "Test line A",
      "Shift DEMO-01",
    ]);
    expect([ru.serial(128), ru.serial(123), ru.terminal(11)]).toEqual([
      "DEMO-SERIAL-000128",
      "DEMO-SERIAL-000123",
      "DEMO-TERM-11",
    ]);
  });

  it.each(["work-aggregation", "work-pallet-20", "offline", "conflicts-page-1"] as const)(
    "shows no test data on %s with the landing profile",
    async (state) => {
      for (const locale of ["ru", "en"] as const) {
        const view = render(
          <StationScreenGallery request={{ state, locale, profile: "landing" }} />,
        );
        await view.findByTestId("station-screen-gallery");
        const text = document.body.textContent ?? "";
        expect(text, `${state} ${locale}`).not.toMatch(
          /Тестов|Демо-станция|DEMO-|Sample product|Sample Manufacturer|Test line|Demo station/u,
        );
        cleanup();
      }
    },
  );

  it("names the landing product on the work screen", async () => {
    const view = render(
      <StationScreenGallery
        request={{ state: "work-aggregation", locale: "ru", profile: "landing" }}
      />,
    );
    expect((await view.findAllByText("Сок яблочный, 1 л")).length).toBeGreaterThan(0);
  });
});
