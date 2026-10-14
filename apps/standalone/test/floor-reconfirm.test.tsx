import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { LockdownSnapshot } from "../src/app/lockdown.js";
import { DeviceError } from "../src/host/device.js";
import type { ChangeItem } from "../src/host/protocol.js";
import { FloorWindowControl, type FloorWindowMode } from "../src/floor/FloorWindowControl.js";
import { createGatedScanSource } from "../src/floor/gated-scan-source.js";
import { Reconfirm } from "../src/floor/Reconfirm.js";
import { createKeyboardWedgeSource } from "../src/floor/scan-source.js";
import { UnpairContext, type UnpairApi } from "../src/floor/setup/unpair-context.js";
import { UnpairStation } from "../src/floor/setup/UnpairStation.js";
import { hashPin } from "../src/lib/credentials.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

afterEach(cleanup);

const ANNA = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
const BORIS = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PASS_7 = "c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d";
/** The PIN 4821 and the badge «MRK-000742» under the site's salt (`proto/fixtures`). */
const PIN_PHC =
  "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
const BADGE_PHC =
  "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const NOW = 1_790_000_000_000;
const CLOCK = () => NOW;

const SITE: ChangeItem = {
  entity: "site",
  id: "1",
  rev: 1,
  deleted: false,
  data: { badgeSalt: "AAECAwQFBgcICQoLDA0ODw==", boxBlockSize: 2000, palletBlockSize: 200 },
};
const anna: ChangeItem = {
  entity: "operators",
  id: ANNA,
  rev: 5,
  deleted: false,
  data: { login: "0042", name: "Анна Кузнецова", role: null, pinPhc: PIN_PHC },
};
const badge: ChangeItem = {
  entity: "operator_badges",
  id: PASS_7,
  rev: 6,
  deleted: false,
  data: { operatorId: ANNA, badgePhc: BADGE_PHC, label: null },
};

async function boris(): Promise<ChangeItem> {
  return {
    entity: "operators",
    id: BORIS,
    rev: 7,
    deleted: false,
    data: { login: "0077", name: "Борис Петров", role: null, pinPhc: await hashPin("1357") },
  };
}

async function synced(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

/** A keyboard-wedge scanner: every character a key, then Enter. */
function scan(text: string) {
  act(() => {
    for (const key of text) fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "Enter" });
  });
}

function press(...keys: string[]) {
  for (const key of keys) fireEvent.click(screen.getByRole("button", { name: key }));
}

/** The login and the PIN on the keypad, as the dialog asks for them. */
async function typeNumberAndPin(login: string, pin: string, confirm: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
  press(...login);
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  press(...pin);
  fireEvent.click(screen.getByRole("button", { name: confirm }));
}

function renderReconfirm(local: LocalExecutor, expectedOperatorId: string | null) {
  const source = createKeyboardWedgeSource(window);
  const onConfirmed = vi.fn();
  const onCancel = vi.fn();
  const onMute = vi.fn();
  const view = render(
    <ThemeProvider>
      <Reconfirm
        open
        title="Выйти из полноэкранного режима?"
        detail="Подтвердите, что это вы."
        confirmLabel="Подтвердить"
        local={local}
        pairing={PAIRING}
        source={source}
        onMute={onMute}
        expectedOperatorId={expectedOperatorId}
        onConfirmed={onConfirmed}
        onCancel={onCancel}
        now={CLOCK}
      />
    </ThemeProvider>,
  );
  return { ...view, onConfirmed, onCancel, onMute };
}

