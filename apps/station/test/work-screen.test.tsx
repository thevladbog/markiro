import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { buildSscc, kmHash, parseKm, type LabelTemplateSpec } from "@markiro/domain";
import i18n from "../src/i18n/index.js";
import { readExceptions, type PendingException } from "../src/lib/box-exceptions-mirror.js";
import type { CloseBoxResult } from "../src/lib/close-box.js";
import { createFloorWorkRegistry, readSealedWorkSummary } from "../src/lib/credential-recovery.js";
import type { PrinterLanguage } from "../src/lib/hardware-config.js";
import type { PrintTarget } from "../src/lib/hardware.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import {
  createKeyboardWedgeSource,
  type ScanListener,
  type ScanSource,
} from "../src/lib/scan-source.js";
import type { ScanQueue } from "../src/lib/scan-queue.js";
import * as signalSound from "../src/lib/signal-sound.js";
import type { SoundSettings } from "../src/lib/signal-sound.js";
import { addRange } from "../src/lib/sscc-pool.js";
import { WorkScreen } from "../src/pages/WorkScreen.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
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

/** Installed-station schema from before durable box-print recovery columns existed. */
function makeLegacyPrintRecoveryExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const stmt of STATION_MIGRATIONS) {
    if (
      stmt.includes("ALTER TABLE boxes_mirror ADD COLUMN print_state") ||
      stmt.includes("ALTER TABLE boxes_mirror ADD COLUMN print_error_code")
    ) {
      continue;
    }
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

/**
 * Same schema, but `all` genuinely round-trips through a microtask before
 * resolving — unlike node:sqlite, which is synchronous under the hood even
 * though the SqlExecutor contract wraps it in a Promise. This widens the
 * mount-time window between the duplicate-index load (`loadCodeKeys`) and
 * the scan source starting to listen, so a scan emitted immediately on
 * mount actually exercises that race instead of it closing before the test
 * can observe it.
 */
function makeAsyncAllExec(): SqlExecutor {
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
    all: async <T,>(sql: string, params: unknown[] = []) => {
      await Promise.resolve();
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

/** Same schema, but every `run()` call throws — simulates a journal write failure. */
function makeThrowingRunExec(): SqlExecutor {
  const base = makeExec();
  return {
    run: async () => {
      throw new Error("disk full");
    },
    all: base.all,
  };
}

/** Same schema, but the FIRST `all()` call rejects — simulates a failed initial key load. */
function makeFailFirstAllExec(): SqlExecutor {
  const base = makeExec();
  let calls = 0;
  return {
    run: base.run,
    all: async <T,>(sql: string, params: unknown[] = []) => {
      calls += 1;
      if (calls === 1) throw new Error("boom: first all() call fails");
      return base.all<T>(sql, params);
    },
  };
}

/** A source the test drives directly. */
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

/** Keeps every subscribed callback so tests can invoke one after its cleanup. */
function retainingSource(): ScanSource & {
  emit: ScanListener;
  firstSubscribed: () => ScanListener;
  latestSubscribed: () => ScanListener;
} {
  let listener: ScanListener = () => {};
  const subscribed: ScanListener[] = [];
  return {
    start(next) {
      listener = next;
      subscribed.push(next);
      return () => {
        if (listener === next) listener = () => {};
      };
    },
    emit: (raw) => listener(raw),
    firstSubscribed() {
      const first = subscribed[0];
      if (!first) throw new Error("scan source has not subscribed yet");
      return first;
    },
    latestSubscribed() {
      const latest = subscribed.at(-1);
      if (!latest) throw new Error("scan source has not subscribed yet");
      return latest;
    },
  };
}

// A valid KM for GTIN 04600000000015 (check digit verified) with serial "5Ab1".
const KM = "0104600000000015215Ab1";

interface RenderWorkScreenOverrides {
  exec?: SqlExecutor;
  shiftId?: string;
  terminalId?: string | null;
  operatorId?: string;
  expectedGtin14?: string;
  productName?: string;
  counterpartyName?: string | null;
  plannedQty?: number | null;
  source?: ScanSource;
  sound?: SoundSettings;
  onScanRecorded?: () => void;
  onScanQueueRegister?: (queue: ScanQueue) => () => void;
  onExit?: () => void;
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
  pendingSync?: number;
}

function renderWorkScreen(overrides: RenderWorkScreenOverrides = {}) {
  const {
    exec = makeExec(),
    shiftId = "s1",
    terminalId = "dev-1",
    operatorId = "operator-1",
    expectedGtin14 = "04600000000015",
    productName = "Water 0.5",
    counterpartyName = null,
    plannedQty,
    source = manualSource(),
    sound = { muted: true, volume: 1 },
    onScanRecorded,
    onScanQueueRegister,
    onExit = () => {},
    onCloseShift,
    pendingSync = 0,
  } = overrides;

  return render(
    <WorkScreen
      exec={exec}
      shiftId={shiftId}
      terminalId={terminalId}
      operatorId={operatorId}
      expectedGtin14={expectedGtin14}
      productName={productName}
      counterpartyName={counterpartyName}
      plannedQty={plannedQty}
      source={source}
      sound={sound}
      {...(onScanRecorded ? { onScanRecorded } : {})}
      {...(onScanQueueRegister ? { onScanQueueRegister } : {})}
      onExit={onExit}
      {...(onCloseShift ? { onCloseShift } : {})}
      pendingSync={pendingSync}
      // None of the tests in this file's outer `describe` care about boxes:
      // `issuerPrefix: null` keeps the whole box section off, exactly like a
      // validation-mode shift, so none of these pre-existing assertions
      // change shape.
      issuerPrefix={null}
      boxCapacity={null}
      verifyPrintedLabel={false}
    />,
  );
}

// A 9-digit GS1 issuer prefix (see sscc-pool.ts's doc comment for why the
// pool is keyed by prefix rather than by GLN) -- the box tests' default,
// standing in for `StationBundle.sscc.issuerPrefix`.
const TEST_ISSUER_PREFIX = "460123456";
const SEEDED_BOX_ID = "seeded-box";

// A second valid KM for the SAME product, distinguished only by serial --
// used where a test needs a fresh, non-duplicate accept after the first.
const OTHER_KM = "0104600000000015215Ab2";
const THIRD_KM = "0104600000000015215Ab3";

const SSCC = buildSscc(0, TEST_ISSUER_PREFIX, 777);
interface RenderWorkOverrides extends RenderWorkScreenOverrides {
  issuerPrefix?: string | null;
  boxCapacity?: number | null;
  bundleRevision?: number;
  /**
   * Test-only seeding: when given (together with a non-null `issuerPrefix`),
   * a box is opened and this many already-accepted codes are named into it
   * BEFORE the component mounts, so `currentBox` finds it already open at
   * exactly this count instead of WorkScreen opening a fresh, empty one.
   */
  boxItemCount?: number;
  closeCurrentBox?: (shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>;
  onScan?: (raw: string) => void;
  verifyPrintedLabel?: boolean;
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  onOpenPrinterSetup?: () => void;
  onPrintRecoveryChange?: (blocked: boolean) => void;
}

// A label spec whose only element resolves to ASCII-only text (the box's
// own sscc field, all digits): `renderTextLikeElement`'s native ZPL/TSPL
// text path only calls the injectable `rasterizeText` for text containing a
// non-ASCII character (see @markiro/domain's `needsImageRendering`), so this
// spec renders successfully even under jsdom, which has no real 2D canvas
// backend and makes the STATION'S real `rasterizeText` always reject (see
// rasterizer.test.ts) -- exactly what a Cyrillic/CJK spec would hit here.
const LABEL_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ id: "a", kind: "field", field: "sscc", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

/**
 * Seeds a minimal `shift_mirror` row carrying `LABEL_SPEC` as the BOX
 * label's own template (`box_label_template_spec`), so WorkScreen's
 * label-geometry effect has something to load for box printing. NOT
 * `label_template_spec` (CodeRabbit PR33 review, Finding 3): that column is
 * the ITEM template, a completely separate field the box-printing path must
 * never read.
 */
async function seedLabelSpec(exec: SqlExecutor, shiftId: string): Promise<void> {
  await exec.run(
    `INSERT INTO shift_mirror (id, status, mode, product_id, box_label_template_spec) VALUES (?,?,?,?,?)`,
    [shiftId, "active", "aggregation", "p1", JSON.stringify(LABEL_SPEC)],
  );
}

const PRINT_TARGET: PrintTarget = { kind: "tcp", host: "10.0.0.5", port: 9100 };

/**
 * Renders `WorkScreen` with box aggregation enabled by default (a non-null
 * `issuerPrefix`), for the box-progress/closing/printing tests. Seeding runs
 * through the SAME `exec` the component receives, straight `INSERT`s against
 * `boxes_mirror`/`codes_mirror` -- not `openBox`/`recordScan` -- because the
 * point is exactly the state those calls would produce, prepared before
 * mount rather than by the component's own effects.
 *
 * Not awaited by callers (matching the brief's own snippets, which call this
 * synchronously): `exec.run`'s underlying node:sqlite write is synchronous
 * (only the Promise wrapper resolves later -- see `makeAsyncAllExec`'s doc
 * comment above), so the seeded rows already exist by the time `render`
 * mounts the component, and every assertion below reaches them through
 * `findBy*`/`waitFor`, which retry rather than assume readiness on the first
 * tick anyway.
 */
function renderWork(overrides: RenderWorkOverrides = {}) {
  const {
    exec = makeExec(),
    shiftId = "s1",
    terminalId = "dev-1",
    operatorId = "operator-1",
    expectedGtin14 = "04600000000015",
    productName = "Water 0.5",
    counterpartyName = null,
    source = manualSource(),
    sound = { muted: true, volume: 1 },
    onScanRecorded,
    onScanQueueRegister,
    onExit = () => {},
    pendingSync = 0,
    issuerPrefix = TEST_ISSUER_PREFIX,
    boxCapacity = null,
    bundleRevision = 0,
    boxItemCount,
    closeCurrentBox,
    onScan,
    verifyPrintedLabel = false,
    printing,
    onOpenPrinterSetup,
    onPrintRecoveryChange,
  } = overrides;

  // Seeded regardless of `issuerPrefix`: the "no sscc block" test needs a
  // box genuinely AT capacity so that a scan reaching it is what would call
  // `closeCurrentBox` if WorkScreen's own `issuerPrefix === null` gating
  // were ever removed -- if seeding here were ALSO gated on `issuerPrefix`,
  // that test's box would never really be near capacity, and the assertion
  // that `close` is never called would pass for the wrong reason.
  if (boxItemCount !== undefined) {
    void exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at) VALUES (?,?,?,?)`,
      [SEEDED_BOX_ID, shiftId, terminalId, "2026-07-29T09:00:00.000Z"],
    );
    for (let i = 0; i < boxItemCount; i++) {
      void exec.run(
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
         VALUES (?,?,?,?,?,?)`,
        [
          `seed-${i}`,
          shiftId,
          expectedGtin14,
          `seed${i}`,
          "2026-07-29T09:00:00.000Z",
          SEEDED_BOX_ID,
        ],
      );
    }
  }

  const screenForRevision = (revision: number) => (
    <WorkScreen
      exec={exec}
      shiftId={shiftId}
      terminalId={terminalId}
      operatorId={operatorId}
      expectedGtin14={expectedGtin14}
      productName={productName}
      counterpartyName={counterpartyName}
      source={source}
      sound={sound}
      {...(onScanRecorded ? { onScanRecorded } : {})}
      {...(onScanQueueRegister ? { onScanQueueRegister } : {})}
      onExit={onExit}
      pendingSync={pendingSync}
      issuerPrefix={issuerPrefix}
      boxCapacity={boxCapacity}
      bundleRevision={revision}
      {...(closeCurrentBox ? { closeCurrentBox } : {})}
      {...(onScan ? { onScan } : {})}
      verifyPrintedLabel={verifyPrintedLabel}
      {...(printing !== undefined ? { printing } : {})}
      {...(onOpenPrinterSetup ? { onOpenPrinterSetup } : {})}
      {...(onPrintRecoveryChange ? { onPrintRecoveryChange } : {})}
    />
  );
  const view = render(screenForRevision(bundleRevision));
  return {
    ...view,
    refreshBundle(revision: number) {
      view.rerender(screenForRevision(revision));
    },
  };
}

describe("WorkScreen", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps sequential scan commit and notification order before presentation extraction", async () => {
    const source = manualSource();
    const base = makeExec();
    const order: string[] = [];
    const exec: SqlExecutor = {
      all: base.all,
      async run(sql, params = []) {
        await base.run(sql, params);
        if (sql.includes("INSERT INTO outbox")) order.push(`commit:${String(params[2])}`);
      },
    };
    renderWorkScreen({
      source,
      exec,
      onScanRecorded: () => order.push("notify"),
    });

    act(() => {
      source.emit(KM);
      source.emit(OTHER_KM);
    });

    await waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual([`commit:${KM}`, "notify", `commit:${OTHER_KM}`, "notify"]);
  });

  it("accepts a valid code, counts it and journals it", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderWorkScreen({ source, exec });

    source.emit(KM);

    await waitFor(async () => {
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
      expect(rows).toHaveLength(1);
    });
    expect(await screen.findByText("1")).toBeDefined();
  });

  it("offers to close or continue once the accepted total reaches the plan", async () => {
    const source = manualSource();
    renderWorkScreen({ source, plannedQty: 1 });

    act(() => source.emit(KM));

    const title = await screen.findByText("Plan completed");
    const prompt = title.closest('[role="alert"]');
    if (!(prompt instanceof HTMLElement)) {
      throw new Error("Plan-reached prompt is not available");
    }
    expect(within(prompt).getByRole("button", { name: "Close shift" })).toBeDefined();
    expect(within(prompt).getByRole("button", { name: "Continue" })).toBeDefined();
  });

  it("returns to shift selection as soon as local shift closing succeeds", async () => {
    const onExit = vi.fn();
    const onCloseShift = vi.fn().mockResolvedValue({
      eventId: "close-1",
      shiftId: "s1",
      productId: "product-1",
      productName: "Water 0.5",
      plannedQtySnapshot: null,
      actualQty: 10,
      closedBoxCount: 2,
      reasonCode: null,
      closedAt: "2026-08-15T20:00:00.000Z",
    });
    renderWorkScreen({ onExit, onCloseShift });

    fireEvent.click(screen.getByRole("button", { name: "Close shift" }));

    await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it("submits shift closing only once when the close control is double-tapped", async () => {
    let finishClose!: (summary: {
      eventId: string;
      shiftId: string;
      productId: string;
      productName: string;
      plannedQtySnapshot: null;
      actualQty: number;
      closedBoxCount: number;
      reasonCode: null;
      closedAt: string;
    }) => void;
    const onCloseShift = vi.fn(
      () =>
        new Promise<{
          eventId: string;
          shiftId: string;
          productId: string;
          productName: string;
          plannedQtySnapshot: null;
          actualQty: number;
          closedBoxCount: number;
          reasonCode: null;
          closedAt: string;
        }>((resolve) => {
          finishClose = resolve;
        }),
    );
    const onExit = vi.fn();
    renderWorkScreen({ onCloseShift, onExit });
    const close = screen.getByRole("button", { name: "Close shift" });

    fireEvent.click(close);
    fireEvent.click(close);

    expect(onCloseShift).toHaveBeenCalledOnce();
    finishClose({
      eventId: "close-1",
      shiftId: "s1",
      productId: "product-1",
      productName: "Water 0.5",
      plannedQtySnapshot: null,
      actualQty: 10,
      closedBoxCount: 2,
      reasonCode: null,
      closedAt: "2026-08-15T20:00:00.000Z",
    });
    await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it("presents accepted scans locally while retaining their success sound", async () => {
    const source = manualSource();
    const playSignalToneSpy = vi.spyOn(signalSound, "playSignalTone");
    renderWorkScreen({ source });

    act(() => source.emit(KM));

    await waitFor(() => {
      expect(playSignalToneSpy).toHaveBeenCalledWith("ok", expect.anything());
      expect(
        screen.getByRole("status").querySelector('[data-semantic="normalized-code"]')?.textContent,
      ).toBe("(01)04600000000015 (21)5Ab1");
    });
    expect(screen.getByRole("status").textContent).not.toContain("ACCEPTED");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the latest accepted code through rejected activity and a remount", async () => {
    const exec = makeExec();
    const source = manualSource();
    const first = renderWorkScreen({ exec, source });

    act(() => source.emit(KM));
    await waitFor(() =>
      expect(
        screen.getByRole("status").querySelector('[data-semantic="normalized-code"]')?.textContent,
      ).toBe("(01)04600000000015 (21)5Ab1"),
    );
    act(() => {
      for (let index = 0; index < 7; index += 1) source.emit(`invalid-${index}`);
    });
    await waitFor(async () => {
      const rows = await exec.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scan_events_mirror WHERE verdict = 'invalid'",
      );
      expect(rows[0]?.n).toBe(7);
    });
    expect(
      screen.getByRole("status").querySelector('[data-semantic="normalized-code"]')?.textContent,
    ).toBe("(01)04600000000015 (21)5Ab1");

    first.unmount();
    renderWorkScreen({ exec, source: manualSource() });
    await waitFor(() =>
      expect(
        screen.getByRole("status").querySelector('[data-semantic="normalized-code"]')?.textContent,
      ).toBe("(01)04600000000015 (21)5Ab1"),
    );
  });

  it("keeps an error verdict visible for exactly 1200 ms", async () => {
    vi.useFakeTimers();
    const source = manualSource();
    renderWorkScreen({ source });

    act(() => source.emit("not-a-code"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").dataset.tone).toBe("error");

    await act(async () => vi.advanceTimersByTimeAsync(1199));
    expect(screen.getByRole("alert").dataset.tone).toBe("error");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a duplicate verdict for exactly 900 ms", async () => {
    vi.useFakeTimers();
    const source = manualSource();
    renderWorkScreen({ source });

    act(() => source.emit(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => source.emit(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").dataset.tone).toBe("duplicate");

    await act(async () => vi.advanceTimersByTimeAsync(899));
    expect(screen.getByRole("alert").dataset.tone).toBe("duplicate");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not let an older timer clear a newer signal", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const source = manualSource();
    renderWorkScreen({ source });

    act(() => source.emit(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    act(() => source.emit(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").dataset.tone).toBe("duplicate");
    const staleCallback = timeoutSpy.mock.calls.find(([, delay]) => delay === 900)?.[0];
    expect(staleCallback).toBeTypeOf("function");
    await act(async () => vi.advanceTimersByTimeAsync(899));

    act(() => source.emit("not-a-code"));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").dataset.tone).toBe("error");
    act(() => staleCallback?.());
    expect(screen.getByRole("alert").dataset.tone).toBe("error");

    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps visual rejection feedback visible when sound is muted", async () => {
    const source = manualSource();
    renderWorkScreen({ source, sound: { muted: true, volume: 1 } });

    act(() => source.emit("not-a-code"));

    const alert = await screen.findByRole("alert");
    expect(alert.dataset.tone).toBe("error");
    expect(alert.textContent).toContain("WRONG CODE");
  });

  it("uses the same error tone for the visual overlay and audible verdict", async () => {
    const frequencies: number[] = [];
    const context = {
      currentTime: 0,
      destination: {},
      state: "running",
      resume: vi.fn(async () => {}),
      createOscillator: () => ({
        type: "",
        frequency: {
          setValueAtTime: (frequency: number) => frequencies.push(frequency),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createGain: () => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }),
    } as unknown as AudioContext;
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function AudioContextStub() {
        return context;
      }),
    );
    const source = manualSource();
    renderWorkScreen({ source, sound: { muted: false, volume: 1 } });

    act(() => source.emit("not-a-code"));

    const alert = await screen.findByRole("alert");
    expect(alert.dataset.tone).toBe("error");
    expect(frequencies).toEqual([220]);
    vi.unstubAllGlobals();
  });

  it("renders the fixed instrument split with a bounded recent list and footer actions", async () => {
    const source = manualSource();
    const view = renderWorkScreen({ source });

    expect(view.container.querySelector(".work-screen__instruments")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Recent operations" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Exceptions" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Close shift" })).toBeDefined();
  });

  it("coalesces a scan burst into one active and one trailing recent read without delaying commits", async () => {
    const source = manualSource();
    const base = makeExec();
    let recentReads = 0;
    let activeRecentReads = 0;
    let maxActiveRecentReads = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const order: string[] = [];
    const exec: SqlExecutor = {
      async run(sql, params = []) {
        await base.run(sql, params);
        if (sql.includes("INSERT INTO outbox")) order.push(`commit:${String(params[2])}`);
      },
      async all<T>(sql: string, params: unknown[] = []) {
        if (sql.includes("FROM scan_events_mirror") && sql.includes("LIMIT ?")) {
          recentReads += 1;
          if (recentReads > 1) {
            activeRecentReads += 1;
            maxActiveRecentReads = Math.max(maxActiveRecentReads, activeRecentReads);
            await refreshGate;
            activeRecentReads -= 1;
          }
        }
        return base.all<T>(sql, params);
      },
    };
    const onScanRecorded = vi.fn(() => order.push("notify"));
    renderWorkScreen({ source, exec, onScanRecorded });
    await waitFor(() => expect(recentReads).toBe(1));
    const burst = Array.from({ length: 6 }, (_, index) => `0104600000000015215Burst${index + 1}`);

    act(() => {
      for (const raw of burst) source.emit(raw);
    });

    await waitFor(() => expect(onScanRecorded).toHaveBeenCalledTimes(burst.length));
    expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(burst.length);
    expect(order).toEqual(burst.flatMap((raw) => [`commit:${raw}`, "notify"]));
    expect(recentReads).toBe(2);
    expect(maxActiveRecentReads).toBe(1);

    releaseRefresh();
    await waitFor(() => expect(recentReads).toBe(3));
    await waitFor(() => expect(activeRecentReads).toBe(0));
  });

  it("drops a queued trailing recent read when the work screen unmounts", async () => {
    const source = manualSource();
    const base = makeExec();
    let recentReads = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const exec: SqlExecutor = {
      run: base.run,
      async all<T>(sql: string, params: unknown[] = []) {
        if (sql.includes("FROM scan_events_mirror") && sql.includes("LIMIT ?")) {
          recentReads += 1;
          if (recentReads > 1) await refreshGate;
        }
        return base.all<T>(sql, params);
      },
    };
    const onScanRecorded = vi.fn();
    const view = renderWorkScreen({ source, exec, onScanRecorded });
    await waitFor(() => expect(recentReads).toBe(1));

    act(() => {
      source.emit(KM);
      source.emit(OTHER_KM);
    });
    await waitFor(() => expect(onScanRecorded).toHaveBeenCalledTimes(2));
    expect(recentReads).toBe(2);

    view.unmount();
    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recentReads).toBe(2);
  });

  it("keeps an unmounted queue registered until an accepted scan write becomes idle", async () => {
    const source = manualSource();
    const base = makeExec();
    let releaseOutbox!: () => void;
    let announceOutbox!: () => void;
    const outboxGate = new Promise<void>((resolve) => {
      releaseOutbox = resolve;
    });
    const outboxReached = new Promise<void>((resolve) => {
      announceOutbox = resolve;
    });
    const exec: SqlExecutor = {
      all: base.all,
      async run(sql, params = []) {
        if (sql.includes("INSERT INTO outbox")) {
          announceOutbox();
          await outboxGate;
        }
        await base.run(sql, params);
      },
    };
    const registered = new Set<ScanQueue>();
    const view = renderWorkScreen({
      source,
      exec,
      onScanQueueRegister(queue) {
        registered.add(queue);
        return () => registered.delete(queue);
      },
    });

    act(() => source.emit(KM));
    await outboxReached;
    view.unmount();
    expect(registered.size).toBe(1);

    releaseOutbox();
    await Promise.all([...registered].map((queue) => queue.idle()));
    await waitFor(() => expect(registered.size).toBe(0));
    expect(await exec.all("SELECT raw FROM outbox")).toHaveLength(1);
  });

  it("flags the second scan of the same code as a duplicate", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderWorkScreen({ source, exec });

    source.emit(KM);
    await screen.findByText("1");
    source.emit(KM);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("duplicate"));
    const codes = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
    expect(codes).toHaveLength(1); // not stored twice

    // Every scan is journalled regardless of verdict — including duplicates.
    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id DESC LIMIT 1",
    );
    expect(events[0]?.verdict).toBe("duplicate");
  });

  it("rejects a code belonging to another product", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderWorkScreen({ source, exec });

    source.emit("0104600000000022215Ab1"); // different GTIN
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));

    // Every scan is journalled regardless of verdict — including rejections.
    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id DESC LIMIT 1",
    );
    expect(events[0]?.verdict).toBe("wrong_gtin");
  });

  it("rejects unparseable input", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderWorkScreen({ source, exec });

    source.emit("not-a-code");
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));
  });

  it("judges a scan emitted at mount time against the loaded index, not an empty one", async () => {
    const source = manualSource();
    const exec = makeAsyncAllExec();
    // Seed the mirror as if this exact code was already accepted in an
    // earlier session — the scenario the mount-time race would misjudge.
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at)
       VALUES (?,?,?,?,?)`,
      [kmHash(parseKm(KM)), "earlier-shift", "04600000000015", "5Ab1", new Date(0).toISOString()],
    );

    renderWorkScreen({ source, exec });
    // Emitted synchronously right after mount, before the async loadCodeKeys()
    // round trip can resolve — exactly the window in which the bug validated
    // against an empty in-memory index and silently dropped the scan.
    source.emit(KM);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("duplicate"));

    // Still exactly the one pre-seeded row: not re-inserted (which would mean
    // it was wrongly accepted), and journalled rather than silently dropped.
    const codes = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
    expect(codes).toHaveLength(1);
    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id DESC LIMIT 1",
    );
    expect(events[0]?.verdict).toBe("duplicate");
  });

  it("shows the shift's product and the tolling customer", async () => {
    const source = manualSource();
    renderWorkScreen({ source, counterpartyName: "Plant X" });
    expect(screen.getByText("Water 0.5")).toBeDefined();
    expect(screen.getByText(/Plant X/)).toBeDefined();
  });

  it("shows the system-error signal and counts the scan as rejected when the journal write throws", async () => {
    const source = manualSource();
    const exec = makeThrowingRunExec();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWorkScreen({ source, exec });
    source.emit(KM);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));
    expect(alert.textContent).toContain("WRITE FAILED");
    expect(await screen.findByText("1")).toBeDefined(); // rejected counter, not accepted

    expect(consoleError).toHaveBeenCalled();
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain("station: scan write failed");
    expect(logged).toContain("journal_write");
    expect(logged).not.toContain(KM);
    expect(logged).not.toContain("disk full");
    consoleError.mockRestore();
  });

  it("keeps scanning after the initial code-key load fails, instead of losing every later scan", async () => {
    const source = manualSource();
    const exec = makeFailFirstAllExec();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWorkScreen({ source, exec });
    source.emit(KM);

    await waitFor(async () => {
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
      expect(rows).toHaveLength(1);
    });
    expect(await screen.findByText("1")).toBeDefined(); // accepted counter

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("leaves the shift immediately when nothing is queued", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 0 });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("warns about queued scans before leaving, and leaves anyway on confirm", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 12 });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByText("12 scans have not reached the server yet.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stays on the shift when the operator cancels", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 12 });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it("blurs the leave-shift control after activation, so it cannot hold focus while scanning continues", async () => {
    // A tap leaves a native <button> focused in Chromium-based webviews. If it
    // stayed focused here, the terminating Enter of the operator's NEXT scan
    // (which the keyboard wedge cannot tell apart from any other keydown)
    // would fire a native click on this still-focused button while the
    // confirmation is up — re-running requestExit() with the queue possibly
    // now drained and exiting with no operator decision.
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 12 });

    const exitButton = screen.getByRole("button", { name: "Pause" });
    exitButton.focus();
    expect(document.activeElement).toBe(exitButton);

    fireEvent.click(exitButton);

    expect(document.activeElement).not.toBe(exitButton);
  });

  it("uses the singular pending-scan copy when exactly one scan is queued", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("1 scan has not reached the server yet.")).toBeDefined();
  });
});

describe("WorkScreen box progress, closing and printing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // This whole block's copy is the box UI's -- Russian regardless of the
  // outer describe's "en" (see the floor rule in Task 13's brief: "Copy is
  // Russian"). i18n's own default is "ru" (src/i18n/index.ts), so switching
  // here and back afterward is what makes these assertions meaningful
  // without disturbing the outer block's English ones.
  beforeAll(async () => {
    await i18n.changeLanguage("ru");
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  let activeSource: (ScanSource & { emit: ScanListener }) | null = null;

  /** Emits on whichever source the most recent `renderWork` call is using. */
  function scan(raw: string): void {
    if (!activeSource) throw new Error("renderWork must be called before scan()");
    activeSource.emit(raw);
  }

  function renderWorkTracked(overrides: RenderWorkOverrides = {}) {
    const source = overrides.source ?? manualSource();
    activeSource = source as ScanSource & { emit: ScanListener };
    return renderWork({ ...overrides, source });
  }

  async function seedClosedBox(
    exec: SqlExecutor,
    boxId = "closed-box",
    sscc = SSCC,
  ): Promise<void> {
    await exec.run(
      `INSERT INTO boxes_mirror
         (box_id, shift_id, terminal_id, sscc, opened_at, closed_at)
       VALUES (?,?,?,?,?,?)`,
      [boxId, "s1", "dev-1", sscc, "2026-07-29T08:00:00.000Z", "2026-07-29T09:00:00.000Z"],
    );
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
       VALUES (?,?,?,?,?,?)`,
      [`code-${boxId}`, "s1", "04600000000015", "serial", "2026-07-29T08:30:00.000Z", boxId],
    );
  }

  async function seedPendingPrint(
    exec: SqlExecutor,
    errorCode: string | null = null,
    state: "pending" | "printed" = "pending",
  ): Promise<void> {
    await seedLabelSpec(exec, "s1");
    await exec.run("UPDATE shift_mirror SET issuer_prefix = ? WHERE id = ?", [
      TEST_ISSUER_PREFIX,
      "s1",
    ]);
    await exec.run(
      `INSERT INTO boxes_mirror
         (box_id, shift_id, terminal_id, sscc, opened_at, closed_at, print_state, print_error_code)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        SEEDED_BOX_ID,
        "s1",
        "dev-1",
        SSCC,
        "2026-07-29T08:00:00.000Z",
        "2026-07-29T09:00:00.000Z",
        state,
        errorCode,
      ],
    );
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
       VALUES (?,?,?,?,?,?)`,
      [
        "pending-code",
        "s1",
        "04600000000015",
        "pending",
        "2026-07-29T08:30:00.000Z",
        SEEDED_BOX_ID,
      ],
    );
  }

  function readExceptionFacts(exec: SqlExecutor): Promise<PendingException[]> {
    return readExceptions(exec, 100);
  }

  it("undoes the last accepted scan in the open box and queues its exception", async () => {
    const exec = makeExec();
    renderWorkTracked({ exec, boxItemCount: 0 });

    act(() => scan(KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(1);
    });
    const target = (
      await exec.all<{ code_hash: string; scanned_at: string; box_id: string }>(
        "SELECT code_hash, scanned_at, box_id FROM codes_mirror",
      )
    )[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Отменить последний скан" }));

    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(0);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Вернуться к работе" }));
    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    expect(
      (screen.getByRole("button", { name: "Отменить последний скан" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(await readExceptionFacts(exec)).toEqual([
      {
        id: expect.any(Number),
        kind: "undo",
        boxId: target.box_id,
        codeHash: target.code_hash,
        targetScannedAt: target.scanned_at,
        shiftId: "s1",
        terminalId: "dev-1",
        operatorId: "operator-1",
        reason: null,
        at: expect.any(String),
      },
    ]);
    expect(
      await exec.all("SELECT box_id FROM boxes_mirror WHERE box_id = ? AND closed_at IS NULL", [
        target.box_id,
      ]),
    ).toHaveLength(1);
  });

  it("clears every scan from the open box only after confirmation", async () => {
    const exec = makeExec();
    const onScan = vi.fn();
    renderWorkTracked({ exec, boxItemCount: 0, onScan });

    act(() => scan(KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(1);
    });
    act(() => scan(OTHER_KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Очистить короб" }));
    act(() => scan(THIRD_KM));
    expect(onScan).toHaveBeenCalledTimes(2);
    expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "Подтвердить очистку" }));

    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(0);
    });
    expect(await readExceptionFacts(exec)).toEqual([
      {
        id: expect.any(Number),
        kind: "clear",
        boxId: SEEDED_BOX_ID,
        codeHash: null,
        targetScannedAt: null,
        shiftId: "s1",
        terminalId: "dev-1",
        operatorId: "operator-1",
        reason: null,
        at: expect.any(String),
      },
    ]);
    expect(
      await exec.all(
        "SELECT box_id FROM boxes_mirror WHERE box_id = ? AND closed_at IS NULL AND sscc IS NULL",
        [SEEDED_BOX_ID],
      ),
    ).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Вернуться к работе" }));
    act(() => scan(KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(1);
    });
  });

  it("reprints a closed box and queues the supplied reason for sync", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    await seedLabelSpec(exec, "s1");
    const boxBefore = await exec.all<Record<string, unknown>>(
      "SELECT * FROM boxes_mirror WHERE box_id = 'closed-box'",
    );
    const codesBefore = await exec.all<Record<string, unknown>>(
      "SELECT * FROM codes_mirror WHERE box_id = 'closed-box' ORDER BY code_hash",
    );
    const print = vi.fn().mockResolvedValue(undefined);
    const onScanRecorded = vi.fn();
    renderWorkTracked({
      exec,
      printing: { target: PRINT_TARGET, language: "zpl", print },
      onScanRecorded,
    });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    const reprintAction = await screen.findByRole("button", { name: "Перепечатать этикетку" });
    await waitFor(() => expect((reprintAction as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reprintAction);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`SSCC ${SSCC}`) }));
    fireEvent.click(screen.getByRole("button", { name: "Другая причина" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Замятие этикетки" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Использовать причину" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить перепечатку" }));

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await waitFor(async () => {
      expect(await readExceptionFacts(exec)).toEqual([
        {
          id: expect.any(Number),
          kind: "reprint",
          boxId: "closed-box",
          codeHash: null,
          targetScannedAt: null,
          shiftId: "s1",
          terminalId: "dev-1",
          operatorId: "operator-1",
          reason: "Замятие этикетки",
          at: expect.any(String),
        },
      ]);
    });
    expect(
      await exec.all<Record<string, unknown>>(
        "SELECT * FROM boxes_mirror WHERE box_id = 'closed-box'",
      ),
    ).toEqual(boxBefore);
    expect(
      await exec.all<Record<string, unknown>>(
        "SELECT * FROM codes_mirror WHERE box_id = 'closed-box' ORDER BY code_hash",
      ),
    ).toEqual(codesBefore);
    expect(onScanRecorded).toHaveBeenCalledOnce();
  });

  it("pauses ordinary scanning while the exception flow is open", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    const onScan = vi.fn();
    renderWorkTracked({ exec, onScan });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    act(() => scan(KM));
    expect(onScan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    act(() => scan(KM));
    await waitFor(() => expect(onScan).toHaveBeenCalledOnce());
  });

  it("drops a stale physical-source callback after the exception screen commits", async () => {
    const exec = makeExec();
    const source = retainingSource();
    const onScan = vi.fn();
    let registeredQueue: ScanQueue | null = null;
    renderWorkTracked({
      exec,
      source,
      onScan,
      onScanQueueRegister(queue) {
        registeredQueue = queue;
        return () => {};
      },
    });
    await waitFor(() => expect(registeredQueue).not.toBeNull());
    const staleCallback = source.latestSubscribed();

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    act(() => staleCallback(KM));
    await act(async () => {
      await registeredQueue!.idle();
    });

    expect(onScan).not.toHaveBeenCalled();
    expect(await exec.all("SELECT * FROM outbox")).toHaveLength(0);
  });

  it("orders a confirmed UI correction behind work already accepted by the current scan queue", async () => {
    const exec = makeExec();
    let registeredQueue: ScanQueue | null = null;
    renderWorkTracked({
      exec,
      boxItemCount: 0,
      onScanQueueRegister(queue) {
        registeredQueue = queue;
        return () => {};
      },
    });
    await waitFor(() => expect(registeredQueue).not.toBeNull());

    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    expect(registeredQueue!.enqueueJob(() => blocker)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Очистить короб" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить очистку" }));
    await act(async () => Promise.resolve());
    expect(await readExceptionFacts(exec)).toHaveLength(0);

    releaseBlocker();
    await act(async () => {
      await registeredQueue!.idle();
    });
    expect((await readExceptionFacts(exec)).map((fact) => fact.kind)).toEqual(["clear"]);
  });

  it("disassembles a closed box, removes its codes and refreshes the panel", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    const onScanRecorded = vi.fn();
    renderWorkTracked({ exec, onScanRecorded });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    const disassembleAction = await screen.findByRole("button", { name: "Расформировать короб" });
    await waitFor(() => expect((disassembleAction as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(disassembleAction);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`SSCC ${SSCC}`) }));
    fireEvent.click(screen.getByRole("button", { name: "Другая причина" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Чужой заказ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Использовать причину" }));
    fireEvent.click(screen.getByRole("button", { name: "Расформировать безвозвратно" }));

    await waitFor(async () => {
      const rows = await exec.all<{ disassembled_at: string | null }>(
        "SELECT disassembled_at FROM boxes_mirror WHERE box_id = 'closed-box'",
      );
      expect(rows[0]?.disassembled_at).not.toBeNull();
      expect(
        await exec.all("SELECT code_hash FROM codes_mirror WHERE box_id = 'closed-box'"),
      ).toHaveLength(0);
    });
    expect(screen.queryByText(`SSCC ${SSCC}`)).toBeNull();
    expect(await readExceptionFacts(exec)).toEqual([
      {
        id: expect.any(Number),
        kind: "disassemble",
        boxId: "closed-box",
        codeHash: null,
        targetScannedAt: null,
        shiftId: "s1",
        terminalId: "dev-1",
        operatorId: "operator-1",
        reason: "Чужой заказ",
        at: expect.any(String),
      },
    ]);
    expect(onScanRecorded).toHaveBeenCalledOnce();
  });

  it("shows how full the open box is", async () => {
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 3 });
    // No jest-dom matcher in this project's setup (see WorkstationSetup's
    // own tests), so assert the DOM text directly.
    expect((await screen.findByTestId("box-progress")).textContent).toBe("3 / 10");
  });

  it("shows the persisted terminal-local box ordinal after remount", async () => {
    const exec = makeExec();
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at, closed_at)
       VALUES (?,?,?,?,?)`,
      ["closed-box", "s1", "dev-1", "2026-07-29T08:00:00.000Z", "2026-07-29T08:30:00.000Z"],
    );
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at)
       VALUES (?,?,?,?)`,
      ["current-box", "s1", "dev-1", "2026-07-29T09:00:00.000Z"],
    );
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at)
       VALUES (?,?,?,?)`,
      ["other-terminal-box", "s1", "dev-2", "2026-07-29T07:00:00.000Z"],
    );

    const first = renderWorkTracked({ exec, boxCapacity: 20 });
    expect(await screen.findByRole("heading", { name: "Короб № 2" })).toBeDefined();
    first.unmount();

    renderWorkTracked({ exec, boxCapacity: 20 });
    expect(await screen.findByRole("heading", { name: "Короб № 2" })).toBeDefined();
  });

  it.each([
    { persistedTerminalId: "old-terminal", label: "re-enrolled" },
    { persistedTerminalId: null, label: "nullable legacy" },
  ])(
    "uses the $label box's persisted terminal identity instead of rendering ordinal zero",
    async ({ persistedTerminalId }) => {
      const exec = makeExec();
      await exec.run(
        `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at, closed_at)
         VALUES (?,?,?,?,?)`,
        [
          "previous-box",
          "s1",
          persistedTerminalId,
          "2026-07-29T08:00:00.000Z",
          "2026-07-29T08:30:00.000Z",
        ],
      );
      await exec.run(
        `INSERT INTO boxes_mirror (box_id, shift_id, terminal_id, opened_at)
         VALUES (?,?,?,?)`,
        ["current-box", "s1", persistedTerminalId, "2026-07-29T09:00:00.000Z"],
      );

      renderWorkTracked({ exec, terminalId: "new-terminal", boxCapacity: 20 });

      expect(await screen.findByRole("heading", { name: "Короб № 2" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Короб № 0" })).toBeNull();
    },
  );

  it("closes the box automatically when it reaches capacity", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("lets the operator close a partial box", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 3 });
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 3, closeCurrentBox: close });
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть короб" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("keeps a delayed manual close inside the recovery work barrier", async () => {
    const base = makeExec();
    await addRange(base, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 5,
    });
    let releaseClose!: () => void;
    let announceClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeReached = new Promise<void>((resolve) => {
      announceClose = resolve;
    });
    const exec: SqlExecutor = {
      all: base.all,
      async run(sql, params = []) {
        if (sql.includes("SET sscc = ?, closed_at = ?")) {
          announceClose();
          await closeGate;
        }
        await base.run(sql, params);
      },
    };
    const registry = createFloorWorkRegistry();
    const view = renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 3,
      onScanQueueRegister: (queue) => registry.register(queue),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть короб" }));
    await closeReached;
    view.unmount();
    const summary = readSealedWorkSummary(exec, registry.current(), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseClose();

    await expect(summary).resolves.toMatchObject({ boxes: 1, total: 1 });
  });

  // Task 13 review, Finding 2: a double-tap (or a tap racing an auto-close
  // triggered by the same accepted scan) used to run `closeCurrentBox`
  // twice before either finished -- both burn a serial and print, and the
  // box's stored SSCC ends up as whichever write lands second.
  it("guards the manual close button against a double-tap that would burn two serials", async () => {
    let resolveClose: ((result: CloseBoxResult) => void) | undefined;
    const close = vi.fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>(
      () =>
        new Promise<CloseBoxResult>((resolve) => {
          resolveClose = resolve;
        }),
    );
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 3, closeCurrentBox: close });
    const button = (await screen.findByRole("button", {
      name: "Закрыть короб",
    })) as HTMLButtonElement;

    fireEvent.click(button);
    // A second tap while the first close is still in flight.
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(close).toHaveBeenCalledTimes(1);

    resolveClose?.({ status: "closed", sscc: SSCC, itemCount: 3 });
    expect(await screen.findByText("Для смены не выбран шаблон этикетки короба")).toBeDefined();
    // The closed box now remains blocked on durable print recovery, and the
    // original action cannot burn a second serial behind that dialog.
    expect(button.disabled).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("blocks on serial exhaustion until the operator uses a floor-sized recovery action", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "no-serials" });
    const onScan = vi.fn();
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close, onScan });
    act(() => scan(KM));
    const dialog = await screen.findByRole("dialog", {
      name: /номера для коробов закончились/i,
    });
    const action = screen.getByRole("button", { name: "Вернуться к работе" });
    expect(action.style.height).toBe("var(--control-floor)");

    act(() => scan(OTHER_KM));
    await act(async () => Promise.resolve());
    expect(onScan).toHaveBeenCalledTimes(1);

    fireEvent.click(action);
    expect(dialog.isConnected).toBe(false);
    act(() => scan(OTHER_KM));
    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(2));
  });

  it("discards a keyboard-wedge scan and suppresses its terminating Enter while serial recovery owns focus", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "no-serials" });
    const source = createKeyboardWedgeSource(window);
    const onScan = vi.fn();
    renderWorkTracked({ source, boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close, onScan });

    act(() => {
      for (const key of KM) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    });
    const dialog = await screen.findByRole("dialog", {
      name: /номера для коробов закончились/i,
    });
    const action = screen.getByRole("button", { name: "Вернуться к работе" });
    action.focus();
    expect(document.activeElement).toBe(action);

    const terminatingEnter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    act(() => {
      for (const key of OTHER_KM) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      window.dispatchEvent(terminatingEnter);
    });

    expect(terminatingEnter.defaultPrevented).toBe(true);
    expect(dialog.isConnected).toBe(true);
    expect(onScan).toHaveBeenCalledTimes(1);

    fireEvent.click(action);
    expect(dialog.isConnected).toBe(false);
  });

  // CodeRabbit PR33 review, Finding 4: `closeCurrentBox` used to only ever
  // resolve to "closed" | "no-serials" | "empty" -- a burned serial that
  // `buildSscc` could not turn into a valid SSCC (an over-capacity pool
  // range) had no status of its own and, before close-box.ts's fix, threw
  // uncaught. WorkScreen's own try/catch around `impl(...)` only ever
  // logged that via `console.error` and returned silently -- the operator
  // saw nothing at all. This pins the operator-visible half of the fix: the
  // new "invalid-serial" status must surface a real message, and scanning
  // must keep working (this is not a fatal state).
  it("says plainly that a box number could not be built, and keeps accepting scans", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "invalid-serial" });
    const onScan = vi.fn();
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close, onScan });
    act(() => scan(KM));
    await waitFor(() =>
      expect(screen.getByText(/не удалось сформировать номер короба/i)).toBeDefined(),
    );
    act(() => scan(OTHER_KM));
    await waitFor(() => expect(onScan).toHaveBeenCalledTimes(2));
  });

  it("times an invalid box serial out as an ordinary 1200 ms error", async () => {
    vi.useFakeTimers();
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "invalid-serial" });
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 9, closeCurrentBox: close });

    act(() => scan(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").textContent).toContain("Не удалось сформировать номер короба");

    await act(async () => vi.advanceTimersByTimeAsync(1199));
    expect(screen.getByRole("alert")).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not prompt for verification when the setting is off", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    renderWorkTracked({
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: false,
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull();
  });

  it("drops a stale source callback after an immediately successful print with verification off", async () => {
    const base = makeExec();
    await seedPendingPrint(base, "transport_failed");
    const source = retainingSource();
    const print = vi.fn(async () => {});
    let armed = false;
    let injected = false;
    let staleCallback: ScanListener = () => {};
    const exec: SqlExecutor = {
      run: base.run,
      all: async <T,>(sql: string, params: unknown[] = []) => {
        if (armed && !injected && sql.includes("b.closed_at IS NULL")) {
          injected = true;
          staleCallback(OTHER_KM);
        }
        return base.all<T>(sql, params);
      },
    };

    renderWorkTracked({
      exec,
      source,
      verifyPrintedLabel: false,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    await screen.findByText("Принтер не принял задание");
    staleCallback = source.firstSubscribed();
    armed = true;
    fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await waitFor(() => expect(injected).toBe(true));
    await act(async () => Promise.resolve());

    expect(
      await base.all("SELECT raw FROM scan_events_mirror WHERE raw = ?", [OTHER_KM]),
    ).toHaveLength(0);
    expect(await base.all("SELECT raw FROM outbox WHERE raw = ?", [OTHER_KM])).toHaveLength(0);
  });

  // Task 13 review, Finding 3: opening the print-unavailable notice used to
  // depend on `verifyPrintedLabel` being on -- so in the DEFAULT
  // configuration (verification off), a box that closed with no printer
  // configured burned a serial and printed nothing, with only a
  // `console.error` to show for it. Whether printing happened at all must be
  // visible regardless of whether a successful print would go on to be
  // verified.
  it("keeps missing-printer recovery persistent with the complete SSCC and blocks scans", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const source = manualSource();
    const onScan = vi.fn();
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      source,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: false,
      onScan,
      // No `printing` prop at all -- the "no printer configured" state.
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText("Принтер не настроен")).toBeDefined();
    expect(screen.getByText(SSCC)).toBeDefined();
    expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull();
    act(() => source.emit(OTHER_KM));
    await act(async () => Promise.resolve());
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("restores a pending print, opens setup, retries the same SSCC, and explicitly confirms skip", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, "transport_failed");
    const source = manualSource();
    const onScan = vi.fn();
    const onSetup = vi.fn();
    const recovery = vi.fn();
    const print = vi.fn(async () => {
      throw new Error("offline printer detail");
    });
    renderWorkTracked({
      exec,
      source,
      onScan,
      onOpenPrinterSetup: onSetup,
      onPrintRecoveryChange: recovery,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    expect(await screen.findByText("Принтер не принял задание")).toBeDefined();
    expect(screen.getByText(SSCC)).toBeDefined();
    expect(recovery).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Настроить принтер" }));
    expect(onSetup).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(screen.getByText(SSCC)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
    expect(screen.getByText(/короб уже закрыт/i)).toBeDefined();
    act(() => source.emit(KM));
    await act(async () => Promise.resolve());
    expect(onScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Принтер не принял задание")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить продолжение" }));
    await waitFor(async () => {
      const rows = await exec.all<{ print_state: string }>(
        "SELECT print_state FROM boxes_mirror WHERE box_id = ?",
        [SEEDED_BOX_ID],
      );
      expect(rows[0]?.print_state).toBe("skipped");
    });
    await waitFor(() => expect(recovery).toHaveBeenLastCalledWith(false));
    act(() => source.emit(KM));
    await waitFor(() => expect(onScan).toHaveBeenCalledOnce());
  });

  it("restores a category-less pending print as interrupted work, not a transport failure", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, null);

    renderWorkTracked({
      exec,
      printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
    });

    expect(
      await screen.findByText("Печать была прервана. Проверьте принтер и повторите печать."),
    ).toBeDefined();
    expect(screen.queryByText("Принтер не принял задание")).toBeNull();
    expect(screen.getByText(SSCC)).toBeDefined();
  });

  it("keeps a backfilled active shift sealed on the same pending box and SSCC", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, null);
    await exec.run("UPDATE shift_mirror SET box_label_template_spec = NULL WHERE id = ?", ["s1"]);
    await exec.run("UPDATE shift_mirror SET box_label_template_spec = ? WHERE id = ?", [
      JSON.stringify(LABEL_SPEC),
      "s1",
    ]);
    const factsBefore = JSON.stringify({
      boxes: await exec.all("SELECT * FROM boxes_mirror ORDER BY box_id"),
      codes: await exec.all("SELECT * FROM codes_mirror ORDER BY code_hash"),
      journal: await exec.all("SELECT * FROM scan_events_mirror ORDER BY id"),
      outbox: await exec.all("SELECT * FROM outbox ORDER BY id"),
    });
    const source = manualSource();
    const onScan = vi.fn();

    renderWorkTracked({ exec, source, onScan });

    expect(
      await screen.findByText("Печать была прервана. Проверьте принтер и повторите печать."),
    ).toBeDefined();
    expect(screen.getByText(SSCC)).toBeDefined();
    act(() => source.emit(OTHER_KM));
    await act(async () => Promise.resolve());
    expect(onScan).not.toHaveBeenCalled();
    expect(
      JSON.stringify({
        boxes: await exec.all("SELECT * FROM boxes_mirror ORDER BY box_id"),
        codes: await exec.all("SELECT * FROM codes_mirror ORDER BY code_hash"),
        journal: await exec.all("SELECT * FROM scan_events_mirror ORDER BY id"),
        outbox: await exec.all("SELECT * FROM outbox ORDER BY id"),
      }),
    ).toBe(factsBefore);
  });

  it("shows a blocking retry when print-recovery hydration fails", async () => {
    const base = makeExec();
    await seedPendingPrint(base, "transport_failed");
    let hydrationAttempts = 0;
    const exec: SqlExecutor = {
      run: base.run,
      all: async <T,>(sql: string, params: unknown[] = []) => {
        if (sql.includes("JOIN shift_mirror s")) {
          hydrationAttempts += 1;
          if (hydrationAttempts === 1) throw new Error("sqlite temporarily unavailable");
        }
        return base.all<T>(sql, params);
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({ exec });

      expect(
        await screen.findByRole("dialog", { name: "Не удалось восстановить состояние печати" }),
      ).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Повторить восстановление" }));

      expect(await screen.findByText("Принтер не принял задание")).toBeDefined();
      expect(hydrationAttempts).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("repairs an interrupted local migration before retrying print recovery", async () => {
    const base = makeLegacyPrintRecoveryExec();
    await seedLabelSpec(base, "s1");
    let releaseMigration: (() => void) | undefined;
    const migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    let migrationStarts = 0;
    const exec: SqlExecutor = {
      all: base.all,
      async run(sql, params = []) {
        if (sql.includes("CREATE TABLE IF NOT EXISTS station_meta")) {
          migrationStarts += 1;
          await migrationGate;
        }
        await base.run(sql, params);
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({ exec });
      expect(
        await screen.findByRole("dialog", { name: "Не удалось восстановить состояние печати" }),
      ).toBeDefined();

      const retry = screen.getByRole("button", { name: "Повторить восстановление" });
      fireEvent.click(retry);
      fireEvent.click(retry);

      expect(
        (await screen.findByRole("button", { name: "Выполняем…" })) as HTMLButtonElement,
      ).toHaveProperty("disabled", true);
      expect(migrationStarts).toBe(1);
      releaseMigration?.();

      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Не удалось восстановить состояние печати" }),
        ).toBeNull(),
      );
      const columns = await base.all<{ name: string }>("PRAGMA table_info(boxes_mirror)");
      expect(columns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["print_state", "print_error_code"]),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns to the shift list without changing unresolved print work", async () => {
    const base = makeExec();
    await seedPendingPrint(base, "transport_failed");
    const onExit = vi.fn();
    const exec: SqlExecutor = {
      run: base.run,
      async all<T>(sql: string, params: unknown[] = []) {
        if (sql.includes("JOIN shift_mirror s")) throw new Error("sqlite unavailable");
        return base.all<T>(sql, params);
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({ exec, onExit });
      await screen.findByRole("dialog", { name: "Не удалось восстановить состояние печати" });

      fireEvent.click(screen.getByRole("button", { name: "К списку смен" }));

      expect(onExit).toHaveBeenCalledOnce();
      expect(
        await base.all<{ sscc: string; print_state: string }>(
          "SELECT sscc, print_state FROM boxes_mirror WHERE box_id = ?",
          [SEEDED_BOX_ID],
        ),
      ).toEqual([{ sscc: SSCC, print_state: "pending" }]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps print recovery actionable when its queue rejects retry and skip jobs", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, "transport_failed");
    const registeredQueue: { current: ScanQueue | null } = { current: null };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({
        exec,
        onScanQueueRegister(queue) {
          registeredQueue.current = queue;
          return () => {};
        },
      });
      expect(await screen.findByText("Принтер не принял задание")).toBeDefined();
      await waitFor(() => expect(registeredQueue.current).not.toBeNull());
      const queue = registeredQueue.current;
      if (!queue) throw new Error("scan queue was not registered");
      await act(async () => {
        await queue.close();
      });

      fireEvent.click(screen.getByRole("button", { name: "Повторить печать" }));
      expect(consoleError).toHaveBeenCalledWith("station: box print retry was not admitted");

      fireEvent.click(screen.getByRole("button", { name: "Продолжить без этикетки" }));
      fireEvent.click(screen.getByRole("button", { name: "Подтвердить продолжение" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Подтвердить продолжение" })).toHaveProperty(
          "disabled",
          false,
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("regenerates a restart-restored printed label for the same persisted box and SSCC", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, null, "printed");
    const close = vi.fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>();
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});

    renderWorkTracked({
      exec,
      closeCurrentBox: close,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    expect(await screen.findByText("Отсканируйте распечатанную этикетку")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Печатать заново" }));

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    const [, bytes] = print.mock.calls[0]!;
    expect(new TextDecoder().decode(bytes)).toContain(SSCC);
    expect(close).not.toHaveBeenCalled();
    const boxes = await exec.all<{ box_id: string; sscc: string }>(
      "SELECT box_id, sscc FROM boxes_mirror WHERE closed_at IS NOT NULL",
    );
    expect(boxes).toEqual([{ box_id: SEEDED_BOX_ID, sscc: SSCC }]);
  });

  it("shows classified feedback when restart verification reprint fails", async () => {
    const exec = makeExec();
    await seedPendingPrint(exec, null, "printed");
    const secret = "native COM7 secret-message";
    const print = vi.fn(async () => {
      throw new Error(secret);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({
        exec,
        verifyPrintedLabel: true,
        printing: { target: PRINT_TARGET, language: "zpl", print },
      });

      await screen.findByText("Отсканируйте распечатанную этикетку");
      fireEvent.click(screen.getByRole("button", { name: "Печатать заново" }));

      expect(await screen.findByText("Принтер не принял задание")).toBeDefined();
      expect(document.body.textContent).not.toContain(secret);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  // Self-review addition: none of the brief's own tests ever set
  // `verifyPrintedLabel: true`, so the "on" branch of that setting was never
  // actually exercised -- only its negation was. This is the positive half.
  //
  // A genuine print must actually happen for the prompt to open (Task 13
  // review, Finding 3): `printing` is supplied and a label spec is seeded
  // via `seedLabelSpec`, so `printAndMaybeVerify` really renders and sends a
  // label before deciding to open the prompt, rather than opening it
  // unconditionally whenever the setting is on.
  it("prompts for print verification when the setting is on and a label was actually printed", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText("Отсканируйте распечатанную этикетку")).toBeDefined();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Отсканируйте распечатанную этикетку" }),
    ).toBeDefined();
  });

  it("drops the old box template when a refreshed bundle removes it without remounting work state", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 1 });
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    const view = renderWorkTracked({
      exec,
      boxCapacity: 1,
      boxItemCount: 0,
      closeCurrentBox: close,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    act(() => scan(KM));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());

    await exec.run("UPDATE shift_mirror SET box_label_template_spec = NULL WHERE id = ?", ["s1"]);
    view.refreshBundle(1);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть короб" }));

    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(print).toHaveBeenCalledOnce();
    expect(await screen.findByText("Для смены не выбран шаблон этикетки короба")).toBeDefined();
  });

  it("logs only a fixed category when verification reprint transport rejects", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    const secret = "native COM7 secret-message";
    const print = vi
      .fn<(_target: PrintTarget, _bytes: Uint8Array) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error(secret));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWorkTracked({
        exec,
        boxCapacity: 10,
        boxItemCount: 9,
        closeCurrentBox: close,
        verifyPrintedLabel: true,
        printing: { target: PRINT_TARGET, language: "zpl", print },
      });
      act(() => scan(KM));
      await screen.findByText("Отсканируйте распечатанную этикетку");
      fireEvent.click(screen.getByRole("button", { name: "Печатать заново" }));

      await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith("station: box label reprint failed"),
      );
      expect(consoleError.mock.calls.flat().map(String).join(" ")).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  // Task 13 review, Finding 3: opening the verification prompt when the
  // setting is on used to depend on nothing but that setting -- reachable
  // even when no printer is configured at all, which is exactly this test.
  // With the fix, the operator is told plainly that nothing was printed
  // instead of being handed a prompt to verify a label that never existed.
  it("shows durable missing-printer recovery instead of opening a verification prompt", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: true,
      // No `printing` prop at all -- the "no printer configured" state.
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText("Принтер не настроен")).toBeDefined();
    expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull();
  });

  // Task 13 review, Finding 5: no existing test passed a real `printing`
  // prop and asserted `printing.print` was actually called -- this fails if
  // `await printing.print(...)` were deleted from `printAndMaybeVerify`.
  it("actually sends the rendered label to the configured printer when a box closes", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });
    act(() => scan(KM));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    const [target, bytes] = print.mock.calls[0]!;
    expect(target).toEqual(PRINT_TARGET);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  // CodeRabbit PR33 review, Finding 3: the box-printing path used to read
  // `shift_mirror.label_template_spec` -- the ITEM template -- for every box
  // label. This seeds the two columns with DIFFERENT specs: `label_template_
  // spec` gets deliberately unparsable JSON (so reading it would make
  // printing silently fail), and `box_label_template_spec` gets a real,
  // valid spec. A fixed WorkScreen must print successfully (it only ever
  // reads the box column); the pre-fix code would have failed to parse the
  // item column and shown "print unavailable" instead.
  it("prints using the box's own label template, never the item template, even when the item template is invalid", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const exec = makeExec();
    await exec.run(
      `INSERT INTO shift_mirror (id, status, mode, product_id, label_template_spec, box_label_template_spec)
       VALUES (?,?,?,?,?,?)`,
      ["s1", "active", "aggregation", "p1", "{ not valid json", JSON.stringify(LABEL_SPEC)],
    );
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });
    act(() => scan(KM));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(screen.queryByText(/печать не выполнена/i)).toBeNull();
  });

  // The converse: a box template that is missing entirely must NOT fall back
  // to a perfectly valid item template -- printing must be visibly skipped,
  // not silently substituted with the wrong label.
  it("does not fall back to the item template when no box template is configured", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const print = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array) => {});
    const exec = makeExec();
    await exec.run(
      `INSERT INTO shift_mirror (id, status, mode, product_id, label_template_spec)
       VALUES (?,?,?,?,?)`,
      ["s1", "active", "aggregation", "p1", JSON.stringify(LABEL_SPEC)],
    );
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText("Для смены не выбран шаблон этикетки короба")).toBeDefined();
    expect(print).not.toHaveBeenCalled();
  });

  // Task 13 review, Finding 4: `printAndMaybeVerify`'s decision of whether a
  // print happened depends on the label spec having loaded, but nothing
  // gated it against a box that closes before that mount-time
  // `readShiftMirror` read resolves -- a very fast first box (capacity 1)
  // reproduces this easily. This pins it directly: the label-spec read is
  // held open with a controllable promise, a scan closes the box WHILE it is
  // still unresolved, and printing must not have happened -- or been given
  // up on -- until the read actually completes.
  it("awaits the label geometry load before deciding whether to print, even when a scan closes the box immediately", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 1 });
    const baseExec = makeExec();
    await seedLabelSpec(baseExec, "s1");
    let resolveShiftMirrorRead: (() => void) | undefined;
    // Every query passes straight through to the real (synchronous)
    // `makeExec`, EXCEPT `readShiftMirror`'s own plain select (`FROM
    // shift_mirror`, distinguished from `readShiftContext`'s join by the
    // absence of `product_mirror`) -- held open until the test releases it.
    const gatedExec: SqlExecutor = {
      run: baseExec.run,
      all: async <T,>(sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM shift_mirror") && !sql.includes("product_mirror")) {
          await new Promise<void>((resolve) => {
            resolveShiftMirrorRead = resolve;
          });
        }
        return baseExec.all<T>(sql, params);
      },
    };
    const print = vi.fn(async () => {});
    renderWorkTracked({
      exec: gatedExec,
      boxCapacity: 1,
      boxItemCount: 0,
      closeCurrentBox: close,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    // The label-geometry read has not resolved yet -- printing must not have
    // happened, nor been given up on (no "print not available" notice)
    // either, since that would mean the gate let this proceed too early.
    expect(print).not.toHaveBeenCalled();
    expect(screen.queryByText(/печать не выполнена/i)).toBeNull();

    resolveShiftMirrorRead?.();
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
  });

  // Task 13 review, Finding 5: nothing previously asserted that choosing
  // skip, or a matching scan, actually reaches `boxes_mirror` --
  // `markPrintSkipped`/`markPrintVerified`'s whole reason for existing.
  it("records a skip on boxes_mirror when the operator chooses skip", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
    });
    act(() => scan(KM));
    await screen.findByRole("button", { name: "Пропустить" });
    await exec.run(
      "UPDATE boxes_mirror SET sscc = ?, closed_at = ?, print_state = 'printed' WHERE box_id = ?",
      [SSCC, "2026-08-13T10:00:00.000Z", SEEDED_BOX_ID],
    );
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));

    await waitFor(async () => {
      const rows = await exec.all<{ print_skipped_at: string | null }>(
        `SELECT print_skipped_at FROM boxes_mirror WHERE box_id = ?`,
        [SEEDED_BOX_ID],
      );
      expect(rows[0]?.print_skipped_at).not.toBeNull();
    });
  });

  it("records a verification on boxes_mirror when the printed label is scanned back", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    renderWorkTracked({
      exec,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
    });
    act(() => scan(KM));
    await screen.findByText("Отсканируйте распечатанную этикетку");
    await exec.run(
      "UPDATE boxes_mirror SET sscc = ?, closed_at = ?, print_state = 'printed' WHERE box_id = ?",
      [SSCC, "2026-08-13T10:00:00.000Z", SEEDED_BOX_ID],
    );
    // The same scan source WorkScreen itself listens on -- PrintVerification
    // takes it over entirely while the prompt is up (see its own doc
    // comment). Same GS1 DataMatrix prefix `print-verification.test.tsx`'s
    // own matching-scan fixture uses.
    act(() => scan(`]C100${SSCC}`));

    await waitFor(async () => {
      const rows = await exec.all<{ print_verified_at: string | null }>(
        `SELECT print_verified_at FROM boxes_mirror WHERE box_id = ?`,
        [SEEDED_BOX_ID],
      );
      expect(rows[0]?.print_verified_at).not.toBeNull();
    });
  });

  it.each(["skip", "verify"] as const)(
    "keeps a delayed print-%s outcome inside the recovery work barrier",
    async (outcome) => {
      const base = makeExec();
      await seedLabelSpec(base, "s1");
      await addRange(base, {
        issuerPrefix: TEST_ISSUER_PREFIX,
        extensionDigit: 0,
        fromSerial: 1,
        toSerial: 5,
      });
      let releaseOutcome!: () => void;
      let announceOutcome!: () => void;
      const outcomeGate = new Promise<void>((resolve) => {
        releaseOutcome = resolve;
      });
      const outcomeReached = new Promise<void>((resolve) => {
        announceOutcome = resolve;
      });
      const marker = outcome === "skip" ? "print_skipped_at" : "print_verified_at";
      const exec: SqlExecutor = {
        async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
          if (sql.includes(`${marker} = ?`)) {
            announceOutcome();
            await outcomeGate;
          }
          return base.all<T>(sql, params);
        },
        run: base.run,
      };
      const registry = createFloorWorkRegistry();
      const view = renderWorkTracked({
        exec,
        boxCapacity: 10,
        boxItemCount: 9,
        verifyPrintedLabel: true,
        printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
        onScanQueueRegister: (queue) => registry.register(queue),
      });
      act(() => scan(KM));
      await screen.findByText("Отсканируйте распечатанную этикетку");
      await base.run("UPDATE boxes_mirror SET acked_at = ? WHERE box_id = ?", [
        "2026-08-06T08:00:00Z",
        SEEDED_BOX_ID,
      ]);

      if (outcome === "skip") {
        fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
      } else {
        const rows = await base.all<{ sscc: string }>(
          "SELECT sscc FROM boxes_mirror WHERE box_id = ?",
          [SEEDED_BOX_ID],
        );
        act(() => scan(`]C100${rows[0]!.sscc}`));
      }
      await outcomeReached;
      view.unmount();
      const summary = readSealedWorkSummary(exec, registry.current(), 1_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseOutcome();

      await expect(summary).resolves.toMatchObject({ boxes: 1, total: 2 });
      const rows = await base.all<Record<string, string | null>>(
        `SELECT ${marker}, acked_at FROM boxes_mirror WHERE box_id = ?`,
        [SEEDED_BOX_ID],
      );
      expect(rows[0]?.[marker]).not.toBeNull();
      expect(rows[0]?.acked_at).toBeNull();
    },
    10_000,
  );

  // Task 13 review, Finding 4: `closeTheBox` used to capture the box id for
  // the verification/skip record from the `box` REACT STATE variable, which
  // this file's own comments (on `boxRef`) already document as able to lag a
  // `process()`-driven close. Two scans fired back-to-back, each closing its
  // own (capacity-1) box, exercise exactly that lag: by the time the SECOND
  // close runs, `box` state may not yet reflect the box the FIRST close just
  // opened. The fix reads `boxRef.current` instead, which `updateBox` sets
  // synchronously and is therefore never stale. `boxCapacity: 1` and no
  // seeded item count keep the load path for both boxes as fast/simple as
  // possible (a single `currentBox` query each), maximising the chance this
  // reproduces the lag rather than merely asserting the happy path.
  it("blocks a buffered second scan before it can close another box", async () => {
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    // Real serials to burn -- deliberately NOT injecting `closeCurrentBox`
    // here (unlike every other test in this describe block): an injected
    // mock never calls the real `closeBox` (close-box.ts), which is what
    // actually writes `sscc`/`closed_at` onto `boxes_mirror`, and this test
    // needs a REAL sscc on each closed row to identify which box a
    // verification prompt belongs to.
    await addRange(exec, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 5,
    });
    renderWorkTracked({
      exec,
      boxCapacity: 1,
      boxItemCount: 0,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print: vi.fn(async () => {}) },
    });

    // Two distinct codes, fired back-to-back in one synchronous batch:
    // `boxCapacity: 1` means EACH closes its own box immediately, and the
    // scan queue serializes their processing -- exactly the "two closes in
    // quick succession" window `boxRef` (not `box` state) exists to survive.
    act(() => {
      scan(KM);
      scan(OTHER_KM);
    });
    await waitFor(async () => {
      const rows = await exec.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM boxes_mirror WHERE closed_at IS NOT NULL`,
      );
      expect(rows[0]?.n).toBe(1);
    });

    // The FIRST of the two closes' verification prompts shows (CodeRabbit
    // PR33 review, Finding 9: both call `enqueueVerification`, which queues
    // rather than overwrites, so the second is queued behind the first
    // instead of silently replacing it -- see the dedicated Finding 9 test
    // below for the full two-prompt sequence). Read its OWN sscc back off
    // the screen rather than assuming which box's prompt this is -- the
    // point here is that the box id `printAndMaybeVerify` was given must
    // match the SAME box this sscc actually belongs to.
    const promptSscc = (
      await screen.findByTestId("print-verification-sscc")
    ).textContent?.replaceAll(" ", "");
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));

    await waitFor(async () => {
      const rows = await exec.all<{ print_skipped_at: string | null }>(
        `SELECT print_skipped_at FROM boxes_mirror WHERE sscc = ?`,
        [promptSscc],
      );
      // Exactly one box row carries this sscc (closeBox wrote it), and it
      // must be the one the skip just recorded against -- not silently
      // dropped (null boxId) and not misattributed to the OTHER box.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.print_skipped_at).not.toBeNull();
    });
    const journal = await exec.all<{ raw: string }>(
      "SELECT raw FROM scan_events_mirror WHERE raw = ?",
      [OTHER_KM],
    );
    const outbox = await exec.all<{ raw: string }>("SELECT raw FROM outbox WHERE raw = ?", [
      OTHER_KM,
    ]);
    expect(journal).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("admits a new box scan only after required verification is resolved", async () => {
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    await addRange(exec, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 5,
    });

    const print = vi.fn(async () => {});

    renderWorkTracked({
      exec,
      boxCapacity: 1,
      boxItemCount: 0,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    act(() => scan(KM));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await screen.findByText("Отсканируйте распечатанную этикетку");
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    await waitFor(() =>
      expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull(),
    );
    await screen.findByText("Короб № 2");
    act(() => scan(OTHER_KM));
    await waitFor(async () => {
      const rows = await exec.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM boxes_mirror WHERE closed_at IS NOT NULL",
      );
      expect(rows[0]?.n).toBe(2);
    });
    expect(print).toHaveBeenCalledTimes(2);
  });

  // Self-review addition: pins the exact mutation named in this task's
  // dispatch -- "a validation-mode shift (no sscc block) attempting to
  // close a box anyway". `issuerPrefix: null` is that shift; the box
  // section must not render at all, and reaching capacity must never call
  // `closeCurrentBox`, not even the injected double.
  it("shows no box UI at all, and never attempts to close, when the shift has no sscc block", async () => {
    const close = vi.fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>();
    renderWorkTracked({
      issuerPrefix: null,
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
    });

    expect(screen.queryByTestId("box-progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "Закрыть короб" })).toBeNull();

    act(() => scan(KM));
    await waitFor(() => expect(screen.getByText("1")).toBeDefined());
    expect(close).not.toHaveBeenCalled();
  });
});
