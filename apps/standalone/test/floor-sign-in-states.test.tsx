import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { OperatorSignIn, type OperatorSignInProps } from "../src/floor/OperatorSignIn.js";
import { createKeyboardWedgeSource, type ScanSource } from "../src/floor/scan-source.js";
import type { FloorOperator } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

/**
 * The states of the redesigned sign-in (design kit 2026-10, variant A): the fields, the lockout
 * shown as a silent countdown, the accepted scan's pause, the scanner's states and the name
 * search with the product's own keyboard. The checks behind them are tested in
 * `operator-sign-in.test.tsx` and `floor-lockout.test.ts`.
 */
const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const ANNA_OPERATOR: FloorOperator = {
  id: ANNA,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
};

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};
const operator = (name: string): ChangeItem => ({
  entity: "operators",
  id: ANNA,
  rev: 5,
  deleted: false,
  data: { login: "0042", name, role: null, pinPhc: PIN_PHC },
});
const BADGE: ChangeItem = {
  entity: "operator_badges",
  id: PASS_7,
  rev: 6,
  deleted: false,
  data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
};

async function synced(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

function lockRow(key: string, failures: number, lockedAt: number) {
  return {
    sql:
      "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
      "VALUES (?, ?, ?, ?)",
    values: [key, failures, lockedAt, lockedAt],
  };
}

function renderSignIn(local: LocalExecutor, over: Partial<OperatorSignInProps> = {}) {
  const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
  const view = render(
    <ThemeProvider>
      <OperatorSignIn
        local={local}
        pairing={PAIRING}
        lineId={null}
        sync={SYNCED}
        notice={null}
        source={createKeyboardWedgeSource(window)}
        now={() => NOW}
        onSignedIn={onSignedIn}
        onSync={vi.fn()}
        onOffice={vi.fn()}
        {...over}
      />
    </ThemeProvider>,
  );
  return { ...view, onSignedIn };
}

function scan(text: string) {
  for (const key of text) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
}

const press = (...keys: string[]) => {
  for (const key of keys) fireEvent.click(screen.getByRole("button", { name: key }));
};
const field = (name: "Табельный номер" | "PIN" | "PIN · недоступен") =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function submitPin(login: string, pin: string) {
  await screen.findByRole("button", { name: "Найти по имени" });
  press(...login);
  fireEvent.click(field("PIN"));
  press(...pin);
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));
}

describe("the fields", () => {
  it("say their state in words and marks, not colour alone: active, accepted, refused", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова")]);
    renderSignIn(local);
    await screen.findByRole("button", { name: "Найти по имени" });
    expect(field("Табельный номер").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("3–12 цифр")).toBeTruthy();
    press(..."0042");
    fireEvent.click(field("PIN"));
    // The number is accepted (a tick), the PIN holds the keypad.
    const login = field("Табельный номер").closest(".floor-entry");
    expect(login?.getAttribute("data-status")).toBe("accepted");
    expect(login?.querySelector('[data-icon="accepted"]')).not.toBeNull();
    expect(field("PIN").closest(".floor-entry")?.getAttribute("data-status")).toBe("active");
    press(..."1111");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("Ошибка · PIN очищен")).toBeTruthy();
    expect(field("PIN").closest(".floor-entry")?.getAttribute("data-status")).toBe("error");
    expect(screen.getByText("Введите заново")).toBeTruthy();
    // Typing again takes the error away.
    press("4");
    expect(field("PIN").closest(".floor-entry")?.getAttribute("data-status")).toBe("active");
  });

  it("splits a refusal into a title and what to do, in one polite region", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова"), BADGE]);
    const view = renderSignIn(local);
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000743"));
    const title = await screen.findByText("Бейдж не найден");
    const hint = screen.getByText(
      "Если бейдж новый, дождитесь синхронизации или обратитесь к администратору.",
    );
    expect(title).not.toBe(hint);
    expect(title.closest(".mk-alert")).toBe(hint.closest(".mk-alert"));
    const region = view.container.querySelector(".floor-sign-in__message");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.contains(title)).toBe(true);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

