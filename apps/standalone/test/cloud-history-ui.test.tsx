import { readFileSync } from "node:fs";
import type { QueryClient } from "@tanstack/react-query";
import type * as OfficeQueries from "../src/office/office-query.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostError } from "../src/host/client.js";
import {
  cloudHistoryManifestSchema,
  cloudHistoryPartSchema,
  type CloudHistoryImportRequest,
  type CloudHistoryImportState,
} from "../src/host/cloud-history.js";
import { fakeOfficeSession, renderOffice, TECHNOLOGIST, ORG_PROFILE } from "./support/office.js";
import "../src/i18n/index.js";
const made = vi.hoisted(() => ({ clients: [] as QueryClient[] }));
vi.mock("../src/office/office-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OfficeQueries>();
  return {
    ...actual,
    createOfficeQueryClient: () => {
      const client = actual.createOfficeQueryClient();
      made.clients.push(client);
      return client;
    },
  };
});
afterEach(() => {
  made.clients.length = 0;
});
const testModuleUrl = import.meta.url;
const golden = readFileSync(
  new URL("../proto/fixtures/cloud-history.jsonl", testModuleUrl),
  "utf8",
);
const [m, p] = golden
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as unknown);
const manifest = cloudHistoryManifestSchema.parse(m);
const part = cloudHistoryPartSchema.parse(p);
const pending: CloudHistoryImportState = {
  batchId: manifest.checksum,
  source: manifest.source,
  status: "pending",
  receivedIndices: [0],
  totalParts: 1,
  counts: manifest.counts,
};
function file(text = golden) {
  const picked = new File([text], "history.jsonl");
  Object.defineProperty(picked, "stream", {
    value: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          for (let n = 0; n < bytes.length; n += 37) controller.enqueue(bytes.slice(n, n + 37));
          controller.close();
        },
      }),
  });
  return picked;
}
function setup(state: CloudHistoryImportState | null = null) {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  const methods = {
    getCloudHistoryState: vi.fn(async () => state),
    importCloudHistory: vi.fn(async (_token: string, _body: CloudHistoryImportRequest) => pending),
    completeCloudHistory: vi.fn(async () => ({ ...pending, status: "complete" as const })),
    cancelCloudHistory: vi.fn(async () => null),
  };
  Object.assign(session.api, methods);
  renderOffice(session, { initialPath: "/import" });
  return { session, ...methods };
}
async function choose(text = golden) {
  fireEvent.change((await screen.findAllByTestId("file-drop-input"))[1]!, {
    target: { files: [file(text)] },
  });
}
describe("cloud history office transfer", () => {
  it("streams the source preview, validates every part before import and only completes after activation", async () => {
    const host = setup();
    await choose();
    expect(
      (await screen.findAllByText(manifest.source.tenantName, { exact: true })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(manifest.since, { exact: true })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить историю" }));
    await waitFor(() =>
      expect(host.importCloudHistory).toHaveBeenCalledWith(expect.any(String), {
        manifest,
        part,
        dryRun: true,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Импортировать историю" }));
    expect(
      await screen.findByText("История перенесена. Работа разрешена после завершения импорта."),
    ).toBeTruthy();
    expect(host.completeCloudHistory).toHaveBeenCalledWith(expect.any(String), {
      batchId: manifest.checksum,
    });
    const cached = JSON.stringify(
      made.clients.flatMap((client) =>
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    );
    expect(
      part.payload.codes.some(
        (code) => cached.includes(code.canonical) || cached.includes(code.hash),
      ),
    ).toBe(false);
    expect(made.clients.every((client) => client.getMutationCache().getAll().length === 0)).toBe(
      true,
    );
  });
  it("refuses an incomplete or corrupted file without sending any part", async () => {
    const host = setup();
    await choose(golden.split("\n")[0]);
    expect(
      await screen.findByText(
        "Файл истории повреждён, неполон или не поддерживается. Создайте новый экспорт.",
      ),
    ).toBeTruthy();
    expect(host.importCloudHistory).not.toHaveBeenCalled();
    await choose(golden.replace("Milk", "PRIVATE-CODE"));
    expect(
      await screen.findByText(
        "Файл истории повреждён, неполон или не поддерживается. Создайте новый экспорт.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("PRIVATE-CODE");
  });
  it("keeps pending visible after a lost answer and resumes an accepted part without importing it again", async () => {
    const host = setup(pending);
    await choose();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить историю" }));
    await screen.findByText("Все части проверены. Можно перенести историю.");
    host.completeCloudHistory.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "not shown" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Продолжить импорт" }));
    await waitFor(() => expect(host.completeCloudHistory).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("История перенесена. Работа разрешена после завершения импорта."),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить импорт" }));
    await screen.findByText("История перенесена. Работа разрешена после завершения импорта.");
    expect(host.importCloudHistory.mock.calls.every(([, body]) => body.dryRun)).toBe(true);
  });
  it("requires explicit confirmation tied to pending batch and explains the canceled-file tombstone", async () => {
    const host = setup(pending);
    fireEvent.click(await screen.findByRole("button", { name: "Отменить незавершённый импорт" }));
    expect(await screen.findByText(/Этот же файл больше не будет принят/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить незавершённую историю" }));
    await waitFor(() =>
      expect(host.cancelCloudHistory).toHaveBeenCalledWith(expect.any(String), {
        batchId: manifest.checksum,
      }),
    );
  });
  it("does not offer the transfer to a technologist", async () => {
    const session = fakeOfficeSession({ user: TECHNOLOGIST });
    renderOffice(session, { initialPath: "/import" });
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByLabelText("Файл истории смен")).toBeNull();
  });
});

it("opens a cloud card with original metadata and no native journal reads", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
  const { cloudShiftCardSchema, cloudBoxCardSchema, cloudPalletRowsSchema } =
    await import("../src/host/cloud-history-read.js");
  const request = (
    await import("../src/host/cloud-history.js")
  ).cloudHistoryImportRequestSchema.parse(fixture.request);
  const shift = request.part.payload.shifts[0];
  if (!shift) throw new Error("missing shift");
  const card = cloudShiftCardSchema.parse({
    shift,
    sourceTimeZone: request.manifest.organization.timeZone,
    codeCount: 1,
    boxCount: 1,
    palletCount: 1,
    lateDataAt: null,
  });
  const boxes = cloudBoxCardSchema.array().parse(
    request.part.payload.boxes
      .filter((box) => box.shiftId === shift.id)
      .map((pack) => ({
        pack,
        sourceTimeZone: request.manifest.organization.timeZone,
        shiftNumber: shift.number,
        productName: shift.productName,
        productionDate: shift.productionDate,
        units: request.part.payload.items.filter((item) => item.boxId === pack.id).length,
      })),
  );
  const pallets = cloudPalletRowsSchema.array().parse(fixture.palletSources);
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getCloudShift.mockResolvedValue(card);
  session.api.listCloudShiftBoxes.mockResolvedValue(boxes);
  session.api.listCloudShiftPallets.mockResolvedValue(pallets);
  renderOffice(session, { initialPath: `/cloud-shifts/${card.shift.id}` });
  expect(
    await screen.findByRole("heading", { name: `Облачная смена ${card.shift.number}` }),
  ).toBeTruthy();
  expect(screen.getByText("Действующие владельцы кодов: 1")).toBeTruthy();
  expect(session.api.getShift).not.toHaveBeenCalled();
  expect(session.api.listShiftScans).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Изменить|Переоткрыть/ })).toBeNull();
});

it("renders cloud owner provenance without a native fallback or fictional open box", async () => {
  const { officeConflictPageSchema } = await import("../src/host/review.js");
  const { CLOUD_HISTORY_DEVICE_ID } = await import("../src/host/cloud-history-read.js");
  const original = officeConflictPageSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/office-conflict-page.json", testModuleUrl), "utf8"),
    ),
  );
  const conflict = original.items[0];
  if (!conflict) throw new Error("conflict fixture");
  conflict.winner.deviceId = CLOUD_HISTORY_DEVICE_ID;
  conflict.winner.deviceName = "SHOULD-NOT-BE-A-STATION";
  conflict.winner.boxSscc = null;
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listShifts.mockResolvedValue([]);
  session.api.listConflicts.mockResolvedValue({ ...original, items: [conflict], total: 1 });
  session.api.getCloudShift.mockRejectedValue(
    new HostError({ kind: "api", code: "not_found", message: "private" }),
  );
  session.api.getCloudBox.mockRejectedValue(
    new HostError({ kind: "api", code: "not_found", message: "private" }),
  );
  renderOffice(session, { initialPath: "/conflicts" });
  expect(await screen.findByText("Облачная история · исходный владелец")).toBeTruthy();
  await waitFor(() => expect(session.api.getCloudShift).toHaveBeenCalled());
  expect(screen.queryByText("SHOULD-NOT-BE-A-STATION")).toBeNull();
  const links = screen.getAllByRole("link").map((node) => node.getAttribute("href"));
  expect(links).not.toContain(`/shifts?shift=${conflict.winner.shiftId}`);
  expect(links).not.toContain(`/shifts/${conflict.winner.shiftId}`);
  expect(screen.getByText("Исходный короб вне перенесённого состава")).toBeTruthy();
});

it("shows a fixed non-retryable history constraint without the raw server message", async () => {
  const host = setup();
  await choose();
  fireEvent.click(await screen.findByRole("button", { name: "Проверить историю" }));
  host.importCloudHistory.mockRejectedValue(
    new HostError({
      kind: "api",
      code: "conflict",
      message: "PRIVATE-CANONICAL",
      details: { constraint: "history_cancelled" },
    }),
  );
  // A fresh check also exercises error handling when an earlier check was still pending.
  await waitFor(() => expect(host.importCloudHistory).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "Проверить историю" }));
  expect(
    await screen.findByText(
      "Этот снимок был отменён и больше не принимается. Создайте новый экспорт из восстановленной копии.",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("PRIVATE-CANONICAL");
});

it("explains administrator requirement for a technologist reading an imported-pack document", async () => {
  const { disaggregationDetailSchema, disaggregationLineSchema } =
    await import("../src/host/disaggregation.js");
  const detail = disaggregationDetailSchema.parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/disaggregation-detail.json", testModuleUrl), "utf8"),
    ),
  );
  const line = disaggregationLineSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../proto/fixtures/cloud-history-disaggregation-line.json", testModuleUrl),
        "utf8",
      ),
    ),
  );
  const session = fakeOfficeSession({ user: TECHNOLOGIST });
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getDisaggregation.mockResolvedValue({ ...detail, lines: [line] });
  session.api.listDisaggregationReasons.mockResolvedValue([]);
  renderOffice(session, { initialPath: `/disaggregation/${detail.document.id}` });
  expect(
    await screen.findByText(
      "Для переноса истории и расформирования импортированных упаковок требуется администратор.",
    ),
  ).toBeTruthy();
  const shiftLink = screen.getByRole("link", { name: line.shiftNumber ?? "" });
  expect(shiftLink.getAttribute("href")).toBe(`/cloud-shifts/${line.shiftId}`);
  expect(session.api.applyDisaggregation).not.toHaveBeenCalled();
});