describe("the identity re-confirmation", () => {
  it("is confirmed by the operator's own badge, and mutes the floor while it is open", async () => {
    const { onConfirmed, onMute, unmount } = renderReconfirm(
      await synced([SITE, anna, badge]),
      ANNA,
    );
    expect(onMute).toHaveBeenLastCalledWith(true);
    scan("MRK-000742");
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    unmount();
    expect(onMute).toHaveBeenLastCalledWith(false);
  });

  it("refuses an unknown badge and says so, without confirming", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna, badge]), ANNA);
    scan("MRK-999999");
    expect(await screen.findByText(/бейдж|Неверный/i)).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("is confirmed by the personnel number and the PIN, which never stay on screen", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna, badge]), ANNA);
    await typeNumberAndPin("0042", "4821", "Подтвердить");
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
  });

  it("refuses a wrong PIN, empties it and stays on the PIN", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna]), ANNA);
    await typeNumberAndPin("0042", "1111", "Подтвердить");
    expect(await screen.findByText("Неверный табельный номер или PIN.")).toBeTruthy();
    expect(screen.getByLabelText("Набранный PIN").textContent).toBe("");
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("counts wrong attempts against the sign-in's lockout: after five the right PIN is refused too", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna]), ANNA);
    fireEvent.click(await screen.findByRole("button", { name: "Ввести табельный номер" }));
    press(..."0042");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      press(..."1111");
      fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
      await waitFor(() => expect(screen.getByLabelText("Набранный PIN").textContent).toBe(""));
      await screen.findByRole("alert");
    }
    press(..."4821");
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(await screen.findByText(/Слишком много неверных PIN.*приостановлен/)).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("wants the signed-in operator's own proof: another operator's PIN does not confirm", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna, await boris()]), ANNA);
    await typeNumberAndPin("0077", "1357", "Подтвердить");
    expect(await screen.findByText(/другого оператора/)).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("accepts any operator's proof when nobody is signed in", async () => {
    const { onConfirmed } = renderReconfirm(await synced([SITE, anna, await boris()]), null);
    await typeNumberAndPin("0077", "1357", "Подтвердить");
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
  });

  it("is cancelled with «Отмена»", async () => {
    const { onCancel } = renderReconfirm(await synced([SITE, anna]), ANNA);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the gated scan source", () => {
  it("hears nothing while muted, hears again after, and drops the keys typed meanwhile", () => {
    const heard: string[] = [];
    const gate = createGatedScanSource(createKeyboardWedgeSource(window));
    const stop = gate.source.start((raw) => heard.push(raw));
    scan("AAA");
    gate.setMuted(true);
    scan("BBB");
    gate.setMuted(false);
    scan("CCC");
    stop();
    expect(heard).toEqual(["AAA", "CCC"]);
  });
});

function windowMode(mode: LockdownSnapshot["mode"], error: LockdownSnapshot["error"] = null) {
  const control: FloorWindowMode = {
    snapshot: { mode, pending: false, error },
    enter: vi.fn(async () => undefined),
    exit: vi.fn(async () => undefined),
    clearError: vi.fn(),
  };
  return control;
}

async function renderControl(control: FloorWindowMode, operatorId: string | null = ANNA) {
  const local = await synced([SITE, anna, badge]);
  const view = render(
    <ThemeProvider>
      <FloorWindowControl
        windowMode={control}
        local={local}
        pairing={PAIRING}
        source={createKeyboardWedgeSource(window)}
        onMute={vi.fn()}
        operatorId={operatorId}
        now={CLOCK}
      />
    </ThemeProvider>,
  );
  return view;
}

