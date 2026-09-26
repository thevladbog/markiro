import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
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
