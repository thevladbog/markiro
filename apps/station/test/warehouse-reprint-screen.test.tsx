import { StrictMode } from "react";
import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  WAREHOUSE_REPRINT_PROTOCOL,
  warehouseBoxTemplate,
  productLabelValueDigest,
  buildWarehouseCodeOnlyLabelTemplate,
  warehouseTemplateSchema,
  warehouseBoxSource,
} from "@markiro/domain";
import i18n from "../src/i18n/index";
vi.mock("../src/lib/rasterizer", () => ({
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
import { WarehouseReprint } from "../src/pages/WarehouseReprint";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { createCredentialGeneration } from "../src/lib/credential-recovery";
import type { StationClient } from "../src/lib/api-client";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
export function warehouseTestCatalog() {
  const box = warehouseBoxTemplate();
  const spec = buildWarehouseCodeOnlyLabelTemplate().spec;
  const snap = {
    ...box,
    id: "00000000-0000-4000-8000-000000000040",
    name: "Только код",
    purpose: "product_duplicate" as const,
    spec,
  };
  const { digest, ...value } = snap;
  void digest;
  const unit = warehouseTemplateSchema.parse({ ...value, digest: productLabelValueDigest(value) });
  return {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([box, unit]),
    templates: [box, unit],
  };
}
function warehouseCatalogGet(path: string, catalog = warehouseTestCatalog()) {
  const url = new URL(path, "https://station.test");
  if (url.pathname === "/shifts/box-label-templates")
    return { items: [], defaultBoxLabelTemplateId: null, defaultSource: null };
  const ids = url.searchParams.get("ids")?.split(",");
  const templates = ids ? catalog.templates.filter((t) => ids.includes(t.id)) : catalog.templates;
  return { ...catalog, revision: productLabelValueDigest(templates), templates };
}
it("selects independent templates and sends legacy and ordinary scans only once", async () => {
  await i18n.changeLanguage("ru");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  let listener: (raw: string) => void = () => {};
  const client = {
    get: vi.fn(async (path: string) => warehouseCatalogGet(path)),
    post: vi.fn().mockResolvedValue({
      status: "found",
      source: warehouseBoxSource(),
      repair: "legacy_tspl_fnc1_literal",
    }),
  } as unknown as StationClient;
  const print = vi.fn().mockResolvedValue(undefined);
  const onExit = vi.fn();
  const view = render(
    <StrictMode>
      <WarehouseReprint
        exec={exec}
        client={client}
        deviceId={i.deviceId}
        operatorId={i.operatorId}
        credentialGeneration={createCredentialGeneration("synthetic-test-key")}
        source={{
          start: (fn) => {
            listener = fn;
            return () => {};
          },
        }}
        hardwareConfig={{
          scanner: null,
          printer: i.printer.target,
          printerLanguage: "tspl",
          printerDpi: 203,
          verifyPrintedLabel: false,
        }}
        print={print}
        onExit={onExit}
      />
    </StrictMode>,
  );
  try {
    const user = {
      click: async (element: Element) => {
        await act(async () => fireEvent.click(element));
      },
    };
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Выбрать шаблоны" }).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Выбрать шаблоны" }));
    await user.click(screen.getByRole("radio", { name: /Только код/ }));
    await user.click(screen.getByRole("button", { name: "Короба · SSCC" }));
    await user.click(
      screen.getByRole("radio", {
        name: new RegExp(i.template.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Применить шаблоны" }));
    await user.click(screen.getByRole("button", { name: "Начать перепечатку" }));
    await waitFor(() =>
      expect(screen.getByText("Отсканируйте код единицы или короба")).toBeTruthy(),
    );
    act(() => listener(`!100${i.source.identity}`));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Этикетка передана на принтер")).toBeTruthy());
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Напечатать ещё раз" }));
    expect(screen.getByRole("dialog", { name: "Причина новой попытки" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Повреждена" }));
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(print).toHaveBeenCalledTimes(1);
    act(() => listener(`00${i.source.identity}`));
    await waitFor(() =>
      expect(screen.getByText("Этот код уже печатали в этом сеансе")).toBeTruthy(),
    );
    expect(print).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Завершить сеанс" }));
    expect(onExit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Завершить и к операциям" }));
    await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    expect(
      db.prepare("SELECT count(*) AS n FROM warehouse_reprint_session_closures").get()?.n,
    ).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM warehouse_reprint_jobs").get()?.n).toBe(1);
  } finally {
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.close();
  }
});

it("prints a manually entered SSCC once, pauses scanner intake and rejects invalid numbers", async () => {
  const { credentialGenerationOwnership } = await import("../src/lib/credential-recovery");
  const { saveWarehouseSession } = await import("../src/lib/warehouse-reprint/store");
  await i18n.changeLanguage("ru");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const generation = createCredentialGeneration("manual-test-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("fixture owner");
  const catalog = warehouseTestCatalog();
  await saveWarehouseSession(exec, {
    owner,
    sessionId: i.sessionId,
    operatorId: i.operatorId,
    reason: "damaged",
    status: "paused",
    unitTemplate: catalog.templates[1] ?? null,
    boxTemplate: i.template,
  });
  let scanning = false;
  const client = {
    get: vi.fn(async (path: string) => warehouseCatalogGet(path, catalog)),
    post: vi
      .fn()
      .mockResolvedValue({ status: "found", source: warehouseBoxSource(), repair: null }),
  } as unknown as StationClient;
  const print = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <WarehouseReprint
      exec={exec}
      client={client}
      deviceId={i.deviceId}
      operatorId={i.operatorId}
      credentialGeneration={generation}
      source={{
        start: () => {
          scanning = true;
          return () => {
            scanning = false;
          };
        },
      }}
      hardwareConfig={{
        scanner: null,
        printer: i.printer.target,
        printerLanguage: "tspl",
        printerDpi: 203,
        verifyPrintedLabel: false,
      }}
      print={print}
      onExit={() => {}}
    />,
  );
  const click = async (name: string) =>
    act(async () => fireEvent.click(screen.getByRole("button", { name })));
  try {
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Начать перепечатку" }).disabled,
      ).toBe(false),
    );
    await click("Начать перепечатку");
    expect(
      screen.getByRole("button", { name: "Ввести код вручную" }).closest("header"),
    ).toBeTruthy();
    await click("Ввести код вручную");
    expect(scanning).toBe(false);
    const field = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Номер короба или полный код единицы",
    });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "346006820000000015" } });
    fireEvent.blur(field);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Найти и перепечатать" }).disabled,
    ).toBe(true);
    const form = field.closest("form");
    if (!form) throw new Error("missing form");
    fireEvent.submit(form);
    expect(client.post).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(scanning).toBe(true));
    await click("Ввести код вручную");
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Номер короба или полный код единицы",
    });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: i.source.identity } });
    const validForm = input.closest("form");
    if (!validForm) throw new Error("missing form");
    await act(async () => fireEvent.submit(validForm));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(client.post).toHaveBeenCalledWith(
      "/station/warehouse-reprint/lookup",
      expect.objectContaining({ raw: i.source.identity, operatorId: i.operatorId }),
    );
    await waitFor(() => expect(scanning).toBe(true));
    await click("Ввести код вручную");
    fireEvent.change(screen.getByRole("textbox", { name: "Номер короба или полный код единицы" }), {
      target: { value: i.source.identity },
    });
    await click("Найти и перепечатать");
    await waitFor(() =>
      expect(screen.getByText("Этот код уже печатали в этом сеансе")).toBeTruthy(),
    );
    expect(print).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Ввести код вручную" }).closest("header"),
    ).toBeTruthy();
    await click("Проверить новую этикетку");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Ввести код вручную" }).disabled,
    ).toBe(true);
  } finally {
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.close();
  }
});

