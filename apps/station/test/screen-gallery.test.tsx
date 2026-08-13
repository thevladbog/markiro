import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPECTED_GALLERY_STATE_IDS,
  GALLERY_FIXTURES,
  findMissingGalleryStates,
  resolveGalleryRequest,
} from "../src/dev/gallery-fixtures.js";
import { shouldRenderGallery } from "../src/dev/gallery-guard.js";
import { StationScreenGallery } from "../src/dev/StationScreenGallery.js";
import { PERSISTENT_GALLERY_STATE_IDS } from "../src/ui/persistent-station-states.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("development screen gallery", () => {
  it("keeps the gallery unreachable outside development even when the query requests it", () => {
    expect(shouldRenderGallery(false, "?gallery=1&state=work-ok&locale=en")).toBe(false);
    expect(shouldRenderGallery(true, "?gallery=0&state=work-ok")).toBe(false);
    expect(shouldRenderGallery(true, "?state=work-ok")).toBe(false);
    expect(shouldRenderGallery(true, "?gallery=1&state=work-ok&locale=en")).toBe(true);

    expect(resolveGalleryRequest(false, "?gallery=1&state=work-ok&locale=en")).toBeNull();

    expect(resolveGalleryRequest(true, "?gallery=1&state=work-ok&locale=en")).toEqual({
      state: "work-ok",
      locale: "en",
    });
  });

  it("falls back deterministically for unknown state and locale values", () => {
    expect(resolveGalleryRequest(true, "?gallery=1&state=not-a-screen&locale=de")).toEqual({
      state: "pairing-waiting",
      locale: "ru",
    });
  });

  it("reports a missing fixture from the independently maintained expected-state list", () => {
    expect(findMissingGalleryStates(GALLERY_FIXTURES, PERSISTENT_GALLERY_STATE_IDS)).toEqual([]);

    expect(PERSISTENT_GALLERY_STATE_IDS).toEqual(
      expect.arrayContaining([
        "new-shift-input",
        "new-shift-found",
        "new-shift-not-found",
        "shift-loading",
        "shift-read-error",
        "shift-empty",
        "exception-applying",
        "serial-exhaustion",
        "conflicts-loading",
        "conflicts-read-error",
        "conflicts-empty",
        "credential-recovery-sealing",
        "credential-recovery-failed",
        "credential-recovery-ready",
        "print-verification",
        "print-mismatch",
        "print-not-sscc",
      ]),
    );

    const withoutPrintVerification = GALLERY_FIXTURES.filter(
      (fixture) => fixture.id !== "print-verification",
    );
    expect(
      findMissingGalleryStates(withoutPrintVerification, PERSISTENT_GALLERY_STATE_IDS),
    ).toEqual(["print-verification"]);
    expect(EXPECTED_GALLERY_STATE_IDS).toContain("print-verification");
  });

  it("renders every expected state through the real fixed station shell without external reads", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("gallery must not use the network")));
    vi.stubGlobal("fetch", fetchSpy);

    for (const state of EXPECTED_GALLERY_STATE_IDS) {
      const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);

      expect(screen.getByTestId("station-screen-gallery").getAttribute("data-gallery-state")).toBe(
        state,
      );
      expect(view.container.querySelector(".station-root")).not.toBeNull();
      expect(view.container.querySelector(".station-screen-slot")).not.toBeNull();

      view.unmount();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders locale-specific long-copy fixtures inside the captured shell", () => {
    const { rerender } = render(
      <StationScreenGallery request={{ state: "long-copy-ru", locale: "ru" }} />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Продолжительная автономная работа на производственной линии",
      }),
    ).not.toBeNull();

    rerender(<StationScreenGallery request={{ state: "long-copy-en", locale: "en" }} />);
    expect(
      screen.getByRole("heading", {
        name: "Extended offline operation on the production line",
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      "ru",
      "Доступно критическое обновление 0.1.0-beta.123",
      "Сменить оператора",
      "Выйти из полноэкранного режима",
    ],
    ["en", "Critical update 0.1.0-beta.123 is available", "Change operator", "Exit fullscreen"],
  ] as const)(
    "renders the real %s floor-header controls with long labels for viewport review",
    async (locale, updateLabel, operatorLabel, windowLabel) => {
      const view = render(
        <StationScreenGallery request={{ state: "floor-header-actions", locale }} />,
      );

      const header = screen.getByRole("banner", {
        name: locale === "ru" ? "Состояние станции" : "Station status",
      });
      const actions = within(header).getByRole("group");
      const update = within(actions).getByRole("button", { name: `! ${updateLabel}` });
      const operator = within(actions).getByRole("button", { name: operatorLabel });
      const windowMode = await within(actions).findByRole("button", { name: windowLabel });

      expect(actions.children).toHaveLength(3);
      expect(update.getAttribute("data-update-severity")).toBe("urgent");
      expect(operator.classList.contains("mk-btn--floor")).toBe(true);
      expect(operator.style.height).toBe("var(--control-floor)");
      expect(windowMode.closest(".window-mode-control")).not.toBeNull();
      expect(view.container.querySelector(".station-floor-window-chrome")).toBeNull();
    },
  );

  it("renders the real window-mode error inside the header action rail", async () => {
    render(<StationScreenGallery request={{ state: "floor-header-window-error", locale: "ru" }} />);

    const actions = within(screen.getByRole("banner", { name: "Состояние станции" })).getByRole(
      "group",
    );
    const error = await within(actions).findByRole("alert");
    expect(error.textContent).toContain("Производство продолжается");
    expect(
      within(error).getByRole("button", { name: "Закрыть сообщение об ошибке режима окна" }),
    ).toBeDefined();
    expect(error.closest(".window-mode-control")).not.toBeNull();
  });

  it("renders the five-result name-search worst case with floor-sized targets", () => {
    const view = render(
      <StationScreenGallery request={{ state: "login-name-search", locale: "ru" }} />,
    );
    const ruResults = within(screen.getByTestId("gallery-name-search-results")).getAllByRole(
      "button",
    );

    expect(ruResults).toHaveLength(5);
    expect(view.container.textContent).toContain("Александрова-Романовская Екатерина Владимировна");
    for (const result of ruResults) {
      expect(result.classList.contains("mk-btn--floor")).toBe(true);
      expect(result.style.height).toBe("var(--control-floor)");
    }

    view.rerender(<StationScreenGallery request={{ state: "login-name-search", locale: "en" }} />);
    const enResults = within(screen.getByTestId("gallery-name-search-results")).getAllByRole(
      "button",
    );
    expect(enResults).toHaveLength(5);
    expect(view.container.textContent).toContain("Alexandria Montgomery-Wellington the Third");
  });

  it.each([
    ["new-shift-input", "GTIN товара"],
    ["new-shift-found", "Тестовый товар А"],
    ["new-shift-not-found", "Товар не найден"],
    ["shift-loading", "Загрузка смен"],
    ["shift-read-error", "Не удалось загрузить смены"],
    ["shift-empty", "Открытых смен нет"],
    ["exception-applying", "Запись сохраняется в локальный журнал"],
    ["serial-exhaustion", "Продолжение сканирования заблокировано"],
    ["conflicts-loading", "Загрузка конфликтов"],
    ["conflicts-read-error", "Не удалось прочитать локальные конфликты"],
    ["conflicts-empty", "Конфликтов нет"],
    ["credential-recovery-sealing", "подготавливаются к безопасному восстановлению"],
    ["credential-recovery-failed", "Не удалось подготовить локальные данные"],
    ["credential-recovery-ready", "Сохранено: 12 сканирований"],
    ["print-mismatch", "SSCC другого короба"],
    ["print-not-sscc", "не распознан SSCC"],
  ] as const)("renders distinct persistent viewport %s", (state, expectedCopy) => {
    const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);
    expect(view.container.textContent).toContain(expectedCopy);
  });
});
