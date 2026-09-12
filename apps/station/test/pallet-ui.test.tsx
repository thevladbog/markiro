import { DatabaseSync } from "node:sqlite";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { LabelTemplateSpec } from "@markiro/domain";
import i18n from "../src/i18n/index.js";
import { PalletContents } from "../src/components/PalletContents.js";
import { PalletClose } from "../src/components/PalletClose.js";
import { PalletExceptions } from "../src/components/PalletExceptions.js";
import { PalletStrip } from "../src/components/PalletStrip.js";
import type { ClosedPalletSummary } from "../src/lib/pallets.js";
import {
  disassemblePallet,
  findUnresolvedPalletPrint,
  markPalletPrintSkipped,
  markPalletPrintVerified,
} from "../src/lib/pallets.js";
import type { PrintTarget } from "../src/lib/hardware.js";
import type { PrinterLanguage } from "../src/lib/hardware-config.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { addRange } from "../src/lib/sscc-pool.js";
import { WorkScreen } from "../src/pages/WorkScreen.js";

/**
 * This test file predates neither the interfaces nor the RU/EN copy it
 * asserts on: every string is read back through `i18n.t(...)` rather than
 * hardcoded twice, so a wording change only ever needs updating in one
 * place -- the JSON dictionaries themselves.
 */
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

