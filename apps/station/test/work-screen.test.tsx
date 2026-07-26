import { DatabaseSync } from "node:sqlite";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
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
  });

  it("rejects a code belonging to another product", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderScreen(source, exec);

    source.emit("0104600000000022215Ab1"); // different GTIN
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));
  });

  it("rejects unparseable input", async () => {
    const source = manualSource();
    const exec = makeExec();
    renderScreen(source, exec);

    source.emit("not-a-code");
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.dataset.tone).toBe("error"));
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
});
