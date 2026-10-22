import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession, SyncState } from "../src/app/shell.js";
import { readCloseSummary } from "../src/floor/close/shift-close.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import { readParticipation } from "../src/floor/shifts/shift-participation.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { DeviceShift, DeviceStatus, HostStatus } from "../src/host/protocol.js";
import { STATION_SHIFT_ENTER } from "../src/host/requests.js";
import { sendFactBatch } from "../src/local/facts-sender.js";
import { sendPendingLeaves, type LeaveShift } from "../src/local/leave-sender.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { km, OPERATOR_ID, VALIDATION_ENTERED } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { multiHost, type MultiHost } from "./support/multi-host.js";
import { OTHER_STATION, THIRD_STATION } from "./support/multi-station.js";
import { fakeSource, PRESS_PAUSE_MS } from "./support/work-screen.js";

// The tones are the work screen's; nothing is heard here.
vi.mock("../src/floor/work/signal-sound.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playSignalTone: vi.fn(),
}));

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};
// No sync ran: the floor checks no operator against copies this test does not keep.
const NOT_SYNCED: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
const NAMES: Readonly<Record<string, string>> = {
  [DEVICE_ID]: "Станция линии 1",
  [OTHER_STATION]: "Станция линии 2",
  [THIRD_STATION]: "Станция линии 3",
};

/** One station's floor over its own database, driven as the shell's link would drive it. */
function station(host: MultiHost, deviceId: string) {
  const { db, executor: local } = openLocalDb();
  const pairing = { hostId: HOST_ID, deviceId };
  const device: DeviceStatus = {
    ...DEVICE_STATUS,
    deviceId,
    deviceName: NAMES[deviceId] ?? deviceId,
  };
  const scanner = fakeSource();
  const { hardware } = fakeHardware();
  const printing = createPrintRuntime(hardware.printBytes);
  const awake = createSystemAwake(vi.fn(async () => undefined));
  const enter = host.enter(deviceId);
  const clock = { now: 0 };
  const requestLeaves = vi.fn<() => void>();
  const state: { link: HostStatus; reads: number; outbox: number } = {
    link: ONLINE,
    reads: 0,
    outbox: 0,
  };
  function Work(props: WorkScreenProps) {
    return <WorkScreen {...props} labelClock={() => clock.now} />;
  }
  const element = () => (
    <ThemeProvider>
      <FloorApp
        operator={SESSION}
        local={local}
        device={device}
        link={state.link}
        sync={NOT_SYNCED}
        shiftReads={{ done: state.reads, failed: false }}
        outboxVersion={state.outbox}
        lineChangePending={false}
        rejectionPending={false}
        enter={enter}
        create={async () => {
          throw new Error("no new shift in this test");
        }}
        checkCode={host.checkCode}
        requestBlock={async () => {
          throw new Error("a validation shift asks for no serials");
        }}
        requestFacts={() => undefined}
        requestLeaves={requestLeaves}
        source={scanner.source}
        printing={printing}
        hardware={hardware}
        awake={awake}
        workScreen={Work}
        dispatch={() => undefined}
        onSignOut={() => undefined}
      />
    </ThemeProvider>
  );
  const view = render(element());
  const update = () => view.rerender(element());
  const screen = () => within(view.container);
  return {
    db,
    local,
    pairing,
    scanner,
    requestLeaves,
    screen,
    /** The host's list into the copies, as the link's read does after a revision. */
    readShifts: () =>
      act(async () => {
        await replaceShiftCopies(local, pairing, await host.list(deviceId), Date.now());
        state.reads += 1;
        update();
      }),
    /** A list the host answered earlier, applied now (an older read that lands after a newer one). */
    applyList: (shifts: DeviceShift[]) =>
      act(async () => {
        await replaceShiftCopies(local, pairing, shifts, Date.now());
        state.reads += 1;
        update();
      }),
    /** One batch of the outbox to the host and its receipts, as the link's delivery does. */
    deliver: () =>
      act(async () => {
        await sendFactBatch(local, pairing, host.facts(deviceId), () => new Date());
        state.outbox += 1;
        update();
      }),
    /** The pauses this station owes, as the link sends them (through `leave` when given). */
    sendLeaves: (leave: LeaveShift = host.leave(deviceId)) =>
      act(async () => {
        await sendPendingLeaves(local, pairing, leave, () => new Date());
        state.reads += 1;
        update();
      }),
    goOffline: () =>
      act(() => {
        state.link = OFFLINE;
        update();
      }),
    goOnline: () =>
      act(() => {
        state.link = ONLINE;
        update();
      }),
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
      }),
    /** A press after an operator's pause (the panels' guard), and what it started. */
    press: async (name: string) => {
      const button = await screen().findByRole("button", { name });
      clock.now += PRESS_PAUSE_MS;
      await act(async () => {
        fireEvent.click(button);
      });
    },
    total: () => view.container.querySelector(".work-shift-band__count")?.textContent ?? null,
    mine: () =>
      view.container.querySelector(".work-shift-band__small--mine .work-shift-band__small-count")
        ?.textContent ?? null,
  };
}