it("prints the real cloud box form in StrictMode using its frozen zone", async () => {
  const { StrictMode } = await import("react");
  const { render } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@markiro/ui");
  const { Office } = await import("../src/office/Office.js");
  const { boxReportRowsSchema } = await import("../src/host/protocol.js");
  const { cloudHistoryImportRequestSchema } = await import("../src/host/cloud-history.js");
  const fixture = JSON.parse(
    readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
  const request = cloudHistoryImportRequestSchema.parse(fixture.request);
  const pack = request.part.payload.boxes[0];
  if (!pack) throw new Error("fixture box");
  const shift = request.part.payload.shifts.find((row) => row.id === pack.shiftId);
  if (!shift) throw new Error("fixture shift");
  const items = request.part.payload.items
    .filter((row) => row.boxId === pack.id)
    .map((item) => {
      const code = request.part.payload.codes.find((row) => row.hash === item.hash);
      if (!code) throw new Error("fixture code");
      return { gtin14: code.gtin14, serial: code.serial, canonical: code.canonical };
    });
  const source = boxReportRowsSchema.parse({
    ...pack,
    productName: shift.productName,
    organization: request.manifest.organization,
    items,
  });
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "America/New_York" });
  session.api.getCloudBox.mockResolvedValue({
    pack,
    sourceTimeZone: request.manifest.organization.timeZone,
    shiftNumber: shift.number,
    productName: shift.productName,
    productionDate: shift.productionDate,
    units: items.length,
  });
  session.api.getCloudBoxReportRows.mockResolvedValue(source);
  let finishPrint: () => void = () => {
    throw new Error("print has not started");
  };
  const print = vi.fn<(html: string) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finishPrint = resolve;
      }),
  );
  render(
    <StrictMode>
      <ThemeProvider defaultTheme="dark">
        <Office session={session} printForm={print} initialPath={`/cloud-boxes/${pack.id}`} />
      </ThemeProvider>
    </StrictMode>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Состав короба" }));
  fireEvent.click(await screen.findByRole("button", { name: "Печать" }));
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  expect(print.mock.calls[0]?.[0]).toContain("13:00");
  expect((screen.getByRole("button", { name: "Печать" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Печать" }));
  expect(print).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishPrint();
  });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Печать" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});

const UNSUPPORTED_ZONE_MESSAGE =
  "Исходный часовой пояс не поддерживается в этой среде. Исторические даты и отчёты недоступны.";
it("refuses an accepted-shape unsupported frozen zone during history preview", async () => {
  const source = structuredClone(manifest);
  source.organization.timeZone = "Mars/Base";
  source.checksum = await (
    await import("../src/host/cloud-history.js")
  ).cloudHistoryChecksum(source);
  const host = setup();
  await choose(JSON.stringify(source) + "\n" + JSON.stringify(part) + "\n");
  expect(await screen.findByText(UNSUPPORTED_ZONE_MESSAGE)).toBeTruthy();
  expect(host.importCloudHistory).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Проверить историю" })).toBeNull();
  expect(source.organization.timeZone).toBe("Mars/Base");
});

it.each(["shift", "box", "pallet"] as const)(
  "safely refuses an already imported %s card with an unsupported original zone",
  async (kind) => {
    const { cloudHistoryImportRequestSchema } = await import("../src/host/cloud-history.js");
    const { cloudPalletRowsSchema } = await import("../src/host/cloud-history-read.js");
    const fixture = JSON.parse(
      readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
    ) as Record<string, unknown>;
    const request = cloudHistoryImportRequestSchema.parse(fixture.request);
    const shift = request.part.payload.shifts[0],
      pack = request.part.payload.boxes[0];
    if (!shift || !pack) throw new Error("fixture");
    const pallet = cloudPalletRowsSchema.array().parse(fixture.palletSources)[0];
    if (!pallet) throw new Error("pallet fixture");
    pallet.organization.timeZone = "Mars/Base";
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    session.api.getCloudShift.mockResolvedValue({
      shift,
      sourceTimeZone: "Mars/Base",
      codeCount: 1,
      boxCount: 1,
      palletCount: 1,
      lateDataAt: null,
    });
    session.api.listCloudShiftBoxes.mockResolvedValue([]);
    session.api.listCloudShiftPallets.mockResolvedValue([]);
    session.api.getCloudBox.mockResolvedValue({
      pack,
      sourceTimeZone: "Mars/Base",
      shiftNumber: shift.number,
      productName: shift.productName,
      productionDate: shift.productionDate,
      units: 1,
    });
    session.api.getCloudPallet.mockResolvedValue(pallet);
    const path =
      kind === "shift"
        ? `/cloud-shifts/${shift.id}`
        : kind === "box"
          ? `/cloud-boxes/${pack.id}`
          : `/cloud-pallets/${pallet.pallet.id}`;
    renderOffice(session, { initialPath: path });
    expect(await screen.findByText(UNSUPPORTED_ZONE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("Unexpected Application Error!")).toBeNull();
    expect(session.api.beginExportFile).not.toHaveBeenCalled();
    expect(pallet.organization.timeZone).toBe("Mars/Base");
  },
);

it("refuses a fresh cloud box form source with an unsupported zone without storing or printing", async () => {
  const { boxReportRowsSchema } = await import("../src/host/protocol.js");
  const { cloudHistoryImportRequestSchema } = await import("../src/host/cloud-history.js");
  const fixture = JSON.parse(
    readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
  ) as Record<string, unknown>;
  const request = cloudHistoryImportRequestSchema.parse(fixture.request);
  const pack = request.part.payload.boxes[0];
  if (!pack) throw new Error("box fixture");
  const shift = request.part.payload.shifts.find((row) => row.id === pack.shiftId);
  if (!shift) throw new Error("shift fixture");
  const items = request.part.payload.items
    .filter((row) => row.boxId === pack.id)
    .map((item) => {
      const code = request.part.payload.codes.find((row) => row.hash === item.hash);
      if (!code) throw new Error("code fixture");
      return { gtin14: code.gtin14, serial: code.serial, canonical: code.canonical };
    });
  const rows = boxReportRowsSchema.parse({
    ...pack,
    productName: shift.productName,
    organization: { ...request.manifest.organization, timeZone: "Mars/Base" },
    items,
  });
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getCloudBox.mockResolvedValue({
    pack,
    sourceTimeZone: "Europe/Moscow",
    shiftNumber: shift.number,
    productName: shift.productName,
    productionDate: shift.productionDate,
    units: items.length,
  });
  session.api.getCloudBoxReportRows.mockResolvedValue(rows);
  const print = vi.fn<(html: string) => void>();
  renderOffice(session, { initialPath: `/cloud-boxes/${pack.id}`, printForm: print });
  fireEvent.click(await screen.findByRole("button", { name: "Состав короба" }));
  fireEvent.click(await screen.findByRole("button", { name: "Печать" }));
  expect(await screen.findByText(UNSUPPORTED_ZONE_MESSAGE)).toBeTruthy();
  expect(print).not.toHaveBeenCalled();
  expect(session.api.beginExportFile).not.toHaveBeenCalled();
  expect(rows.organization.timeZone).toBe("Mars/Base");
});

it.each(["initial", "fresh"] as const)(
  "refuses an unsupported %s cloud export source without storing",
  async (stage) => {
    const { shiftExportRowsSchema } = await import("../src/host/protocol.js");
    const { cloudHistoryImportRequestSchema } = await import("../src/host/cloud-history.js");
    const fixture = JSON.parse(
      readFileSync(new URL("../proto/fixtures/cloud-history-read.json", testModuleUrl), "utf8"),
    ) as Record<string, unknown>;
    const request = cloudHistoryImportRequestSchema.parse(fixture.request);
    const shift = request.part.payload.shifts[0];
    const rows = shiftExportRowsSchema.array().parse(fixture.exportSources)[0];
    if (!shift || !rows) throw new Error("fixture");
    const unsupported = { ...rows, organization: { ...rows.organization, timeZone: "Mars/Base" } };
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    session.api.getCloudShift.mockResolvedValue({
      shift,
      sourceTimeZone: "Europe/Moscow",
      codeCount: rows.codes.length,
      boxCount: rows.boxes.length,
      palletCount: rows.pallets.length,
      lateDataAt: null,
    });
    session.api.listCloudShiftBoxes.mockResolvedValue([]);
    session.api.listCloudShiftPallets.mockResolvedValue([]);
    session.api.getCloudShiftExportSource.mockResolvedValue(unsupported);
    if (stage === "fresh") session.api.getCloudShiftExportSource.mockResolvedValueOnce(rows);
    renderOffice(session, { initialPath: `/cloud-shifts/${shift.id}` });
    fireEvent.click(await screen.findByRole("button", { name: "Выгрузка" }));
    if (stage === "fresh") {
      const submit = await screen.findByRole("button", { name: "Сформировать и сохранить" });
      await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
      fireEvent.click(submit);
    }
    expect(await screen.findByText(UNSUPPORTED_ZONE_MESSAGE)).toBeTruthy();
    expect(session.api.beginExportFile).not.toHaveBeenCalled();
    expect(unsupported.organization.timeZone).toBe("Mars/Base");
  },
);
