import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import { isExhausted } from "../src/office/sscc/counter-kind.js";
import {
  fakeOfficeSession,
  renderOffice,
  SSCC_STATE,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function openSscc(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "SSCC" }));
  await screen.findByRole("heading", { name: "SSCC" });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getSscc.mockResolvedValue(SSCC_STATE);
  return session;
}

/** Data rows of the counters table, top to bottom. */
async function counterRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole("table");
  return within(table).getAllByRole("row").slice(1);
}

describe("SSCC page", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows a technologist the counters, current prefix first, and the blocks read-only", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getSscc.mockResolvedValue(SSCC_STATE);
    await openSscc(session);
    const rows = await counterRows();
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("460709100")).toBeTruthy();
    expect(within(rows[0]!).getByText("текущий")).toBeTruthy();
    expect(within(rows[0]!).getByText("Короба")).toBeTruthy();
    expect(within(rows[1]!).getByText("Паллеты")).toBeTruthy();
    expect(within(rows[2]!).getByText("460068200")).toBeTruthy();
    expect(within(rows[2]!).getByText("1500")).toBeTruthy();
    expect(screen.getByText("2000")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Изменить счётчик/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(screen.getByText("Изменять эти данные может только администратор.")).toBeTruthy();
  });

  it("says a counter past its last serial has run out and offers no change of it, while one at its last serial still has it", async () => {
    const session = fakeOfficeSession();
    // The host moved the current box counter past 9 999 999 with its last block;
    // the pallet counter is at its last serial, which it can still give.
    session.api.getSscc.mockResolvedValue({
      ...SSCC_STATE,
      counters: SSCC_STATE.counters.map((counter) =>
        counter.issuerPrefix !== "460709100"
          ? counter
          : { ...counter, nextSerial: counter.extension === 0 ? 10_000_000 : 9_999_999 },
      ),
    });
    await openSscc(session);
    const [boxes, pallets] = await counterRows();
    if (boxes === undefined || pallets === undefined) throw new Error("no rows");
    expect(within(boxes).getAllByRole("cell")[2]?.textContent).toBe("!Номера закончились");
    expect(within(boxes).queryByRole("button")).toBeNull();
    expect(screen.queryByText("10000000")).toBeNull();
    expect(within(pallets).getAllByRole("cell")[2]?.textContent).toBe("9999999");
    expect(
      within(pallets).getByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460709100" }),
    ).toBeTruthy();
  });

  it("shows a technologist a counter that has run out as run out, with the others as they are", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    session.api.getSscc.mockResolvedValue({
      ...SSCC_STATE,
      counters: SSCC_STATE.counters.map((counter) =>
        counter.issuerPrefix === "460068200" && counter.extension === 1
          ? { ...counter, nextSerial: counter.maxSerial + 1 }
          : counter,
      ),
    });
    await openSscc(session);
    const rows = await counterRows();
    // The current prefix first, then the other: the exhausted one is the last row.
    expect(rows.map((row) => within(row).getAllByRole("cell")[2]?.textContent)).toEqual([
      "1",
      "0",
      "1500",
      "!Номера закончились",
    ]);
  });

  it("moves a counter forward with its revision", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockResolvedValue({
      issuerPrefix: "460709100",
      extension: 1,
      nextSerial: 25,
      maxSerial: 9999999,
      rev: 7,
    });
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460709100" }),
    );
    type("Следующий номер", "25");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateSsccCounter).toHaveBeenCalledWith(
      "office-session-token",
      { issuerPrefix: "460709100", extension: 1 },
      { nextSerial: 25, expectedRev: 2 },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const rows = await counterRows();
    expect(within(rows[1]!).getByText("25")).toBeTruthy();
    expect(session.api.getSscc).toHaveBeenCalledTimes(1);
  });

  it("does not let a counter go back", async () => {
    const session = adminSession();
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460068200" }),
    );
    type("Следующий номер", "39");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Номер должен быть не меньше 40")).toBeTruthy();
    expect(session.api.updateSsccCounter).not.toHaveBeenCalled();
  });

  it("shows the host's floor when the counter moved meanwhile", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "sscc_below_floor",
        status: 409,
        message: "an SSCC counter only moves forward",
        details: { minSerial: 60 },
      }),
    );
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Паллеты, префикс 460068200" }),
    );
    type("Следующий номер", "50");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Номер должен быть не меньше 60")).toBeTruthy();
    // The host's newer floor must stick: a retry below it fails the same way,
    // client-side, without asking the host again.
    type("Следующий номер", "55");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Номер должен быть не меньше 60")).toBeTruthy();
    expect(session.api.updateSsccCounter).toHaveBeenCalledTimes(1);
  });

  it("checks a counter's value against its upper bound", async () => {
    const session = adminSession();
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Короба, префикс 460709100" }),
    );
    type("Следующий номер", "10000000");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите целое число от 1 до 9999999")).toBeTruthy();
    expect(session.api.updateSsccCounter).not.toHaveBeenCalled();
  });

  it("offers to load the counters again after a stale change", async () => {
    const session = adminSession();
    session.api.updateSsccCounter.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 9 },
      }),
    );
    await openSscc(session);
    fireEvent.click(
      await screen.findByRole("button", { name: "Изменить счётчик: Короба, префикс 460709100" }),
    );
    type("Следующий номер", "100");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.getSscc).toHaveBeenCalledTimes(2));
  });

  it("saves the block sizes with their revision", async () => {
    const session = adminSession();
    session.api.updateBlockSizes.mockResolvedValue({
      ...SSCC_STATE,
      boxBlockSize: 1000,
      blockSizesRev: 8,
    });
    await openSscc(session);
    const box = await screen.findByLabelText("Номеров в блоке для коробов");
    expect(box).toHaveProperty("value", "2000");
    type("Номеров в блоке для коробов", "1000");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateBlockSizes).toHaveBeenCalledWith("office-session-token", {
      boxBlockSize: 1000,
      palletBlockSize: 200,
      expectedRev: 3,
    });
    expect(screen.getByLabelText("Номеров в блоке для коробов")).toHaveProperty("value", "1000");
  });

  it("clears the block-size success notice when the next save starts", async () => {
    const session = adminSession();
    session.api.updateBlockSizes
      .mockResolvedValueOnce({ ...SSCC_STATE, boxBlockSize: 1000, blockSizesRev: 8 })
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          status: 400,
          message: "the box block size is out of range",
          details: { field: "boxBlockSize" },
        }),
      );
    await openSscc(session);
    await screen.findByLabelText("Номеров в блоке для коробов");
    type("Номеров в блоке для коробов", "1000");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();

    type("Номеров в блоке для коробов", "1500");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
  });

  it("checks the block sizes against the host's limits", async () => {
    const session = adminSession();
    await openSscc(session);
    await screen.findByLabelText("Номеров в блоке для коробов");
    type("Номеров в блоке для коробов", "100001");
    type("Номеров в блоке для паллет", "0");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 10 000")).toBeTruthy();
    expect(session.api.updateBlockSizes).not.toHaveBeenCalled();
  });

  it("offers to load the block sizes again after a stale change", async () => {
    const session = adminSession();
    session.api.getSscc
      .mockResolvedValueOnce(SSCC_STATE)
      .mockResolvedValueOnce({ ...SSCC_STATE, boxBlockSize: 5000, blockSizesRev: 9 });
    session.api.updateBlockSizes.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 9 },
      }),
    );
    await openSscc(session);
    await screen.findByLabelText("Номеров в блоке для коробов");
    type("Номеров в блоке для коробов", "3000");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Номеров в блоке для коробов")).toHaveProperty("value", "5000"),
    );
    expect(session.api.getSscc).toHaveBeenCalledTimes(2);
  });
});

describe("isExhausted", () => {
  it("is true only for a counter past its own last serial", () => {
    expect(isExhausted({ nextSerial: 9_999_999, maxSerial: 9_999_999 })).toBe(false);
    expect(isExhausted({ nextSerial: 10_000_000, maxSerial: 9_999_999 })).toBe(true);
    // The bound is the counter's own, not the usual one.
    expect(isExhausted({ nextSerial: 100, maxSerial: 100 })).toBe(false);
    expect(isExhausted({ nextSerial: 101, maxSerial: 100 })).toBe(true);
    expect(isExhausted({ nextSerial: 50_000_000, maxSerial: 9_999_999 })).toBe(true);
    expect(isExhausted({ nextSerial: 0, maxSerial: 9_999_999 })).toBe(false);
  });
});