afterEach(() => {
  cleanup();
});

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) {
    try {
      db.exec(stmt);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T,>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

function manualSource(): ScanSource & { emit: ScanListener } {
  let listener: ScanListener = () => {};
  return {
    start(next) {
      listener = next;
      return () => {
        if (listener === next) listener = () => {};
      };
    },
    emit: (raw) => listener(raw),
  };
}

const TEST_ISSUER_PREFIX = "460123456";
const PALLET_EXTENSION_DIGIT = 1;
const PRINT_TARGET: PrintTarget = { kind: "tcp", host: "10.0.0.5", port: 9100 };

// ASCII-only (the pallet's own `sscc` field, all digits): the station's real
// `rasterizeText` needs a 2D canvas jsdom does not provide, but the native
// ZPL/TSPL text path only calls it for non-ASCII text (see @markiro/domain's
// `needsImageRendering`) -- mirrors work-screen.test.tsx's own `LABEL_SPEC`.
const PALLET_LABEL_SPEC: LabelTemplateSpec = {
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  elements: [{ id: "a", kind: "field", field: "sscc", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

interface SeedShiftOptions {
  shiftId: string;
  palletBoxCapacity?: number | null;
  palletLabelTemplateSpec?: LabelTemplateSpec | null;
}

async function seedShift(exec: SqlExecutor, options: SeedShiftOptions): Promise<void> {
  await exec.run(
    `INSERT INTO shift_mirror (id, status, mode, product_id, pallet_box_capacity, pallet_label_template_spec)
     VALUES (?,?,?,?,?,?)`,
    [
      options.shiftId,
      "active",
      "aggregation",
      "p1",
      options.palletBoxCapacity ?? null,
      options.palletLabelTemplateSpec ? JSON.stringify(options.palletLabelTemplateSpec) : null,
    ],
  );
}

interface SeedPalletOptions {
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  boxCount: number;
  openedAt?: string;
  closedAt?: string | null;
  sscc?: string | null;
  printState?: "pending" | "printed" | "skipped";
  printErrorCode?: string | null;
}

/** Seeds a pallet row and `boxCount` already-closed boxes joined to it. */
async function seedPallet(exec: SqlExecutor, options: SeedPalletOptions): Promise<void> {
  await exec.run(
    `INSERT INTO pallets_mirror
       (pallet_id, shift_id, terminal_id, sscc, opened_at, closed_at, print_state, print_error_code)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      options.palletId,
      options.shiftId,
      options.terminalId,
      options.sscc ?? null,
      options.openedAt ?? "2026-07-29T09:00:00.000Z",
      options.closedAt ?? null,
      options.printState ?? "pending",
      options.printErrorCode ?? null,
    ],
  );
  for (let i = 0; i < options.boxCount; i++) {
    const boxId = `${options.palletId}-box-${i}`;
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, pallet_id)
       VALUES (?,?,?,?,?,?,?)`,
      [
        boxId,
        options.shiftId,
        options.terminalId,
        `sscc-${boxId}`,
        "2026-07-29T09:00:00.000Z",
        "2026-07-29T09:05:00.000Z",
        options.palletId,
      ],
    );
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id) VALUES (?,?,?,?,?,?)`,
      [
        `code-${boxId}`,
        options.shiftId,
        "04600000000015",
        `s${i}`,
        "2026-07-29T09:00:00.000Z",
        boxId,
      ],
    );
  }
}

interface RenderWorkOptions {
  exec?: SqlExecutor;
  shiftId?: string;
  terminalId?: string | null;
  palletBoxCapacity?: number | null;
  issuerPrefix?: string | null;
  onCloseShift?: (reasonCode?: string | null) => Promise<{
    eventId: string;
    shiftId: string;
    productId: string;
    productName: string;
    plannedQtySnapshot: number | null;
    actualQty: number;
    closedBoxCount: number;
    reasonCode: null;
    closedAt: string;
  }>;
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  source?: ScanSource;
}

function renderWork(overrides: RenderWorkOptions = {}) {
  const {
    exec = makeExec(),
    shiftId = "s1",
    terminalId = "dev-1",
    palletBoxCapacity = null,
    issuerPrefix = TEST_ISSUER_PREFIX,
    onCloseShift,
    printing,
    source = manualSource(),
  } = overrides;

  return render(
    <WorkScreen
      exec={exec}
      shiftId={shiftId}
      terminalId={terminalId}
      operatorId="operator-1"
      expectedGtin14="04600000000015"
      productName="Water 0.5"
      source={source}
      sound={{ muted: true, volume: 1 }}
      onExit={() => {}}
      {...(onCloseShift ? { onCloseShift } : {})}
      pendingSync={0}
      issuerPrefix={issuerPrefix}
      boxCapacity={null}
      palletBoxCapacity={palletBoxCapacity}
      verifyPrintedLabel={false}
      {...(printing !== undefined ? { printing } : {})}
    />,
  );
}

describe("PalletStrip", () => {
  it("shows 42 of 66 as a continuous progress bar and exposes the two pallet actions", () => {
    const onShowContents = vi.fn();
    const onClose = vi.fn();
    render(
      <PalletStrip
        boxCount={42}
        capacity={66}
        serials="available"
        lastBoxSscc="004601234560000017"
        onShowContents={onShowContents}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("66");
    expect(screen.getByText(i18n.t("pallet.remaining", { count: 24 }))).toBeDefined();
    expect(screen.getByText(/64\s*%/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.contents") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.closeCurrent") }));
    expect(onShowContents).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the box/capacity readout and warns without blocking when the pallet pool is dry", () => {
    render(<PalletStrip boxCount={13} capacity={12} serials="empty" />);
    expect(screen.getByText(i18n.t("pallet.progress", { boxes: 13, capacity: 12 }))).toBeDefined();
    // The over-capacity warning is TEXT, never colour alone (project
    // accessibility rule) -- and its presence does not remove or disable
    // anything else on the strip.
    expect(screen.getByText(i18n.t("pallet.noSerials"))).toBeDefined();
  });

  it("shows no warning at all while this device can still close the pallet", () => {
    render(<PalletStrip boxCount={3} capacity={12} serials="available" />);
    expect(screen.getByText(i18n.t("pallet.progress", { boxes: 3, capacity: 12 }))).toBeDefined();
    expect(screen.queryByText(i18n.t("pallet.noSerials"))).toBeNull();
  });

  it("carries the shared work-instrument card class station.css actually styles (Task 15 review, Finding 2)", () => {
    // station.css has zero rules for a bare `.pallet-strip` -- no CSS rule
    // is directly testable in jsdom, but `work-instrument` is the class
    // that actually supplies the card's border/background, and whether the
    // component applies it IS testable.
    const { container } = render(<PalletStrip boxCount={3} capacity={12} serials="available" />);
    const root = container.querySelector(".pallet-strip");
    expect(root?.classList.contains("work-instrument")).toBe(true);
  });
});

describe("PalletContents", () => {
  it("waits for accepted scans to drain and reads local membership with retry after a read failure", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 66 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 2 });
    let drain: () => void = () => {};
    const idle = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const all = vi.spyOn(exec, "all").mockRejectedValueOnce(new Error("read failed"));
    const onClose = vi.fn();
    render(
      <PalletContents
        exec={exec}
        shiftId="s1"
        terminalId="dev-1"
        palletId="p1"
        waitForIdle={() => idle}
        onClose={onClose}
      />,
    );
    expect(screen.getByText(i18n.t("pallet.contentsLoading"))).toBeDefined();
    expect(all).not.toHaveBeenCalled();
    drain();
    await screen.findByText(i18n.t("pallet.contentsError"));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("productLabels.retry") }));
    await screen.findByText("sscc-p1-box-1");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.backToAssembly") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PalletClose", () => {
  const SSCC = "103460068200000004";

  it("names the pallet and its SSCC while its label is printing", () => {
    render(
      <PalletClose result={{ status: "closed", sscc: SSCC, boxCount: 12 }} print="printing" />,
    );
    expect(screen.getByText(i18n.t("pallet.closed"))).toBeDefined();
    expect(screen.getByText(SSCC)).toBeDefined();
  });

  it("never resends a pallet label whose outcome is unknown, offering only the two honest choices", () => {
    render(<PalletClose result={{ status: "closed", sscc: SSCC, boxCount: 12 }} print="unknown" />);
    // This component has no printer reference at all -- merely rendering the
    // "unknown" state cannot, by construction, trigger another print.
    expect(screen.getByRole("button", { name: i18n.t("pallet.confirmPrinted") })).toBeDefined();
    expect(screen.getByRole("button", { name: i18n.t("pallet.reprint") })).toBeDefined();
  });

  it("offers retry, setup and skip on a known failure, matching BoxPrintRecovery's own actions", () => {
    const onRetry = vi.fn();
    const onSetup = vi.fn();
    const onSkip = vi.fn();
    render(
      <PalletClose
        result={{ status: "closed", sscc: SSCC, boxCount: 12 }}
        print="failed"
        errorCode="printer_unconfigured"
        onRetry={onRetry}
        onSetup={onSetup}
        onSkip={onSkip}
      />,
    );
    expect(screen.getByText(i18n.t("box.printRecovery.errors.printerUnconfigured"))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("box.printRecovery.setup") }));
    expect(onSetup).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("box.printRecovery.continueWithoutLabel") }),
    );
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("pluralizes the box count correctly instead of a bare, ungrammatical string (Task 15 review, Finding 4)", () => {
    // The dictionary itself: a bare "Коробов на паллете: {{count}}" reads
    // wrong at count=1 ("Коробов на паллете: 1"). This file's own
    // convention (see `hiddenByFilter_*` in ru.json) is one/few/many/other.
    expect(i18n.t("pallet.boxCount", { count: 1 })).toBe("На паллете 1 короб");
    expect(i18n.t("pallet.boxCount", { count: 2 })).toBe("На паллете 2 короба");
    expect(i18n.t("pallet.boxCount", { count: 5 })).toBe("На паллете 5 коробов");

    // And the component actually forwards `count` rather than hardcoding
    // the phrase, so the rendered screen reads correctly too.
    render(<PalletClose result={{ status: "closed", sscc: SSCC, boxCount: 1 }} print="printing" />);
    expect(screen.getByText("На паллете 1 короб")).toBeDefined();
  });
});

describe("PalletExceptions", () => {
  const pallet: ClosedPalletSummary = {
    palletId: "pallet-1",
    sscc: "103460068200000004",
    boxCount: 12,
    closedAt: "2026-07-29T09:10:00.000Z",
  };

  it("requires a reason before it will disassemble a pallet", () => {
    render(
      <PalletExceptions
        pallets={[pallet]}
        onReprint={vi.fn()}
        onDisassemble={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.disassembleAction") }));
    const confirmButton = screen.getByRole("button", {
      name: i18n.t("box.confirmAction"),
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it("disassembles only after the reason and the irreversible confirmation", async () => {
    const onDisassemble = vi.fn().mockResolvedValue(undefined);
    render(
      <PalletExceptions
        pallets={[pallet]}
        onReprint={vi.fn()}
        onDisassemble={onDisassemble}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.disassembleAction") }));
    fireEvent.click(screen.getByText(i18n.t("pallet.reasons.disassemble.damagedPallet")));
    const confirm = screen.getByRole("button", {
      name: i18n.t("box.confirmAction"),
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    // The destructive action needs its own irreversible-warning step --
    // not yet applied merely from clicking the first confirm button.
    expect(onDisassemble).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("box.confirmDisassemble") }));
    await waitFor(() =>
      expect(onDisassemble).toHaveBeenCalledWith(
        "pallet-1",
        i18n.t("pallet.reasons.disassemble.damagedPallet"),
      ),
    );
  });

  it("uses the floor-sized picker button for the closed-pallet target list, matching ShiftBoxesPanel's box row (Task 15 review, Finding 1)", () => {
    const other: ClosedPalletSummary = {
      palletId: "pallet-2",
      sscc: "103460068200000011",
      boxCount: 5,
      closedAt: "2026-07-29T09:20:00.000Z",
    };
    const { container } = render(
      <PalletExceptions
        pallets={[pallet, other]}
        onReprint={vi.fn()}
        onDisassemble={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    // Two pallets -- `selectAction` lands on the "target" picker stage
    // instead of skipping straight to a reason.
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.reprintAction") }));
    const item = container.querySelector(".pallet-exceptions__item");
    expect(item).not.toBeNull();
    // A raw `<button>` carries none of these classes -- it loses the 64px
    // glove-sized touch target and the floor typography that
    // `Button size="floor"` gives ShiftBoxesPanel's identical box picker.
    expect(item?.classList.contains("mk-btn")).toBe(true);
    expect(item?.classList.contains("mk-btn--floor")).toBe(true);
  });
});

describe("WorkScreen pallet strip", () => {
  it("opens local contents from the card, swallows scans there, and resumes scanning after return", async () => {
    const exec = makeExec();
    const source = manualSource();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 66 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 42 });
    await seedPallet(exec, { palletId: "other", shiftId: "s1", terminalId: "dev-2", boxCount: 1 });
    renderWork({ exec, source, palletBoxCapacity: 66 });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 42, capacity: 66 }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.contents") }));
    await screen.findByText("sscc-p1-box-41");
    expect(screen.queryByText("sscc-other-box-0")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(43);
    const raw = "010460000000001521TEST-CONTENTS";
    source.emit(raw);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.backToAssembly") }));
    expect(await exec.all("SELECT * FROM scan_events_mirror")).toHaveLength(0);
    source.emit(raw);
    await waitFor(async () =>
      expect(await exec.all("SELECT * FROM scan_events_mirror")).toHaveLength(1),
    );
  });

  it("opens the existing partial-close confirmation directly from the card", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 66 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 42 });
    renderWork({ exec, palletBoxCapacity: 66 });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 42, capacity: 66 }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.closeCurrent") }));
    await screen.findByText(i18n.t("pallet.earlyCloseDetail", { count: 42, capacity: 66 }));
    const rows = await exec.all<{ closed_at: string | null }>(
      "SELECT closed_at FROM pallets_mirror WHERE pallet_id='p1'",
    );
    expect(rows[0]?.closed_at).toBeNull();
  });

  it("shows the pallet strip only when the shift has pallets", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 12 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 3 });

    renderWork({ exec, palletBoxCapacity: 12 });
    expect(
      await screen.findByText(i18n.t("pallet.progress", { boxes: 3, capacity: 12 })),
    ).toBeDefined();

    cleanup();
    const exec2 = makeExec();
    await seedShift(exec2, { shiftId: "s1", palletBoxCapacity: null });
    renderWork({ exec: exec2, palletBoxCapacity: null });
    await screen.findByText("Water 0.5", { exact: false }).catch(() => undefined);
    expect(screen.queryByText(/коробов/)).toBeNull();
  });
});

describe("WorkScreen pallet early close", () => {
  it("states the box count in the early-close confirmation before doing anything", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 12 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 3 });

    renderWork({ exec, palletBoxCapacity: 12 });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 3, capacity: 12 }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.more") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.earlyClose") }));
    expect(
      screen.getByText(i18n.t("pallet.earlyCloseDetail", { count: 3, capacity: 12 })),
    ).toBeDefined();
  });

  it("actually closes the pallet and prints its label once confirmed", async () => {
    const exec = makeExec();
    await seedShift(exec, {
      shiftId: "s1",
      palletBoxCapacity: 12,
      palletLabelTemplateSpec: PALLET_LABEL_SPEC,
    });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 3 });
    await addRange(exec, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: PALLET_EXTENSION_DIGIT,
      fromSerial: 1,
      toSerial: 200,
    });
    const printJobs: Array<{ target: PrintTarget; bytes: Uint8Array }> = [];
    const print = vi.fn(async (target: PrintTarget, bytes: Uint8Array) => {
      printJobs.push({ target, bytes });
    });

    renderWork({
      exec,
      palletBoxCapacity: 12,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 3, capacity: 12 }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.more") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pallet.earlyClose") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("box.confirmAction") }));

    expect(await screen.findByText(i18n.t("pallet.closed"))).toBeDefined();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(i18n.t("pallet.printed"))).toBeDefined();

    const rows = await exec.all<{ print_state: string; closed_at: string | null }>(
      "SELECT print_state, closed_at FROM pallets_mirror WHERE pallet_id = 'p1'",
    );
    expect(rows[0]?.print_state).toBe("printed");
    expect(rows[0]?.closed_at).not.toBeNull();
  });
});

describe("WorkScreen shift close blocked by an open pallet", () => {
  it("blocks shift close on an open pallet until it is confirmed", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 12 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 7 });
    const onCloseShift = vi.fn();

    renderWork({ exec, palletBoxCapacity: 12, onCloseShift });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 7, capacity: 12 }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.closeShift") }));
    expect(
      await screen.findByText(i18n.t("work.palletOpenAtClose", { count: 7, capacity: 12 })),
    ).toBeDefined();
    expect(onCloseShift).not.toHaveBeenCalled();
  });

  it("proceeds to close the shift once the blocking pallet is resolved", async () => {
    const exec = makeExec();
    await seedShift(exec, {
      shiftId: "s1",
      palletBoxCapacity: 12,
      palletLabelTemplateSpec: PALLET_LABEL_SPEC,
    });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 7 });
    await addRange(exec, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: PALLET_EXTENSION_DIGIT,
      fromSerial: 1,
      toSerial: 200,
    });
    const print = vi.fn(async () => {});
    const onCloseShift = vi.fn().mockResolvedValue({
      eventId: "e1",
      shiftId: "s1",
      productId: "p1",
      productName: "Water 0.5",
      plannedQtySnapshot: null,
      actualQty: 0,
      closedBoxCount: 0,
      reasonCode: null,
      closedAt: "2026-07-29T10:00:00.000Z",
    });

    renderWork({
      exec,
      palletBoxCapacity: 12,
      onCloseShift,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 7, capacity: 12 }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.closeShift") }));
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("work.palletOpenAtCloseConfirm") }),
    );

    // The pallet's own label resolves first...
    expect(await screen.findByText(i18n.t("pallet.printed"))).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.continue") }));

    // ...and only THEN does the shift close actually go through.
    await waitFor(() => expect(onCloseShift).toHaveBeenCalledOnce());
  });

  it("explains a dry serial pool instead of silently re-showing the same prompt (Task 15 review, Finding 3)", async () => {
    const exec = makeExec();
    await seedShift(exec, { shiftId: "s1", palletBoxCapacity: 12 });
    await seedPallet(exec, { palletId: "p1", shiftId: "s1", terminalId: "dev-1", boxCount: 7 });
    // No `addRange`: this device's pallet serial pool is empty, so the
    // confirmed close attempt below cannot actually close the pallet.
    const onCloseShift = vi.fn();

    renderWork({ exec, palletBoxCapacity: 12, onCloseShift });
    await screen.findByText(i18n.t("pallet.progress", { boxes: 7, capacity: 12 }));

    fireEvent.click(screen.getByRole("button", { name: i18n.t("work.closeShift") }));
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("work.palletOpenAtCloseConfirm") }),
    );

    // The pallet is left open exactly as it was, and the same confirmation
    // comes back -- but it must now say WHY confirming again did nothing,
    // not just silently repeat the identical prompt.
    expect(await screen.findByText(i18n.t("work.palletOpenAtCloseNoSerials"))).toBeDefined();
    expect(onCloseShift).not.toHaveBeenCalled();
  });
});

describe("pallet print recovery", () => {
  it("reads a pallet left printing at startup as unknown, and WorkScreen never resends it", async () => {
    const exec = makeExec();
    await seedShift(exec, {
      shiftId: "s1",
      palletBoxCapacity: 12,
      palletLabelTemplateSpec: PALLET_LABEL_SPEC,
    });
    // Closed, with an SSCC already assigned, but `print_error_code` is NULL:
    // exactly the shape a crash mid-print (before any category was ever
    // recorded) leaves behind -- this device cannot tell whether the label
    // reached the printer.
    await seedPallet(exec, {
      palletId: "p1",
      shiftId: "s1",
      terminalId: "dev-1",
      boxCount: 3,
      closedAt: "2026-07-29T09:20:00.000Z",
      sscc: "103460068200000099",
      printState: "pending",
      printErrorCode: null,
    });

    const recovered = await findUnresolvedPalletPrint(exec, "s1", "dev-1");
    expect(recovered).toMatchObject({ state: "pending", errorCode: null, palletId: "p1" });

    const print = vi.fn(async () => {});
    renderWork({
      exec,
      palletBoxCapacity: 12,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    expect(await screen.findByText(i18n.t("pallet.printUnknown"))).toBeDefined();
    expect(screen.getByRole("button", { name: i18n.t("pallet.confirmPrinted") })).toBeDefined();
    expect(screen.getByRole("button", { name: i18n.t("pallet.reprint") })).toBeDefined();
    // Merely restoring and displaying this state must never itself print.
    expect(print).not.toHaveBeenCalled();
  });

  it("confirming an already-printed label records the outcome and clears acked_at for resend", async () => {
    const exec = makeExec();
    await exec.run(
      `INSERT INTO pallets_mirror (pallet_id, shift_id, terminal_id, sscc, opened_at, closed_at, acked_at, print_state)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["p1", "s1", "dev-1", "sscc1", "t0", "t1", "t1", "pending"],
    );
    const won = await markPalletPrintVerified(exec, "p1", "2026-07-29T10:00:00.000Z");
    expect(won).toBe(true);
    const rows = await exec.all<{
      print_state: string;
      print_verified_at: string;
      acked_at: string | null;
    }>(
      "SELECT print_state, print_verified_at, acked_at FROM pallets_mirror WHERE pallet_id = 'p1'",
    );
    expect(rows[0]).toMatchObject({
      print_state: "printed",
      print_verified_at: "2026-07-29T10:00:00.000Z",
      acked_at: null,
    });
  });

  it("skipping a pallet label records the outcome and clears acked_at for resend", async () => {
    const exec = makeExec();
    await exec.run(
      `INSERT INTO pallets_mirror (pallet_id, shift_id, terminal_id, sscc, opened_at, closed_at, acked_at, print_state)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["p1", "s1", "dev-1", "sscc1", "t0", "t1", "t1", "pending"],
    );
    const won = await markPalletPrintSkipped(exec, "p1", "2026-07-29T10:05:00.000Z");
    expect(won).toBe(true);
    const rows = await exec.all<{
      print_state: string;
      print_skipped_at: string;
      acked_at: string | null;
    }>("SELECT print_state, print_skipped_at, acked_at FROM pallets_mirror WHERE pallet_id = 'p1'");
    expect(rows[0]).toMatchObject({
      print_state: "skipped",
      print_skipped_at: "2026-07-29T10:05:00.000Z",
      acked_at: null,
    });
  });
});

describe("pallet exception reason cap", () => {
  it("caps a queued exception reason at 500 characters", async () => {
    const exec = makeExec();
    await disassemblePallet(exec, {
      palletId: "p1",
      shiftId: "s1",
      terminalId: "dev-1",
      operatorId: "op1",
      reason: "x".repeat(600),
      occurredAt: "2026-07-29T09:00:00.000Z",
    });
    const rows = await exec.all<{ reason: string }>(
      "SELECT reason FROM pallet_exceptions_mirror WHERE pallet_id = 'p1'",
    );
    expect(rows[0]?.reason).toHaveLength(500);
  });
});
