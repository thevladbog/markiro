import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db";
import { buildSscc, kmHash, parseKm, type LabelTemplateSpec } from "@markiro/domain";
import i18n from "../src/i18n/index.js";
import type { CloseBoxResult } from "../src/lib/close-box.js";
import { createFloorWorkRegistry, readSealedWorkSummary } from "../src/lib/credential-recovery.js";
import type { PrinterLanguage } from "../src/lib/hardware-config.js";
import type { PrintTarget } from "../src/lib/hardware.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import type { ScanQueue } from "../src/lib/scan-queue.js";
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
    start(l) {
      listener = l;
      return () => {
        listener = () => {};
      };
    },
    emit: (raw) => listener(raw),
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
  source?: ScanSource;
  sound?: SoundSettings;
  onScanRecorded?: () => void;
  onScanQueueRegister?: (queue: ScanQueue) => () => void;
  onExit?: () => void;
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
    source = manualSource(),
    sound = { muted: true, volume: 1 },
    onScanRecorded,
    onScanQueueRegister,
    onExit = () => {},
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
      source={source}
      sound={sound}
      {...(onScanRecorded ? { onScanRecorded } : {})}
      {...(onScanQueueRegister ? { onScanQueueRegister } : {})}
      onExit={onExit}
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
    boxItemCount,
    closeCurrentBox,
    onScan,
    verifyPrintedLabel = false,
    printing,
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

  return render(
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
      {...(closeCurrentBox ? { closeCurrentBox } : {})}
      {...(onScan ? { onScan } : {})}
      verifyPrintedLabel={verifyPrintedLabel}
      {...(printing !== undefined ? { printing } : {})}
    />,
  );
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

  it("announces accepted scans with a title instead of an icon or color alone", async () => {
    const source = manualSource();
    renderWorkScreen({ source });

    act(() => source.emit(KM));

    const alert = await screen.findByRole("alert");
    expect(alert.dataset.tone).toBe("ok");
    expect(alert.textContent).toContain("ACCEPTED");
  });

  it.each([
    { tone: "ok", raw: KM, duration: 350 },
    { tone: "error", raw: "not-a-code", duration: 1200 },
  ] as const)(
    "keeps the $tone verdict visible for exactly $duration ms",
    async ({ tone, raw, duration }) => {
      vi.useFakeTimers();
      const source = manualSource();
      renderWorkScreen({ source });

      act(() => source.emit(raw));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("alert").dataset.tone).toBe(tone);

      await act(async () => vi.advanceTimersByTimeAsync(duration - 1));
      expect(screen.getByRole("alert").dataset.tone).toBe(tone);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("keeps a duplicate verdict for exactly 900 ms", async () => {
    vi.useFakeTimers();
    const source = manualSource();
    renderWorkScreen({ source });

    act(() => source.emit(KM));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(350));
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
    expect(screen.getByRole("alert").dataset.tone).toBe("ok");
    const staleCallback = timeoutSpy.mock.calls.find(([, delay]) => delay === 350)?.[0];
    expect(staleCallback).toBeTypeOf("function");
    await act(async () => vi.advanceTimersByTimeAsync(349));

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
    expect(screen.getByRole("button", { name: "Pause / finish" })).toBeDefined();
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

    fireEvent.click(screen.getByRole("button", { name: "Pause / finish" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("warns about queued scans before leaving, and leaves anyway on confirm", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 12 });

    fireEvent.click(screen.getByRole("button", { name: "Pause / finish" }));
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByText("12 scans have not reached the server yet.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stays on the shift when the operator cancels", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 12 });

    fireEvent.click(screen.getByRole("button", { name: "Pause / finish" }));
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

    const exitButton = screen.getByRole("button", { name: "Pause / finish" });
    exitButton.focus();
    expect(document.activeElement).toBe(exitButton);

    fireEvent.click(exitButton);

    expect(document.activeElement).not.toBe(exitButton);
  });

  it("uses the singular pending-scan copy when exactly one scan is queued", async () => {
    const onExit = vi.fn();
    renderWorkScreen({ onExit, pendingSync: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Pause / finish" }));
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

  it("undoes the last accepted scan in the open box and queues its exception", async () => {
    const exec = makeExec();
    renderWorkTracked({ exec, boxItemCount: 0 });

    act(() => scan(KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(1);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Отменить последний скан" }));

    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(0);
    });
    expect(screen.queryByRole("button", { name: "Отменить последний скан" })).toBeNull();
    const exceptions = await exec.all<{ kind: string; operator_id: string }>(
      "SELECT kind, operator_id FROM box_exceptions_mirror",
    );
    expect(exceptions).toEqual([{ kind: "undo", operator_id: "operator-1" }]);
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

    fireEvent.click(await screen.findByRole("button", { name: "Очистить короб" }));
    act(() => scan(THIRD_KM));
    expect(onScan).toHaveBeenCalledTimes(2);
    expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "Подтвердить очистку" }));

    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(0);
    });
    const exceptions = await exec.all<{ kind: string }>("SELECT kind FROM box_exceptions_mirror");
    expect(exceptions).toEqual([{ kind: "clear" }]);

    act(() => scan(KM));
    await waitFor(async () => {
      expect(await exec.all("SELECT code_hash FROM codes_mirror")).toHaveLength(1);
    });
  });

  it("reprints a closed box and queues the supplied reason for sync", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    await seedLabelSpec(exec, "s1");
    const print = vi.fn().mockResolvedValue(undefined);
    const onScanRecorded = vi.fn();
    renderWorkTracked({
      exec,
      printing: { target: PRINT_TARGET, language: "zpl", print },
      onScanRecorded,
    });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Перепечатать" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Замятие этикетки" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await waitFor(async () => {
      const rows = await exec.all<{ kind: string; reason: string }>(
        "SELECT kind, reason FROM box_exceptions_mirror",
      );
      expect(rows).toEqual([{ kind: "reprint", reason: "Замятие этикетки" }]);
    });
    expect(onScanRecorded).toHaveBeenCalledOnce();
  });

  it("pauses ordinary scanning while a box-action reason dialog is open", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    const onScan = vi.fn();
    renderWorkTracked({ exec, onScan });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Перепечатать" }));
    act(() => scan(KM));
    expect(onScan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    act(() => scan(KM));
    await waitFor(() => expect(onScan).toHaveBeenCalledOnce());
  });

  it("disassembles a closed box, removes its codes and refreshes the panel", async () => {
    const exec = makeExec();
    await seedClosedBox(exec);
    const onScanRecorded = vi.fn();
    renderWorkTracked({ exec, onScanRecorded });

    fireEvent.click(screen.getByRole("button", { name: "Исключения" }));
    fireEvent.click(await screen.findByRole("button", { name: "Расформировать" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Чужой заказ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

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
    const exceptions = await exec.all<{ kind: string; reason: string }>(
      "SELECT kind, reason FROM box_exceptions_mirror",
    );
    expect(exceptions).toEqual([{ kind: "disassemble", reason: "Чужой заказ" }]);
    expect(onScanRecorded).toHaveBeenCalledOnce();
  });

  it("shows how full the open box is", async () => {
    renderWorkTracked({ boxCapacity: 10, boxItemCount: 3 });
    // No jest-dom matcher in this project's setup (see WorkstationSetup's
    // own tests), so assert the DOM text directly.
    expect((await screen.findByTestId("box-progress")).textContent).toBe("3 / 10");
  });

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
    await waitFor(() => expect(button.disabled).toBe(false));
    // Still just the one call, even after the in-flight close settles and
    // the button re-enables.
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

  // Task 13 review, Finding 3: opening the print-unavailable notice used to
  // depend on `verifyPrintedLabel` being on -- so in the DEFAULT
  // configuration (verification off), a box that closed with no printer
  // configured burned a serial and printed nothing, with only a
  // `console.error` to show for it. Whether printing happened at all must be
  // visible regardless of whether a successful print would go on to be
  // verified.
  it("shows the print-unavailable notice even when the verification setting is off", async () => {
    const close = vi
      .fn<(shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>>()
      .mockResolvedValue({ status: "closed", sscc: SSCC, itemCount: 10 });
    renderWorkTracked({
      boxCapacity: 10,
      boxItemCount: 9,
      closeCurrentBox: close,
      verifyPrintedLabel: false,
      // No `printing` prop at all -- the "no printer configured" state.
    });
    act(() => scan(KM));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText(/печать не выполнена/i)).toBeDefined();
    expect(screen.queryByText("Отсканируйте распечатанную этикетку")).toBeNull();
  });

  it("times a print failure out as an ordinary 1200 ms error", async () => {
    vi.useFakeTimers();
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
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert").textContent).toContain("Печать не выполнена");

    await act(async () => vi.advanceTimersByTimeAsync(1199));
    expect(screen.getByRole("alert")).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByRole("alert")).toBeNull();
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
  });

  // Task 13 review, Finding 3: opening the verification prompt when the
  // setting is on used to depend on nothing but that setting -- reachable
  // even when no printer is configured at all, which is exactly this test.
  // With the fix, the operator is told plainly that nothing was printed
  // instead of being handed a prompt to verify a label that never existed.
  it("says printing did not happen instead of opening a verification prompt when no printer is configured", async () => {
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
    expect(await screen.findByText(/печать не выполнена/i)).toBeDefined();
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
    expect(await screen.findByText(/печать не выполнена/i)).toBeDefined();
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
    fireEvent.click(await screen.findByRole("button", { name: "Пропустить" }));

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
        all: base.all,
        async run(sql, params = []) {
          if (sql.includes(`SET ${marker} = ?`)) {
            announceOutcome();
            await outcomeGate;
          }
          await base.run(sql, params);
        },
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
  it("attributes the print-verification record to the box actually closed, not a stale one, across two back-to-back closes", async () => {
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
      expect(rows[0]?.n).toBe(2);
    });

    // The FIRST of the two closes' verification prompts shows (CodeRabbit
    // PR33 review, Finding 9: both call `enqueueVerification`, which queues
    // rather than overwrites, so the second is queued behind the first
    // instead of silently replacing it -- see the dedicated Finding 9 test
    // below for the full two-prompt sequence). Read its OWN sscc back off
    // the screen rather than assuming which box's prompt this is -- the
    // point here is that the box id `printAndMaybeVerify` was given must
    // match the SAME box this sscc actually belongs to.
    const promptSscc = (await screen.findByText(/^\d{18}$/)).textContent;
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
  });

  // CodeRabbit PR33 review, Finding 9: two boxes closing in quick succession
  // (box capacity 1) used to fire `printing.print(...)` for both with no
  // serialization at all, and the second's verification prompt would
  // silently overwrite the first's (a single `verification` slot). This
  // pins BOTH halves of the fix in one scenario: the printer mock tracks
  // concurrent calls (never more than 1 in flight), and BOTH boxes' outcomes
  // are resolved -- one at a time, via the queued prompts -- rather than
  // the first one being silently lost.
  it("serializes concurrent box-label prints and loses neither box's verification outcome", async () => {
    const exec = makeExec();
    await seedLabelSpec(exec, "s1");
    await addRange(exec, {
      issuerPrefix: TEST_ISSUER_PREFIX,
      extensionDigit: 0,
      fromSerial: 1,
      toSerial: 5,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const print = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A deliberately slow printer -- long enough that, without
      // serialization, the SECOND box's print would start while the
      // first's is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
    });

    renderWorkTracked({
      exec,
      boxCapacity: 1,
      boxItemCount: 0,
      verifyPrintedLabel: true,
      printing: { target: PRINT_TARGET, language: "zpl", print },
    });

    // Two distinct codes, fired back-to-back: `boxCapacity: 1` closes a
    // box (and fires a print) for each.
    act(() => {
      scan(KM);
      scan(OTHER_KM);
    });

    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    // The core serialization assertion: never more than one physical
    // print call in flight, however close together the two boxes closed.
    expect(maxInFlight).toBe(1);

    await waitFor(async () => {
      const rows = await exec.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM boxes_mirror WHERE closed_at IS NOT NULL`,
      );
      expect(rows[0]?.n).toBe(2);
    });

    // First prompt: resolve it (skip), then the SECOND must appear --
    // proving it was queued, not dropped, while the first was showing.
    const firstSscc = (await screen.findByText(/^\d{18}$/)).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));

    const secondSscc = await waitFor(() => {
      const text = screen.getByText(/^\d{18}$/).textContent;
      if (text === firstSscc) throw new Error("still showing the first prompt");
      return text;
    });
    expect(secondSscc).not.toBe(firstSscc);
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));

    // Neither box was left without an outcome -- both boxes_mirror rows
    // carry a resolved print_skipped_at, and the queue is now empty.
    await waitFor(async () => {
      const rows = await exec.all<{ sscc: string; print_skipped_at: string | null }>(
        `SELECT sscc, print_skipped_at FROM boxes_mirror WHERE closed_at IS NOT NULL`,
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.print_skipped_at).not.toBeNull();
      }
    });
    expect(screen.queryByText(/^\d{18}$/)).toBeNull();
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
