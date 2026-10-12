import { useSyncExternalStore } from "react";
import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  makePalletLabelSource,
  buildPalletLabelTemplates,
  warehouseBoxSource,
  PALLET_REPRINT_PROTOCOL,
} from "@markiro/domain";
import { PalletConfirmation } from "../src/ui/warehouse-reprint/PalletConfirmation.js";
import { createWarehousePalletWork } from "../src/lib/warehouse-reprint/pallet-work.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint.js";
import type { StationClient } from "../src/lib/api-client.js";
import i18n from "../src/i18n/index.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeDriverText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
vi.mock("../src/ui/LabelRasterPreview.js", () => ({
  LabelRasterPreview: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));
it("shows saved facts and requires confirmation; cancel never prints and scanned SSCC verifies the new attempt", async () => {
  await i18n.changeLanguage("ru");
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  const template = buildPalletLabelTemplates()[0];
  if (!template) throw new Error("Missing template");
  const source = makePalletLabelSource({
    version: 1,
    sscc: "146000000000001231",
    shiftId: "00000000-0000-4000-8000-000000000001",
    closedAt: "2026-10-11T00:00:00.000Z",
    boxCount: 1,
    itemCount: 1,
    boxSsccs: [input.source.identity],
    compositionDigest: "a".repeat(64),
    rendering: {
      kind: "thermal",
      rendererVersion: "thermal-v1",
      template: template.spec,
      fields: {
        ...warehouseBoxSource().fields,
        sscc: "146000000000001231",
        qty: "1",
        "qty.boxes": "1",
        date: "11.10.2026",
        expiry: "11.10.2026",
      },
      brandingJson: null,
    },
  });
  const client: StationClient = {
    get: async <T,>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
    post: async <T,>() => ({ status: "found", source }) as T,
    download: async () => new Blob(),
    whoami: async () => ({ ok: true }),
  };
  const print = vi.fn(async () => {}),
    generation = createCredentialGeneration("screen-key");
  const hardwareConfig = {
    scanner: null,
    printer: input.printer.target,
    printerLanguage: "tspl" as const,
    printerDpi: 203 as const,
    verifyPrintedLabel: false,
  };
  const work = createWarehousePalletWork({
    exec,
    client,
    generation,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => hardwareConfig,
    print,
  });
  let listener: (raw: string) => void = () => {};
  function View() {
    const state = useSyncExternalStore(work.subscribe, work.getSnapshot);
    return (
      <PalletConfirmation
        exec={exec}
        client={client}
        credentialGeneration={generation}
        deviceId={input.deviceId}
        operatorId={input.operatorId}
        source={{
          start: (fn) => {
            listener = fn;
            return () => {};
          },
        }}
        hardwareConfig={hardwareConfig}
        print={print}
        onExit={() => {}}
        state={state}
        work={work}
        onFinish={async () => {
          await work.finish();
        }}
        modeBusy={false}
      />
    );
  }
  await work.initialize();
  const view = render(<View />);
  try {
    expect(
      screen.getByTestId("warehouse-pallet-screen").querySelector(".warehouse-work-grid"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("warehouse-pallet-screen").querySelector(".warehouse-session-panel"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ввести код вручную" })).toBeTruthy();
    await act(async () => {
      listener(source.sscc);
      await work.idle();
    });
    await screen.findByRole("img", { name: "Сохранённая этикетка палеты" });
    expect(screen.getAllByText("11.10.2026")).toHaveLength(2);
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать шаблоны" }));
    await screen.findByRole("dialog", { name: "Шаблон этикетки палеты" });
    fireEvent.click(screen.getByRole("button", { name: "Применить шаблоны" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(work.getSnapshot().choice?.id).toBeNull();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(await exec.all("SELECT * FROM warehouse_pallet_jobs")).toHaveLength(0);
    await act(async () => {
      listener(source.sscc);
      await work.idle();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Подтвердить печать" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await act(async () => {
      await work.idle();
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить сканированием" }));
    await act(async () => {
      listener(`]C100${source.sscc}`);
      await work.idle();
    });
    expect(work.getSnapshot().job?.state).toBe("verified");
    expect(await exec.all("SELECT * FROM warehouse_reprint_jobs")).toHaveLength(0);
  } finally {
    view.unmount();
    await work.close();
    db.close();
  }
});

it("shows a human shift number and sync guidance instead of asking to resolve a successful send", async () => {
  await i18n.changeLanguage("ru");
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput(),
    generation = createCredentialGeneration("pending-screen");
  await seedWarehouseOperator(exec, input.operatorId);
  const shiftId = "00000000-0000-4000-8000-000000000001";
  await exec.run(
    "INSERT INTO shift_mirror(id,status,mode,product_id,number) VALUES(?,'closed','aggregation','product','OCT26-006/S')",
    [shiftId],
  );
  const diagnostic = {
    sscc: "146000000000001231",
    shiftId,
    originDeviceId: input.deviceId,
    sourceRevision: "a".repeat(64),
    attemptId: null,
    productionSequence: null,
    kind: "sync_pending",
  };
  const client: StationClient = {
    get: async <T,>() =>
      ({ protocols: [PALLET_REPRINT_PROTOCOL, "warehouse-pallet-reprint-v2"] }) as T,
    post: async <T,>() => ({ status: "unavailable", code: "delivery_unresolved", diagnostic }) as T,
    download: async () => new Blob(),
    whoami: async () => ({ ok: true }),
  };
  const hardwareConfig = {
    scanner: null,
    printer: null,
    printerLanguage: "tspl" as const,
    verifyPrintedLabel: false,
    boxPrinter: null,
    duplicatePrinter: null,
    palletPrinter: input.printer,
  };
  const work = createWarehousePalletWork({
    exec,
    client,
    generation,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => hardwareConfig,
    print: async () => {
      throw new Error("must not print");
    },
  });
  await work.initialize();
  await work.scan(diagnostic.sscc);
  const view = render(
    <PalletConfirmation
      exec={exec}
      client={client}
      credentialGeneration={generation}
      deviceId={input.deviceId}
      operatorId={input.operatorId}
      source={{ start: () => () => {} }}
      hardwareConfig={hardwareConfig}
      print={async () => {
        throw new Error("must not print");
      }}
      onExit={() => {}}
      state={work.getSnapshot()}
      work={work}
      onFinish={async () => {}}
      modeBusy={false}
    />,
  );
  try {
    expect(screen.getByText("OCT26-006/S")).toBeTruthy();
    expect(screen.queryByText(shiftId)).toBeNull();
    expect(
      screen.queryByText("Разрешите исходную попытку на станции, где печатали эту палету."),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Обновить статус" })).toBeTruthy();
    expect(screen.getByText(/Для выбора шаблона дождитесь/)).toBeTruthy();
  } finally {
    view.unmount();
    await work.close();
    db.close();
  }
});