describe("the header's window mode", () => {
  it("leaves the full-screen mode only after the operator proved who they are", async () => {
    const control = windowMode("locked");
    await renderControl(control);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из полноэкранного режима" }));
    expect(await screen.findByText("Выйти из полноэкранного режима?")).toBeTruthy();
    // Nothing happened yet: the press alone is not enough.
    expect(control.exit).not.toHaveBeenCalled();
    scan("MRK-000742");
    await waitFor(() => expect(control.exit).toHaveBeenCalledTimes(1));
    expect(control.enter).not.toHaveBeenCalled();
  });

  it("does not leave when the dialog is cancelled", async () => {
    const control = windowMode("locked");
    await renderControl(control);
    fireEvent.click(screen.getByRole("button", { name: "Выйти из полноэкранного режима" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
    expect(control.exit).not.toHaveBeenCalled();
    expect(screen.queryByText("Выйти из полноэкранного режима?")).toBeNull();
  });

  it("goes back to the full-screen mode with one press, asking nothing", async () => {
    const control = windowMode("windowed");
    await renderControl(control);
    fireEvent.click(screen.getByRole("button", { name: "Вернуться в полноэкранный режим" }));
    expect(control.enter).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Подтвердите, что это вы.")).toBeNull();
  });

  it("says that the window did not change, and the message can be dismissed", async () => {
    const control = windowMode("locked", "exit");
    await renderControl(control);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/Не удалось выйти из полноэкранного режима/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Закрыть" }));
    expect(control.clearError).toHaveBeenCalled();
  });
});

function unpairApi(local: LocalExecutor, patch: Partial<UnpairApi> = {}): UnpairApi {
  return {
    local,
    pairing: PAIRING,
    operatorId: ANNA,
    inShift: false,
    source: createKeyboardWedgeSource(window),
    onMute: vi.fn(),
    countUnsent: async () => 0,
    owesBlocks: async () => false,
    forget: vi.fn(async () => undefined),
    now: CLOCK,
    ...patch,
  };
}

function renderUnpair(api: UnpairApi | null) {
  return render(
    <ThemeProvider>
      <UnpairContext.Provider value={api}>
        <UnpairStation />
      </UnpairContext.Provider>
    </ThemeProvider>,
  );
}

describe("«Отвязать станцию»", () => {
  it("renders nothing where the app provided no context", () => {
    const view = renderUnpair(null);
    expect(view.container.textContent).toBe("");
  });

  it("asks, says what is lost, wants the proof, and only then forgets the pairing", async () => {
    const api = unpairApi(await synced([SITE, anna, badge]));
    renderUnpair(api);
    fireEvent.click(screen.getByRole("button", { name: "Отвязать станцию" }));
    expect(await screen.findByText("Отвязать станцию?")).toBeTruthy();
    expect(screen.getByText(/удалятся справочники/)).toBeTruthy();
    const next = await screen.findByRole("button", { name: "Подтвердите, что это вы" });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    expect(api.forget).not.toHaveBeenCalled();
    scan("MRK-000742");
    await waitFor(() => expect(api.forget).toHaveBeenCalledTimes(1));
    // Nothing waits to be sent: the shell is not asked to keep anything.
    expect(api.forget).toHaveBeenCalledWith(false);
  });

  it("names the records not yet sent and keeps them on the disk", async () => {
    const api = unpairApi(await synced([SITE, anna, badge]), { countUnsent: async () => 3 });
    renderUnpair(api);
    fireEvent.click(screen.getByRole("button", { name: "Отвязать станцию" }));
    expect(await screen.findByText(/Не отправлено на хост записей: 3/)).toBeTruthy();
    const next = screen.getByRole("button", { name: "Подтвердите, что это вы" });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    scan("MRK-000742");
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith(true));
  });

  it("warns that a restored host is still owed its blocks, and that records could not be counted", async () => {
    const api = unpairApi(await synced([SITE, anna]), {
      countUnsent: async () => null,
      owesBlocks: async () => true,
    });
    renderUnpair(api);
    fireEvent.click(screen.getByRole("button", { name: "Отвязать станцию" }));
    expect(await screen.findByText(/Не удалось посчитать неотправленные записи/)).toBeTruthy();
    expect(screen.getByText(/ещё не вернула ему выданные блоки/)).toBeTruthy();
  });

  it("cannot go on while a shift is open", async () => {
    const api = unpairApi(await synced([SITE, anna]), { inShift: true });
    renderUnpair(api);
    fireEvent.click(screen.getByRole("button", { name: "Отвязать станцию" }));
    expect(await screen.findByText(/Сначала выйдите из смены/)).toBeTruthy();
    const next = screen.getByRole("button", { name: "Подтвердите, что это вы" });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when the shell kept the pairing, and nothing was lost", async () => {
    const api = unpairApi(await synced([SITE, anna, badge]), {
      forget: vi.fn(async () => {
        throw new DeviceError("storage", "no");
      }),
    });
    renderUnpair(api);
    fireEvent.click(screen.getByRole("button", { name: "Отвязать станцию" }));
    const next = await screen.findByRole("button", { name: "Подтвердите, что это вы" });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    scan("MRK-000742");
    expect(await screen.findByText(/Не удалось очистить данные станции/)).toBeTruthy();
  });
});
