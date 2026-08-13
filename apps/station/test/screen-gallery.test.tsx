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
        "box-print-template-missing",
        "box-print-printer-unconfigured",
        "box-print-render-failed",
        "box-print-transport-failed",
        "box-print-skip-confirm",
      ]),
    );

    const withoutPrintVerification = GALLERY_FIXTURES.filter(
      (fixture) => fixture.id !== "print-verification",
    );
    expect(
      findMissingGalleryStates(withoutPrintVerification, PERSISTENT_GALLERY_STATE_IDS),
    ).toEqual(["print-verification"]);
    expect(EXPECTED_GALLERY_STATE_IDS).toContain("print-verification");
    expect(EXPECTED_GALLERY_STATE_IDS).toEqual(
      expect.arrayContaining([
        "box-print-template-missing",
        "box-print-printer-unconfigured",
        "box-print-render-failed",
        "box-print-transport-failed",
        "box-print-skip-confirm",
      ]),
    );
  });

  it("renders aggregation with the production scan, 20-place box, and six-row history instruments", () => {
    const view = render(
      <StationScreenGallery request={{ state: "work-aggregation", locale: "ru" }} />,
    );

    const scan = view.container.querySelector<HTMLElement>(".work-scan-result");
    expect(scan).not.toBeNull();
    expect(scan?.querySelector('[data-semantic="accepted-marker"]')?.textContent).toBe("✓");
    expect(scan?.querySelector('[data-semantic="normalized-code"]')?.textContent).toBe(
      "(01)04607000000042 (21)DEMO-SERIAL-000128 (91)ABCD " +
        "(92)TEST-LONG-CRYPTO-TAIL-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789 (93)XYZ1",
    );
    expect(scan?.querySelector('[data-semantic="verdict"]')).toBeNull();
    expect(scan?.querySelector('[data-semantic="gtin"]')).toBeNull();
    expect(scan?.querySelector('[data-semantic="serial"]')).toBeNull();
    expect(scan?.querySelector('[data-semantic="crypto"]')).toBeNull();
    expect(scan?.textContent).not.toContain("ПРИНЯТО");
    expect(scan?.textContent).not.toContain("Криптохвост");
    expect(view.container.querySelector(".mk-signal-overlay")).toBeNull();

    const box = view.container.querySelector<HTMLElement>(".work-box-fill");
    expect(box).not.toBeNull();
    if (!box) throw new Error("work box fill was not rendered");
    expect(within(box).getByText("Короб № 1")).toBeDefined();
    expect(within(box).getByTestId("box-progress").textContent).toBe("2 / 20");
    const cells = box.querySelectorAll(".work-box-fill__cell");
    expect(cells).toHaveLength(20);
    expect(cells[0]?.getAttribute("data-state")).toBe("filled");
    expect(cells[1]?.getAttribute("data-state")).toBe("filled");
    expect(cells[2]?.getAttribute("data-state")).toBe("next");
    expect(within(box).getByRole("button", { name: "Закрыть короб" })).toBeDefined();
    expect(within(box).getByRole("button", { name: "Отменить последний скан" })).toBeDefined();
    expect(within(box).getByRole("button", { name: "Очистить короб" })).toBeDefined();

    expect(view.container.querySelectorAll(".work-recent li")).toHaveLength(6);
  });

  it.each([
    {
      locale: "ru" as const,
      undo: "Отменить последний скан",
      clear: "Очистить короб",
    },
    {
      locale: "en" as const,
      undo: "Undo last scan",
      clear: "Clear box",
    },
  ])("uses the exact production work copy in $locale", ({ locale, undo, clear }) => {
    render(<StationScreenGallery request={{ state: "work-aggregation", locale }} />);

    expect(screen.getByRole("button", { name: undo })).toBeDefined();
    expect(screen.getByRole("button", { name: clear })).toBeDefined();
  });

  it.each([
    { locale: "ru" as const, accepted: "ПРИНЯТО" },
    { locale: "en" as const, accepted: "ACCEPTED" },
  ])(
    "announces the localized accepted result without adding visual fact copy in $locale",
    ({ locale, accepted }) => {
      const normalized =
        "(01)04607000000042 (21)DEMO-SERIAL-000128 (91)ABCD " +
        "(92)TEST-LONG-CRYPTO-TAIL-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789 (93)XYZ1";
      render(<StationScreenGallery request={{ state: "work-aggregation", locale }} />);

      const status = screen.getByRole("status", { name: `${accepted}: ${normalized}` });
      expect(status.textContent).toBe(`✓${normalized}`);
      expect(status.textContent).not.toContain(accepted);
      expect(status.textContent).not.toContain("GTIN");
      expect(status.textContent).not.toContain("Серийный номер");
      expect(status.textContent).not.toContain("Serial number");
      expect(status.textContent).not.toContain("Криптохвост");
      expect(status.textContent).not.toContain("Crypto tail");
      expect(status.querySelector('[data-semantic="verdict"]')).toBeNull();
      expect(status.querySelector('[data-semantic="gtin"]')).toBeNull();
      expect(status.querySelector('[data-semantic="serial"]')).toBeNull();
      expect(status.querySelector('[data-semantic="crypto"]')).toBeNull();
    },
  );

  it("renders standalone box states through the production grouped fill instrument", () => {
    const view = render(<StationScreenGallery request={{ state: "box-empty", locale: "ru" }} />);
    expect(view.container.querySelectorAll(".work-box-fill__cell")).toHaveLength(20);

    view.rerender(<StationScreenGallery request={{ state: "box-full", locale: "ru" }} />);
    const grouped = view.container.querySelector<HTMLElement>(".work-box-fill__grid");
    expect(grouped?.getAttribute("data-grouped")).toBe("true");
    expect(grouped?.getAttribute("aria-valuemax")).toBe("120");
    expect(view.container.querySelector(".work-box-fill")?.textContent).toContain("120 / 120");
  });

  it.each([
    ["box-print-template-missing", "Для смены не выбран шаблон этикетки короба", false],
    ["box-print-printer-unconfigured", "Принтер не настроен", true],
    ["box-print-render-failed", "Не удалось подготовить этикетку", false],
    ["box-print-transport-failed", "Принтер не принял задание", true],
  ] as const)(
    "renders persistent recovery %s through the production recovery dialog",
    (state, message, hasSetup) => {
      const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);

      expect(view.container.querySelector(".box-print-recovery")).not.toBeNull();
      expect(screen.getByRole("alert").textContent).toBe(message);
      expect(screen.getByText("046012345600000016")).toBeDefined();
      expect(screen.getByRole("button", { name: "Повторить печать" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Продолжить без этикетки" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Настроить принтер" }) !== null).toBe(hasSetup);
    },
  );

  it("opens the production skip confirmation deterministically for viewport acceptance", () => {
    const view = render(
      <StationScreenGallery request={{ state: "box-print-skip-confirm", locale: "ru" }} />,
    );

    expect(view.container.querySelector(".box-print-recovery")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Продолжить без этикетки?" })).toBeDefined();
    expect(
      screen.getByText("Короб уже закрыт. Его нужно будет промаркировать этикеткой позже."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Подтвердить продолжение" })).toBeDefined();
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
