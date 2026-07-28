# Station Hardware Wiring & Workstation Config (05b-3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the station's hardware half to the app — a persisted workstation configuration, printing in the printer's own language, truthful status indicators — and close the three deferred defects that block or undermine that wiring.

**Architecture:** A `hardware_config` entry in the existing `station_meta` table holds the scanner port/baud, the printer target and the printer language. The station reads it at start, opens a configured serial scanner, and prints the shift's label **spec** through the emitter the configured language selects. The Rust scanner gains a generation counter (enabling close-before-open) and a status event (enabling honest indicators). The operator roster moves to two alternating slot tables with a single-statement pointer flip, so an interrupted refresh is never visible.

**Tech Stack:** TypeScript/React 19 (station webview), Rust/Tauri 2.11 (`serialport`), `tauri-plugin-sql` (SQLite), `@markiro/domain` label emitters, vitest + `node:sqlite`, cargo test, NestJS (the API guard task).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-26-station-hardware-wiring-design.md`. Every task's requirements implicitly include this section.
- **ZPL and TSC only.** PDF output and OS-spooler printing are explicitly out of this slice.
- **Printing takes its language from `hardware_config.printerLanguage`, never from the template's `language` field** — a template stores a language-neutral `spec`, and both emitters consume the same spec. The template's `language` is the editor's preview/download choice.
- **TSPL output is a latin1 byte carrier**: convert it with `charCodeAt`, never `TextEncoder` (which would UTF-8-encode every byte above 0x7F and corrupt the `BITMAP` payload). Plan 04 pinned this.
- **The hardware contract stays stateless** — callers pass concrete targets (`openScanner(port, baud)`, `print(target, bytes)`); configuration lives on the station.
- **i18n RU + EN in lockstep** — the station throws on a missing key in test mode and a parity test exists; add every key to BOTH `apps/station/src/i18n/ru.json` and `en.json`.
- Floor mode: dark default, touch targets ≥64px.
- No new npm dependencies. Do NOT edit `.npmrc` (adding `minimumReleaseAgeExclude` is task failure). New cargo crates use the repo's caret style.
- Conventional commits, English, no co-author lines.
- Station tests: `pnpm --filter @markiro/station test` (vitest, jsdom). Rust: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml` — `generate_context!()` needs `apps/station/dist`, so run `pnpm turbo build --filter '@markiro/station...'` first if the build complains. API e2e need `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173`.
- Run `lint` and `typecheck` for every package you touch before committing — CI gates on both.

## File Structure

| File                                                              | Responsibility                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/station/src/lib/hardware-config.ts` (new)                   | Load/save the workstation configuration in `station_meta`          |
| `apps/station/src/lib/print-label.ts` (new)                       | Turn a label spec into printer bytes using the configured language |
| `apps/station/src-tauri/src/scanner.rs` (modify)                  | Generation-counted sessions + `station://scanner-status`           |
| `apps/station/src/lib/hardware.ts` (modify)                       | `onScannerStatus` on the contract and the Tauri implementation     |
| `apps/station/src/lib/mirror.ts` (modify)                         | Two-slot roster publication                                        |
| `packages/db/src/sqlite/{schema,migrations}.ts` (modify)          | Second roster slot table                                           |
| `apps/station/src/pages/WorkstationSetup.tsx` (modify)            | Persist config, printer language, close-before-open                |
| `apps/station/src/ui/{StatusBar,FloorShell}.tsx` (modify)         | Three scanner states                                               |
| `apps/station/src/App.tsx` (modify)                               | Load config, pick the scan source, route to setup, live indicators |
| `apps/api/src/modules/employees/employees.controller.ts` (modify) | Session-only                                                       |
| `docs/device-key-surface.md` (new)                                | What a device api-key may reach                                    |

---

### Task 1: Workstation configuration store

**Files:**

- Create: `apps/station/src/lib/hardware-config.ts`
- Test: `apps/station/test/hardware-config.test.ts`

**Interfaces:**

- Consumes: `SqlExecutor` from `apps/station/src/lib/mirror.ts`; `PrintTarget` from `apps/station/src/lib/hardware.ts`.
- Produces:
  - `type PrinterLanguage = "zpl" | "tspl"`
  - `interface HardwareConfig { scanner: { port: string; baud: number } | null; printer: PrintTarget | null; printerLanguage: PrinterLanguage }`
  - `loadHardwareConfig(exec: SqlExecutor): Promise<HardwareConfig>`
  - `saveHardwareConfig(exec: SqlExecutor, config: HardwareConfig): Promise<void>`
  - `const DEFAULT_HARDWARE_CONFIG: HardwareConfig`

Like `loadSoundSettings`, the loader must never reject: it runs at boot and can race the migrations that create `station_meta`, and a station that cannot read a preference must still validate codes.

- [ ] **Step 1: Write the failing test**

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  DEFAULT_HARDWARE_CONFIG,
  loadHardwareConfig,
  saveHardwareConfig,
  type HardwareConfig,
} from "../src/lib/hardware-config.js";

// Same shape as mirror.test.ts's `nodeExecutor`; `applyMigrations` already
// swallows the duplicate-column error the re-runnable ALTER produces.
function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

async function makeExec(): Promise<SqlExecutor> {
  const exec = nodeExecutor();
  await applyMigrations(exec);
  return exec;
}

const CONFIG: HardwareConfig = {
  scanner: { port: "COM3", baud: 9600 },
  printer: { kind: "tcp", host: "10.0.0.7", port: 9100 },
  printerLanguage: "tspl",
};

