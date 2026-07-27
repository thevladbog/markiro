import { DatabaseSync } from "node:sqlite";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db";
import i18n from "../src/i18n/index.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
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

function renderScreen(source: ScanSource, exec: SqlExecutor) {
  return render(
    <WorkScreen
      exec={exec}
      shiftId="s1"
      terminalId="dev-1"
      expectedGtin14="04600000000015"
      productName="Water 0.5"
      source={source}
      sound={{ muted: true, volume: 1 }}
    />,
  );
}

describe("WorkScreen", () => {
  it("accepts a valid code, counts it and journals it", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderScreen(source, exec);

    source.emit(KM);

    await waitFor(async () => {
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
      expect(rows).toHaveLength(1);
    });
    expect(await screen.findByText("1")).toBeDefined();
  });

  it("flags the second scan of the same code as a duplicate", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderScreen(source, exec);

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
    renderScreen(source, exec);

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
    renderScreen(source, exec);

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
      [KM, "earlier-shift", "04600000000015", "5Ab1", new Date(0).toISOString()],
    );

    renderScreen(source, exec);
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
    render(
      <WorkScreen
        exec={makeExec()}
        shiftId="s1"
        terminalId="dev-1"
        expectedGtin14="04600000000015"
        productName="Water 0.5"
        counterpartyName="Plant X"
        source={source}
        sound={{ muted: true, volume: 1 }}
      />,
    );
    expect(screen.getByText("Water 0.5")).toBeDefined();
    expect(screen.getByText(/Plant X/)).toBeDefined();
  });

  it("shows the system-error signal and counts the scan as rejected when the journal write throws", async () => {
    const source = manualSource();
    const exec = makeThrowingRunExec();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderScreen(source, exec);
    source.emit(KM);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));
    expect(alert.textContent).toContain("WRITE FAILED");
    expect(await screen.findByText("1")).toBeDefined(); // rejected counter, not accepted

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps scanning after the initial code-key load fails, instead of losing every later scan", async () => {
    const source = manualSource();
    const exec = makeFailFirstAllExec();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderScreen(source, exec);
    source.emit(KM);

    await waitFor(async () => {
      const rows = await exec.all<{ code_hash: string }>("SELECT code_hash FROM codes_mirror");
      expect(rows).toHaveLength(1);
    });
    expect(await screen.findByText("1")).toBeDefined(); // accepted counter

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