it("acknowledges the visible quarantine warning durably without accepting or deleting its history", async () => {
  const { credentialGenerationOwnership } = await import("../src/lib/credential-recovery");
  const { saveWarehouseSession, prepareWarehouseJob } =
    await import("../src/lib/warehouse-reprint/store");
  await i18n.changeLanguage("ru");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const generation = createCredentialGeneration("quarantine-screen-test-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("fixture owner");
  await saveWarehouseSession(exec, {
    owner,
    sessionId: i.sessionId,
    operatorId: i.operatorId,
    reason: i.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: i.template,
  });
  await prepareWarehouseJob(exec, { ...i, owner });
  await exec.run(
    "UPDATE warehouse_reprint_events SET receive_status='quarantined',rejection_code='template_mismatch' WHERE owner=? AND event_id=?",
    [owner, i.preparedEvent.eventId],
  );
  const props = {
    exec,
    client: {
      get: vi.fn(async (path: string) => warehouseCatalogGet(path)),
      post: vi.fn(),
    } as unknown as StationClient,
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    credentialGeneration: generation,
    source: { start: () => () => {} },
    hardwareConfig: {
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    },
    print: vi.fn(),
    onExit: () => {},
  };
  let view = render(<WarehouseReprint {...props} />);
  try {
    await screen.findByText(/История перепечатки требует разбора/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    });
    await waitFor(() =>
      expect(screen.queryByText(/История перепечатки требует разбора/)).toBeNull(),
    );
    const [event] = await exec.all<{ digest: string; receive_status: string }>(
      "SELECT digest,receive_status FROM warehouse_reprint_events WHERE owner=? AND event_id=?",
      [owner, i.preparedEvent.eventId],
    );
    expect(event?.receive_status).toBe("quarantined");
    expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(1);
    expect(await exec.all("SELECT * FROM warehouse_reprint_history_acknowledgements")).toEqual([
      {
        owner,
        event_id: i.preparedEvent.eventId,
        digest: event?.digest,
        rejection_code: "template_mismatch",
        operator_id: i.operatorId,
        acknowledged_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]);
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view = render(<WarehouseReprint {...props} />);
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Отправить подготовленную этикетку" })
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/История перепечатки требует разбора/)).toBeNull();
    expect(props.print).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.close();
  }
});