describe("two stations in one shift (plan 2b, spec §9.6)", () => {
  it("join, count the whole shift, close each part, and the last closer gives the reason", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    const c = station(host, THIRD_STATION);
    for (const one of [a, b, c]) await one.readShifts();

    // A continues the shift it opened; B joins; C finds the line full.
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await c.readShifts();
    expect(await c.screen().findByText("Линия занята: 2 из 2")).toBeTruthy();
    // The card's count is advisory: C may ask, and the host refuses with its own numbers.
    await c.press("Присоединиться");
    expect(
      await c
        .screen()
        .findByText(
          "Линия занята: 2 из 2. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
        ),
    ).toBeTruthy();
    expect(host.state().parts.has(THIRD_STATION)).toBe(false);

    // Both scan; the host takes their facts; each band says its own and the whole shift's.
    await a.scanner.listening();
    await b.scanner.listening();
    await a.scan(km("A1"));
    await waitFor(() => expect(a.mine()).toBe("1"));
    await a.scan(km("A2"));
    await waitFor(() => expect(a.mine()).toBe("2"));
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("1"));
    await a.deliver();
    await b.deliver();
    await a.readShifts();
    await b.readShifts();
    await waitFor(() => expect(a.total()).toBe("3"));
    await waitFor(() => expect(b.total()).toBe("3"));

    // A closes its part: not the last, so no reason; the shift waits for B.
    await a.press("Закрыть мою часть");
    expect(await a.screen().findByText("Смена закроется, когда закроют остальные.")).toBeTruthy();
    expect(a.screen().queryByText("Факт не совпадает с планом. Выберите причину:")).toBeNull();
    await a.press("Подтвердить закрытие части");
    expect(
      await a
        .screen()
        .findByText("Ваша часть закрыта на этой станции. Данные будут отправлены автоматически."),
    ).toBeTruthy();
    await a.deliver();
    expect(
      await a
        .screen()
        .findByText("Хост принял закрытие вашей части. Смена закроется, когда закроют остальные."),
    ).toBeTruthy();

    // A's closed part holds no slot: C may join now.
    await c.readShifts();
    expect(await c.screen().findByRole("button", { name: "Присоединиться" })).toBeTruthy();

    // B closes last with the link: the whole shift (3) missed the plan (1 200), so it gives a reason.
    await b.readShifts();
    await b.press("Закрыть мою часть");
    expect(
      await b
        .screen()
        .findByText("Остальные уже закрыли свои части: смена закроется вместе с вашей."),
    ).toBeTruthy();
    await b.press("Остановка оборудования");
    await b.press("Подтвердить закрытие части");
    await b.deliver();
    expect(await b.screen().findByText("Смена закрыта: все её части закрыты.")).toBeTruthy();
    expect(host.state()).toMatchObject({ status: "closed", reasonMissing: false });
    // The shift closes at the latest device close, in the host's whole seconds.
    const closes = [DEVICE_ID, OTHER_STATION].map(
      (id) => host.state().parts.get(id)?.row.closedAt ?? "",
    );
    expect(closes.every((at) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at))).toBe(true);
    expect(host.state().closedAt).toBe(closes.reduce((a2, b2) => (b2 > a2 ? b2 : a2)));
    await a.readShifts();
    expect(await a.screen().findByText("Смена закрыта: все её части закрыты.")).toBeTruthy();
  });

  it("the last closer without the link gives no reason; the host marks it missing (spec §12.9)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    await a.readShifts();
    await b.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    // A learns of B by the link's next read; without it A would close as the shift's only station.
    await a.readShifts();
    await a.press("Закрыть мою часть");
    await a.press("Подтвердить закрытие части");
    // The close is written to the outbox before it is delivered.
    await a
      .screen()
      .findByText("Ваша часть закрыта на этой станции. Данные будут отправлены автоматически.");
    await a.deliver();
    await b.readShifts();
    await b.goOffline();
    await b.press("Закрыть мою часть");
    expect(
      await b
        .screen()
        .findByText(
          "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Если понадобится причина расхождения, её укажет офис.",
        ),
    ).toBeTruthy();
    expect(b.screen().queryByText("Факт не совпадает с планом. Выберите причину:")).toBeNull();
    await b.press("Подтвердить закрытие части");
    await b.goOnline();
    await b.deliver();
    expect(
      await b
        .screen()
        .findByText("Смена закрыта, но без причины расхождения с планом: её укажет офис."),
    ).toBeTruthy();
    expect(host.state()).toMatchObject({ status: "closed", reasonMissing: true });
  });

  it("«Выйти из смены» frees the slot; an entry before the pause reaches the host drops it; a stale pause undoes nothing", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    const c = station(host, THIRD_STATION);
    for (const one of [a, b, c]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");

    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(1));
    await b.sendLeaves();
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("left");
    await c.readShifts();
    expect(await c.screen().findByRole("button", { name: "Присоединиться" })).toBeTruthy();

    // A leaves while the host is away and comes back before the pause reaches it.
    await a.goOffline();
    await a.press("Выйти из смены");
    await waitFor(() => expect(a.requestLeaves).toHaveBeenCalledTimes(1));
    await a.press("Продолжить");
    await a.goOnline();
    await a.sendLeaves();
    expect(host.state().parts.get(DEVICE_ID)?.row.state).toBe("active");

    // B comes back (a new stay, a new token); a pause of its first stay that this station still
    // keeps, with that stay's token, goes through the station's sender now and undoes nothing (host
    // `651eb1c06`): the host answers the part active, the station settles it as stale.
    const firstStay = host.state().parts.get(OTHER_STATION)?.row.joinedRev ?? null;
    await b.readShifts();
    await b.press("Продолжить");
    const secondStay = host.state().parts.get(OTHER_STATION)?.row.joinedRev ?? null;
    expect(secondStay).not.toBe(firstStay);
    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(2));
    await waitFor(async () =>
      expect(
        (await readParticipation(b.local, b.pairing, VALIDATION_ENTERED.id))?.leaveRequestedAt,
      ).not.toBeNull(),
    );
    b.db
      .prepare("UPDATE floor_shift_participation SET joined_rev = ? WHERE shift_id = ?")
      .run(firstStay, VALIDATION_ENTERED.id);
    await b.sendLeaves();
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("active");
    const kept = await readParticipation(b.local, b.pairing, VALIDATION_ENTERED.id);
    expect(kept).toMatchObject({
      myState: "active",
      joinedRev: secondStay,
      leaveRequestedAt: null,
    });
  });

  it("a code scanned at both stations counts once in the whole shift: the host's conflict wins (final review I2)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    for (const one of [a, b]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await a.scanner.listening();
    await b.scanner.listening();

    // A takes the code first, with the link; B, offline, takes the same code later and another.
    await a.scan(km("D1"));
    await waitFor(() => expect(a.mine()).toBe("1"));
    await a.scan(km("A1"));
    await waitFor(() => expect(a.mine()).toBe("2"));
    await a.deliver();
    await b.goOffline();
    await b.scan(km("D1"));
    await waitFor(() => expect(b.mine()).toBe("1"));
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("2"));

    // B's records reach the host: the registry keeps A's scan and answers B's `conflict`.
    await b.goOnline();
    await b.deliver();
    expect(host.state().accepted).toBe(3);
    await a.readShifts();
    await b.readShifts();
    await waitFor(() => expect(a.total()).toBe("3"));
    // B keeps its own two codes on its band, and the whole shift counts the code once.
    await waitFor(() => expect(b.total()).toBe("3"));
    expect(b.mine()).toBe("2");
    const summary = await readCloseSummary(b.local, b.pairing, VALIDATION_ENTERED.id, true);
    expect(summary.part?.total).toBe(3);
  });

  it("a part left on the host and continued offline takes its slot again when the link is back (final review I1)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    for (const one of [a, b]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");

    // B leaves with the link up: the host frees its slot and the cache says so.
    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(1));
    await b.sendLeaves();
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("left");

    // The link drops; the operator continues from the stored snapshot and scans.
    await b.goOffline();
    await b.press("Продолжить");
    await b.scanner.listening();
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("1"));

    // The link is back: the station takes its slot again on the host.
    await b.goOnline();
    await b.readShifts();
    await waitFor(() => expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("active"));
  });

  it("a full line on the return is said on the work screen, the line goes on, and the slot is taken once one is free (final review I1)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    const c = station(host, THIRD_STATION);
    for (const one of [a, b, c]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(1));
    await b.sendLeaves();
    await b.goOffline();
    await b.press("Продолжить");

    // C takes the slot B freed while B works offline.
    await c.readShifts();
    await c.press("Присоединиться");

    // B's return meets a full line: said with its numbers; B's scans still count.
    await b.goOnline();
    await b.readShifts();
    expect(await b.screen().findByText("Линия занята: 2 из 2")).toBeTruthy();
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("left");
    await b.scanner.listening();
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("1"));

    // C leaves: B's next read takes the slot, and the notice goes.
    await c.press("Выйти из смены");
    await waitFor(() => expect(c.requestLeaves).toHaveBeenCalledTimes(1));
    await c.sendLeaves();
    await b.readShifts();
    await waitFor(() => expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("active"));
    await b.readShifts();
    await waitFor(() => expect(b.screen().queryByText("Линия занята: 2 из 2")).toBeNull());
  });

  it("a pause in flight that reaches the host after the entry is undone by the next read (final review I1)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    for (const one of [a, b]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(1));

    // The pause is read and on its way; the operator comes back and the entry reaches the host
    // first (an active part's re-entry stamps no new token), then the pause frees the slot.
    let asked: () => void = () => undefined;
    const askedNow = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = sendPendingLeaves(
      b.local,
      b.pairing,
      async (shiftId, leave) => {
        asked();
        await held;
        return host.leave(OTHER_STATION)(shiftId, leave);
      },
      () => new Date(),
    );
    await askedNow;
    await b.press("Продолжить");
    release();
    await act(async () => {
      await sending;
    });
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("left");

    // The next read finds the part left while the station works it, and enters again.
    await b.readShifts();
    await waitFor(() => expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("active"));
  });

  it("an older read landing after a newer one takes no figures back; reads of one second apply in order (final review I3)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    for (const one of [a, b]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await b.scanner.listening();

    const older = await host.list(DEVICE_ID);
    host.tick();
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("1"));
    await b.deliver();
    const newer = await host.list(DEVICE_ID);
    await a.applyList(newer);
    await waitFor(() => expect(a.total()).toBe("1"));
    await a.applyList(older);
    const cached = await readParticipation(a.local, a.pairing, VALIDATION_ENTERED.id);
    expect(cached?.totals.accepted).toBe(1);
    expect(a.total()).toBe("1");

    // The host's clock has not moved: the next read carries the same `asOf` and still applies.
    await b.scan(km("B2"));
    await waitFor(() => expect(b.mine()).toBe("2"));
    await b.deliver();
    const same = await host.list(DEVICE_ID);
    expect(same[0]?.totals?.asOf).toBe(newer[0]?.totals?.asOf);
    await a.applyList(same);
    await waitFor(() => expect(a.total()).toBe("2"));
  });
});