describe("hardware config", () => {
  it("defaults to no hardware and ZPL when nothing is stored", async () => {
    expect(await loadHardwareConfig(await makeExec())).toEqual(DEFAULT_HARDWARE_CONFIG);
    expect(DEFAULT_HARDWARE_CONFIG).toEqual({
      scanner: null,
      printer: null,
      printerLanguage: "zpl",
    });
  });

  it("round-trips a full configuration", async () => {
    const exec = await makeExec();
    await saveHardwareConfig(exec, CONFIG);
    expect(await loadHardwareConfig(exec)).toEqual(CONFIG);
  });

  it("round-trips a serial printer target", async () => {
    const exec = await makeExec();
    const serial: HardwareConfig = {
      scanner: null,
      printer: { kind: "serial", port: "COM4", baud: 19200 },
      printerLanguage: "zpl",
    };
    await saveHardwareConfig(exec, serial);
    expect(await loadHardwareConfig(exec)).toEqual(serial);
  });

  it("falls back to defaults on corrupt stored content", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      "{not json",
    ]);
    expect(await loadHardwareConfig(exec)).toEqual(DEFAULT_HARDWARE_CONFIG);
  });

  it("falls back to defaults for an unknown printer language", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({ scanner: null, printer: null, printerLanguage: "postscript" }),
    ]);
    expect((await loadHardwareConfig(exec)).printerLanguage).toBe("zpl");
  });

  it("never rejects when the table does not exist yet", async () => {
    const failing: SqlExecutor = {
      run: async () => {},
      all: async () => {
        throw new Error("no such table: station_meta");
      },
    };
    await expect(loadHardwareConfig(failing)).resolves.toEqual(DEFAULT_HARDWARE_CONFIG);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run hardware-config`
Expected: FAIL — `Failed to resolve import "../src/lib/hardware-config.js"`.

- [ ] **Step 3: Implement**

```ts
import type { PrintTarget } from "./hardware.js";
import type { SqlExecutor } from "./mirror.js";

/** The printer's command language. PDF output is a later slice. */
export type PrinterLanguage = "zpl" | "tspl";

/**
 * Everything the workstation setup screen configures once. Held on the
 * station (not the server) so the device configures and runs offline; the
 * hardware contract stays stateless and receives these values per call.
 */
export interface HardwareConfig {
  /** null = no serial scanner; the keyboard wedge needs no configuration. */
  scanner: { port: string; baud: number } | null;
  printer: PrintTarget | null;
  printerLanguage: PrinterLanguage;
}

export const DEFAULT_HARDWARE_CONFIG: HardwareConfig = {
  scanner: null,
  printer: null,
  printerLanguage: "zpl",
};

const META_KEY = "hardware_config";

function parseScanner(value: unknown): HardwareConfig["scanner"] {
  if (typeof value !== "object" || value === null) return null;
  const { port, baud } = value as { port?: unknown; baud?: unknown };
  if (typeof port !== "string" || port.length === 0) return null;
  return { port, baud: typeof baud === "number" ? baud : 9600 };
}

function parsePrinter(value: unknown): PrintTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as { kind?: unknown; port?: unknown; baud?: unknown; host?: unknown };
  if (t.kind === "serial" && typeof t.port === "string" && t.port.length > 0) {
    return { kind: "serial", port: t.port, baud: typeof t.baud === "number" ? t.baud : 9600 };
  }
  if (t.kind === "tcp" && typeof t.host === "string" && t.host.length > 0) {
    return { kind: "tcp", host: t.host, port: typeof t.port === "number" ? t.port : 9100 };
  }
  return null;
}

/**
 * Reads the stored configuration, falling back to defaults for anything
 * missing or malformed. Never rejects: this runs at boot and can race the
 * migration that creates `station_meta`, and a station that cannot read a
 * preference must still come up and validate codes.
 */
export async function loadHardwareConfig(exec: SqlExecutor): Promise<HardwareConfig> {
  try {
    const rows = await exec.all<{ value: string | null }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [META_KEY],
    );
    const raw = rows[0]?.value;
    if (!raw) return { ...DEFAULT_HARDWARE_CONFIG };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      scanner: parseScanner(parsed.scanner),
      printer: parsePrinter(parsed.printer),
      printerLanguage: parsed.printerLanguage === "tspl" ? "tspl" : "zpl",
    };
  } catch {
    return { ...DEFAULT_HARDWARE_CONFIG };
  }
}

export async function saveHardwareConfig(exec: SqlExecutor, config: HardwareConfig): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [META_KEY, JSON.stringify(config)],
  );
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station exec vitest run hardware-config`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/hardware-config.ts apps/station/test/hardware-config.test.ts
git commit -m "feat(station): persisted workstation hardware configuration"
```

---

### Task 2: Print a label spec in the configured language

**Files:**

- Create: `apps/station/src/lib/print-label.ts`
- Test: `apps/station/test/print-label.test.ts`

**Interfaces:**

- Consumes: `generateZpl`, `generateTspl`, `sampleLabelData`, types `LabelTemplateSpec`, `LabelField`, `RasterizeTextFn` from `@markiro/domain`; `PrinterLanguage` (Task 1).
- Produces:
  - `latin1ToBytes(text: string): Uint8Array`
  - `renderLabelBytes(spec: LabelTemplateSpec, data: Record<LabelField, string>, language: PrinterLanguage, rasterizeText: RasterizeTextFn): Promise<Uint8Array>`

**Why `latin1ToBytes` and not `TextEncoder`:** the TSPL emitter returns its binary `BITMAP` payload as a latin1 string (one code unit per byte — pinned in plan 04). `TextEncoder` would UTF-8-encode every byte above 0x7F into two bytes and corrupt the bitmap. ZPL is ASCII, where the two agree, so one helper serves both.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { sampleLabelData, type LabelTemplateSpec, type RasterResult } from "@markiro/domain";
import { latin1ToBytes, renderLabelBytes } from "../src/lib/print-label.js";

// Deterministic 8x1 all-white raster so the emitters reach their raster branch
// without a canvas. TSPL inverts it to 0xFF — a byte above 0x7F, which is
// exactly what must survive the encoding.
const fakeRasterize = async (): Promise<RasterResult> => ({
  hex: "00",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
});

const SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [{ id: "a", kind: "field", field: "product.name", xMm: 4, yMm: 4, fontSizePt: 10 }],
};

describe("latin1ToBytes", () => {
  it("keeps a byte above 0x7F as one byte", () => {
    expect(Array.from(latin1ToBytes("ÿA"))).toEqual([0xff, 0x41]);
  });

  it("encodes an empty string to no bytes", () => {
    expect(Array.from(latin1ToBytes(""))).toEqual([]);
  });
});