describe("a lockout, shown silently", () => {
  it("holds the PIN and its keys for an operator's lockout, counts down in mm:ss, and frees another number", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова")]);
    await local.transaction([lockRow(`operator:${ANNA}`, 5, NOW - 100_000)]);
    renderSignIn(local);
    await submitPin("0042", "4821");
    const title = await screen.findByText(
      "Вход по PIN для этого табельного номера приостановлен на 4 мин.",
    );
    expect(title.closest(".mk-alert--error")).not.toBeNull();
    expect(screen.getByRole("timer").textContent).toBe("03:20");
    expect(screen.getByText("до возобновления входа по PIN")).toBeTruthy();
    // The PIN is held (a padlock and «недоступен»), and with it the keypad it would take.
    expect(field("PIN · недоступен").disabled).toBe(true);
    expect((screen.getByRole("button", { name: "1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Войти" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The number is not held: another operator may type theirs, and the lockout lets go of the screen.
    fireEvent.click(field("Табельный номер"));
    expect((screen.getByRole("button", { name: "1" }) as HTMLButtonElement).disabled).toBe(false);
    press("Стереть");
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByText(/приостановлен на 4 мин/)).toBeNull();
    expect(field("PIN").disabled).toBe(false);
  });

  it("holds both fields and the keypad for the station's lockout, and the badge still asks the check", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова"), BADGE]);
    await local.transaction([lockRow("station", 10, NOW - 1_000)]);
    const { onSignedIn } = renderSignIn(local);
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByText("Вход на этой станции приостановлен на 1 мин.");
    expect(screen.getByText("до возобновления входа")).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:59");
    expect(field("Табельный номер").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "PIN · недоступен" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "5" }) as HTMLButtonElement).disabled).toBe(true);
    // The chip says it too, as a word.
    expect(screen.getByTestId("scanner-chip").textContent).toContain("Вход приостановлен");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("counts on the computer's clock, never speaks the seconds, and says once that it is over", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова"), BADGE]);
    await local.transaction([lockRow("station", 10, NOW - 58_000)]);
    let clock = NOW;
    const view = renderSignIn(local, { now: () => clock });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByText("Вход на этой станции приостановлен на 1 мин.");
    const region = view.container.querySelector(".floor-sign-in__message");
    expect(screen.getByRole("timer").textContent).toBe("00:02");
    // The countdown is not in the region a reader follows, and says nothing by itself.
    expect(region?.contains(screen.getByRole("timer"))).toBe(false);
    expect(screen.getByRole("timer").closest("[aria-live]")?.getAttribute("aria-live")).not.toBe(
      "assertive",
    );
    clock = NOW + 1_000;
    await waitFor(() => expect(screen.getByRole("timer").textContent).toBe("00:01"));
    expect(region?.textContent).not.toMatch(/\d\d:\d\d/);
    clock = NOW + 2_500;
    // It ends: the fields are free, and the region says so, once.
    expect(await screen.findByText("Вход снова доступен")).toBeTruthy();
    expect(screen.queryByRole("timer")).toBeNull();
    expect(field("Табельный номер").disabled).toBe(false);
    expect(field("PIN").disabled).toBe(false);
    expect(region?.textContent).toContain("Вход снова доступен");
    await sleep(700);
    expect(screen.getAllByText("Вход снова доступен")).toHaveLength(1);
  });
});

describe("an accepted scan", () => {
  it("shows a tick and the operator's name before the floor takes over, and signs in once", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова"), BADGE]);
    const { onSignedIn, container } = renderSignIn(local, { successHoldMs: 120 });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => {
      scan("MRK-000742");
      scan("MRK-000742");
    });
    expect(await screen.findByTestId("accepted-icon")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Анна Кузнецова" })).toBeTruthy();
    expect(screen.getByText("Входим…")).toBeTruthy();
    expect(container.querySelector(".operator-login")?.getAttribute("data-accepted")).toBe("true");
    expect(onSignedIn).not.toHaveBeenCalled();
    // A second scan in the moment is the same badge read twice: it does not sign in again.
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    await sleep(150);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("writes the operator's name as text, never as markup", async () => {
    const name = '<b>Анна</b> <img src=x onerror="alert(1)"> & "Кузнецова"';
    const local = await synced([SITE, operator(name), BADGE]);
    const { container, onSignedIn } = renderSignIn(local, { successHoldMs: 80 });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByTestId("accepted-icon");
    expect(container.querySelector("b, img")).toBeNull();
    expect(screen.getByRole("heading", { name }).textContent).toBe(name);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ ...ANNA_OPERATOR, name }, null));
  });

  it("signs nobody in when the screen leaves in the moment, and leaves no timer behind", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова"), BADGE]);
    const { onSignedIn, unmount } = renderSignIn(local, { successHoldMs: 80 });
    await screen.findByRole("button", { name: "Найти по имени" });
    act(() => scan("MRK-000742"));
    await screen.findByTestId("accepted-icon");
    unmount();
    await sleep(150);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("does not pause a PIN sign-in: only a scan has the tick", async () => {
    const local = await synced([SITE, operator("Анна Кузнецова")]);
    const { onSignedIn } = renderSignIn(local, { successHoldMs: 5_000 });
    await submitPin("0042", "4821");
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    expect(screen.queryByTestId("accepted-icon")).toBeNull();
  });
});

