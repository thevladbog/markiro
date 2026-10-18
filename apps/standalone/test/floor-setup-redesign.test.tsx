import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, manualRuntime, setUpPrinting } from "./support/printing.js";

/**
 * The redesigned «Рабочее место» (design kit 2026-10): the four tabs, the footer's state, the
 * printer form with its keypad, the scanner's check inside «Сканеры», the theme of the floor.
 */
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
});

function fakeSource() {
  let listener: ScanListener | null = null;
  const setManual = vi.fn<(active: boolean) => void>();
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: setManual,
  };
  return {
    source,
    setManual,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

async function setup(options: { printers?: boolean } = {}) {
  const local = openLocalDb().executor;
  if (options.printers === true) await setUpPrinting(local);
  const shell = fakeHardware();
  const scanner = fakeSource();
  const onBack = vi.fn();
  render(
    <ThemeProvider>
      <WorkstationSetup
        local={local}
        hardware={shell.hardware}
        printing={manualRuntime(shell.hardware).runtime}
        source={scanner.source}
        render={fakeRender}
        facts={{ name: "Станция 1 · Линия 1", device: "7f3a1c2e…c21d", host: "192.168.1.10:8443" }}
        onSaved={vi.fn()}
        onBack={onBack}
      />
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Принтеры" });
  return { local, shell, scanner, onBack };
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("the tabs", () => {
  it("are four segments in the kit's order, the chosen one marked, with the screen's own title", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "Рабочее место", level: 2 })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((each) => each.textContent)).toEqual([
      "Принтеры",
      "Сканеры",
      "Звук",
      "Станция",
    ]);
    expect(screen.getByRole("tab", { name: "Принтеры" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Принтеры и назначение печати")).toBeTruthy();
    tab("Звук");
    expect(screen.getByText("Громкость сигналов станции")).toBeTruthy();
  });

  it("have no hint line at the bottom: the hints stand at their fields", async () => {
    await setup();
    expect(document.querySelector(".workstation-setup__hint")).toBeNull();
  });
});

describe("the footer's state", () => {
  it("says there is nothing to save, then what is unsaved, then that it is saved", async () => {
    await setup();
    expect(screen.getByText("Нет изменений")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Назад" })).toBeTruthy();
    tab("Звук");
    click("Тише");
    expect(screen.getByText("Не сохранено: громкость")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Назад без сохранения" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Звук сигналов" }));
    expect(screen.getByText("Не сохранено: звук, громкость")).toBeTruthy();
    await act(async () => {
      click("Сохранить");
    });
    expect(await screen.findByText("Настройки сохранены")).toBeTruthy();
    expect(screen.queryByText(/Не сохранено/)).toBeNull();
    click("Громче");
  });

  it("names every change on every tab, and goes back to «Нет изменений» when the change is undone", async () => {
    await setup({ printers: true });
    fireEvent.click(screen.getByRole("switch", { name: "Проверять этикетку короба" }));
    expect(screen.getByText("Не сохранено: проверка этикетки")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Проверять этикетку короба" }));
    expect(screen.getByText("Нет изменений")).toBeTruthy();
    click("Удалить принтер «Zebra у линии»");
    expect(screen.getByText(/^Не сохранено: принтеры/)).toBeTruthy();
    tab("Станция");
    // The footer is the screen's, whatever the tab: the tab of the station has the same one.
    expect(screen.getByText(/^Не сохранено: принтеры/)).toBeTruthy();
  });

  it("is «Отмена» and «Готово» while the printer's form is open, with the hint of what happens", async () => {
    await setup();
    click("Добавить принтер");
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeTruthy();
    expect(screen.getByText("Принтер появится в списке после «Готово».")).toBeTruthy();
    expect(screen.getByText("Сначала «Готово» или «Отмена»")).toBeTruthy();
    // The other tabs are off meanwhile.
    expect((screen.getByRole("tab", { name: "Звук" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the list of printers", () => {
  it("is a row per printer: its name, the state of its test, its line, three actions of 64 px", async () => {
    await setup({ printers: true });
    const row = screen.getByRole("heading", { name: "Zebra у линии" }).closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Не проверялся")).toBeTruthy();
    expect(within(row as HTMLElement).getByText(/192\.168\.1\.50/)).toBeTruthy();
    const names = within(row as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Пробная печать на «Zebra у линии»",
      "Изменить принтер «Zebra у линии»",
      "Удалить принтер «Zebra у линии»",
    ]);
    // «Что на каком принтере» is a block of its own at the right, three fields.
    const routing = screen
      .getByRole("heading", { name: "Что на каком принтере" })
      .closest("section");
    expect(within(routing as HTMLElement).getAllByRole("combobox")).toHaveLength(3);
  });
});

describe("the printer form", () => {
  it("states the printer's own resolution and where A4 goes", async () => {
    await setup();
    click("Добавить принтер");
    expect(screen.getByText("Разрешение принтера")).toBeTruthy();
    expect(
      screen.getByText(
        "Это разрешение самого принтера. У шаблонов этикеток своего dpi нет: станция печатает в dpi принтера.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "ZPL — принтеры Zebra, TSPL — принтеры TSC. Лист А4 печатается только через драйвер Windows.",
      ),
    ).toBeTruthy();
  });

  it("names what is wrong under the fields and in the footer when «Готово» is refused", async () => {
    await setup();
    click("Добавить принтер");
    fireEvent.change(screen.getByLabelText("Порт"), { target: { value: "99999" } });
    // The port is wrong at once; the address waits for «Готово».
    expect(screen.getByText("Ошибка · 1–65 535")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Порт"), { target: { value: "9100" } });
    click("Готово");
    expect(screen.getByText("Ошибка · Укажите адрес принтера.")).toBeTruthy();
    expect(screen.getByText("Укажите адрес принтера.")).toBeTruthy();
    expect(
      document.querySelector(".setup-footer__status .mk-alert, .setup-footer__status [role]"),
    ).not.toBeNull();
  });
});

describe("the keypad of the printer form", () => {
  const open = async () => {
    const harness = await setup();
    click("Добавить принтер");
    fireEvent.pointerDown(screen.getByLabelText("Адрес принтера"));
    return harness;
  };

  it("opens beside the form when the address is tapped, and folds the other groups into one line", async () => {
    await open();
    const pad = screen.getByRole("group", { name: "Клавиатура адреса" });
    expect(pad).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Адрес" }).getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText("Остальное: бумага, язык, разрешение принтера, способ печати"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Язык принтера")).toBeNull();
    expect(screen.getByText("4 числа 0–255 через точку")).toBeTruthy();
    expect(screen.getByText("Пробная печать станет доступна после «Готово».")).toBeTruthy();
    // «Изменить» closes the keypad and brings the full form back.
    click("Изменить");
    expect(screen.queryByRole("group", { name: "Клавиатура адреса" })).toBeNull();
    expect(screen.getByLabelText("Язык принтера")).toBeTruthy();
  });

  it("types an address with its keys and judges it as it grows", async () => {
    await open();
    const pad = within(screen.getByRole("group", { name: "Клавиатура адреса" }));
    for (const key of "192.168.1.25") fireEvent.click(pad.getByRole("button", { name: key }));
    expect((screen.getByLabelText("Адрес принтера") as HTMLInputElement).value).toBe(
      "192.168.1.25",
    );
    expect(screen.getByText("Адрес принят")).toBeTruthy();
    fireEvent.click(pad.getByRole("button", { name: "6" }));
    expect((screen.getByLabelText("Адрес принтера") as HTMLInputElement).value).toBe(
      "192.168.1.256",
    );
    expect(screen.getByText("Ошибка · октет «256» больше 255; допустимо 0–255")).toBeTruthy();
    // «Далее: порт» and «Готово» wait while the address is wrong; the footer says why.
    expect((pad.getByRole("button", { name: "Далее: порт" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Готово" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      screen.getByText("Адрес неверный: октет «256» больше 255; допустимо 0–255."),
    ).toBeTruthy();
    fireEvent.click(pad.getByRole("button", { name: "Стереть" }));
    expect(screen.getByText("Адрес принят")).toBeTruthy();
  });

  it("goes on to the port, hides the dot there, and closes with its own button", async () => {
    await open();
    const pad = within(screen.getByRole("group", { name: "Клавиатура адреса" }));
    for (const key of "10.0.0.7") fireEvent.click(pad.getByRole("button", { name: key }));
    fireEvent.click(pad.getByRole("button", { name: "Далее: порт" }));
    expect(screen.getByRole("radio", { name: "Порт" }).getAttribute("aria-checked")).toBe("true");
    expect(pad.queryByRole("button", { name: "." })).toBeNull();
    expect(screen.getByText("1–65 535, обычно 9100")).toBeTruthy();
    // The port starts as 9100: erase it and type another with the keys.
    for (let i = 0; i < 4; i += 1) fireEvent.click(pad.getByRole("button", { name: "Стереть" }));
    for (const key of "9101") fireEvent.click(pad.getByRole("button", { name: key }));
    expect((screen.getByLabelText("Порт") as HTMLInputElement).value).toBe("9101");
    fireEvent.click(pad.getByRole("button", { name: "Закрыть клавиатуру" }));
    expect(screen.queryByRole("group", { name: "Клавиатура адреса" })).toBeNull();
  });

  it("moves its target with the segment, and the hardware keyboard and a paste still type", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Порт" }));
    expect(screen.getByRole("button", { name: "Закрыть клавиатуру" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Адрес" }));
    fireEvent.change(screen.getByLabelText("Адрес принтера"), { target: { value: "zebra.local" } });
    expect((screen.getByLabelText("Адрес принтера") as HTMLInputElement).value).toBe("zebra.local");
    // A host name passes the live check and the keypad's «Далее».
    expect(screen.getByText("Адрес принят")).toBeTruthy();
    const input = screen.getByLabelText("Адрес принтера") as HTMLInputElement;
    const paste = createEvent.paste(input, {
      clipboardData: { getData: () => " 192.168.1.256 " },
    });
    input.setSelectionRange(0, input.value.length);
    fireEvent(input, paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe("192.168.1.256");
    expect(screen.getByText("Ошибка · октет «256» больше 255; допустимо 0–255")).toBeTruthy();
  });

  it("keeps the scanner out of the entry while it is open, and gives the entry back when it closes", async () => {
    const { scanner } = await open();
    expect(scanner.setManual).toHaveBeenLastCalledWith(true);
    // The field loses the focus (a key was tapped): the entry is still the keypad's.
    fireEvent.blur(screen.getByLabelText("Адрес принтера"));
    expect(scanner.setManual).not.toHaveBeenLastCalledWith(false);
    click("Отмена");
    expect(scanner.setManual).toHaveBeenLastCalledWith(false);
  });

  it("closes with «Готово» and when the connection changes", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Адрес принтера"), { target: { value: "10.0.0.1" } });
    fireEvent.click(screen.getByRole("radio", { name: "COM-порт" }));
    expect(screen.queryByRole("group", { name: "Клавиатура адреса" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Сеть" }));
    fireEvent.pointerDown(screen.getByLabelText("Адрес принтера"));
    expect(screen.getByRole("group", { name: "Клавиатура адреса" })).toBeTruthy();
    click("Готово");
    expect(screen.queryByRole("group", { name: "Клавиатура адреса" })).toBeNull();
    expect(screen.getByText("10.0.0.1:9100", { exact: false })).toBeTruthy();
  });

  it("offers the same keypad without the dot for a serial printer's speed", async () => {
    await setup();
    click("Добавить принтер");
    fireEvent.click(screen.getByRole("radio", { name: "COM-порт" }));
    fireEvent.pointerDown(screen.getByLabelText("Скорость, бод"));
    const pad = within(screen.getByRole("group", { name: "Клавиатура скорости" }));
    expect(pad.queryByRole("button", { name: "." })).toBeNull();
    fireEvent.click(pad.getByRole("button", { name: "Стереть" }));
    fireEvent.click(pad.getByRole("button", { name: "5" }));
    expect((screen.getByLabelText("Скорость, бод") as HTMLInputElement).value).toBe("9605");
  });
});

describe("the scanners tab", () => {
  it("holds the connection and the check side by side, and the speed's keypad takes the check's place", async () => {
    await setup();
    tab("Сканеры");
    expect(screen.getByText("Клавиатурный сканер")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Проверка сканера" })).toBeTruthy();
    expect(screen.getByText("Ждём скан")).toBeTruthy();
    fireEvent.pointerDown(screen.getByLabelText("Скорость, бод"));
    expect(screen.queryByRole("heading", { name: "Проверка сканера" })).toBeNull();
    const pad = within(screen.getByRole("group", { name: "Клавиатура скорости" }));
    fireEvent.click(pad.getByRole("button", { name: "Закрыть клавиатуру" }));
    expect(screen.getByRole("heading", { name: "Проверка сканера" })).toBeTruthy();
  });

  it("judges a scan of the tab against the shown code, in a panel of the same tab", async () => {
    const { scanner } = await setup();
    tab("Сканеры");
    const code = (screen.getByTestId("self-test-code").textContent ?? "").replaceAll("␝", "\u001d");
    await scanner.read(code);
    expect(screen.getByTestId("self-test-verdict").getAttribute("data-tone")).toBe("ok");
    expect(screen.queryByText("Ждём скан")).toBeNull();
  });
});

describe("the sound tab", () => {
  it("is a switch, a number, ten divisions and the words of the level", async () => {
    await setup();
    tab("Звук");
    expect(screen.getByRole("switch", { name: "Звук сигналов" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("80%")).toBeTruthy();
    expect(document.querySelectorAll(".setup-volume__division")).toHaveLength(10);
    expect(document.querySelectorAll('.setup-volume__division[data-filled="true"]')).toHaveLength(
      8,
    );
    expect(screen.getByText("Уровень 8 из 10. Установите хорошо слышимый уровень.")).toBeTruthy();
    click("Тише");
    expect(screen.getByText("70%")).toBeTruthy();
    expect(document.querySelectorAll('.setup-volume__division[data-filled="true"]')).toHaveLength(
      7,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Звук сигналов" }));
    expect(screen.getByText("Без звука")).toBeTruthy();
    expect(document.querySelectorAll('.setup-volume__division[data-filled="true"]')).toHaveLength(
      0,
    );
  });
});

describe("the station tab", () => {
  it("shows the facts of the station, and no unpairing where the app gave none", async () => {
    await setup();
    tab("Станция");
    expect(screen.getByRole("heading", { name: "Эта станция" })).toBeTruthy();
    expect(screen.getByText("Станция 1 · Линия 1")).toBeTruthy();
    expect(screen.getByText("7f3a1c2e…c21d")).toBeTruthy();
    expect(screen.getByText("192.168.1.10:8443")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отвязать станцию" })).toBeNull();
  });

  it("switches the floor's theme at once, «Системная» first and by default, stored where the floor's theme is", async () => {
    await setup();
    tab("Станция");
    const group = screen.getByRole("radiogroup", { name: /Тема цеха/ });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Системная", "Светлая", "Тёмная"]);
    expect(
      within(group).getByRole("radio", { name: "Системная" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Тёмная" }));
    expect(within(group).getByRole("radio", { name: "Тёмная" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(window.localStorage.getItem("markiro.theme")).toBe("dark");
    fireEvent.click(within(group).getByRole("radio", { name: "Светлая" }));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(window.localStorage.getItem("markiro.theme")).toBe("light");
    // A theme is no setting of the setup: nothing to save.
    expect(screen.getByText("Нет изменений")).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Системная" }));
    expect(window.localStorage.getItem("markiro.theme")).toBe("system");
  });
});
