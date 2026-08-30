import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
});

describe("development screen gallery", () => {
  const inventoryGalleryStateIds = [
    "inventory-task-selection",
    "inventory-other-line-confirmation",
    "inventory-simple-box-accepted",
    "inventory-duplicate-other-terminal",
    "inventory-known-ineligible",
    "inventory-protected-moving-by-ud",
    "inventory-not-in-snapshot",
    "inventory-repack-awaiting-old-box",
    "inventory-repack-scanning",
    "inventory-repack-capacity-20",
    "inventory-repack-box-ready",
    "inventory-repack-corrections",
    "inventory-production-date-change",
    "inventory-leave-open-box",
    "inventory-print-recovery",
    "inventory-same-sscc-reprint-confirmation",
  ] as const;

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

  it("registers every approved inventory handoff state as a deterministic fixture", () => {
    expect(EXPECTED_GALLERY_STATE_IDS).toEqual(
      expect.arrayContaining([...inventoryGalleryStateIds]),
    );

    for (const id of inventoryGalleryStateIds) {
      expect(GALLERY_FIXTURES).toContainEqual({
        id,
        kind: "inventory",
        variant: id.replace("inventory-", ""),
        source: "synthetic",
      });
    }
  });

  it("restores the production header controls on the real warehouse task selector", async () => {
    // TaskSelection's warehouse category is the exact same App.tsx mount as
    // plain shift selection, which unconditionally receives
    // operatorControl/windowControl/update once authenticated -- this state
    // used to render without them (Task 1 audit finding).
    render(<StationScreenGallery request={{ state: "inventory-task-selection", locale: "ru" }} />);

    const header = screen.getByRole("banner", { name: "Состояние станции" });
    expect(
      within(header).getByRole("button", {
        name: "! Доступно критическое обновление 0.1.0-beta.123",
      }),
    ).toBeDefined();
    expect(within(header).getByRole("button", { name: "Сменить оператора" })).toBeDefined();
    expect(
      await within(header).findByRole("button", { name: "Выйти из полноэкранного режима" }),
    ).toBeDefined();
    // App.tsx:216 derives `shift` only from `activeFloorTask?.kind ===
    // "production"`, and TaskSelection only ever renders while
    // `activeFloorTask` is null -- so production never has a shift label (or
    // a collapsible bar) here either, in both the shift and warehouse
    // categories alike (second review finding).
    expect(header.getAttribute("data-collapsed")).toBe("false");
    expect(within(header).queryByTestId("shift-status")).toBeNull();
    expect(within(header).queryByRole("button", { name: /Развернуть|Свернуть/ })).toBeNull();
  });

  it.each([
    "inventory-simple-box-accepted",
    "inventory-not-in-snapshot",
    "inventory-repack-scanning",
    "inventory-print-recovery",
  ] as const)(
    "renders %s with the real header controls, expanded and without a shift label",
    async (state) => {
      // App.tsx:216 ties `shift` -- and therefore both the collapsible status
      // bar and the shift label (App.tsx:1390-1398, 1414) -- exclusively to
      // `activeFloorTask.kind === "production"`. An inventory floor task is
      // never that kind, so InventoryWorkScreen can NEVER render a collapsed
      // bar or a "Смена" label in production; StationScreenGallery.tsx used
      // to fabricate exactly that impossible combination (second review
      // finding). This is a positive+negative assertion, not a smoke check:
      // the real controls must still be present (positive) while the
      // collapse affordance and shift label must be absent (negative).
      render(<StationScreenGallery request={{ state, locale: "ru" }} />);

      const header = screen.getByRole("banner", { name: "Состояние станции" });

      expect(
        within(header).getByRole("button", {
          name: "! Доступно критическое обновление 0.1.0-beta.123",
        }),
      ).toBeDefined();
      expect(within(header).getByRole("button", { name: "Сменить оператора" })).toBeDefined();
      expect(
        await within(header).findByRole("button", { name: "Выйти из полноэкранного режима" }),
      ).toBeDefined();

      expect(header.getAttribute("data-collapsed")).toBe("false");
      expect(within(header).queryByTestId("shift-status")).toBeNull();
      expect(within(header).queryByRole("button", { name: /Развернуть|Свернуть/ })).toBeNull();
    },
  );

  it("renders approved inventory verdicts through production inventory instruments", async () => {
    const cases = [
      ["inventory-simple-box-accepted", "Короб принят: 20 кодов", "inventory-scan-instrument"],
      [
        "inventory-duplicate-other-terminal",
        "Код уже проверен на другом терминале",
        "inventory-scan-instrument",
      ],
      [
        "inventory-known-ineligible",
        "Код не участвует в инвентаризации",
        "inventory-scan-instrument",
      ],
      [
        "inventory-protected-moving-by-ud",
        "Код не учтён: уже в отгрузке",
        "inventory-scan-instrument",
      ],
      [
        "inventory-not-in-snapshot",
        "Код отсутствует в исходном снимке",
        "inventory-scan-instrument",
      ],
      ["inventory-repack-capacity-20", "12 / 20", "repack-instrument"],
      ["inventory-print-recovery", "Этикетка не напечатана", "inventory-box-print"],
    ] as const;

    for (const [state, copy, productionClass] of cases) {
      const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);
      await waitFor(() => expect(view.container.textContent).toContain(copy));
      expect(view.container.querySelector(`.${productionClass}`)).not.toBeNull();
      view.unmount();
    }
  });

  it("freezes inventory gallery dates and exposes no raw marked code", async () => {
    const view = render(
      <StationScreenGallery
        request={{ state: "inventory-production-date-change", locale: "ru" }}
      />,
    );

    const date = await screen.findByLabelText("Дата производства");
    expect(date.getAttribute("value")).toBe("2026-08-19");
    expect(view.container.textContent).not.toContain("010460000000001521");
  });

  it("drives the real check work branch with its production accessibility contract", async () => {
    render(
      <StationScreenGallery request={{ state: "inventory-simple-box-accepted", locale: "ru" }} />,
    );

    expect(await screen.findByRole("button", { name: "Изменить дату производства" })).toBeDefined();
  });

  it("drives the real repack print-recovery branch with production disabled actions", async () => {
    render(<StationScreenGallery request={{ state: "inventory-print-recovery", locale: "ru" }} />);

    expect(await screen.findByRole("button", { name: "Повторить печать" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Настроить принтер" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(await screen.findByRole("button", { name: "Изменить" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Исправления" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Выйти из задания" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("renders aggregation with the production scan, 10-place box, and six-row history instruments", () => {
    const view = render(
      <StationScreenGallery request={{ state: "work-aggregation", locale: "ru" }} />,
    );

    // The aggregation card is the identity hero alone: the accepted-scan
    // readout lives in the box instrument and prints the serial only, while
    // the full code stays in the recent-operations list.
    const scan = view.container.querySelector<HTMLElement>(".work-scan-result");
    expect(scan).not.toBeNull();
    expect(scan?.getAttribute("data-identity-only")).toBe("true");
    expect(scan?.querySelector('[data-semantic="accepted-marker"]')).toBeNull();
    expect(scan?.querySelector('[data-semantic="normalized-code"]')).toBeNull();
    expect(scan?.textContent).not.toContain("ПРИНЯТО");
    expect(scan?.textContent).not.toContain("Криптохвост");
    expect(view.container.querySelector(".mk-signal-overlay")).toBeNull();

    const box = view.container.querySelector<HTMLElement>(".work-box-fill");
    expect(box).not.toBeNull();
    if (!box) throw new Error("work box fill was not rendered");
    expect(within(box).getByText("Короб № 1")).toBeDefined();
    expect(within(box).getByTestId("box-progress").textContent).toBe("2 / 10");
    expect(
      within(box).getByRole("status").querySelector('[data-semantic="accepted-serial"]')
        ?.textContent,
    ).toBe("DEMO-SERIAL-000128");
    expect(box.querySelector('.work-box-fill__grid[data-large="true"]')).not.toBeNull();
    const cells = box.querySelectorAll(".work-box-fill__cell");
    expect(cells).toHaveLength(10);
    expect(cells[0]?.getAttribute("data-state")).toBe("filled");
    expect(cells[1]?.getAttribute("data-state")).toBe("filled");
    expect(cells[2]?.getAttribute("data-state")).toBe("next");
    expect(cells[2]?.textContent).toBe("3");
    expect(within(box).getByRole("button", { name: "Закрыть короб" })).toBeDefined();
    expect(within(box).getByRole("button", { name: "Отменить последний скан" })).toBeDefined();
    expect(within(box).getByRole("button", { name: "Очистить короб" })).toBeDefined();

    expect(view.container.querySelectorAll(".work-recent li")).toHaveLength(6);
  });

  it("renders the work fixture with a real locally cached product image", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:gallery-product");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    render(<StationScreenGallery request={{ state: "work-aggregation", locale: "ru" }} />);

    const image = await screen.findByRole("img", { name: "Тестовый товар А" });
    expect(image.getAttribute("src")).toBe("blob:gallery-product");
    expect(image.classList.contains("work-scan-result__image")).toBe(true);
  });

  it("covers the compact active-shift waiting state with the product image", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:gallery-product");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const view = render(
      <StationScreenGallery request={{ state: "work-aggregation-waiting", locale: "ru" }} />,
    );

    expect(await screen.findByRole("img", { name: "Тестовый товар А" })).toBeDefined();
    // The waiting readout lives beside the box count now, not in the card.
    expect(within(view.container).getByText("Ожидание скана…")).toBeDefined();
    expect(
      view.container.querySelector(".work-box-fill__last[data-tone='neutral']"),
    ).not.toBeNull();
    expect(within(view.container).getByText("Короб № 1")).toBeDefined();
  });

  it("renders active work collapsed first and restores the production header controls", async () => {
    render(<StationScreenGallery request={{ state: "work-aggregation", locale: "ru" }} />);

    const header = screen.getByRole("banner", { name: "Состояние станции" });
    expect(header.getAttribute("data-collapsed")).toBe("true");
    const initialExpand = within(header).getByRole("button", {
      name: "Развернуть панель состояния",
    });
    fireEvent.click(initialExpand);
    const update = within(header).getByRole("button", {
      name: "! Доступно критическое обновление 0.1.0-beta.123",
    });
    const operator = within(header).getByRole("button", { name: "Сменить оператора" });
    const windowMode = await within(header).findByRole("button", {
      name: "Выйти из полноэкранного режима",
    });
    const collapse = within(header).getByRole("button", {
      name: "Свернуть панель состояния",
    });
    const expandedChevronPath = collapse
      .querySelector(".station-status-toggle__chevron path")
      ?.getAttribute("d");

    expect(collapse.querySelector(".station-status-toggle__chevron")).not.toBeNull();
    expect(expandedChevronPath).toBe("M4 11l5-5 5 5");

    for (const action of [update, operator, windowMode, collapse]) {
      expect(action.classList.contains("mk-btn--floor")).toBe(true);
      expect(action.classList.contains("mk-btn--secondary")).toBe(true);
      expect(action.style.height).toBe("var(--control-floor)");
    }
    expect(update.textContent).toBe("!Обновления");
    expect(windowMode.textContent).toContain("Оконный режим");

    fireEvent.click(collapse);
    const expand = within(header).getByRole("button", {
      name: "Развернуть панель состояния",
    });
    expect(expand.querySelector(".station-status-toggle__chevron path")?.getAttribute("d")).toBe(
      "M4 7l5 5 5-5",
    );

    fireEvent.click(expand);
    const expandedAgain = within(header).getByRole("button", {
      name: "Свернуть панель состояния",
    });
    expect(
      expandedAgain.querySelector(".station-status-toggle__chevron path")?.getAttribute("d"),
    ).toBe("M4 11l5-5 5 5");
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
      // The aggregation readout announces and prints the SERIAL only — the
      // full normalized code lives in the recent-operations list.
      const serial = "DEMO-SERIAL-000128";
      render(<StationScreenGallery request={{ state: "work-aggregation", locale }} />);

      const status = screen.getByRole("status", { name: `${accepted}: ${serial}` });
      expect(status.textContent).toBe(`✓${serial}`);
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

  it("renders box states through the production grouped fill instrument", () => {
    // "box-empty" is a standalone component review (the box panel never has
    // its own screen in production).
    const view = render(<StationScreenGallery request={{ state: "box-empty", locale: "ru" }} />);
    expect(view.container.querySelectorAll(".work-box-fill__cell")).toHaveLength(20);
    expect(view.container.querySelector(".work-screen")).toBeNull();

    // "box-full" is a moment inside an ordinary scanning shift, so -- unlike
    // "box-empty" -- it renders inside the real work screen alongside the
    // scan result and counters, the same as production.
    view.rerender(<StationScreenGallery request={{ state: "box-full", locale: "ru" }} />);
    expect(view.container.querySelector(".work-screen")).not.toBeNull();
    expect(view.container.querySelector(".work-scan-result")).not.toBeNull();
    const grouped = view.container.querySelector<HTMLElement>(".work-box-fill__grid");
    expect(grouped?.getAttribute("data-grouped")).toBe("true");
    expect(grouped?.getAttribute("aria-valuemax")).toBe("120");
    expect(view.container.querySelector(".work-box-fill")?.textContent).toContain("120 / 120");
    expect(
      within(view.container.querySelector(".work-box-fill") as HTMLElement).getByRole("button", {
        name: "Закрыть короб",
      }),
    ).toBeDefined();
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
      const fixture = GALLERY_FIXTURES.find((candidate) => candidate.id === state);
      const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);

      expect(screen.getByTestId("station-screen-gallery").getAttribute("data-gallery-state")).toBe(
        state,
      );
      if (fixture?.kind === "login") {
        // Sign-in has no station/operator/shift identity yet, so -- exactly
        // like the production `stage === "login"` branch in App.tsx -- it
        // renders without the shared FloorShell status bar.
        expect(view.container.querySelector(".operator-login")).not.toBeNull();
        expect(view.container.querySelector(".station-root")).toBeNull();
      } else if (fixture?.kind === "pairing") {
        // Pairing has no station/operator/shift identity yet either -- like
        // login, App.tsx's `stage === "pairing"` branch mounts Enrollment
        // without the shared FloorShell status bar.
        expect(view.container.querySelector(".station-root")).toBeNull();
        if (fixture.variant === "waiting" || fixture.variant === "success") {
          // These two render the real Enrollment component (or, for
          // "success", a faithful mirror of its own success branch -- see
          // PairingFixture's doc comment) -- assert its real root and
          // stage-specific copy so a silently empty render can't pass.
          expect(view.container.querySelector(".station-enrollment")).not.toBeNull();
          expect(view.container.textContent).toContain(
            fixture.variant === "waiting" ? "Подключение станции" : "Станция подключена",
          );
        } else {
          // redeeming/error/service/recovery are outside this audit's scope
          // and still render the synthetic StationScreen card -- assert its
          // container and that it isn't a silently empty render.
          expect(view.container.querySelector(".gallery-centered-card")).not.toBeNull();
          expect(view.container.querySelector(".gallery-card")).not.toBeNull();
          expect(view.container.textContent?.trim().length).toBeGreaterThan(0);
        }
      } else {
        expect(view.container.querySelector(".station-root")).not.toBeNull();
        expect(view.container.querySelector(".station-screen-slot")).not.toBeNull();
      }

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
    ["exception-applying", "Выполняем действие"],
    ["serial-exhaustion", "Продолжение сканирования заблокировано"],
    ["conflicts-loading", "Читаем локальный список расхождений"],
    ["conflicts-read-error", "Не удалось прочитать список расхождений"],
    ["conflicts-empty", "Расхождений нет"],
    ["credential-recovery-sealing", "подготавливаются к безопасному восстановлению"],
    ["credential-recovery-failed", "Не удалось подготовить локальные данные"],
    ["credential-recovery-ready", "Сохранено: 12 сканирований"],
    ["print-mismatch", "Это другая этикетка"],
    ["print-not-sscc", "Это не групповой код"],
  ] as const)("renders distinct persistent viewport %s", async (state, expectedCopy) => {
    const view = render(<StationScreenGallery request={{ state, locale: "ru" }} />);
    // exception-applying and the conflicts variants reach their captured
    // text through the real components' own async state machine (simulated
    // button clicks / a synthetic executor promise), not the first
    // synchronous render.
    await waitFor(() => {
      expect(view.container.textContent).toContain(expectedCopy);
    });
  });
});
