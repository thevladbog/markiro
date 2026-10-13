import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, SyncState } from "../src/app/shell.js";
import { OperatorSignIn, type OperatorSignInProps } from "../src/floor/OperatorSignIn.js";
import { createKeyboardWedgeSource, type ScanSource } from "../src/floor/scan-source.js";
import { signInWithBadge, type FloorOperator } from "../src/floor/sign-in.js";
import type { ChangeItem } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
/** The PIN 4821 and the badge «MRK-000742» under `SITE`'s salt (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
/** One clock for every render: a new function would read the copies again on its own. */
const CLOCK = () => NOW;
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};
const OPERATOR: ChangeItem = {
  entity: "operators",
  id: ANNA,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
};
const BADGE: ChangeItem = {
  entity: "operator_badges",
  id: PASS_7,
  rev: 6,
  deleted: false,
  data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
};
const ANNA_OPERATOR: FloorOperator = {
  id: ANNA,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
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

interface Options {
  local: LocalExecutor;
  sync?: SyncState;
  notice?: FloorNotice | null;
  source?: ScanSource;
  watchScanners?: OperatorSignInProps["watchScanners"];
}

function renderSignIn({ local, sync = SYNCED, notice = null, source, watchScanners }: Options) {
  const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
  const onSync = vi.fn<() => void>();
  const onOffice = vi.fn<() => void>();
  const view = render(
    <ThemeProvider>
      <OperatorSignIn
        local={local}
        pairing={PAIRING}
        lineId={null}
        sync={sync}
        notice={notice}
        source={source ?? createKeyboardWedgeSource(window)}
        now={CLOCK}
        onSignedIn={onSignedIn}
        onSync={onSync}
        onOffice={onOffice}
        {...(watchScanners === undefined ? {} : { watchScanners })}
      />
    </ThemeProvider>,
  );
  return { ...view, onSignedIn, onSync, onOffice };
}

/** A keyboard-wedge scanner: every character a key, then Enter. */
function scan(text: string) {
  for (const key of text) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
}

function press(...keys: string[]) {
  for (const key of keys) fireEvent.click(screen.getByRole("button", { name: key }));
}

async function enterLogin(login: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
  press(...login);
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

describe("the floor's sign-in screen", () => {
  it("signs an operator in with a personnel number and a PIN on the keypad", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await enterLogin("0042");
    expect(screen.getByText("Табельный номер 0042. Введите PIN")).toBeTruthy();
    press("4", "8", "2", "1");
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("••••");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("says a wrong PIN, empties it and stays on the PIN", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await enterLogin("0042");
    press("1", "1", "1", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText("Неверный табельный номер или PIN.")).toBeTruthy();
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    expect(screen.getByText("Табельный номер 0042. Введите PIN")).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("offers «Далее» for 3–12 digits and «Войти» for 4–6", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    const next = () => screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
    press("4", "2");
    expect(next().disabled).toBe(true);
    press("0");
    expect(next().disabled).toBe(false);
    fireEvent.click(next());
    const submit = () => screen.getByRole("button", { name: "Войти" }) as HTMLButtonElement;
    press("4", "8", "2");
    expect(submit().disabled).toBe(true);
    press("1");
    expect(submit().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Введите табельный номер")).toBeTruthy();
  });

  it("signs an operator in with a badge scan, once, whatever arrives during the check", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText("Отсканируйте бейдж для входа");
    act(() => {
      scan("MRK-000742");
      scan("MRK-000742");
    });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("explains a refused scan in words of its own, and asks for a sync only after an unknown badge", async () => {
    const { onSync } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText("Отсканируйте бейдж для входа");
    act(() => scan("MRK-000743"));
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    expect(onSync).toHaveBeenCalledTimes(1);
    act(() => scan("0104600682000013215Abc\u001d91EE11"));
    expect(await screen.findByText("Это код товара, а не бейдж. Приложите бейдж.")).toBeTruthy();
    act(() => scan("ЬКЛ-000742"));
    expect(await screen.findByText(/^Сканер набирает в русской раскладке\./)).toBeTruthy();
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("says how many minutes a locked station waits", async () => {
    const local = await synced([SITE, OPERATOR, BADGE]);
    await local.transaction([
      {
        sql:
          "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
          "VALUES ('station', 10, ?, ?)",
        values: [NOW - 1_000, NOW - 1_000],
      },
    ]);
    renderSignIn({ local });
    await screen.findByText("Отсканируйте бейдж для входа");
    act(() => scan("MRK-000742"));
    expect(
      await screen.findByText(
        "Слишком много неудачных попыток. Вход на этой станции приостановлен на 1 мин.",
      ),
    ).toBeTruthy();
  });

  it("says nobody can sign in until this pairing's copies arrive, and keeps the way into the office", async () => {
    const { executor } = openLocalDb();
    const { onOffice } = renderSignIn({ local: executor, sync: { ...SYNCED, synced: 0 } });
    expect(await screen.findByText(/^Справочники ещё не загружены с хоста\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ввести табельный номер" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(onOffice).toHaveBeenCalledTimes(1);
  });

  it("reads the copies again after every sync", async () => {
    const { executor } = openLocalDb();
    const source = createKeyboardWedgeSource(window);
    const { rerender } = renderSignIn({ local: executor, sync: { ...SYNCED, synced: 0 }, source });
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [SITE] }),
      local: executor,
      ...PAIRING,
    });
    rerender(
      <ThemeProvider>
        <OperatorSignIn
          local={executor}
          pairing={PAIRING}
          lineId={null}
          sync={SYNCED}
          notice={null}
          source={source}
          now={CLOCK}
          onSignedIn={() => undefined}
          onSync={() => undefined}
          onOffice={() => undefined}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText(/^В справочнике нет операторов\./)).toBeTruthy();
  });

  it("offers to read the copies again when the read fails", async () => {
    const real = await synced([SITE, OPERATOR]);
    let failing = true;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderSignIn({ local });
    expect(
      await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере."),
    ).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "Ввести табельный номер" })).toBeTruthy();
  });

  it("says why the last operator was signed out until somebody tries to sign in", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]), notice: "idle" });
    expect(await screen.findByText("Оператор вышел по бездействию. Войдите снова.")).toBeTruthy();
    act(() => scan("MRK-000743"));
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    expect(screen.queryByText("Оператор вышел по бездействию. Войдите снова.")).toBeNull();
  });

  it("does not bring the leave notice back on a step change or during a later check", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    render(screenOf(propsOf(gate.local, { notice: "idle" })));
    const IDLE = "Оператор вышел по бездействию. Войдите снова.";
    expect(await screen.findByText(IDLE)).toBeTruthy();
    // Moving between the steps without trying to sign in keeps it.
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    expect(screen.getByText(IDLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText(IDLE)).toBeTruthy();
    // The first attempt dismisses it for good, also while the check runs.
    gate.hold();
    try {
      act(() => scan("MRK-000743"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      expect(screen.queryByText(IDLE)).toBeNull();
    } finally {
      gate.release();
    }
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    expect(screen.queryByText(/^Бейдж не найден\./)).toBeNull();
    expect(screen.queryByText(IDLE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.queryByText(IDLE)).toBeNull();
  });

  it("stops listening to the scanner once it leaves the screen", async () => {
    const stop = vi.fn();
    const source: ScanSource = {
      start: vi.fn(() => stop),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    const { unmount } = renderSignIn({ local: await synced([SITE]), source });
    await screen.findByText(/^В справочнике нет операторов\./);
    expect(source.start).toHaveBeenCalledTimes(1);
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the keyboard-wedge scan source", () => {
  it("hands over the keys typed before Enter, without modifiers, and nothing for a bare Enter", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    fireEvent.keyDown(window, { key: "Shift" });
    scan("Ab-1");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "x" });
    source.clearPendingInput();
    scan("2");
    stop();
    scan("3");
    expect(scans).toEqual(["Ab-1", "2"]);
  });

  describe("keys with a modifier", () => {
    /** The keys of one scan, each with its modifiers, then Enter. */
    function scanned(...keys: Array<[string, KeyboardEventInit?]>): string[] {
      const source = createKeyboardWedgeSource(window);
      const scans: string[] = [];
      const stop = source.start((raw) => scans.push(raw));
      for (const [key, init] of keys) fireEvent.keyDown(window, { key, ...init });
      fireEvent.keyDown(window, { key: "Enter" });
      stop();
      return scans;
    }

    it("reads Ctrl+] as the GS1 group separator a scanner sends as a control character", () => {
      expect(scanned(["a"], ["]", { ctrlKey: true }], ["b"])).toEqual(["a\u001db"]);
    });

    it("drops the other keys held with Ctrl, and every key held with Meta", () => {
      expect(scanned(["a"], ["c", { ctrlKey: true }], ["b"])).toEqual(["ab"]);
      expect(scanned(["a"], ["v", { ctrlKey: true, shiftKey: true }], ["b"])).toEqual(["ab"]);
      expect(scanned(["a"], ["a", { metaKey: true }], ["b"])).toEqual(["ab"]);
      expect(scanned(["a"], ["]", { metaKey: true }], ["b"])).toEqual(["ab"]);
    });

    it("keeps what AltGr types (Windows sends it as Ctrl+Alt), `]` included", () => {
      expect(scanned(["a"], ["@", { ctrlKey: true, altKey: true }], ["b"])).toEqual(["a@b"]);
      // AltGr+9 is `]` on some layouts: a character, not the separator.
      expect(scanned(["a"], ["]", { ctrlKey: true, altKey: true }], ["b"])).toEqual(["a]b"]);
    });

    it("keeps a plain, shifted or Alt-held character", () => {
      expect(
        scanned(["a"], ["B", { shiftKey: true }], ["x", { altKey: true }], ["]"], ["-"]),
      ).toEqual(["aBx]-"]);
    });
  });

  it("keeps the scan's Enter from also pressing the focused button", () => {
    const source = createKeyboardWedgeSource(window);
    const stop = source.start(() => undefined);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    stop();
  });
});

const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PASS_8 = "e7f6d5c4-b3a2-4918-8a7b-6c5d4e3f2a19";
const OTHER_HOST = "9b8a7c6d-5e4f-4321-8a9b-0c1d2e3f4a5b";
const OTHER_DEVICE = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const LINE = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const OTHER_LINE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BADGE_PROMPT = "Отсканируйте бейдж для входа";
const FAILED_TEXT = "Не удалось проверить вход на этом компьютере. Попробуйте ещё раз.";

function operatorItem(id: string, rev: number, login: string, name: string): ChangeItem {
  return {
    entity: "operators",
    id,
    rev,
    deleted: false,
    data: { login, name, role: null, pinPhc: PIN_PHC },
  };
}

function badgeItem(id: string, rev: number, operatorId: string): ChangeItem {
  return {
    entity: "operator_badges",
    id,
    rev,
    deleted: false,
    data: { operatorId, badgePhc: BADGE_PHC, label: null },
  };
}

/** The props of a screen on `local`, for the tests that re-render with other ones. */
function propsOf(local: LocalExecutor, over: Partial<OperatorSignInProps> = {}) {
  return {
    local,
    pairing: PAIRING,
    lineId: null,
    sync: SYNCED,
    notice: null,
    source: createKeyboardWedgeSource(window),
    now: CLOCK,
    onSignedIn: () => undefined,
    onSync: () => undefined,
    onOffice: () => undefined,
    ...over,
  } satisfies OperatorSignInProps;
}

function screenOf(props: OperatorSignInProps) {
  return (
    <ThemeProvider>
      <OperatorSignIn {...props} />
    </ThemeProvider>
  );
}

/**
 * A local database whose next query waits for `release()`: the check that
 * makes it stays in flight while the test changes the screen under it. Always
 * release, or the whole file's sign-in queue stays held.
 */
function gatedExecutor(real: LocalExecutor) {
  let pending: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const local: LocalExecutor = {
    query: (sql, params, row) => {
      const wait = pending;
      pending = null;
      return wait === null
        ? real.query(sql, params, row)
        : wait.then(() => real.query(sql, params, row));
    },
    transaction: (statements) => real.transaction(statements),
  };
  return {
    local,
    hold() {
      pending = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
    },
  };
}

/** Resolves once every check started so far has finished (sign-in attempts queue up in order). */
async function drained(local: LocalExecutor) {
  await act(async () => {
    await signInWithBadge({ local, pairing: PAIRING, now: CLOCK }, "ЬКЛ");
  });
}

const failureCount = z.object({ failures: z.number().int() });

async function stationFailures(local: LocalExecutor) {
  const rows = await local.query(
    "SELECT failures FROM floor_sign_in_failures WHERE key = 'station'",
    [],
    failureCount,
  );
  return rows[0]?.failures ?? 0;
}

function lockRow(key: string, failures: number, lockedAt: number) {
  return {
    sql:
      "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
      "VALUES (?, ?, ?, ?)",
    values: [key, failures, lockedAt, lockedAt],
  };
}

describe("a check that is still running when the screen changes", () => {
  it("drops its answer when the screen has left", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    const onSync = vi.fn<() => void>();
    const { unmount } = render(screenOf(propsOf(gate.local, { onSignedIn, onSync })));
    await screen.findByText(BADGE_PROMPT);
    gate.hold();
    try {
      act(() => scan("MRK-000742"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      unmount();
    } finally {
      gate.release();
    }
    await drained(gate.local);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
  });

  it.each([
    ["pairing's host", { pairing: { hostId: OTHER_HOST, deviceId: DEVICE_ID } }],
    ["pairing's device", { pairing: { hostId: HOST_ID, deviceId: OTHER_DEVICE } }],
    ["station's line", { lineId: OTHER_LINE }],
  ] as const)("drops its answer when the %s changed meanwhile", async (_name, changed) => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    const onSync = vi.fn<() => void>();
    const first = propsOf(gate.local, { onSignedIn, onSync, lineId: LINE });
    const { rerender } = render(screenOf(first));
    await screen.findByText(BADGE_PROMPT);
    gate.hold();
    try {
      act(() => scan("MRK-000742"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      rerender(screenOf({ ...first, ...changed }));
    } finally {
      gate.release();
    }
    await drained(gate.local);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
    expect(screen.queryByText("Проверяем…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still answers when only a callback changed meanwhile", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    const first = propsOf(gate.local, { onSignedIn, lineId: LINE });
    const { rerender } = render(screenOf(first));
    await screen.findByText(BADGE_PROMPT);
    gate.hold();
    try {
      act(() => scan("MRK-000742"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      rerender(screenOf({ ...first, onSync: () => undefined, onOffice: () => undefined }));
    } finally {
      gate.release();
    }
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, LINE));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it("says it is checking and holds the scan screen's buttons until the answer, but not the way into the office", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    render(screenOf(propsOf(gate.local, { onSignedIn })));
    await screen.findByText(BADGE_PROMPT);
    gate.hold();
    try {
      act(() => scan("MRK-000742"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      const office = screen.getByRole("button", { name: "Офис" }) as HTMLButtonElement;
      const login = screen.getByRole("button", {
        name: "Ввести табельный номер",
      }) as HTMLButtonElement;
      // A check that never settles must not trap the station on this screen.
      expect(office.disabled).toBe(false);
      expect(login.disabled).toBe(true);
    } finally {
      gate.release();
    }
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Проверяем…")).toBeNull();
  });

  it("lets the operator leave for the office while a check runs, and the check then signs nobody in", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    const onSync = vi.fn<() => void>();
    // The shell leaves this screen for the office: the screen goes away.
    const onOffice = vi.fn(() => {
      view.unmount();
    });
    const view = render(screenOf(propsOf(gate.local, { onSignedIn, onSync, onOffice })));
    await enterLogin("0042");
    press("4", "8", "2", "1");
    gate.hold();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Войти" }));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      // The keypad and the way back stay held; the office does not.
      expect((screen.getByRole("button", { name: "Назад" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect((screen.getByRole("button", { name: "1" }) as HTMLButtonElement).disabled).toBe(true);
      const office = screen.getByRole("button", { name: "Офис" }) as HTMLButtonElement;
      expect(office.disabled).toBe(false);
      fireEvent.click(office);
      expect(onOffice).toHaveBeenCalledTimes(1);
    } finally {
      gate.release();
    }
    await drained(gate.local);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
  });

  it.each([
    ["pairing's device", { pairing: { hostId: HOST_ID, deviceId: OTHER_DEVICE } }],
    ["station's line", { lineId: OTHER_LINE }],
  ] as const)(
    "empties the typed PIN even when the %s changed during the check",
    async (name, changed) => {
      const real = await synced([SITE, OPERATOR]);
      const gate = gatedExecutor(real);
      const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
      const first = propsOf(gate.local, { onSignedIn, lineId: LINE });
      const { rerender } = render(screenOf(first));
      await enterLogin("0042");
      press("4", "8", "2", "1");
      expect(screen.getByLabelText("Набранный PIN").textContent).toBe("••••");
      gate.hold();
      try {
        fireEvent.click(screen.getByRole("button", { name: "Войти" }));
        expect(await screen.findByText("Проверяем…")).toBeTruthy();
        // The other pairing has copies of its own, so the PIN step stays up
        // under it and the typed PIN would be visible if it were kept.
        if (name === "pairing's device") {
          await syncReferences({
            changes: async () => ({
              hostId: HOST_ID,
              rev: 10,
              hasMore: false,
              items: [SITE, OPERATOR],
            }),
            local: real,
            hostId: HOST_ID,
            deviceId: OTHER_DEVICE,
          });
        }
        rerender(screenOf({ ...first, ...changed }));
      } finally {
        gate.release();
      }
      await drained(gate.local);
      await waitFor(() => expect(screen.getByLabelText("Набранный PIN").textContent).toBe(""));
      expect(onSignedIn).not.toHaveBeenCalled();
    },
  );

  it("reads under the pairing it was last given", async () => {
    const { executor } = openLocalDb();
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    const first = propsOf(executor, { sync: { ...SYNCED, synced: 0 } });
    const { rerender } = render(screenOf(first));
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    await syncReferences({
      changes: async () => ({
        hostId: OTHER_HOST,
        rev: 10,
        hasMore: false,
        items: [SITE, OPERATOR, BADGE],
      }),
      local: executor,
      hostId: OTHER_HOST,
      deviceId: OTHER_DEVICE,
    });
    rerender(
      screenOf({
        ...first,
        pairing: { hostId: OTHER_HOST, deviceId: OTHER_DEVICE },
        sync: SYNCED,
        onSignedIn,
      }),
    );
    await screen.findByText(BADGE_PROMPT);
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("listens to the source it is given now and stops the old one", async () => {
    const local = await synced([SITE, OPERATOR]);
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();
    const first: ScanSource = {
      start: vi.fn(() => stopFirst),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    const second: ScanSource = {
      start: vi.fn(() => stopSecond),
      clearPendingInput: vi.fn(),
      setManualTextEntryActive: vi.fn(),
    };
    const props = propsOf(local, { source: first });
    const { rerender, unmount } = render(screenOf(props));
    await screen.findByText(BADGE_PROMPT);
    rerender(screenOf({ ...props, source: second }));
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(stopSecond).not.toHaveBeenCalled();
    unmount();
    expect(stopSecond).toHaveBeenCalledTimes(1);
  });
});

describe("what the screen holds back", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a PIN as dots and a scan not at all, in no attribute either", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText(BADGE_PROMPT);
    act(() => scan("MRK-000743"));
    const refusal = await screen.findByText(/^Бейдж не найден\./);
    expect(refusal.closest(".mk-alert--error")).not.toBeNull();
    expect(document.body.innerHTML).not.toContain("000743");
    await enterLogin("0042");
    press("4", "8", "2", "1");
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("••••");
    expect(document.body.innerHTML).not.toContain("4821");
    expect(document.body.innerHTML).not.toContain("4,8,2,1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(document.body.innerHTML).not.toContain("4821");
  });

  it("empties the PIN after a sign-in, and on the way back to the number", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await enterLogin("0042");
    press("1", "2");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText("Введите табельный номер")).toBeTruthy();
    press("0", "0", "4", "2");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
  });

  it("logs nothing and shows no text of a database error, and takes the next attempt", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const real = await synced([SITE, OPERATOR, BADGE]);
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing
          ? Promise.reject(new Error("SELECT 4821 MRK-000742 failed"))
          : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    const { onSignedIn, onSync } = renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    failing = true;
    act(() => scan("MRK-000742"));
    expect(await screen.findByText(FAILED_TEXT)).toBeTruthy();
    for (const secret of ["4821", "MRK-000742", "SELECT"]) {
      expect(document.body.innerHTML).not.toContain(secret);
    }
    expect(onSync).not.toHaveBeenCalled();
    failing = false;
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("hands an operator's name over as it is and shows no name of its own", async () => {
    const name = '<b>Анна</b> <img src=x onerror="alert(1)"> & "Кузнецова"';
    const local = await synced([SITE, operatorItem(ANNA, 5, "0042", name), BADGE]);
    const { container, onSignedIn } = renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ ...ANNA_OPERATOR, name }, null));
    expect(container.querySelector("b, img")).toBeNull();
    expect(document.body.textContent).not.toContain("Кузнецова");
  });

  it("documents today's behaviour, owner decision pending: a stray product barcode counts as an unknown badge and ten of them pause the station", async () => {
    // Documents today's behaviour so the owner's decision stays visible
    // (Task 3 review): nothing tells an EAN-13 or a single-AI GS1-128 SSCC
    // from a badge somebody typed by hand, so each is a guess against the
    // station and the tenth pauses every sign-in for a minute.
    const local = await synced([SITE, OPERATOR, BADGE]);
    const { onSync } = renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    const strays = ["4600682000013", "00460068200001321567", "0104600682000013"];
    for (const [index, code] of strays.entries()) {
      act(() => scan(code));
      await waitFor(async () => expect(await stationFailures(local)).toBe(index + 1));
      expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    }
    expect(screen.queryByText("Это код товара, а не бейдж. Приложите бейдж.")).toBeNull();
    expect(onSync).toHaveBeenCalledTimes(3);
    await local.transaction([
      { sql: "UPDATE floor_sign_in_failures SET failures = 9 WHERE key = 'station'" },
    ]);
    act(() => scan("5901234123457"));
    expect(
      await screen.findByText(
        "Слишком много неудачных попыток. Вход на этой станции приостановлен на 1 мин.",
      ),
    ).toBeTruthy();
  });
});

describe("the screen's answers", () => {
  it("says how many minutes an operator's PIN waits, rounded up, and still takes the badge", async () => {
    const local = await synced([SITE, OPERATOR, BADGE]);
    await local.transaction([lockRow(`operator:${ANNA}`, 5, NOW - 100_000)]);
    const { onSignedIn, onSync } = renderSignIn({ local });
    await enterLogin("0042");
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(
      await screen.findByText(
        "Слишком много неверных PIN. Вход по PIN для этого табельного номера приостановлен на 4 мин. Можно войти по бейджу.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    expect(onSync).not.toHaveBeenCalled();
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("asks for a sync after a wrong PIN, and counts a double press once", async () => {
    const local = await synced([SITE, OPERATOR]);
    const { onSync } = renderSignIn({ local });
    await enterLogin("0042");
    press("1", "1", "1", "1");
    const submit = screen.getByRole("button", { name: "Войти" });
    // Both presses in one act: the button has not yet turned into its loading
    // self when the second arrives, so only the screen's own guard stops it.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(await screen.findByText("Неверный табельный номер или PIN.")).toBeTruthy();
    // A second check would still be hashing: wait for every check to end.
    await drained(local);
    expect(await stationFailures(local)).toBe(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("says why a number or a badge two operators share is refused, without asking for a sync", async () => {
    const local = await synced([
      SITE,
      operatorItem(ANNA, 5, "0042", "Анна Кузнецова"),
      operatorItem(BORIS, 6, "0042", "Борис Орлов"),
      badgeItem(PASS_7, 7, ANNA),
      badgeItem(PASS_8, 8, BORIS),
    ]);
    const { onSync, onSignedIn } = renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    act(() => scan("MRK-000742"));
    expect(
      await screen.findByText(
        "Этот бейдж выдан нескольким операторам. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
    act(() => scan("\u0007"));
    expect(
      await screen.findByText("Это не похоже на бейдж. Приложите бейдж ещё раз."),
    ).toBeTruthy();
    await enterLogin("0042");
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(
      await screen.findByText(
        "Этот табельный номер есть у нескольких операторов. Обратитесь к администратору.",
      ),
    ).toBeTruthy();
    expect(onSync).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("says a refusal and a notice in the polite region and in no alert of their own", async () => {
    const view = renderSignIn({
      local: await synced([SITE, OPERATOR, BADGE]),
      notice: "idle",
    });
    await screen.findByText(BADGE_PROMPT);
    const region = view.container.querySelector<HTMLElement>(".floor-sign-in__message");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toContain("Оператор вышел по бездействию.");
    // Heard once, by the region: an alert inside it would be read a second time.
    expect(region?.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toEqual([]);

    act(() => scan("MRK-000743"));
    const refusal = await screen.findByText(/^Бейдж не найден\./);
    expect(region?.contains(refusal)).toBe(true);
    expect(refusal.closest(".mk-alert--error")).not.toBeNull();
    expect(region?.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("warns, rather than fails, when a scan finds the copies not ready, and asks for a sync", async () => {
    const { executor } = openLocalDb();
    const { onSync } = renderSignIn({ local: executor, sync: { ...SYNCED, synced: 0 } });
    await screen.findByText(/^Справочники ещё не загружены с хоста\./);
    act(() => scan("MRK-000742"));
    const message = await screen.findByText(
      "Справочники операторов ещё не загружены с хоста. Вход станет доступен после синхронизации.",
    );
    expect(message.closest(".mk-alert--warn")).not.toBeNull();
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("says there are no operators and keeps the way into the office", async () => {
    const { onOffice } = renderSignIn({ local: await synced([SITE]) });
    expect(await screen.findByText(/^В справочнике нет операторов\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ввести табельный номер" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(onOffice).toHaveBeenCalledTimes(1);
  });
});

describe("the keypad's limits and the scanner on every step", () => {
  it("takes at most 12 digits of a number and 6 of a PIN", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    press(..."1234567890");
    expect((screen.getByRole("button", { name: "1" }) as HTMLButtonElement).disabled).toBe(false);
    press("1", "2");
    expect(screen.getByLabelText("Набранный табельный номер").textContent).toBe("123456789012");
    expect((screen.getByRole("button", { name: "3" }) as HTMLButtonElement).disabled).toBe(true);
    const next = screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    press(..."482100");
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("••••••");
    expect((screen.getByRole("button", { name: "3" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Войти" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("takes a badge scan on the number and the PIN steps too, and empties the PIN after it", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await enterLogin("0042");
    press("1", "1");
    act(() => scan("MRK-000743"));
    expect(await screen.findByText(/^Бейдж не найден\./)).toBeTruthy();
    expect(screen.getByText("Табельный номер 0042. Введите PIN")).toBeTruthy();
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("drops the keys typed before a step changes, so they do not join the next scan", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    await screen.findByText(BADGE_PROMPT);
    for (const key of "abc") fireEvent.keyDown(window, { key });
    fireEvent.click(screen.getByRole("button", { name: "Ввести табельный номер" }));
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });
});

describe("the keyboard-wedge scan source, further", () => {
  it("forgets the keys typed before it was stopped", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const first = source.start(() => undefined);
    for (const key of "ab") fireEvent.keyDown(window, { key });
    first();
    const second = source.start((raw) => scans.push(raw));
    scan("c");
    second();
    expect(scans).toEqual(["c"]);
  });

  it("leaves Tab and the arrows alone, and keeps their names out of a scan", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(tab);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true });
    window.dispatchEvent(arrow);
    scan("A");
    stop();
    expect(tab.defaultPrevented).toBe(false);
    expect(arrow.defaultPrevented).toBe(false);
    expect(scans).toEqual(["A"]);
  });

  it("hands a GS1 group separator over untouched", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    scan("0104600682000013\u001d91EE11");
    stop();
    expect(scans).toEqual(["0104600682000013\u001d91EE11"]);
  });
});

describe("the rest of the screen", () => {
  it("clears the last answer when the next check starts", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR, BADGE]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    render(screenOf(propsOf(gate.local, { onSignedIn })));
    await screen.findByText(BADGE_PROMPT);
    act(() => scan("MRK-000743"));
    await screen.findByText(/^Бейдж не найден\./);
    gate.hold();
    try {
      act(() => scan("MRK-000742"));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      expect(screen.queryByText(/^Бейдж не найден\./)).toBeNull();
    } finally {
      gate.release();
    }
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it("holds the keypad and every button but the office while a PIN is checked", async () => {
    const gate = gatedExecutor(await synced([SITE, OPERATOR]));
    const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
    render(screenOf(propsOf(gate.local, { onSignedIn })));
    await screen.findByText(BADGE_PROMPT);
    await enterLogin("0042");
    press("4", "8", "2", "1");
    gate.hold();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Войти" }));
      expect(await screen.findByText("Проверяем…")).toBeTruthy();
      for (const name of ["1", "Стереть", "Сброс", "Назад"]) {
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      }
      expect((screen.getByRole("button", { name: "Офис" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect((screen.getByRole("button", { name: "Войти" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    } finally {
      gate.release();
    }
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it.each([
    ["idle", "Оператор вышел по бездействию. Войдите снова."],
    ["removed", "Оператор больше не может входить на станции. Обратитесь к администратору."],
    ["line_changed", "Станция перешла на другую линию. Войдите снова."],
  ] as const)("says why an operator left: %s", async (notice, text) => {
    renderSignIn({ local: await synced([SITE, OPERATOR]), notice });
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("goes back from the number to the badge prompt", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText(BADGE_PROMPT)).toBeTruthy();
  });

  it("reads the copies again when asked, and says it is reading", async () => {
    const real = await synced([SITE, OPERATOR]);
    let reads = 0;
    const local: LocalExecutor = {
      query: () => {
        reads += 1;
        return Promise.reject(new Error("disk"));
      },
      transaction: (statements) => real.transaction(statements),
    };
    renderSignIn({ local });
    await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере.");
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(screen.getByText("Читаем справочник операторов…")).toBeTruthy();
    expect(
      await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере."),
    ).toBeTruthy();
    expect(reads).toBeGreaterThan(before);
  });
});

describe("text typed into a field, not scanned", () => {
  it("hands nothing over while a text field takes the keys, and drops what came before", () => {
    const source = createKeyboardWedgeSource(window);
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    fireEvent.keyDown(window, { key: "x" });
    source.setManualTextEntryActive(true);
    scan("Анна");
    source.setManualTextEntryActive(false);
    scan("MRK-1");
    stop();
    expect(scans).toEqual(["MRK-1"]);
  });

  it("leaves the field's own Enter alone", () => {
    const source = createKeyboardWedgeSource(window);
    const stop = source.start(() => undefined);
    source.setManualTextEntryActive(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(enter);
    stop();
    expect(enter.defaultPrevented).toBe(false);
  });
});

describe("finding oneself by name", () => {
  const BORIS_ITEM = operatorItem(BORIS, 6, "0077", "Борис Петров");

  async function openSearch() {
    fireEvent.click(await screen.findByRole("button", { name: "Найти по имени" }));
    return screen.getByLabelText("Имя оператора") as HTMLInputElement;
  }

  function typeName(field: HTMLInputElement, value: string) {
    fireEvent.change(field, { target: { value } });
  }

  it("finds an operator by name and signs them in with their PIN", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    const field = await openSearch();
    expect(screen.getByText("Введите первые 2–3 буквы имени")).toBeTruthy();
    typeName(field, "кузн");
    fireEvent.click(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" }));
    expect(screen.getByText("Анна Кузнецова, табельный номер 0042. Введите PIN")).toBeTruthy();
    press("4", "8", "2", "1");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("waits for two letters and says when nobody matches", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    const field = await openSearch();
    expect(await screen.findByText("Введите минимум две буквы")).toBeTruthy();
    typeName(field, "а");
    expect(screen.getByText("Введите минимум две буквы")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /— 0042$/ })).toBeNull();
    typeName(field, "яя");
    expect(screen.getByText("Операторы не найдены")).toBeTruthy();
  });

  it("goes back from the PIN to the search as it was, and from the search to the badge", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    typeName(await openSearch(), "бор");
    fireEvent.click(await screen.findByRole("button", { name: "Борис Петров — 0077" }));
    press("1");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect((screen.getByLabelText("Имя оператора") as HTMLInputElement).value).toBe("бор");
    expect(await screen.findByRole("button", { name: "Борис Петров — 0077" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.getByText(BADGE_PROMPT)).toBeTruthy();
    // The keypad's way afterwards names nobody.
    await enterLogin("0077");
    expect(screen.getByText("Табельный номер 0077. Введите PIN")).toBeTruthy();
  });

  it("does not take a name typed into the field for a badge scan", async () => {
    const { onSignedIn, onSync } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    const field = await openSearch();
    act(() => field.focus());
    for (const key of "MRK-000743") fireEvent.keyDown(field, { key });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText(/^Бейдж не найден\./)).toBeNull();
    expect(onSync).not.toHaveBeenCalled();
    // Out of the field, the scanner signs in again.
    act(() => field.blur());
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  it("gives the scanner back when the screen goes while the field has the keys", async () => {
    const source = createKeyboardWedgeSource(window);
    const { unmount } = renderSignIn({ local: await synced([SITE, OPERATOR]), source });
    const field = await openSearch();
    act(() => field.focus());
    unmount();
    const scans: string[] = [];
    const stop = source.start((raw) => scans.push(raw));
    scan("MRK-000742");
    stop();
    expect(scans).toEqual(["MRK-000742"]);
  });

  it("gives the scanner back when choosing a name takes the field away", async () => {
    const { onSignedIn } = renderSignIn({ local: await synced([SITE, OPERATOR, BADGE]) });
    const field = await openSearch();
    act(() => field.focus());
    typeName(field, "кузн");
    // A click on a result does not blur the field in jsdom: only the step change can.
    fireEvent.click(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" }));
    expect(screen.getByText("Анна Кузнецова, табельный номер 0042. Введите PIN")).toBeTruthy();
    act(() => scan("MRK-000742"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
  });

  describe("when a sync takes the field away while the screen stays", () => {
    const READ_FAILED = /^Не удалось прочитать справочник операторов на этом компьютере\./;

    function failingCopies(): LocalExecutor {
      return {
        query: () => Promise.reject(new Error("disk")),
        transaction: () => Promise.reject(new Error("disk")),
      };
    }

    /** The copies the screen reads, swappable between renders. */
    async function swappable() {
      const real = await synced([SITE, OPERATOR, BADGE]);
      let backing: LocalExecutor = real;
      const local: LocalExecutor = {
        query: (sql, params, row) => backing.query(sql, params, row),
        transaction: (statements) => backing.transaction(statements),
      };
      const onSignedIn = vi.fn<(operator: FloorOperator, lineId: string | null) => void>();
      const source = createKeyboardWedgeSource(window);
      const element = (sync: SyncState) => (
        <ThemeProvider>
          <OperatorSignIn
            local={local}
            pairing={PAIRING}
            lineId={null}
            sync={sync}
            notice={null}
            source={source}
            now={CLOCK}
            onSignedIn={onSignedIn}
            onSync={() => undefined}
            onOffice={() => undefined}
          />
        </ThemeProvider>
      );
      return {
        ...render(element(SYNCED)),
        element,
        onSignedIn,
        // What the next read finds, and what is there again afterwards.
        swap: (next: LocalExecutor) => {
          backing = next;
        },
        restore: () => {
          backing = real;
        },
      };
    }

    it.each([
      ["a failed read", failingCopies, READ_FAILED],
      [
        "copies that are not ready",
        () => openLocalDb().executor,
        /^Справочники ещё не загружены с хоста\./,
      ],
      ["no operators", () => synced([SITE]), /^В справочнике нет операторов\./],
    ])("hears a badge again after %s", async (_name, copies, said) => {
      const next = await copies();
      const view = await swappable();
      const field = await openSearch();
      // The first reading of the copies has landed once the hint replaces «Читаем…».
      await screen.findByText("Введите минимум две буквы");
      act(() => field.focus());
      view.swap(next);
      view.rerender(view.element({ ...SYNCED, synced: 2 }));
      expect(await screen.findByText(said)).toBeTruthy();
      expect(screen.queryByLabelText("Имя оператора")).toBeNull();
      // The search's own re-read answers too, to a screen that no longer shows it.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      view.restore();
      act(() => scan("MRK-000742"));
      await waitFor(() => expect(view.onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    });

    it("hears a badge there without the field ever having the keys (the control)", async () => {
      const view = await swappable();
      await openSearch();
      await screen.findByText("Введите минимум две буквы");
      view.swap(failingCopies());
      view.rerender(view.element({ ...SYNCED, synced: 2 }));
      expect(await screen.findByText(READ_FAILED)).toBeTruthy();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      view.restore();
      act(() => scan("MRK-000742"));
      await waitFor(() => expect(view.onSignedIn).toHaveBeenCalledWith(ANNA_OPERATOR, null));
    });
  });

  it("shows no name from the previous reading while the search reads the copies again", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR, BORIS_ITEM]) });
    typeName(await openSearch(), "кузн");
    expect(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Найти по имени" }));
    typeName(screen.getByLabelText("Имя оператора"), "кузн");
    // The list read before is gone at once; the new reading lands afterwards.
    expect(screen.getByText("Читаем справочник операторов…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Анна Кузнецова — 0042" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Анна Кузнецова — 0042" })).toBeTruthy();
  });

  it("offers no name while the copies cannot be read", async () => {
    const real = await synced([SITE, OPERATOR]);
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    failing = true;
    typeName(await openSearch(), "ан");
    expect(
      await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Анна Кузнецова — 0042" })).toBeNull();
  });
});

describe("the size of the screen's controls", () => {
  /** Every button now on screen is a floor one (64 px, `size="floor"`). */
  function allFloorSized() {
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
  }

  it("keeps every button at the floor's 64 px on every step", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await screen.findByText(BADGE_PROMPT);
    allFloorSized();
    fireEvent.click(screen.getByRole("button", { name: "Найти по имени" }));
    fireEvent.change(screen.getByLabelText("Имя оператора"), { target: { value: "ан" } });
    await screen.findByRole("button", { name: "Анна Кузнецова — 0042" });
    allFloorSized();
    fireEvent.click(screen.getByRole("button", { name: "Анна Кузнецова — 0042" }));
    allFloorSized();
  });

  it("keeps «Повторить» at the floor's size too", async () => {
    const local: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    renderSignIn({ local });
    await screen.findByText("Не удалось прочитать справочник операторов на этом компьютере.");
    allFloorSized();
  });
});

describe("the welcome screen's layout, the same on every step", () => {
  /** «Офис» and, off the badge step, «Назад»: present, floor-sized, and «Офис» in one place. */
  function officeInHeader() {
    const office = screen.getByRole("button", { name: "Офис" });
    expect(office.className).toContain("mk-btn--floor");
    expect(office.closest(".operator-login__header")).not.toBeNull();
    return office;
  }

  function backInActions() {
    const back = screen.getByRole("button", { name: "Назад" });
    expect(back.className).toContain("mk-btn--floor");
    expect(back.closest(".operator-login__actions")).not.toBeNull();
  }

  it("keeps «Офис» in the header and «Назад» in the action row on every step", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await screen.findByText(BADGE_PROMPT);
    expect(screen.getByRole("heading", { name: "Вход оператора" })).toBeTruthy();
    officeInHeader();
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ввести табельный номер" }));
    officeInHeader();
    backInActions();
    press("0", "0", "4", "2");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    officeInHeader();
    backInActions();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Найти по имени" }));
    officeInHeader();
    backInActions();
    // The name field is labelled.
    expect(screen.getByLabelText("Имя оператора").tagName).toBe("INPUT");
  });

  it("offers the name search from the number step and the number from the name search, as the cloud station does", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    fireEvent.click(screen.getByRole("button", { name: "Найти по имени" }));
    expect(screen.getByText("Введите первые 2–3 буквы имени")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ввести табельный номер" }));
    expect(screen.getByText("Введите табельный номер")).toBeTruthy();
    expect(screen.getByLabelText("Набранный табельный номер").textContent).toBe("");
  });

  it("shows the badge cue on the badge step only", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await screen.findByText(BADGE_PROMPT);
    expect(screen.getByText("Поднесите бейдж к сканеру")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ввести табельный номер" }));
    expect(screen.queryByText("Поднесите бейдж к сканеру")).toBeNull();
  });
});

describe("the scanner's state on the welcome screen", () => {
  function snapshotOf(...statuses: Array<"connected" | "disconnected">) {
    return {
      revision: 1,
      scanners: statuses.map((status, index) => ({
        port: `COM${index + 3}`,
        baud: 9600,
        status,
      })),
    };
  }

  function watching(...statuses: Array<"connected" | "disconnected">) {
    return (onSnapshot: (next: ReturnType<typeof snapshotOf>) => void) => {
      onSnapshot(snapshotOf(...statuses));
      return Promise.resolve(() => undefined);
    };
  }

  function chip() {
    return screen.getByTestId("scanner-state");
  }

  it("says the scanner is ready with only the keyboard wedge", async () => {
    renderSignIn({ local: await synced([SITE, OPERATOR]) });
    await screen.findByText(BADGE_PROMPT);
    expect(chip().textContent).toContain("Сканер штрихкодов готов");
    expect(chip().getAttribute("data-tone")).toBe("ok");
  });

  it("follows the COM scanners the shell reports", async () => {
    const local = await synced([SITE, OPERATOR]);
    const view = renderSignIn({ local, watchScanners: watching("connected") });
    await screen.findByText(BADGE_PROMPT);
    expect(chip().textContent).toContain("Сканер штрихкодов готов");
    view.unmount();

    renderSignIn({ local, watchScanners: watching("disconnected") });
    await screen.findByText(BADGE_PROMPT);
    await waitFor(() => expect(chip().getAttribute("data-tone")).toBe("error"));
    expect(chip().textContent).toContain("Сканер не на связи");
  });

  it("warns when only a part of the scanners answers, and when the shell cannot say", async () => {
    const local = await synced([SITE, OPERATOR]);
    const view = renderSignIn({ local, watchScanners: watching("connected", "disconnected") });
    await screen.findByText(BADGE_PROMPT);
    await waitFor(() => expect(chip().textContent).toContain("Часть сканеров недоступна"));
    expect(chip().getAttribute("data-tone")).toBe("warn");
    view.unmount();

    renderSignIn({ local, watchScanners: () => Promise.reject(new Error("no shell")) });
    await screen.findByText(BADGE_PROMPT);
    await waitFor(() => expect(chip().textContent).toContain("Состояние сканера неизвестно"));
  });

  it("says the sign-in is paused while the station is locked out, and still takes the scan's answer", async () => {
    const local = await synced([SITE, OPERATOR, BADGE]);
    await local.transaction([
      {
        sql:
          "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) " +
          "VALUES ('station', 10, ?, ?)",
        values: [NOW - 1_000, NOW - 1_000],
      },
    ]);
    renderSignIn({ local });
    await screen.findByText(BADGE_PROMPT);
    expect(chip().getAttribute("data-tone")).toBe("ok");
    act(() => scan("MRK-000742"));
    expect(
      await screen.findByText(
        "Слишком много неудачных попыток. Вход на этой станции приостановлен на 1 мин.",
      ),
    ).toBeTruthy();
    expect(chip().textContent).toContain("Вход приостановлен");
    expect(chip().getAttribute("data-tone")).toBe("error");
  });
});