describe("renderLabelBytes", () => {
  it("emits ZPL when the printer speaks ZPL", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "zpl", fakeRasterize);
    expect(new TextDecoder().decode(bytes)).toContain("^XA");
  });

  it("emits TSPL from the same spec when the printer speaks TSPL", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("SIZE");
    expect(text).toContain("PRINT 1");
  });

  it("ignores the template's own language field", async () => {
    // SPEC declares "zpl"; the printer says TSPL and must win.
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("^XA");
  });

  it("preserves TSPL's binary payload bytes intact", async () => {
    const bytes = await renderLabelBytes(SPEC, sampleLabelData(), "tspl", fakeRasterize);
    expect(Array.from(bytes)).toContain(0xff);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run print-label`
Expected: FAIL — `Failed to resolve import "../src/lib/print-label.js"`.

- [ ] **Step 3: Implement**

```ts
import {
  generateTspl,
  generateZpl,
  type LabelField,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";
import type { PrinterLanguage } from "./hardware-config.js";

/**
 * Converts an emitter's output to exact bytes, one code unit per byte.
 *
 * The TSPL emitter carries its binary `BITMAP` payload as a latin1 string
 * (pinned in plan 04). `TextEncoder` would UTF-8-encode every byte above
 * 0x7F into two bytes and corrupt the bitmap, so the conversion must be a
 * plain `charCodeAt` walk. ZPL is printable ASCII, where both agree.
 */
export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Renders a label for the printer actually attached to this workstation.
 *
 * The template's own `language` field is deliberately ignored: a spec is
 * language-neutral geometry and both emitters consume it, so a plant can run
 * mixed printers against one set of templates. The configured printer
 * language decides the output.
 */
export async function renderLabelBytes(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  language: PrinterLanguage,
  rasterizeText: RasterizeTextFn,
): Promise<Uint8Array> {
  const text =
    language === "tspl"
      ? await generateTspl(spec, data, { rasterizeText })
      : await generateZpl(spec, data, { rasterizeText });
  return latin1ToBytes(text);
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station exec vitest run print-label`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/print-label.ts apps/station/test/print-label.test.ts
git commit -m "feat(station): render labels in the configured printer language"
```

---

### Task 3: Generation-counted scanner sessions and a status event

**Files:**

- Modify: `apps/station/src-tauri/src/scanner.rs`

**Interfaces:**

- Produces: the existing commands keep their signatures; the module additionally emits `station://scanner-status` with the payload `"connected"` or `"disconnected"`, and exposes `pub const SCANNER_STATUS_EVENT: &str = "station://scanner-status";`.
- Produces (Rust, unit-testable): `pub fn session_should_run(mine: u64, current: u64) -> bool`.

**Why:** `SCANNING` is one bool serving as both "a scanner is open" and "this thread should run". A fast close→open can flip it back to true before the old thread notices, briefly running two readers; and `open_scanner` rejects while it is set, so the setup screen cannot close-before-open and dead-ends on a wrong port until the app restarts.

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` in `apps/station/src-tauri/src/scanner.rs`:

```rust
    use super::session_should_run;

    #[test]
    fn a_session_runs_while_it_is_the_current_generation() {
        assert!(session_should_run(7, 7));
    }

    #[test]
    fn a_session_stops_once_a_newer_generation_starts() {
        assert!(!session_should_run(7, 8));
    }

    #[test]
    fn a_stale_session_stops_even_if_the_counter_moved_far() {
        assert!(!session_should_run(1, 42));
    }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml scanner`
Expected: FAIL — `cannot find function session_should_run in this scope`.

- [ ] **Step 3: Replace the session state**

In `apps/station/src-tauri/src/scanner.rs`, replace the `SCANNING` static and its uses. Change the atomic import on line 2 from `AtomicBool` to `AtomicU64`, and **delete `use std::sync::Arc;`** — the reader thread now takes an owned `AppHandle` clone, so `Arc` becomes unused and an unused import fails the build under `-D warnings`.

```rust
use std::sync::atomic::{AtomicU64, Ordering};

/// Event carrying the scanner's connection state to the webview.
pub const SCANNER_STATUS_EVENT: &str = "station://scanner-status";

/// Monotonic session counter. Each reader thread captures the generation it
/// was started with and exits as soon as the current one differs, so a fast
/// close→open can never leave two readers alive — which is what makes
/// close-before-open safe for the setup screen.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A reader keeps running only while its own generation is still current.
pub fn session_should_run(mine: u64, current: u64) -> bool {
    mine == current
}
```

Rewrite `open_scanner` to take a fresh generation instead of refusing when one is open, and to report status:

```rust
#[tauri::command]
pub fn open_scanner(app: AppHandle, port: String, baud: u32) -> Result<(), String> {
    // Starting a new session implicitly retires the previous one: its thread
    // sees a newer generation and exits. This is what lets the setup screen
    // recover from a wrong port without an app restart.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let mut handle = serialport::new(&port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| e.to_string())?;

    let _ = app.emit(SCANNER_STATUS_EVENT, "connected");
    let app = app.clone();
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut chunk = [0u8; 256];
        while session_should_run(generation, GENERATION.load(Ordering::SeqCst)) {
            match handle.read(&mut chunk) {
                Ok(0) => continue,
                Ok(n) => {
                    for line in absorb_chunk(&mut buffer, &String::from_utf8_lossy(&chunk[..n])) {
                        let _ = app.emit(SCAN_EVENT, line);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        // Only the session that is still current owns the status: a retired
        // thread exiting must not report a disconnect over its successor.
        if session_should_run(generation, GENERATION.load(Ordering::SeqCst)) {
            let _ = app.emit(SCANNER_STATUS_EVENT, "disconnected");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn close_scanner(app: AppHandle) -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit(SCANNER_STATUS_EVENT, "disconnected");
    Ok(())
}
```

`close_scanner` now takes `AppHandle`; Tauri injects it, and the TypeScript call site passes no arguments, so `hardware.ts` needs no change for this.

- [ ] **Step 4: Run it green**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`
Expected: PASS — the three new `session_should_run` tests plus every existing test (`split_lines`, `absorb_chunk`, config, printer).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src-tauri/src/scanner.rs
git commit -m "feat(station): generation-counted scanner sessions with status events"
```

---

### Task 4: Scanner status on the hardware contract

**Files:**

- Modify: `apps/station/src/lib/hardware.ts`
- Test: `apps/station/test/hardware.test.ts`

**Interfaces:**

- Consumes: the Rust event `station://scanner-status` with payload `"connected" | "disconnected"` (Task 3).
- Produces:
  - `type ScannerStatus = "connected" | "disconnected"`
  - `HardwareContract` gains `onScannerStatus(listener: (status: ScannerStatus) => void): Promise<() => void>`

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/hardware.test.ts`:

```ts
describe("scanner status subscription", () => {
  it("delivers status updates and unsubscribes on stop", async () => {
    const unsubscribe = vi.fn();
    let emit: (s: "connected" | "disconnected") => void = () => {};
    const hw: HardwareContract = {
      listScannerPorts: async () => [],
      openScanner: async () => {},
      closeScanner: async () => {},
      onScan: async () => () => {},
      onScannerStatus: async (listener) => {
        emit = listener;
        return unsubscribe;
      },
      print: async () => {},
    };

    const seen: string[] = [];
    const stop = await hw.onScannerStatus((s) => seen.push(s));
    emit("connected");
    emit("disconnected");
    expect(seen).toEqual(["connected", "disconnected"]);

    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run hardware`
Expected: FAIL — TypeScript rejects the object literal because `onScannerStatus` is not part of `HardwareContract`.

- [ ] **Step 3: Implement**

In `apps/station/src/lib/hardware.ts`, add the type and the contract member, and implement it in `tauriHardware` next to `onScan`:

```ts
/** Whether a configured serial scanner is currently open. */
export type ScannerStatus = "connected" | "disconnected";
```

Add to the `HardwareContract` interface:

```ts
  /** Subscribes to scanner connection changes; resolves to the unsubscribe function. */
  onScannerStatus(listener: (status: ScannerStatus) => void): Promise<() => void>;
```

Add to `tauriHardware`:

```ts
  async onScannerStatus(listener) {
    return listen<ScannerStatus>("station://scanner-status", (event) => listener(event.payload));
  },
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station test`
Expected: PASS — the new case plus the existing suite. Adding a member to the interface breaks every existing test double, so add `onScannerStatus: async () => () => {},` to the `hardware()` factory in `apps/station/test/workstation-setup.test.tsx` and to any literal `HardwareContract` in `apps/station/test/hardware.test.ts`. Those two files hold all of them.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/hardware.ts apps/station/test/hardware.test.ts apps/station/test/workstation-setup.test.tsx
git commit -m "feat(station): scanner status on the hardware contract"
```

---

### Task 5: Atomic operator roster publication (two slots)

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `apps/station/src/lib/mirror.ts`
- Test: `apps/station/test/mirror.test.ts`

**Interfaces:**

- Produces: `replaceOperatorsMirror(exec, operators)` and `readOperatorsMirror(exec)` both keep their signatures. `auth.ts` and `roster-sync.ts` are the only callers and need no change.

**Why:** today the mirror upserts the incoming operators and then deletes the ones missing from the bundle. A failure between the two leaves a removed or deactivated operator able to sign in offline.

**Approach — two slots, not a generation column.** The roster lives in two identical tables; one is active at a time, named by a `station_meta` key. A refresh fills the **inactive** slot and then flips the pointer in a single statement.

A generation column on one table does NOT work here, and the reason is worth stating so nobody "simplifies" it back: writing a new generation means upserting the existing row, which moves that operator **out** of the still-active generation. An interrupted refresh would then drop the operator it had already rewritten — the very bug this task fixes. Two slots avoid it because the active slot's rows are never touched during a refresh.

This is also the only shape that is atomic under `tauri-plugin-sql`'s connection pool: the flip is one `INSERT ... ON CONFLICT` on `station_meta`, and single statements are the only unit of atomicity available (a multi-call `BEGIN`/`COMMIT` can land on different pooled connections — see `upsertBundle`'s doc comment).

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/mirror.test.ts`. The file already provides `nodeExecutor()` and imports `applyMigrations`, `readOperatorsMirror`, `replaceOperatorsMirror` and `SqlExecutor` — reuse them rather than adding new helpers.

```ts
const OPERATOR_A = {
  operatorId: "op-a",
  name: "A",
  login: "1001",
  role: "operator",
  pinHash: "pbkdf2$sha256$100000$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGE=",
  badgeHash: null,
  active: true,
};
const OPERATOR_B = { ...OPERATOR_A, operatorId: "op-b", name: "B", login: "1002" };

describe("roster publication is atomic", () => {
  it("keeps the previous roster when a refresh fails midway", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A, OPERATOR_B]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId).sort()).toEqual([
      "op-a",
      "op-b",
    ]);

    // A refresh that removes B but dies before the publish. Only the flip
    // writes to station_meta, so failing that statement models exactly the
    // "everything staged, nothing published" case.
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/station_meta/.test(sql)) throw new Error("write failed");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    await expect(replaceOperatorsMirror(failing, [OPERATOR_A])).rejects.toThrow();

    // The previous complete roster is still what authenticates.
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId).sort()).toEqual([
      "op-a",
      "op-b",
    ]);
  });

  it("publishes the new roster once the refresh completes", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A, OPERATOR_B]);
    await replaceOperatorsMirror(exec, [OPERATOR_A]);
    expect((await readOperatorsMirror(exec)).map((o) => o.operatorId)).toEqual(["op-a"]);
  });

  it("clears the roster when a completed refresh contains nobody", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [OPERATOR_A]);
    await replaceOperatorsMirror(exec, []);
    expect(await readOperatorsMirror(exec)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run mirror`
Expected: FAIL on the first case — today's implementation never writes to `station_meta`, so nothing throws and the refresh publishes itself by deleting B; vitest reports the promise resolved instead of rejecting.

- [ ] **Step 3: Add the second slot table**

In `packages/db/src/sqlite/schema.ts`, add beside `operatorsMirror` (identical columns — note `login` is `NOT NULL` here because this table has no legacy rows to accommodate):

```ts
/**
 * The second roster slot. `operators_mirror` and this table hold alternating
 * generations of the same roster; `station_meta.operators_slot` names the
 * active one. See `replaceOperatorsMirror` for why publication needs two
 * tables rather than a generation column.
 */
export const operatorsMirrorB = sqliteTable("operators_mirror_b", {
  operatorId: text("operator_id").primaryKey(),
  name: text("name").notNull(),
  login: text("login").notNull(),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  badgeHash: text("badge_hash"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});
```

In `packages/db/src/sqlite/migrations.ts`, add the matching statement immediately after the `operators_mirror` one:

```ts
  `CREATE TABLE IF NOT EXISTS operators_mirror_b (
     operator_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     login TEXT NOT NULL,
     role TEXT NOT NULL,
     pin_hash TEXT NOT NULL,
     badge_hash TEXT,
     active INTEGER NOT NULL DEFAULT 1
   );`,
```

No `ALTER TABLE` upgrade statement is needed: the table is created complete, and a device that already has `operators_mirror` keeps reading it because the absent `operators_slot` key means slot A.

- [ ] **Step 4: Publish into the inactive slot**

In `apps/station/src/lib/mirror.ts`, replace `replaceOperatorsMirror` **and the doc comment above it** (which currently documents the old non-transactional behaviour and would become false):

```ts
const ACTIVE_SLOT_KEY = "operators_slot";
const SLOT_TABLES = { a: "operators_mirror", b: "operators_mirror_b" } as const;
type RosterSlot = keyof typeof SLOT_TABLES;

/**
 * The slot currently serving offline sign-in. Absent means "a", so a device
 * enrolled before the second slot existed keeps its roster on upgrade.
 */
async function activeSlot(exec: SqlExecutor): Promise<RosterSlot> {
  try {
    const rows = await exec.all<{ value: string | null }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [ACTIVE_SLOT_KEY],
    );
    return rows[0]?.value === "b" ? "b" : "a";
  } catch {
    return "a";
  }
}

/**
 * Publishes a complete roster atomically.
 *
 * The incoming operators are written into the INACTIVE slot, and only once
 * every row has landed is the active slot flipped — a single statement, which
 * is the only unit of atomicity `tauri-plugin-sql`'s connection pool gives us
 * (multi-call BEGIN/COMMIT can land on different pooled connections; see
 * `upsertBundle`). A refresh that fails partway is therefore never published:
 * the device keeps authenticating against the last complete roster instead of
 * a half-updated one, which previously left a removed or deactivated operator
 * able to sign in offline.
 *
 * A generation column on a single table cannot do this: writing the new
 * generation means upserting the operator's existing row, which moves it out
 * of the still-active generation, so an interrupted refresh would drop the
 * operators it had already rewritten.
 *
 * The table names are interpolated from `SLOT_TABLES`, a closed set of two
 * literals — never from a parameter — because SQLite has no placeholder for
 * an identifier.
 */
export async function replaceOperatorsMirror(
  exec: SqlExecutor,
  operators: OperatorMirrorRecord[],
): Promise<void> {
  const target: RosterSlot = (await activeSlot(exec)) === "a" ? "b" : "a";
  const table = SLOT_TABLES[target];

  await exec.run(`DELETE FROM ${table}`);
  for (const op of operators) {
    await exec.run(
      `INSERT INTO ${table} (operator_id, name, login, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?,?)`,
      [op.operatorId, op.name, op.login, op.role, op.pinHash, op.badgeHash, b(op.active)],
    );
  }

  // The publish. Everything above this line is invisible to sign-in.
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [ACTIVE_SLOT_KEY, target],
  );
}
```

**Correction (found in PR #12 review, after this plan shipped):** the snippet below this note originally read the active slot with `const table = SLOT_TABLES[await activeSlot(exec)]` followed by a second `exec.all` against that resolved table — two round trips with a JS gap between them. A publish can flip `station_meta.operators_slot` in that gap: a sign-in that resolved slot "a" before the flip would then read table "a" after it, which by construction still holds the previous generation (an operator just removed or deactivated server-side would authenticate anyway), or — once `publishOperatorsMirror`'s post-flip cleanup has also run — an empty table. Do not implement it that way. Resolve the pointer and read the rows in ONE statement instead, so SQLite evaluates both against a single consistent snapshot and there is no gap for a concurrent publish to land in:

```ts
export async function readOperatorsMirror(exec: SqlExecutor): Promise<OperatorMirrorRecord[]> {
  const rows = await exec.all<{
    operator_id: string;
    name: string;
    login: string | null;
    role: string;
    pin_hash: string;
    badge_hash: string | null;
    active: number;
  }>(
    `SELECT operator_id, name, login, role, pin_hash, badge_hash, active
       FROM ${SLOT_TABLES.a}
      WHERE COALESCE((SELECT value FROM station_meta WHERE key = ?), 'a') <> 'b'
     UNION ALL
     SELECT operator_id, name, login, role, pin_hash, badge_hash, active
       FROM ${SLOT_TABLES.b}
      WHERE COALESCE((SELECT value FROM station_meta WHERE key = ?), 'a') = 'b'`,
    [ACTIVE_SLOT_KEY, ACTIVE_SLOT_KEY],
  );
  return rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    // Legacy rows (mirrored before the column existed) read as "", which never
    // matches a real personnel number; the first roster sync overwrites them.
    login: r.login ?? "",
    role: r.role,
    pinHash: r.pin_hash,
    badgeHash: r.badge_hash,
    active: r.active === 1,
  }));
}
```

The `COALESCE(..., 'a')` in each branch reproduces `activeSlot`'s absent-key-means-"a" fallback, so a device upgrading with rows already in `operators_mirror` and no pointer row yet still reads them. `${SLOT_TABLES.a}` / `${SLOT_TABLES.b}` are still the same closed set of two literals used everywhere else in this file — never caller input.

- [ ] **Step 5: Correct the now-false doc comment in `roster-sync.ts`**

`apps/station/src/lib/roster-sync.ts`'s doc comment states that a failed sync leaves the mirror "partially updated until the next successful sync". That is no longer true and would mislead the next reader. Replace that paragraph with:

```ts
 * `replaceOperatorsMirror` publishes atomically (see its doc comment): a sync
 * that fails partway leaves the previously published roster active rather than
 * a partially updated one, so an interrupted sync can never widen offline
 * access.
```

- [ ] **Step 6: Update the schema drift test**

`packages/db/test/sqlite-schema.test.ts` asserts "creates all six mirror tables". Rename it to seven and add the assertion:

```ts
  it("creates all seven mirror tables", () => {
```

```ts
expect(names).toContain("operators_mirror_b");
```

- [ ] **Step 7: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/db test`
Expected: PASS on both — the three new atomicity tests, the existing mirror tests (including "clears the mirror when the bundle has no operators"), and the db sqlite-schema test.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/migrations.ts packages/db/test/sqlite-schema.test.ts apps/station/src/lib/mirror.ts apps/station/src/lib/roster-sync.ts apps/station/test/mirror.test.ts
git commit -m "feat(station): publish the operator roster atomically via two slots"
```

---

### Task 6: Workstation setup persists the configuration

**Files:**

- Modify: `apps/station/src/pages/WorkstationSetup.tsx`, `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Test: `apps/station/test/workstation-setup.test.tsx`

**Interfaces:**

- Consumes: `loadHardwareConfig`/`saveHardwareConfig`/`HardwareConfig`/`PrinterLanguage` (Task 1), `renderLabelBytes` (Task 2), `rasterizeText` from `apps/station/src/lib/rasterizer.js`, `HardwareContract` (Task 4).
- Produces: `WorkstationSetupProps` gains `onConfigChange: (config: HardwareConfig) => void` so the app can react without re-reading the database.

New i18n keys under `setup`: `printerLanguage`, `languageZpl`, `languageTspl`, `saved`.

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/workstation-setup.test.tsx`:

```tsx
it("saves the chosen scanner, printer and language", async () => {
  const runs: [string, unknown[]][] = [];
  const exec: SqlExecutor = {
    run: async (sql, params = []) => {
      runs.push([sql, params]);
    },
    all: async () => [],
  };
  const onConfigChange = vi.fn();

  render(
    <WorkstationSetup
      hw={hardware()}
      exec={exec}
      sound={{ muted: false, volume: 1 }}
      onSoundChange={() => {}}
      onConfigChange={onConfigChange}
      onDone={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "COM3" }));
  fireEvent.change(screen.getByLabelText("Printer address (leave empty for a serial printer)"), {
    target: { value: "10.0.0.7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "TSPL" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));

  await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
  const saved = onConfigChange.mock.calls.at(-1)![0] as HardwareConfig;
  expect(saved.scanner).toEqual({ port: "COM3", baud: 9600 });
  expect(saved.printer).toEqual({ kind: "tcp", host: "10.0.0.7", port: 9100 });
  expect(saved.printerLanguage).toBe("tspl");
  expect(runs.some(([sql]) => sql.includes("station_meta"))).toBe(true);
});

it("closes the current scanner before opening another port", async () => {
  const calls: string[] = [];
  const hw = hardware({
    closeScanner: async () => {
      calls.push("close");
    },
    openScanner: async () => {
      calls.push("open");
    },
  });

  render(
    <WorkstationSetup
      hw={hw}
      exec={{ run: async () => {}, all: async () => [] }}
      sound={{ muted: false, volume: 1 }}
      onSoundChange={() => {}}
      onConfigChange={() => {}}
      onDone={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "COM3" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect scanner" }));
  await waitFor(() => expect(calls).toEqual(["close", "open"]));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run workstation-setup`
Expected: FAIL — `onConfigChange` is not a prop, there is no TSPL button, and the connect path never calls `closeScanner`.

- [ ] **Step 3: Implement**

In `apps/station/src/pages/WorkstationSetup.tsx`:

Extend the props:

```tsx
export interface WorkstationSetupProps {
  hw: HardwareContract;
  exec: SqlExecutor;
  sound: SoundSettings;
  onSoundChange: (s: SoundSettings) => void;
  /** Fired after the configuration is persisted, so the app can apply it. */
  onConfigChange: (config: HardwareConfig) => void;
  onDone: () => void;
}
```

Add language state and seed every field from the stored configuration on mount:

```tsx
const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>("zpl");

useEffect(() => {
  void loadHardwareConfig(exec).then((config) => {
    if (config.scanner) {
      setPort(config.scanner.port);
      setBaud(String(config.scanner.baud));
    }
    if (config.printer?.kind === "tcp") setPrinterHost(config.printer.host);
    if (config.printer?.kind === "serial") setPrinterPort(config.printer.port);
    setPrinterLanguage(config.printerLanguage);
  });
}, [exec]);
```

Close before opening, so a wrong port is recoverable:

```tsx
async function openScanner() {
  setBusy(true);
  setError(null);
  try {
    // Retire any previous session first: without this a wrong port leaves
    // the scanner "already open" until the app restarts.
    await hw.closeScanner();
    await hw.openScanner(port, Number(baud) || DEFAULT_BAUD);
  } catch (err) {
    setError(err instanceof Error ? err.message : t("setup.failed"));
  } finally {
    setBusy(false);
  }
}
```

Build the configuration and persist it on Done:

```tsx
function currentConfig(): HardwareConfig {
  const printer: PrintTarget | null = printerHost
    ? { kind: "tcp", host: printerHost, port: DEFAULT_PRINTER_PORT }
    : printerPort
      ? { kind: "serial", port: printerPort, baud: Number(baud) || DEFAULT_BAUD }
      : null;
  return {
    scanner: port ? { port, baud: Number(baud) || DEFAULT_BAUD } : null,
    printer,
    printerLanguage,
  };
}

async function finish() {
  setBusy(true);
  setError(null);
  const config = currentConfig();
  try {
    await saveHardwareConfig(exec, config);
    onConfigChange(config);
    onDone();
  } catch (err) {
    setError(err instanceof Error ? err.message : t("setup.failed"));
  } finally {
    setBusy(false);
  }
}
```

Render the language choice in the printer section, and make Done call `finish`:

```tsx
<div style={{ display: "flex", gap: 12 }}>
  <span>{t("setup.printerLanguage")}</span>
  <Button
    type="button"
    variant={printerLanguage === "zpl" ? "primary" : "secondary"}
    style={{ minHeight: 64 }}
    onClick={() => setPrinterLanguage("zpl")}
  >
    {t("setup.languageZpl")}
  </Button>
  <Button
    type="button"
    variant={printerLanguage === "tspl" ? "primary" : "secondary"}
    style={{ minHeight: 64 }}
    onClick={() => setPrinterLanguage("tspl")}
  >
    {t("setup.languageTspl")}
  </Button>
</div>
```

```tsx
<Button type="button" style={{ minHeight: 64 }} disabled={busy} onClick={() => void finish()}>
  {t("setup.done")}
</Button>
```

Make the test print use the configured language and the real rasterizer, so it verifies the production path:

```tsx
async function testPrint() {
  setBusy(true);
  setError(null);
  try {
    const config = currentConfig();
    if (!config.printer) throw new Error(t("setup.failed"));
    // A minimal spec: one line of text, rendered by the same code that will
    // print real labels, in the language this workstation is configured for.
    const spec: LabelTemplateSpec = {
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: config.printerLanguage,
      elements: [{ id: "t", kind: "text", text: "Markiro", xMm: 4, yMm: 4, fontSizePt: 12 }],
    };
    const bytes = await renderLabelBytes(
      spec,
      sampleLabelData(),
      config.printerLanguage,
      rasterizeText,
    );
    await hw.print(config.printer, bytes);
  } catch (err) {
    setError(err instanceof Error ? err.message : t("setup.failed"));
  } finally {
    setBusy(false);
  }
}
```

- [ ] **Step 4: Add the i18n keys to BOTH dictionaries**

`en.json`, inside `setup`:

```json
    "printerLanguage": "Printer language",
    "languageZpl": "ZPL",
    "languageTspl": "TSPL",
    "saved": "Settings saved",
```

`ru.json`, inside `setup`:

```json
    "printerLanguage": "Язык принтера",
    "languageZpl": "ZPL",
    "languageTspl": "TSPL",
    "saved": "Настройки сохранены",
```

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/station test`
Expected: PASS — the two new setup tests, the existing setup tests and the i18n parity test.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/pages/WorkstationSetup.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/workstation-setup.test.tsx
git commit -m "feat(station): persist the workstation configuration and printer language"
```

---

### Task 7: Three honest scanner states in the status bar

**Files:**

- Modify: `apps/station/src/ui/StatusBar.tsx`, `apps/station/src/ui/FloorShell.tsx`, `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Test: `apps/station/test/status-bar.test.tsx`

**Interfaces:**

- Produces: `type ScannerIndicator = "keyboard" | "connected" | "disconnected"`; `StatusBarProps { online: boolean; scanner: ScannerIndicator; printerConfigured: boolean }`; `FloorShellProps` threads the same two fields.

New i18n keys under `shell`: `scannerKeyboard`, `scannerDisconnected`.

- [ ] **Step 1: Write the failing test**

Replace the two indicator tests in `apps/station/test/status-bar.test.tsx`:

```tsx
describe("StatusBar", () => {
  it("reports the keyboard wedge when no serial scanner is configured", () => {
    render(<StatusBar online scanner="keyboard" printerConfigured={false} />);
    expect(screen.getByText("Keyboard")).toBeDefined();
  });

  it("reports a connected serial scanner", () => {
    render(<StatusBar online scanner="connected" printerConfigured />);
    expect(screen.getByText("Connected")).toBeDefined();
  });

  it("raises the alarm when a configured scanner drops", () => {
    render(<StatusBar online scanner="disconnected" printerConfigured />);
    expect(screen.getByText("No signal")).toBeDefined();
  });

  it("reports a printer that is not configured", () => {
    render(<StatusBar online scanner="keyboard" printerConfigured={false} />);
    expect(screen.getByText("Not configured")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run status-bar`
Expected: FAIL — `StatusBar` still takes `scannerConnected: boolean`, so TypeScript rejects `scanner` and none of the new copy renders.

- [ ] **Step 3: Implement**

In `apps/station/src/ui/StatusBar.tsx`:

```tsx
/** What the station can honestly say about its scanner. */
export type ScannerIndicator = "keyboard" | "connected" | "disconnected";

export interface StatusBarProps {
  online: boolean;
  scanner: ScannerIndicator;
  printerConfigured: boolean;
}

export function StatusBar({ online, scanner, printerConfigured }: StatusBarProps) {
  const { t } = useTranslation();
  // A keyboard wedge is indistinguishable from a keyboard, so "keyboard" is
  // the honest label when no serial scanner is configured — it neither claims
  // a device we cannot see nor implies nothing works.
  const scannerLabel =
    scanner === "connected"
      ? t("shell.connected")
      : scanner === "disconnected"
        ? t("shell.scannerDisconnected")
        : t("shell.scannerKeyboard");
  return (
    <header
      style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        padding: "8px 16px",
        fontSize: "1rem",
      }}
    >
      <StatusChip
        status={online ? "ok" : "warn"}
        label={online ? t("shell.online") : t("shell.offline")}
      />
      <span>{t("shell.sync")}: 0</span>
      <span>
        {t("shell.agent")}: <span>{t("shell.notConfigured")}</span>
      </span>
      <span>
        {t("shell.scanner")}: <span>{scannerLabel}</span>
      </span>
      <span>
        {t("shell.printer")}:{" "}
        <span>{printerConfigured ? t("shell.connected") : t("shell.notConfigured")}</span>
      </span>
      <span>{t("shell.teammates")}: +0</span>
    </header>
  );
}
```

In `apps/station/src/ui/FloorShell.tsx`, replace `scannerConnected: boolean` with `scanner: ScannerIndicator` in the props and pass it straight through to `StatusBar`.

- [ ] **Step 4: Add the i18n keys to BOTH dictionaries**

`en.json`, inside `shell`: `"scannerKeyboard": "Keyboard", "scannerDisconnected": "No signal",`
`ru.json`, inside `shell`: `"scannerKeyboard": "Клавиатурный", "scannerDisconnected": "Нет связи",`

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/station test`
Expected: PASS — the four status-bar tests plus the rest (App.tsx still passes the old prop and will be updated in Task 8; if the suite fails to typecheck there, complete Task 8 before committing and commit both together).

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/ui/StatusBar.tsx apps/station/src/ui/FloorShell.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/status-bar.test.tsx
git commit -m "feat(station): three honest scanner states in the status bar"
```

---

### Task 8: Wire the hardware into the app

**Files:**

- Modify: `apps/station/src/App.tsx`, `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Test: `apps/station/test/App.test.tsx`

**Interfaces:**

- Consumes: `loadHardwareConfig`/`HardwareConfig` (Task 1), `tauriHardware`/`createHardwareScanSource`/`ScannerStatus` (Tasks 4 and 05b-2), `createKeyboardWedgeSource`, `WorkstationSetup` (Task 6), `ScannerIndicator` (Task 7).
- Produces: nothing further tasks consume.

New i18n key under `shell`: `setup` (the button that opens the setup screen).

This is the task that makes the hardware half reachable at all: today `App.tsx` imports none of it.

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/App.test.tsx`:

```tsx
it("uses the keyboard wedge when no serial scanner is configured", () => {
  expect(pickScanSource({ scanner: null, printer: null, printerLanguage: "zpl" })).toBe("wedge");
});

it("uses the hardware scanner once one is configured", () => {
  expect(
    pickScanSource({
      scanner: { port: "COM3", baud: 9600 },
      printer: null,
      printerLanguage: "zpl",
    }),
  ).toBe("hardware");
});

it("shows the keyboard indicator until a configured scanner reports connected", () => {
  expect(scannerIndicator({ scanner: null, printer: null, printerLanguage: "zpl" }, null)).toBe(
    "keyboard",
  );
  const configured = {
    scanner: { port: "COM3", baud: 9600 },
    printer: null,
    printerLanguage: "zpl" as const,
  };
  expect(scannerIndicator(configured, null)).toBe("disconnected");
  expect(scannerIndicator(configured, "connected")).toBe("connected");
  expect(scannerIndicator(configured, "disconnected")).toBe("disconnected");
});
```

Import the two helpers at the top of that file:

```tsx
import { pickScanSource, scannerIndicator } from "../src/App.js";
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run App`
Expected: FAIL — neither helper is exported from `App.tsx`.

- [ ] **Step 3: Implement the pure decisions**

Add to `apps/station/src/App.tsx`, beside `nextStationView` (both are exported so they can be tested without rendering, which jsdom cannot do for the Tauri paths):

```tsx
/**
 * Which scan source a configured station should use. The keyboard wedge is
 * the default because most USB scanners are HID keyboards and need no setup;
 * a serial scanner is opted into on the setup screen.
 */
export function pickScanSource(config: HardwareConfig): "wedge" | "hardware" {
  return config.scanner ? "hardware" : "wedge";
}

/**
 * What the status bar may honestly claim. Without a configured serial scanner
 * the wedge is working but undetectable, so we say "keyboard" rather than
 * claiming or denying a device. With one configured, the Rust status event is
 * the only truth — and until it arrives we assume disconnected, because
 * showing a green light for a scanner that never opened is the failure this
 * indicator exists to prevent.
 */
export function scannerIndicator(
  config: HardwareConfig,
  status: ScannerStatus | null,
): ScannerIndicator {
  if (!config.scanner) return "keyboard";
  return status === "connected" ? "connected" : "disconnected";
}
```

- [ ] **Step 4: Wire the app**

Add the state and effects alongside the existing hooks (before the `if (!config)` early return, per the Rules of Hooks):

```tsx
const [hardwareConfig, setHardwareConfig] = useState<HardwareConfig>(DEFAULT_HARDWARE_CONFIG);
const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
const [showSetup, setShowSetup] = useState(false);

useEffect(() => {
  void loadHardwareConfig(tauriExecutor).then(setHardwareConfig);
}, []);

// Open a configured scanner at start so a set-up station comes up ready.
useEffect(() => {
  if (!hardwareConfig.scanner) return;
  const { port, baud } = hardwareConfig.scanner;
  void tauriHardware.openScanner(port, baud).catch((err: unknown) => {
    console.error("station: opening the configured scanner failed", err);
  });
}, [hardwareConfig.scanner?.port, hardwareConfig.scanner?.baud]);

useEffect(() => {
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  void tauriHardware
    .onScannerStatus(setScannerStatus)
    .then((fn) => {
      if (stopped) fn();
      else unsubscribe = fn;
    })
    .catch((err: unknown) => {
      console.error("station: scanner status subscription failed", err);
    });
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}, []);

const wedgeSource = useMemo(() => createKeyboardWedgeSource(), []);
const hardwareSource = useMemo(() => createHardwareScanSource(tauriHardware), []);
const scanSource = pickScanSource(hardwareConfig) === "hardware" ? hardwareSource : wedgeSource;
```

Replace the existing `scanSource` memo with the pair above, pass the live indicator into `FloorShell`, and add the setup route inside the floor stage.

**Delete the comment block above `<FloorShell`** — it currently explains that both indicators are hardcoded because "the workstation setup screen is not wired into the app in this slice", which this task makes false. Replace it with a one-line note that both values now come from the stored configuration and the live scanner status.

```tsx
    <FloorShell
      online={online}
      scanner={scannerIndicator(hardwareConfig, scannerStatus)}
      printerConfigured={hardwareConfig.printer !== null}
      tasks={[]}
      activeTaskId=""
      onSelectTask={() => {}}
    >
      {showSetup ? (
        <WorkstationSetup
          hw={tauriHardware}
          exec={tauriExecutor}
          sound={sound}
          onSoundChange={setSound}
          onConfigChange={setHardwareConfig}
          onDone={() => setShowSetup(false)}
        />
      ) : shift ? (
```

Add a way in — a button in the shift-selection stage, so an operator can reach setup without a shift:

```tsx
<ShiftSelection
  client={activeClient}
  onSelected={handleShiftEntered}
  onNew={() => setFloorView("new")}
  onSetup={() => setShowSetup(true)}
/>
```

`ShiftSelection` gains an optional `onSetup?: () => void` prop and, when provided, renders a secondary button labelled `t("shell.setup")` beside "New shift".

- [ ] **Step 5: Add the i18n key to BOTH dictionaries**

`en.json` inside `shell`: `"setup": "Workstation setup",`
`ru.json` inside `shell`: `"setup": "Настройка рабочего места",`

- [ ] **Step 6: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint`
Expected: PASS on all three.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/App.tsx apps/station/src/pages/ShiftSelection.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/App.test.tsx
git commit -m "feat(station): wire the configured hardware into the app"
```

---

### Task 9: Restrict the device-key surface

**Files:**

- Modify: `apps/api/src/modules/employees/employees.controller.ts`
- Create: `docs/device-key-surface.md`
- Test: `apps/api/test/employees.e2e.test.ts`

**Interfaces:**

- Consumes: `SessionOnlyGuard` from `apps/api/src/tenancy/session-only.guard.ts` (built in 05a).

**Why:** `GET /employees` is `TenantGuard`-only, so a station api-key can list every employee **including plaintext badge codes** — which undoes the reason the roster ships only hashes to devices. The station never calls this module.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/employees.e2e.test.ts` (mint a station key the way `station-devices.e2e.test.ts` does):

```ts
// Routes carry no global prefix — only Better Auth's own `/api/auth/*` mount
// does — so these are `/station-devices` and `/employees`, matching the
// existing suites.
it("rejects a station api-key: employees are cabinet-only", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);

  const device = await agent.post("/station-devices").send({ name: "Line 1 terminal" }).expect(201);
  const apiKey = (device.body as { apiKey: string }).apiKey;

  await request(app!.getHttpServer()).get("/employees").set("x-api-key", apiKey).expect(403);
});

it("still serves employees to a signed-in cabinet user", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  await agent.get("/employees").expect(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run employees`
Expected: FAIL — the station key gets 200 instead of 403.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/employees/employees.controller.ts`, import the guard and add it to the class decorator:

```ts
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
```

```ts
@UseGuards(TenantGuard, SessionOnlyGuard)
```

- [ ] **Step 4: Run it green**

Run the same command as Step 2.
Expected: PASS — both new cases plus the existing employees e2e.

- [ ] **Step 5: Document the surface**

Create `docs/device-key-surface.md`:

```markdown
# What a station api-key may reach

A station device authenticates with an organization-owned api-key
(`x-api-key`). `TenantGuard` accepts it for tenant resolution, so **every
tenant-guarded route is reachable by a device unless it also carries
`SessionOnlyGuard`**. A floor device is the most theft-exposed credential in
the system, so this list is deliberately explicit.

## Reachable by a device key

| Route                                                            | Why the station needs it                  |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `GET /station/operators`                                         | the offline sign-in roster (hashes only)  |
| `GET /shifts`, `GET /shifts/:id/bundle`, `POST /shifts/:id/open` | shift selection and the offline bundle    |
| `GET /products`, `POST /products/gtin-check`                     | ad-hoc shift creation from a scanned GTIN |

## Cabinet-only (`SessionOnlyGuard`)

| Module                     | Why a device must not reach it                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `station-devices`          | a stolen device could enrol or revoke other devices                                                                        |
| `employees`                | `EmployeeDto` carries **plaintext badge codes**, which is exactly what shipping only hashes to devices is meant to prevent |
| `operators` (admin routes) | granting or resetting station access is a manager action                                                                   |

## Rule for new routes

Anything a station does not demonstrably need gets `SessionOnlyGuard`. When
adding a tenant-guarded route, decide which table above it belongs in and add
it there in the same change.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/employees/employees.controller.ts apps/api/test/employees.e2e.test.ts docs/device-key-surface.md
git commit -m "fix(api): make employees cabinet-only and document the device-key surface"
```

---

### Task 10: Docs and full verification

**Files:**

- Modify: `apps/station/README.md`, `docs/hardware-acceptance-checklist.md`, `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`

- [ ] **Step 1: Document the slice in the station README**

Add a section describing: the `hardware_config` entry in `station_meta` (scanner port/baud, printer target, printer language); that printing renders the shift's spec through the emitter the **configured language** selects, so the template's `language` field is only the editor's preview/download choice; the three scanner indicator states and where they come from; that the roster is published by generation so an interrupted refresh is never visible. Link `docs/device-key-surface.md`.

- [ ] **Step 2: Update the hardware acceptance checklist**

Add these items under the scanner/printer section:

```markdown
- [ ] A configured serial scanner opens at station start and the status bar shows "connected".
- [ ] Unplugging the scanner mid-shift flips the indicator to "no signal".
- [ ] Choosing a wrong port, then the right one, works without restarting the app (close-before-open).
- [ ] A ZPL template prints correctly on a TSPL printer and vice versa (the configured language wins).
- [ ] The setup screen's test print produces the same output as a real label print.
```

- [ ] **Step 3: Update the roadmap**

Mark the `05b-3` row done with today's date, and note that PDF output plus OS-spooler printing remain a separate slice.

- [ ] **Step 4: Full verification**

```bash
pnpm format:check
pnpm turbo lint typecheck test build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: every turbo task green; report the per-package test counts. The API e2e suites need the env from Global Constraints. If `format:check` flags a file, run `pnpm format` and re-check. A known environment flake can fail one untouched API e2e file under host CPU contention — re-run and report both runs honestly rather than changing test infrastructure.

- [ ] **Step 5: Commit**

```bash
git add apps/station/README.md docs/hardware-acceptance-checklist.md docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md
git commit -m "docs: workstation configuration and hardware wiring"
```
