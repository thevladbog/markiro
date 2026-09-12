import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { WorkScreen } from "../src/pages/WorkScreen.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  type FloorWorkBarrier,
} from "../src/lib/credential-recovery.js";
import type { ScanSource } from "../src/lib/scan-source.js";
import { openProductLabelWork } from "./support/product-label-work.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeText: async () => ({ hex: "00", totalBytes: 1, bytesPerRow: 1, width: 8, height: 1 }),
}));
beforeAll(() => i18n.changeLanguage("ru"));
const resources: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
afterEach(() => {
  for (const h of resources.splice(0)) h.close();
});
async function setup(verification: "none" | "required" = "required") {
  const generation = createCredentialGeneration("floor-product-label-test");
  const owner = await credentialGenerationOwnership(generation);
  const h = await openProductLabelWork(verification, owner ?? undefined, false);
  resources.push(h);
  const callbacks = new Set<(raw: string) => void>();
  const source: ScanSource = {
    start(cb) {
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
      };
    },
  };
  const barriers = new Set<FloorWorkBarrier>();
  const register = (barrier: FloorWorkBarrier) => {
    barriers.add(barrier);
    return () => {
      barriers.delete(barrier);
    };
  };
  const exit = vi.fn();
  const element = (
    <WorkScreen
      exec={h.exec}
      shiftId={h.input.shiftId}
      terminalId={h.input.terminalId}
      operatorId={h.input.operatorId}
      expectedGtin14={h.input.gtin14}
      productName="Кега"
      source={source}
      sound={{ muted: true, volume: 0 }}
      issuerPrefix={null}
      boxCapacity={null}
      verifyPrintedLabel={false}
      pendingSync={0}
      onExit={exit}
      onScanQueueRegister={register}
      onFloorWorkRegister={register}
      productLabelEnvironment={{
        generation,
        deviceId: h.input.deviceId,
        operatorName: "Оператор",
        hardwareConfig: {
          scanner: null,
          printer: h.deps.target,
          printerLanguage: "zpl",
          printerDpi: 203,
          verifyPrintedLabel: false,
        },
        print: h.print,
      }}
    />
  );
  const view = render(element);
  await screen.findByText("Дубликат Data Matrix");
  const scan = (...raws: string[]) =>
    act(() => {
      for (const raw of raws) for (const cb of callbacks) cb(raw);
    });
  const idle = async () => {
    await act(async () => {
      await Promise.all([...barriers].map((b) => b.idle()));
    });
  };
  return { h, view, exit, scan, idle, callbacks, element };
}
describe("duplicate printing through the real WorkScreen scanner", () => {
  it.each(["none", "required"] as const)(
    "shows the frozen %s verification policy before the first scan",
    async (verification) => {
      await setup(verification);
      const hint =
        verification === "none" ? "productLabels.noneHint" : "productLabels.requiredHint";
      const otherHint =
        verification === "none" ? "productLabels.requiredHint" : "productLabels.noneHint";
      expect(screen.getByText(i18n.t(hint))).toBeTruthy();
      expect(screen.queryByText(i18n.t(otherHint))).toBeNull();
    },
  );
  it("does not confirm from an original burst; compares the full tail and counts only the original", async () => {
    const { h, scan, idle, callbacks } = await setup();
    expect(callbacks.size).toBe(1);
    scan(h.input.raw, h.input.raw);
    await idle();
    await screen.findByRole("dialog", { name: "Проверьте этикетку" });
    expect(h.print).toHaveBeenCalledTimes(1);
    scan(h.input.raw.replace("tail", "TAIL"));
    await idle();
    await screen.findByText("Код не совпадает");
    expect((await h.exec.all<{ n: number }>("SELECT count(*) n FROM codes_mirror"))[0]?.n).toBe(1);
    scan(h.input.raw);
    await idle();
    await screen.findByText("Этикетка подтверждена");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callbacks.size).toBe(1);
    expect(
      (await h.exec.all<{ n: number }>("SELECT count(*) n FROM scan_events_mirror"))[0]?.n,
    ).toBe(1);
  });
  it("explains the active processing refusal without a new unit or print", async () => {
    const { h, scan, idle } = await setup("none");
    await h.exec.run(
      "INSERT INTO validation_code_history(shift_id,code_hash,kind,source_shift_id,shift_number,shift_status,scanned_at) VALUES(?,?,'reprocessing',?,'ACTIVE','active',?)",
      [h.input.shiftId, h.input.codeHash, crypto.randomUUID(), h.input.acceptedAt],
    );
    scan(h.input.raw);
    await idle();
    expect(await screen.findByText("Код обрабатывается в другой активной смене")).toBeTruthy();
    expect(h.print).not.toHaveBeenCalled();
    expect(await h.exec.all("SELECT * FROM validation_occurrences")).toHaveLength(0);
  });

  it("restores the main processed counter and pending confirmation after remount", async () => {
    const { h, scan, idle, view, element } = await setup("none");
    scan(h.input.raw);
    await idle();
    view.unmount();
    render(element);
    const summary = await screen.findByRole("complementary", { name: "Итоги смены" });
    await waitFor(() =>
      expect(within(summary).getByText("Принято").parentElement?.textContent).toContain("1"),
    );
    expect(within(summary).queryByText("Синхронизировано")).toBeNull();
  });

  it("recovers a committed acceptance after its reply is lost without losing the print prompt", async () => {
    const { h, scan, idle } = await setup();
    const run = h.exec.run;
    let lost = false;
    h.exec.run = async (sql, params) => {
      await run(sql, params);
      if (!lost && sql.includes("INSERT INTO product_label_accept_commands")) {
        lost = true;
        throw new Error("reply lost");
      }
    };
    scan(h.input.raw);
    await idle();
    await screen.findByRole("button", { name: "Отправить сохранённую этикетку" });
    expect(h.print).not.toHaveBeenCalled();
    expect((await h.exec.all<{ n: number }>("SELECT count(*) n FROM codes_mirror"))[0]?.n).toBe(1);
  });

  it("continues in none without a verified claim and discards all input during sending", async () => {
    const { h, scan, idle } = await setup("none");
    let release!: () => void;
    h.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    scan(h.input.raw);
    await waitFor(() => expect(h.print).toHaveBeenCalledTimes(1));
    scan(h.input.raw.replace("SERIAL-42", "SERIAL-43"));
    release();
    await idle();
    await screen.findByText("Отправлено на принтер");
    expect(screen.queryByText("Этикетка подтверждена")).toBeNull();
    expect((await h.exec.all<{ n: number }>("SELECT count(*) n FROM codes_mirror"))[0]?.n).toBe(1);
    scan(h.input.raw.replace("SERIAL-42", "SERIAL-44"));
    await idle();
    expect(h.print).toHaveBeenCalledTimes(2);
  });
  it("pauses with an unresolved job and remounts without sending it again", async () => {
    const { h, scan, idle, exit, view, element } = await setup();
    scan(h.input.raw);
    await idle();
    const dialog = await screen.findByRole("dialog", { name: "Проверьте этикетку" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Пауза" }));
    await waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(h.print).toHaveBeenCalledTimes(1);
    expect(
      (await h.exec.all<{ status: string }>("SELECT status FROM product_label_jobs"))[0]?.status,
    ).toBe("awaiting_verification");
    view.unmount();
    render(element);
    await screen.findByRole("dialog", { name: "Проверьте этикетку" });
    expect(h.print).toHaveBeenCalledTimes(1);
  });
  it("requires a reason and uses the same bytes for a reprint", async () => {
    const { h, scan, idle } = await setup();
    scan(h.input.raw);
    await idle();
    fireEvent.click(await screen.findByRole("button", { name: "Напечатать повторно" }));
    scan(h.input.raw);
    await idle();
    expect(
      (await h.exec.all<{ status: string }>("SELECT status FROM product_label_jobs"))[0]?.status,
    ).toBe("awaiting_verification");
    const action = screen.getByRole("button", { name: "Напечатать повторно" });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Этикетка повреждена" }));
    fireEvent.click(action);
    await waitFor(() => expect(h.print).toHaveBeenCalledTimes(2));
    await idle();
    expect(h.print.mock.calls[1]?.[1]).toEqual(h.print.mock.calls[0]?.[1]);
    expect((await h.exec.all<{ n: number }>("SELECT count(*) n FROM codes_mirror"))[0]?.n).toBe(1);
  });
});
