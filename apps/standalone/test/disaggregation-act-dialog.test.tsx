import { readFileSync } from "node:fs";

import { DISAGGREGATION_MANUAL_UPLOAD_NOTE, renderDisaggregationReportHtml } from "@markiro/domain";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  disaggregationDetailSchema,
  disaggregationReportRowsSchema,
  type DisaggregationDetail,
  type DisaggregationReportRows,
} from "../src/host/disaggregation.js";
import { actData } from "../src/office/disaggregation/act-data.js";
import { OfficeFilesError } from "../src/office/exports/office-files.js";
import type { PrintForm } from "../src/office/forms/form-printer-context.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { fakeOfficeFiles } from "./support/office-files.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));

const BOXES = disaggregationReportRowsSchema.parse(
  fixture("disaggregation-report-rows-boxes.json"),
);
const FULL = disaggregationReportRowsSchema.parse(fixture("disaggregation-report-rows-full.json"));
const DETAIL: DisaggregationDetail = disaggregationDetailSchema.parse(
  fixture("disaggregation-detail.json"),
);
const DOC = { ...DETAIL.document, status: "applied" as const, docNo: "DSG-26-0007" };
const APPLIED: DisaggregationDetail = { document: DOC, lines: DETAIL.lines };
const TOKEN = "office-session-token";
const TITLE = "Акт дезагрегации DSG-26-0007";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** What the act draws for `rows` in the organization's zone, with the standalone's note. */
function expectedHtml(rows: DisaggregationReportRows): string {
  return renderDisaggregationReportHtml(
    { ...actData(rows), operationNote: DISAGGREGATION_MANUAL_UPLOAD_NOTE },
    ORG_PROFILE.timeZone,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withHost(detail: DisaggregationDetail = APPLIED, user = fakeOfficeSession().user) {
  const session = fakeOfficeSession({ user });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listDisaggregationReasons.mockResolvedValue([]);
  session.api.listDisaggregations.mockResolvedValue([detail.document]);
  session.api.getDisaggregation.mockResolvedValue(detail);
  session.api.getDisaggregationReportRows.mockImplementation(async (_token, _id, variant) =>
    variant === "full" ? FULL : BOXES,
  );
  return session;
}

/** Opens the document through the list and then the act's dialog. */
async function openAct(
  session: FakeOfficeSession,
  print: PrintForm,
  files = fakeOfficeFiles(),
): Promise<HTMLElement> {
  renderOffice(session, { printForm: print, files });
  fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
  fireEvent.click(await screen.findByRole("link", { name: /^Открыть документ / }));
  await screen.findByRole("heading", { level: 1, name: /^Документ / });
  fireEvent.click(await screen.findByRole("button", { name: "Акт дезагрегации" }));
  const dialog = await screen.findByRole("dialog", { name: TITLE });
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  return dialog;
}

async function afterPaint(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function closeDialog(dialog: HTMLElement): void {
  const [footer] = within(dialog).getAllByRole("button", { name: "Закрыть" }).reverse();
  if (footer === undefined) throw new Error("the dialog has no «Закрыть»");
  fireEvent.click(footer);
}

describe("«Акт дезагрегации» of a document (plan ДЗГ-О)", () => {
  it("offers the cloud's two variants, the short one chosen, and reads its rows when it opens", async () => {
    const session = withHost();
    const dialog = await openAct(session, vi.fn<PrintForm>());
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(within(dialog).getByRole("radio", { name: "Только коды упаковок" })).toBeTruthy();
    expect(
      within(dialog).getByText(/Акт рисуется по данным, прочитанным в момент нажатия/),
    ).toBeTruthy();
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledWith(TOKEN, DOC.id, "boxes");
  });

  it("prints the act from rows read again at the press, in the organization's zone, with the manual-upload note", async () => {
    const session = withHost();
    const print = vi.fn<PrintForm>();
    const dialog = await openAct(session, print);
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(session.api.getDisaggregationReportRows).toHaveBeenCalledTimes(2);
    expect(print).toHaveBeenCalledWith(expectedHtml(BOXES));
    expect(print.mock.calls[0]?.[0]).toContain(
      "загружается в личный кабинет Честного знака вручную",
    );
    expect(print.mock.calls[0]?.[0]).not.toContain("передаются в ГИС МТ автоматически");
  });

  it("reads and prints the full variant when it is chosen", async () => {
    const session = withHost();
    const print = vi.fn<PrintForm>();
    const dialog = await openAct(session, print);
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Коды упаковок и содержимого/ }));
    await waitFor(() =>
      expect(session.api.getDisaggregationReportRows).toHaveBeenCalledWith(TOKEN, DOC.id, "full"),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledWith(expectedHtml(FULL)));
  });

  it("opens the act in the browser: saved under «Формы\\Дезагрегация» in a folder of its own, then the folder on request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T15:30:00.000Z"));
    const files = fakeOfficeFiles();
    const dialog = await openAct(withHost(), vi.fn<PrintForm>(), files);
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Коды упаковок и содержимого/ }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(/Форма открыта в браузере\./);
    const folder = ["Формы", "Дезагрегация", "DSG-26-0007", "2026-10-08_18-30-00_act_full"];
    const name = "Акт дезагрегации DSG-26-0007.html";
    expect(files.save).toHaveBeenCalledWith(folder, [
      { name, bytes: new TextEncoder().encode(expectedHtml(FULL)) },
    ]);
    expect(files.openFile).toHaveBeenCalledWith(folder, name);
    fireEvent.click(within(dialog).getByRole("button", { name: "Показать папку" }));
    await waitFor(() => expect(files.open).toHaveBeenCalledWith(folder));
  });

  it("keeps the act's exact HTML on the host as a file of its document, printed or not, and still prints without the host", async () => {
    const session = withHost();
    const print = vi.fn<PrintForm>();
    const dialog = await openAct(session, print);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const [, begin] = session.api.beginExportFile.mock.calls[0] ?? [];
    expect(begin).toMatchObject({
      kind: "form",
      targetType: "disaggregation_document",
      targetId: DOC.id,
      formatId: "form_act",
      formatVersion: 1,
      fileName: "Акт дезагрегации DSG-26-0007.html",
    });
    const bytes = Uint8Array.from(atob(begin?.contentBase64 ?? ""), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(expectedHtml(BOXES));
    // A host that cannot keep it never stops the print.
    session.api.beginExportFile.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await afterPaint();
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    await within(dialog).findByText(/^Копия на хосте не сохранена: /);
  });

  it("says why the act was not saved, and opens nothing", async () => {
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("documents_unavailable", "no folder"));
    const dialog = await openAct(withHost(), vi.fn<PrintForm>(), files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText(
      "На этом компьютере не найдена папка «Документы». Форма не сохранена.",
    );
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it("says a print window that did not open, and offers the browser", async () => {
    const print = vi.fn<PrintForm>(() => {
      throw new Error("no window");
    });
    const dialog = await openAct(withHost(), print);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText(/Окно печати не открылось/);
  });

  it("shows a read that failed and reads again on request", async () => {
    const session = withHost();
    session.api.getDisaggregationReportRows.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "host down" }),
    );
    renderOffice(session, { printForm: vi.fn<PrintForm>(), files: fakeOfficeFiles() });
    fireEvent.click(await screen.findByRole("link", { name: "Дезагрегация" }));
    fireEvent.click(await screen.findByRole("link", { name: /^Открыть документ / }));
    await screen.findByRole("heading", { level: 1, name: /^Документ / });
    fireEvent.click(await screen.findByRole("button", { name: "Акт дезагрегации" }));
    const dialog = await screen.findByRole("dialog", { name: TITLE });
    await within(dialog).findByText(/Нет связи с хостом/);
    expect(within(dialog).queryByRole("button", { name: "Печать" })?.hasAttribute("disabled")).toBe(
      true,
    );
    session.api.getDisaggregationReportRows.mockResolvedValue(BOXES);
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Печать" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("abandons a press whose dialog was closed while the act was being drawn, or saved", async () => {
    const print = vi.fn<PrintForm>();
    const files = fakeOfficeFiles();
    const session = withHost();
    let dialog = await openAct(session, print, files);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText("Рисуем форму…");
    closeDialog(dialog);
    await afterPaint();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Акт дезагрегации" }));
    dialog = await screen.findByRole("dialog", { name: TITLE });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Открыть в браузере" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в браузере" }));
    await within(dialog).findByText("Сохраняем форму и открываем браузер…");
    closeDialog(dialog);
    await afterPaint();
    expect(files.save).not.toHaveBeenCalled();
  });

  it("holds the variant still while it works", async () => {
    const session = withHost();
    const dialog = await openAct(session, vi.fn<PrintForm>());
    const read = deferred<DisaggregationReportRows>();
    session.api.getDisaggregationReportRows.mockImplementationOnce(() => read.promise);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await within(dialog).findByText("Читаем актуальные данные…");
    for (const radio of within(dialog).getAllByRole("radio")) {
      expect(radio).toHaveProperty("disabled", true);
    }
    await act(async () => {
      read.resolve(BOXES);
    });
    await waitFor(() =>
      expect(within(dialog).getAllByRole("radio")[0]).toHaveProperty("disabled", false),
    );
  });

  it("is as available to a technologist and to a draft as to an administrator", async () => {
    const draft: DisaggregationDetail = {
      document: { ...DETAIL.document, status: "draft", docNo: "DSG-26-0007" },
      lines: DETAIL.lines,
    };
    const print = vi.fn<PrintForm>();
    const dialog = await openAct(withHost(draft, TECHNOLOGIST), print);
    fireEvent.click(within(dialog).getByRole("button", { name: "Печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });
});
