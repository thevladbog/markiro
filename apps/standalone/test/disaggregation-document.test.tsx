import { readFileSync } from "node:fs";

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  disaggregationDetailSchema,
  type DisaggregationDetail,
  type DisaggregationDocument,
  type DisaggregationLine,
  type DisaggregationReason,
} from "../src/host/disaggregation.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { chooseText, optionTexts, shownIn, waitForList } from "./support/select.js";
import { expectFocusedNotice } from "./support/shifts.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));

const TOKEN = "office-session-token";
const DOC_ID = "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c";
const BOX_SSCC = "046006820000015000";
const PALLET_SSCC = "146006820000000409";

const DAMAGED: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000003",
  name: "Повреждена упаковка",
  sortOrder: 30,
  archived: false,
  rev: 0,
};
const OTHER: DisaggregationReason = {
  id: "d15a0000-0000-4000-8000-000000000005",
  name: "Другое",
  sortOrder: 50,
  archived: false,
  rev: 0,
};

function line(n: number, overrides: Partial<DisaggregationLine> = {}): DisaggregationLine {
  return {
    id: `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ssccInput: BOX_SSCC,
    sscc: BOX_SSCC,
    boxId: `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    palletId: null,
    shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    shiftNumber: "OCT26-003",
    status: "ok",
    productId: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
    productName: "Молоко 3,2% 0,9 л",
    codeCount: 12,
    validatedAt: "2026-10-13T09:01:00Z",
    ...overrides,
  };
}

const BOX_LINE = line(1, { ssccInput: `(00)${BOX_SSCC}` });
const PALLET_LINE = line(2, {
  ssccInput: PALLET_SSCC,
  sscc: PALLET_SSCC,
  boxId: null,
  palletId: "a0000000-0000-4000-8000-000000000001",
  codeCount: 0,
});
const OPEN_SHIFT_LINE = line(3, {
  ssccInput: "046006820000015017",
  sscc: "046006820000015017",
  status: "shift_open",
  shiftNumber: "OCT26-004",
});
const NOT_FOUND_LINE = line(4, {
  ssccInput: "MRK-000742",
  sscc: null,
  boxId: null,
  shiftId: null,
  shiftNumber: null,
  status: "not_found",
  productId: null,
  productName: null,
  codeCount: 0,
});

function header(overrides: Partial<DisaggregationDocument> = {}): DisaggregationDocument {
  return {
    id: DOC_ID,
    docNo: "DSG-26-0001",
    status: "draft",
    reasonId: DAMAGED.id,
    reasonName: DAMAGED.name,
    comment: "Короб помят при погрузке",
    source: "manual",
    lineCount: 2,
    codeCount: 12,
    createdBy: "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
    createdByName: "Ирина Смирнова",
    createdAt: "2026-10-13T09:00:00Z",
    appliedAt: null,
    appliedBy: null,
    appliedByName: null,
    cancelledAt: null,
    cancelledBy: null,
    rev: 41,
    ...overrides,
  };
}

const DRAFT: DisaggregationDetail = { document: header(), lines: [BOX_LINE, PALLET_LINE] };

function conflict(constraint: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({
    kind: "api",
    code: "conflict",
    status: 409,
    message: constraint,
    details: { constraint, ...details },
  });
}

function validation(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "invalid",
    details: { field },
  });
}

interface Fake {
  session: FakeOfficeSession;
  /** What the host holds now: the next read answers it. */
  host: { detail: DisaggregationDetail };
}

/** A session whose host keeps the document: every read answers what it holds now. */
function fake(initial: DisaggregationDetail = DRAFT, user = fakeOfficeSession().user): Fake {
  const session = fakeOfficeSession({ user });
  const host = { detail: initial };
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listDisaggregationReasons.mockResolvedValue([DAMAGED, OTHER]);
  session.api.listDisaggregations.mockImplementation(async () => [host.detail.document]);
  session.api.getDisaggregation.mockImplementation(async () => host.detail);
  return { session, host };
}