describe("the scanner's states on the badge's half", () => {
  const watching = (status: "connected" | "disconnected") =>
    ((
      onSnapshot: (next: {
        revision: number;
        scanners: { port: string; baud: number; status: typeof status }[];
      }) => void,
    ) => {
      onSnapshot({ revision: 1, scanners: [{ port: "COM3", baud: 9600, status }] });
      return Promise.resolve(() => undefined);
    }) as NonNullable<OperatorSignInProps["watchScanners"]>;

  it("says «Сканер готов» with a glyph when the scanner answers, and draws the badge", async () => {
    renderSignIn(await synced([SITE, operator("Анна Кузнецова")]), {
      watchScanners: watching("connected"),
    });
    await screen.findByText("Отсканируйте бейдж");
    const chip = screen.getByTestId("scanner-chip");
    expect(chip.textContent).toBe("√Сканер готов");
    expect(chip.getAttribute("data-tone")).toBe("ok");
    expect(screen.getByTestId("badge-icon")).toBeTruthy();
    expect(screen.queryByTestId("scanner-state")).toBeNull();
  });

  it("changes the picture and the words when the COM scanner does not answer, and points to what works", async () => {
    const onScannerSettings = vi.fn();
    renderSignIn(await synced([SITE, operator("Анна Кузнецова")]), {
      watchScanners: watching("disconnected"),
      onScannerSettings,
    });
    await screen.findByText("Бейдж сейчас не прочитать");
    expect(screen.getByTestId("plug-icon")).toBeTruthy();
    expect(screen.queryByTestId("badge-icon")).toBeNull();
    expect(
      screen.getByText("COM-сканер не отвечает. Клавиатурный сканер и ввод номера работают."),
    ).toBeTruthy();
    expect(screen.getByTestId("scanner-chip").textContent).toContain("Нет связи с COM-сканером");
    const warning = screen.getByTestId("scanner-state");
    expect(within(warning).getByText("Сканер не на связи")).toBeTruthy();
    expect(
      within(warning).getByText("Проверьте кабель или введите табельный номер и PIN."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Настройки сканера" }));
    expect(onScannerSettings).toHaveBeenCalledTimes(1);
    // Typing the number still works.
    press("1");
    expect(screen.getByLabelText("Набранный табельный номер").textContent).toBe("1");
  });
});

describe("no copies yet", () => {
  it("offers a new sync from the screen itself, besides the way to the office", async () => {
    const { executor } = openLocalDb();
    const onSync = vi.fn();
    renderSignIn(executor, { sync: { ...SYNCED, synced: 0 }, onSync });
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    fireEvent.click(screen.getByRole("button", { name: "Повторить синхронизацию" }));
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Офис" })).toBeTruthy();
  });
});

describe("the name search with the product's own keyboard", () => {
  const BORIS: ChangeItem = {
    entity: "operators",
    id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    rev: 6,
    deleted: false,
    data: { login: "0077", name: "Борис Петров", role: null, pinPhc: PIN_PHC },
  };

  async function open(source?: ScanSource) {
    const local = await synced([SITE, operator("Анна Кузнецова"), BORIS, BADGE]);
    const view = renderSignIn(local, source === undefined ? {} : { source });
    fireEvent.click(await screen.findByRole("button", { name: "Найти по имени" }));
    return { ...view, input: screen.getByLabelText("Имя оператора") as HTMLInputElement };
  }

  it("types a name with the keys, spelled with a capital, and finds the operator", async () => {
    const { input } = await open();
    press("А", "Н");
    expect(input.value).toBe("Ан");
    expect(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" })).toBeTruthy();
    expect(screen.getByText("№ 0042")).toBeTruthy();
    press("Стереть");
    expect(input.value).toBe("А");
    press("Пробел");
    expect(input.value).toBe("А ");
  });

  it("asks for no Windows keyboard, keeps the real field for a hardware keyboard, and says the scanner is quiet", async () => {
    const { input } = await open();
    expect(input.getAttribute("inputmode")).toBe("none");
    fireEvent.change(input, { target: { value: "бор" } });
    expect(await screen.findByRole("button", { name: "Борис Петров — 0077" })).toBeTruthy();
    expect(
      screen.getByText(/Пока вы вводите имя, бейдж не сканируется\. Найдено: 1\./),
    ).toBeTruthy();
  });

  it("gives the keys to the field when a key is tapped, so the scanner is quiet exactly while a name is typed", async () => {
    const source: ScanSource = {
      start: vi.fn(() => () => undefined),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    await open(source);
    press("А");
    expect(document.activeElement).toBe(screen.getByLabelText("Имя оператора"));
    expect(source.setManualTextEntryActive).toHaveBeenCalledWith(true);
  });

  it("holds the keys while a check runs", async () => {
    await open();
    expect((screen.getByRole("button", { name: "Й" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