describe("the fake host answers as the host does (final review I3)", () => {
  const closeRecord = (closedAt: string, reasonCode: string | null = null) => ({
    id: crypto.randomUUID(),
    kind: "shift_closed",
    data: { plannedQtySnapshot: 1200, actualQty: 0, closedBoxCount: 0, reasonCode, closedAt },
  });

  it("closes the shift at the latest device close, though an earlier one arrives last", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    await host.enter(OTHER_STATION)(VALIDATION_ENTERED.id, STATION_SHIFT_ENTER);
    const [later] = await host.facts(OTHER_STATION)([closeRecord("2026-10-08T07:10:00.500Z")]);
    expect(later?.details).toEqual({ partClosed: true });
    await host.facts(DEVICE_ID)([closeRecord("2026-10-08T07:05:00.900Z")]);
    expect(host.state()).toMatchObject({ status: "closed", closedAt: "2026-10-08T07:10:00Z" });
  });

  it("reads a closed part back to a capable build and refuses it `shift_status` to an older one", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    await host.enter(OTHER_STATION)(VALIDATION_ENTERED.id, STATION_SHIFT_ENTER);
    await host.facts(DEVICE_ID)([closeRecord("2026-10-08T07:05:00.000Z")]);
    const back = await host.enter(DEVICE_ID)(VALIDATION_ENTERED.id, STATION_SHIFT_ENTER);
    expect(back.myState).toBe("closed");
    await expect(
      host.enter(DEVICE_ID)(VALIDATION_ENTERED.id, { supports: ["validation-v1"] }),
    ).rejects.toMatchObject({ code: "conflict", details: { constraint: "shift_status" } });
  });

  it("refuses a late close of a one-device shift without the reason it needs; a shared one is already closed", async () => {
    const solo = multiHost(VALIDATION_ENTERED, 1, NAMES);
    solo.open(DEVICE_ID);
    const [closed] = await solo.facts(DEVICE_ID)([
      closeRecord("2026-10-08T07:05:00.000Z", "equipment_stop"),
    ]);
    expect(closed?.outcome).toBe("accepted");
    const [late] = await solo.facts(DEVICE_ID)([closeRecord("2026-10-08T07:06:00.000Z")]);
    expect(late).toMatchObject({
      outcome: "rejected",
      code: "invalid_record",
      details: { field: "data.reasonCode" },
    });
    const shared = multiHost(VALIDATION_ENTERED, 2, NAMES);
    shared.open(DEVICE_ID);
    await shared.enter(OTHER_STATION)(VALIDATION_ENTERED.id, STATION_SHIFT_ENTER);
    await shared.facts(OTHER_STATION)([closeRecord("2026-10-08T07:04:00.000Z")]);
    await shared.facts(DEVICE_ID)([closeRecord("2026-10-08T07:05:00.000Z")]);
    const [again] = await shared.facts(DEVICE_ID)([closeRecord("2026-10-08T07:06:00.000Z")]);
    expect(again).toMatchObject({ outcome: "accepted", details: { alreadyClosed: true } });
  });
});