/** Opens the document through the list, as a person does. */
async function openDocument(value: FakeOfficeSession): Promise<void> {
  renderOffice(value);
  fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
  fireEvent.click(await screen.findByRole("link", { name: /^Открыть документ / }));
  await screen.findByRole("heading", { level: 1, name: /^Документ / });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function linesTable(): HTMLElement {
  const region = screen.getByRole("region", { name: "Строки документа" });
  return within(region).getByRole("table");
}

function lineRows(): HTMLElement[] {
  return within(linesTable()).getAllByRole("row").slice(1);
}

function paste(text: string): void {
  fireEvent.change(screen.getByLabelText("SSCC коробов или палетов"), { target: { value: text } });
}

function pickFile(file: File): void {
  fireEvent.change(screen.getByTestId("file-drop-input"), { target: { files: [file] } });
}

describe("office «Дезагрегация»: a draft document", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the header, the lines and the way back", async () => {
    const { session } = fake();
    await openDocument(session);
    expect(screen.getByRole("heading", { level: 1, name: "Документ DSG-26-0001" })).toBeTruthy();
    expect(session.api.getDisaggregation).toHaveBeenCalledWith(TOKEN, DOC_ID);
    expect(screen.getByRole("link", { name: "← Дезагрегация" }).getAttribute("href")).toBe(
      "/disaggregation",
    );
    expect(screen.getAllByText("Черновик").length).toBeGreaterThan(0);
    expect(shownIn("Причина")).toBe("Повреждена упаковка");
    expect((screen.getByLabelText("Комментарий") as HTMLInputElement).value).toBe(
      "Короб помят при погрузке",
    );
  });

  it("lists the lines: SSCC as (00)…, level, shift, product, codes, status, and a way to delete", async () => {
    const { session } = fake({
      document: header({ lineCount: 4 }),
      lines: [BOX_LINE, PALLET_LINE, OPEN_SHIFT_LINE, NOT_FOUND_LINE],
    });
    await openDocument(session);
    const titles = within(linesTable())
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(titles).toEqual(["SSCC", "Уровень", "Смена", "Товар", "Кодов", "Статус", "Действия"]);
    const cells = lineRows().map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
    expect(cells[0]?.slice(0, 5)).toEqual([
      `(00)${BOX_SSCC}`,
      "Короб",
      "OCT26-003",
      "Молоко 3,2% 0,9 л",
      "12",
    ]);
    expect(cells[0]?.[5]).toContain("Готов к проведению");
    expect(cells[1]?.slice(0, 2)).toEqual([`(00)${PALLET_SSCC}`, "Палет"]);
    expect(cells[2]?.[5]).toContain("Смена ещё открыта");
    // What is no SSCC stays as it was typed.
    expect(cells[3]?.slice(0, 5)).toEqual(["MRK-000742", "—", "—", "—", "0"]);
    expect(cells[3]?.[5]).toContain("Короб или палет не найдены");
    expect(
      within(lineRows()[0] as HTMLElement).getByRole("link", { name: "OCT26-003" }),
    ).toBeTruthy();
  });

  it("says when a document has no line", async () => {
    const { session } = fake({ document: header({ lineCount: 0 }), lines: [] });
    await openDocument(session);
    expect(screen.getByText("Строки не добавлены.")).toBeTruthy();
  });

  it("saves the whole header when a reason is chosen", async () => {
    const { session, host } = fake({
      document: header({ reasonId: null, reasonName: null }),
      lines: [BOX_LINE],
    });
    session.api.updateDisaggregation.mockImplementation(async () => {
      host.detail = {
        ...host.detail,
        document: header({ rev: 42, reasonId: OTHER.id, reasonName: OTHER.name }),
      };
      return host.detail;
    });
    await openDocument(session);
    expect(shownIn("Причина")).toBe("Не выбрана");
    await waitForList(() =>
      expect(optionTexts("Причина")).toEqual(["Не выбрана", "Повреждена упаковка", "Другое"]),
    );
    chooseText("Причина", "Другое");
    // Saved where it stands: the notice does not take the focus from the field.
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(document.activeElement).not.toBe(
      screen.getByText("Изменения сохранены.").closest('[role="alert"]'),
    );
    expect(session.api.updateDisaggregation).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      reasonId: OTHER.id,
      comment: "Короб помят при погрузке",
      expectedRev: 41,
    });
    expect(shownIn("Причина")).toBe("Другое");
  });

  it("saves the comment when the field loses focus, and only if it changed", async () => {
    const { session, host } = fake();
    session.api.updateDisaggregation.mockImplementation(async () => {
      host.detail = { ...host.detail, document: header({ rev: 42, comment: "Новый текст" }) };
      return host.detail;
    });
    await openDocument(session);
    const comment = screen.getByLabelText("Комментарий");
    fireEvent.focus(comment);
    fireEvent.blur(comment);
    expect(session.api.updateDisaggregation).not.toHaveBeenCalled();
    fireEvent.change(comment, { target: { value: "  Новый текст  " } });
    fireEvent.blur(comment);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateDisaggregation).toHaveBeenCalledTimes(1);
    expect(session.api.updateDisaggregation).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      reasonId: DAMAGED.id,
      comment: "Новый текст",
      expectedRev: 41,
    });
  });

  it("clears the comment as null", async () => {
    const { session, host } = fake();
    session.api.updateDisaggregation.mockImplementation(async () => {
      host.detail = { ...host.detail, document: header({ rev: 42, comment: null }) };
      return host.detail;
    });
    await openDocument(session);
    const comment = screen.getByLabelText("Комментарий");
    fireEvent.change(comment, { target: { value: "   " } });
    fireEvent.blur(comment);
    await waitFor(() => expect(session.api.updateDisaggregation).toHaveBeenCalledTimes(1));
    expect(session.api.updateDisaggregation.mock.calls[0]?.[2]).toEqual({
      reasonId: DAMAGED.id,
      comment: null,
      expectedRev: 41,
    });
  });

  it("offers to load the document again after a stale header, and drops the edit", async () => {
    const { session, host } = fake();
    session.api.updateDisaggregation.mockRejectedValue(
      new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
    );
    await openDocument(session);
    const comment = screen.getByLabelText("Комментарий");
    fireEvent.change(comment, { target: { value: "Чужая правка" } });
    fireEvent.blur(comment);
    const reads = session.api.getDisaggregation.mock.calls.length;
    host.detail = {
      ...host.detail,
      document: header({ rev: 43, comment: "Правка в другом окне" }),
    };
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(session.api.getDisaggregation.mock.calls.length).toBe(reads + 1));
    await waitFor(() =>
      expect((screen.getByLabelText("Комментарий") as HTMLInputElement).value).toBe(
        "Правка в другом окне",
      ),
    );
    expect(screen.queryByRole("button", { name: "Загрузить заново" })).toBeNull();
  });

  it("adds pasted SSCCs as typed with the SSCC the domain reads, and clears the field", async () => {
    const { session, host } = fake();
    session.api.addDisaggregationLines.mockImplementation(async () => {
      host.detail = {
        document: header({ rev: 42, lineCount: 4 }),
        lines: [BOX_LINE, PALLET_LINE, OPEN_SHIFT_LINE, NOT_FOUND_LINE],
      };
      return host.detail;
    });
    await openDocument(session);
    expect(screen.getByRole("button", { name: "Добавить строки" }).hasAttribute("disabled")).toBe(
      true,
    );
    paste("(00)046006820000015017 046006820000015024");
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    await expectFocusedNotice("Добавлено строк: 2.");
    expect(session.api.addDisaggregationLines).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      lines: [
        { input: "(00)046006820000015017", sscc: "046006820000015017" },
        { input: "046006820000015024", sscc: "046006820000015024" },
      ],
      import: false,
    });
    expect((screen.getByLabelText("SSCC коробов или палетов") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(lineRows().length).toBe(4);
  });

  it("sends what is no SSCC with a null SSCC, for the host to call not found", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockResolvedValue(DRAFT);
    await openDocument(session);
    paste("MRK-000742,046006820000015001");
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    await waitFor(() => expect(session.api.addDisaggregationLines).toHaveBeenCalledTimes(1));
    expect(session.api.addDisaggregationLines.mock.calls[0]?.[2]).toEqual({
      lines: [
        { input: "MRK-000742", sscc: null },
        { input: "046006820000015001", sscc: null },
      ],
      import: false,
    });
  });

  it("imports a file as an import, in the file's order", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockResolvedValue(DRAFT);
    await openDocument(session);
    pickFile(new File(["046006820000015017;046006820000015024\n"], "list.csv"));
    await expectFocusedNotice("Из файла добавлено строк: 2.");
    expect(session.api.addDisaggregationLines).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      lines: [
        { input: "046006820000015017", sscc: "046006820000015017" },
        { input: "046006820000015024", sscc: "046006820000015024" },
      ],
      import: true,
    });
  });

  it("sends 1 200 SSCCs of a file in three requests of 500, 500 and 200, in order", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockResolvedValue(DRAFT);
    await openDocument(session);
    const tokens = Array.from({ length: 1200 }, (_, n) => `MRK-${String(n).padStart(6, "0")}`);
    pickFile(new File([tokens.join("\n")], "list.txt"));
    await expectFocusedNotice("Из файла добавлено строк: 1200.");
    const sent = session.api.addDisaggregationLines.mock.calls.map((call) => call[2].lines);
    expect(sent.map((part) => part.length)).toEqual([500, 500, 200]);
    expect(sent.flat().map((each) => each.input)).toEqual(tokens);
  });

  it("stops at the part that failed, says how many went in and reads the document again", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines
      .mockResolvedValueOnce(DRAFT)
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
      );
    await openDocument(session);
    const reads = session.api.getDisaggregation.mock.calls.length;
    const tokens = Array.from({ length: 1200 }, (_, n) => `MRK-${String(n).padStart(6, "0")}`);
    pickFile(new File([tokens.join("\n")], "list.txt"));
    // The cause is told too, so the rest is not added blindly again.
    await expectFocusedNotice(
      "Добавлено 500 из 1200 SSCC. Следующую часть не удалось добавить. Добавьте оставшиеся SSCC ещё раз. На хосте произошла ошибка. Повторите попытку.",
    );
    expect(session.api.addDisaggregationLines).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(session.api.getDisaggregation.mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it("keeps the pasted SSCCs that did not go in", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines
      .mockResolvedValueOnce(DRAFT)
      .mockRejectedValueOnce(
        new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
      );
    await openDocument(session);
    const tokens = Array.from({ length: 700 }, (_, n) => `MRK-${String(n).padStart(6, "0")}`);
    paste(tokens.join("\n"));
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    await expectFocusedNotice(
      "Добавлено 500 из 700 SSCC. Следующую часть не удалось добавить. Добавьте оставшиеся SSCC ещё раз. На хосте произошла ошибка. Повторите попытку.",
    );
    const left = (screen.getByLabelText("SSCC коробов или палетов") as HTMLTextAreaElement).value;
    expect(left.split("\n")).toEqual(tokens.slice(500));
  });

  it("explains a first part that failed as any failed write, and keeps the text", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", status: 500, message: "boom" }),
    );
    await openDocument(session);
    paste("MRK-000001");
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/Добавлено \d+ из/)).toBeNull();
    expect((screen.getByLabelText("SSCC коробов или палетов") as HTMLTextAreaElement).value).toBe(
      "MRK-000001",
    );
  });

  it("says the document is full when the host refuses the lines", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockRejectedValue(validation("lines"));
    await openDocument(session);
    paste("MRK-000001");
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    await expectFocusedNotice("В документе не может быть больше 10 000 строк.");
  });

  it("explains a token the host cannot take, apart from a full document", async () => {
    const { session } = fake();
    session.api.addDisaggregationLines.mockRejectedValue(validation("lines.3.input"));
    await openDocument(session);
    paste("MRK-1");
    fireEvent.click(screen.getByRole("button", { name: "Добавить строки" }));
    await expectFocusedNotice(
      "Хост не принял одну из строк: SSCC длиннее 64 символов или с управляющим символом. Исправьте её и добавьте снова.",
    );
  });

  it("does not send a file of 10 001 SSCCs", async () => {
    const { session } = fake();
    await openDocument(session);
    pickFile(new File([Array(10_001).fill("1").join("\n")], "list.txt"));
    await expectFocusedNotice("В файле больше 10 000 SSCC: разделите его на части.");
    expect(session.api.addDisaggregationLines).not.toHaveBeenCalled();
  });

  it("does not send an empty file", async () => {
    const { session } = fake();
    await openDocument(session);
    pickFile(new File([" \n;\n"], "list.txt"));
    await expectFocusedNotice("В файле нет ни одного SSCC.");
    expect(session.api.addDisaggregationLines).not.toHaveBeenCalled();
  });

  it("refuses a file that is not .txt or .csv", async () => {
    const { session } = fake();
    await openDocument(session);
    pickFile(new File(["x"], "list.xlsx"));
    await expectFocusedNotice("Можно загрузить только файл .txt или .csv.");
    expect(session.api.addDisaggregationLines).not.toHaveBeenCalled();
  });

  it("says a file could not be read", async () => {
    const { session } = fake();
    await openDocument(session);
    const broken = new File(["x"], "list.txt");
    Object.defineProperty(broken, "text", { value: () => Promise.reject(new Error("io")) });
    pickFile(broken);
    await expectFocusedNotice("Файл не удалось прочитать.");
    expect(session.api.addDisaggregationLines).not.toHaveBeenCalled();
  });

  it("deletes a line", async () => {
    const { session, host } = fake();
    session.api.deleteDisaggregationLine.mockImplementation(async () => {
      host.detail = { document: header({ rev: 42, lineCount: 1 }), lines: [PALLET_LINE] };
      return host.detail;
    });
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: `Удалить строку (00)${BOX_SSCC}` }));
    await expectFocusedNotice("Строка удалена.");
    expect(session.api.deleteDisaggregationLine).toHaveBeenCalledWith(TOKEN, DOC_ID, BOX_LINE.id);
    expect(lineRows().length).toBe(1);
  });

  it("will not apply without a reason, and says why", async () => {
    const { session } = fake({
      document: header({ reasonId: null, reasonName: null }),
      lines: [BOX_LINE],
    });
    await openDocument(session);
    const apply = screen.getByRole("button", { name: "Провести" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    const hint = screen.getByText(
      "Провести можно, когда выбрана причина и все строки готовы к проведению.",
    );
    expect(apply.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("will not apply with a line that is not ready", async () => {
    const { session } = fake({ document: header(), lines: [BOX_LINE, OPEN_SHIFT_LINE] });
    await openDocument(session);
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(true);
  });

  it("will not apply a document with no line", async () => {
    const { session } = fake({ document: header({ lineCount: 0 }), lines: [] });
    await openDocument(session);
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(true);
  });

  it("applies after a confirmation with the numbers, and shows the document as applied", async () => {
    const { session, host } = fake();
    session.api.applyDisaggregation.mockImplementation(async () => {
      host.detail = {
        document: header({
          status: "applied",
          rev: 42,
          appliedAt: "2026-10-13T10:00:00Z",
          appliedBy: "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
          appliedByName: "Ирина Смирнова",
        }),
        lines: host.detail.lines,
      };
      return host.detail;
    });
    await openDocument(session);
    const reads = session.api.getDisaggregation.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Провести документ?" });
    expect(
      within(confirm).getByText(
        "Будут расформированы упаковки из 2 строк документа, кодов: 12. Коды коробов станут свободными. Станции получат это изменение при следующем подключении к серверу.",
      ),
    ).toBeTruthy();
    expect(session.api.applyDisaggregation).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Провести" }));
    await expectFocusedNotice("Документ проведён.");
    expect(session.api.applyDisaggregation).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      expectedRev: 41,
    });
    expect(session.api.getDisaggregation.mock.calls.length).toBeGreaterThan(reads);
    expect(screen.getByText("Проведён", { selector: "dt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Провести" })).toBeNull();
    expect(screen.queryByLabelText("Комментарий")).toBeNull();
  });

  it("applies once when the confirmation is pressed twice in the same moment", async () => {
    const { session, host } = fake();
    session.api.applyDisaggregation.mockImplementation(async () => {
      host.detail = {
        document: header({ status: "applied", rev: 42, appliedAt: "2026-10-13T10:00:00Z" }),
        lines: host.detail.lines,
      };
      return host.detail;
    });
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Провести документ?" });
    const button = within(confirm).getByRole("button", { name: "Провести" });
    fireEvent.click(button);
    fireEvent.click(button);
    await expectFocusedNotice("Документ проведён.");
    expect(session.api.applyDisaggregation).toHaveBeenCalledTimes(1);
    // The second press did not meet the first one's result as a refusal.
    expect(screen.queryByText(/проведён или отменён в другом окне/)).toBeNull();
  });

  it("closes the confirmation with Escape and applies nothing", async () => {
    const { session } = fake();
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(session.api.applyDisaggregation).not.toHaveBeenCalled();
  });

  it("says that lines changed when the host refuses the apply, and reads the document again", async () => {
    const { session, host } = fake();
    session.api.applyDisaggregation.mockImplementation(async () => {
      host.detail = {
        document: host.detail.document,
        lines: [BOX_LINE, { ...PALLET_LINE, status: "shift_open" }],
      };
      throw new HostError(fixtureError("error-disaggregation-invalid-lines.json"));
    });
    await openDocument(session);
    const reads = session.api.getDisaggregation.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    await expectFocusedNotice(
      "Часть строк изменила статус и не готова к проведению. Проверьте таблицу ниже.",
    );
    await waitFor(() =>
      expect(session.api.getDisaggregation.mock.calls.length).toBeGreaterThan(reads),
    );
    await waitFor(() => expect(screen.getAllByText(/Смена ещё открыта/).length).toBe(1));
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["reason_required", "Выберите причину: без неё документ не проводится."],
    ["no_lines", "В документе нет строк."],
  ])("explains %s in its own words", async (constraint, text) => {
    const { session } = fake();
    session.api.applyDisaggregation.mockRejectedValue(conflict(constraint));
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    await expectFocusedNotice(text);
  });

  it("says the host waits for the stations when it was restored, and keeps the draft as it is", async () => {
    const { session } = fake();
    session.api.applyDisaggregation.mockRejectedValue(
      new HostError(fixtureError("error-disaggregation-restore-hold.json")),
    );
    await openDocument(session);
    const reads = session.api.getDisaggregation.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    await expectFocusedNotice(
      "Хост восстановлен из копии: документы нельзя проводить, пока администратор не возобновит работу станций («Резервные копии» → «Возобновить приём данных станций»). Черновик сохранён.",
    );
    // The document is as it was: it is not read again as if it were invalid.
    expect(session.api.getDisaggregation.mock.calls.length).toBe(reads);
    expect(screen.queryByText(/Часть строк изменила статус/)).toBeNull();
    expect(screen.getByRole("button", { name: "Провести" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows the current document when it was applied or cancelled in another window", async () => {
    const { session, host } = fake();
    session.api.applyDisaggregation.mockImplementation(async () => {
      host.detail = {
        document: header({ status: "cancelled", rev: 43, cancelledAt: "2026-10-13T10:00:00Z" }),
        lines: host.detail.lines,
      };
      throw conflict("document_not_draft");
    });
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    await expectFocusedNotice(
      "Документ уже проведён или отменён в другом окне. Показано его текущее состояние.",
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Провести" })).toBeNull());
  });

  it("offers to load the document again after a stale apply", async () => {
    const { session } = fake();
    session.api.applyDisaggregation.mockRejectedValue(
      new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
    );
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    expect(await screen.findByRole("button", { name: "Загрузить заново" })).toBeTruthy();
  });

  it("cancels the document after a confirmation", async () => {
    const { session, host } = fake();
    session.api.cancelDisaggregation.mockImplementation(async () => {
      host.detail = {
        document: header({ status: "cancelled", rev: 42, cancelledAt: "2026-10-13T10:00:00Z" }),
        lines: host.detail.lines,
      };
      return host.detail;
    });
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Отменить документ" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Отменить документ?" });
    expect(
      within(confirm).getByText("Документ будет отменён. Это действие нельзя отменить."),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Отменить документ" }));
    await expectFocusedNotice("Документ отменён.");
    expect(session.api.cancelDisaggregation).toHaveBeenCalledWith(TOKEN, DOC_ID, {
      expectedRev: 41,
    });
    expect(screen.queryByRole("button", { name: "Отменить документ" })).toBeNull();
    expect(screen.getByText("Отменён", { selector: "dt" })).toBeTruthy();
  });

  it("keeps the document when the cancelling is dismissed", async () => {
    const { session } = fake();
    await openDocument(session);
    fireEvent.click(screen.getByRole("button", { name: "Отменить документ" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(session.api.cancelDisaggregation).not.toHaveBeenCalled();
  });

  it("has the act for a draft too, and no file for Честный знак", async () => {
    const { session } = fake();
    await openDocument(session);
    expect(screen.getByRole("button", { name: "Акт дезагрегации" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Файл для Честного знака" })).toBeNull();
  });

  it("lets a technologist do the same", async () => {
    const { session } = fake(DRAFT, TECHNOLOGIST);
    session.api.applyDisaggregation.mockResolvedValue({
      document: header({ status: "applied", rev: 42 }),
      lines: DRAFT.lines,
    });
    await openDocument(session);
    expect(screen.getByLabelText("Комментарий")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Провести" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Провести" }),
    );
    await expectFocusedNotice("Документ проведён.");
  });
});

/** The init of a `HostError` from a fixture of the host's error answers. */
function fixtureError(name: string): ConstructorParameters<typeof HostError>[0] {
  const body = fixture(name) as {
    error: { code: string; message: string; details: Record<string, unknown> };
  };
  return {
    kind: "api",
    code: body.error.code,
    status: 409,
    message: body.error.message,
    details: body.error.details,
  };
}

describe("office «Дезагрегация»: a document that is not a draft", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    cleanup();
  });

  const APPLIED: DisaggregationDetail = {
    document: header({
      status: "applied",
      appliedAt: "2026-10-13T10:00:00Z",
      appliedBy: "2f4e6a8c-1b3d-4f5a-9c7e-0d2b4f6a8c1e",
      appliedByName: "Павел Орлов",
      rev: 44,
    }),
    lines: [BOX_LINE, PALLET_LINE],
  };
  const CANCELLED: DisaggregationDetail = {
    document: header({ status: "cancelled", cancelledAt: "2026-10-13T11:30:00Z", rev: 44 }),
    lines: [BOX_LINE],
  };

  it("shows an applied document to read: no field, no panel to add, no delete, apply or cancel", async () => {
    const { session } = fake(APPLIED);
    await openDocument(session);
    expect(screen.queryByLabelText("Комментарий")).toBeNull();
    expect(screen.queryByLabelText("SSCC коробов или палетов")).toBeNull();
    expect(screen.queryByTestId("file-drop-input")).toBeNull();
    expect(screen.queryByRole("button", { name: /Удалить строку/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Провести" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить документ" })).toBeNull();
    expect(screen.getByText("Повреждена упаковка")).toBeTruthy();
    expect(screen.getByText("Короб помят при погрузке")).toBeTruthy();
    // The header in words: who and when (the organization's zone, 10:00 UTC is 13:00).
    expect(screen.getByText("13.10.2026, 13:00")).toBeTruthy();
    expect(screen.getByText("Павел Орлов")).toBeTruthy();
    expect(lineRows().length).toBe(2);
    expect(within(linesTable()).queryByRole("columnheader", { name: "Действия" })).toBeNull();
  });

  it("has both the act and the file for Честный знак when applied", async () => {
    const { session } = fake(APPLIED);
    await openDocument(session);
    expect(screen.getByRole("button", { name: "Акт дезагрегации" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Файл для Честного знака" })).toBeTruthy();
  });

  it("shows a cancelled document to read, with the act and without the file", async () => {
    const { session } = fake(CANCELLED);
    await openDocument(session);
    expect(screen.queryByLabelText("Комментарий")).toBeNull();
    expect(screen.queryByRole("button", { name: "Провести" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отменить документ" })).toBeNull();
    expect(screen.getByRole("button", { name: "Акт дезагрегации" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Файл для Честного знака" })).toBeNull();
    expect(screen.getAllByText("Отменён").length).toBeGreaterThan(0);
  });

  it("shows a document with no reason as «Не выбрана» and no comment as a dash", async () => {
    const { session } = fake({
      document: header({ status: "cancelled", reasonId: null, reasonName: null, comment: null }),
      lines: [],
    });
    await openDocument(session);
    expect(screen.getByText("Не выбрана")).toBeTruthy();
    expect(screen.getByText("Нет")).toBeTruthy();
  });

  it("reads an applied document of the host's fixture", async () => {
    const detail = disaggregationDetailSchema.parse(fixture("disaggregation-detail.json"));
    const { session } = fake({ ...detail, document: { ...detail.document, status: "applied" } });
    await openDocument(session);
    expect(lineRows().length).toBe(5);
  });
});

describe("office «Дезагрегация»: a document that did not load", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    cleanup();
  });

  it("says an unknown document is not found and links back", async () => {
    const { session } = fake();
    session.api.getDisaggregation.mockRejectedValue(
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such document" }),
    );
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
    fireEvent.click(await screen.findByRole("link", { name: /^Открыть документ / }));
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeTruthy();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("link", { name: "← Дезагрегация" }));
    expect(await screen.findByRole("heading", { name: "Дезагрегация", level: 1 })).toBeTruthy();
  });
});

it("reads a handheld document without inventing an office user and keeps its act and XML actions", async () => {
  const detail = disaggregationDetailSchema.parse({
    ...DRAFT,
    document: header({
      status: "applied",
      createdBy: null,
      createdByDeviceId: "11111111-1111-4111-8111-111111111111",
      createdByOperatorId: "22222222-2222-4222-8222-222222222222",
      createdByName: "Сергей · ТСД склада",
      appliedBy: null,
      appliedByName: "Сергей · ТСД склада",
      appliedAt: "2026-10-30T15:00:00Z",
    }),
  });
  const { session } = fake(detail);
  await openDocument(session);
  expect(screen.getAllByText("Сергей · ТСД склада")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Провести" })).toBeNull();
  expect(screen.getByRole("button", { name: "Акт дезагрегации" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Файл для Честного знака" })).toBeTruthy();
});
