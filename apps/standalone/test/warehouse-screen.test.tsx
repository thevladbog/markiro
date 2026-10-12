import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BOX_SSCC } from "./support/warehouse.js";
import {
  OPERATOR_ID,
  renderWarehouse,
  rows,
  startedWarehouse,
} from "./support/warehouse-screen.js";

describe("the warehouse reprint screen (plan СКЛ)", () => {
  it("starts a session with a reason and the organization's templates, and prints a box found on the host", async () => {
    const at = await renderWarehouse();
    expect(await screen.findByText("Коды единиц: Дубль 58×40")).toBeTruthy();
    expect(screen.getByText("Короба: Коробка 58×40")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Начать перепечатку" }).hasAttribute("disabled"),
    ).toBe(true);
    await at.press("Повреждена");
    await at.press("Начать перепечатку");
    await at.scanner.listening();
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(screen.getByText("Этикеток передано на принтер: 1")).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledWith({ sscc: BOX_SSCC });
    expect(at.shell.sends).toHaveLength(1);
    expect(at.props.onRecorded).toHaveBeenCalled();
    expect(rows(at.db, "SELECT reason, started_by FROM wh_sessions")).toEqual([
      { reason: "damaged", started_by: OPERATOR_ID },
    ]);
  });

  it("says honestly that nothing is found without the host, and prints nothing", async () => {
    const at = await startedWarehouse({ online: false });
    await at.scan(BOX_SSCC);
    expect(
      await screen.findByText(
        "Нет связи с хостом: найти код нельзя. Дождитесь связи и отсканируйте снова.",
      ),
    ).toBeTruthy();
    expect(at.lookup).not.toHaveBeenCalled();
    expect(at.shell.sends).toHaveLength(0);
  });

  it("prints a code of the session again only after a reason is chosen", async () => {
    const at = await startedWarehouse();
    await at.scan(BOX_SSCC);
    await at.scan(BOX_SSCC);
    expect(await screen.findByText(/Этот код уже печатали в этом сеансе/)).toBeTruthy();
    expect(at.shell.sends).toHaveLength(1);
    await at.press("Напечатать ещё раз");
    expect(screen.getByRole("heading", { name: "Причина новой попытки" })).toBeTruthy();
    await at.press("Утеряна");
    await at.press("Напечатать");
    expect(at.shell.sends).toHaveLength(2);
    expect(rows(at.db, "SELECT reason, attempts FROM wh_jobs")).toEqual([
      { reason: "lost", attempts: 2 },
    ]);
  });

  it("continues an open session after a pause, and finishes it after a confirmation", async () => {
    const at = await startedWarehouse();
    await at.scan(BOX_SSCC);
    await at.press("К сменам");
    expect(at.props.onLeave).toHaveBeenCalledTimes(1);
    await at.press("Завершить сеанс");
    expect(screen.getByRole("heading", { name: "Завершить сеанс перепечатки?" })).toBeTruthy();
    await at.press("Завершить");
    expect(at.props.onLeave).toHaveBeenCalledTimes(2);
    expect(rows(at.db, "SELECT finished_by FROM wh_sessions")).toEqual([
      { finished_by: OPERATOR_ID },
    ]);
  });

  it("chooses templates from a searchable list, kept for each kind of label", async () => {
    const at = await renderWarehouse();
    await screen.findByRole("button", { name: "Начать перепечатку" });
    await at.press("Шаблоны");
    expect(screen.getByRole("heading", { name: "Шаблоны этикеток" })).toBeTruthy();
    await at.press("Короба");
    const search = screen.getByLabelText("Поиск шаблона");
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "нет такого" } });
    expect(screen.getByText("По этому запросу шаблонов нет.")).toBeTruthy();
    expect(at.scanner.textEntry).toContain(true);
    fireEvent.change(search, { target: { value: "короб" } });
    expect(screen.getByRole("button", { name: /Коробка 58×40/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await at.press("Применить шаблоны");
    expect(await screen.findByText("Короба: Коробка 58×40")).toBeTruthy();
    expect(at.scanner.textEntry.at(-1)).toBe(false);
  });

  it("looks a typed SSCC up as a scan, and takes no scan while the form is open", async () => {
    const at = await startedWarehouse();
    await at.press("Ввести код вручную");
    await at.scan(BOX_SSCC);
    expect(at.lookup).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByLabelText("Номер короба или паллеты (18 цифр) либо полный код единицы"),
      { target: { value: BOX_SSCC } },
    );
    await at.press("Найти и напечатать");
    expect(await screen.findByText(/Этикетка передана на принтер/)).toBeTruthy();
    expect(at.lookup).toHaveBeenCalledTimes(1);
  });
});
