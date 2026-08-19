# Station USB Printer Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect USB label printers on Windows via the print spooler, let the operator pick one in workstation setup, and print raw ZPL/TSPL bytes to it — as a third transport next to TCP and COM.

**Architecture:** A new `list_usb_printers` Tauri command enumerates local spooler queues on USB ports; `PrintTarget` gains a `Usb { printer }` variant printed via spooler RAW (`OpenPrinterW` → `StartDocPrinterW(RAW)` → `WritePrinter`). The TS `HardwareContract`, hardware config parsing, and the printer setup panel gain the matching `usb` transport. The transport-independent `printerLanguage` (ZPL/TSPL) field is untouched and applies to USB automatically.

**Tech Stack:** Rust (Tauri 2, `windows-sys` 0.61), React/TypeScript (Vitest, Testing Library), i18next.

**Spec:** `docs/superpowers/specs/2026-08-19-station-usb-printer-design.md`

## Global Constraints

- Windows only: non-Windows `list_usb_printers` returns `[]`; non-Windows USB print returns "USB printing is only available on Windows".
- Spooler RAW only — no PDF, no GDI rendering, no direct `usbprint.sys`/WinUSB access, no live plug/unplug subscriptions.
- Detection filter: local queues whose port name starts with `USB` (case-insensitive).
- Config stores the printer by spooler queue name (`{ kind: "usb", printer: string }`); old stored configs must keep parsing unchanged.
- `printerLanguage: "zpl" | "tspl"` stays a transport-independent field; do not move or change its UI block.
- No new crates: extend the existing `windows-sys` target dependency features only.
- All user-visible text goes through i18n (`ru.json`/`en.json` in lockstep — a parity test enforces identical key sets).
- Win32 calls stay behind `#[cfg(windows)]`; keep pure, cross-platform-testable functions for filtering and serde.
- Work happens on branch `feature/station-usb-printer` in an isolated worktree; the main checkout has unrelated uncommitted user work that must not be touched.
- `EnumPrinters`/`WritePrinter` are not unit-tested; physical Zebra/TSC acceptance on Windows is a separate gate and is documented, not claimed.

---

### Task 1: Branch, worktree, and baseline

**Files:**
- Create: `.worktrees/station-usb-printer/` (git worktree)

**Interfaces:**
- Produces: a clean worktree on branch `feature/station-usb-printer` where all later tasks run, with workspace deps installed and `@markiro/domain` / `@markiro/ui` / `@markiro/db` built so station tests resolve compiled output.

- [ ] **Step 1: Create the worktree and branch**

Run from the repository root (`/Users/thevladbog/PRSOME/q`). The branch starts from the current HEAD of `codex/fix-admin-operations-ui`, which contains the committed spec. Do not touch the main checkout's uncommitted changes.

```bash
git worktree add .worktrees/station-usb-printer -b feature/station-usb-printer
cd .worktrees/station-usb-printer
git status --short
```

Expected: empty `git status` output in the worktree.

- [ ] **Step 2: Install dependencies and build station's workspace deps**

```bash
corepack enable
pnpm install --frozen-lockfile || pnpm install --no-lockfile
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/db build
```

Expected: all builds succeed. (Fresh worktrees fail to resolve workspace packages until compiled output exists.)

- [ ] **Step 3: Confirm the baseline is green before changing anything**

```bash
pnpm --filter @markiro/station exec vitest run test/hardware.test.ts test/hardware-config.test.ts test/workstation-setup.test.tsx
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: PASS. If the baseline fails, stop and report — do not diagnose it as part of this feature.

### Task 2: Rust — USB printer enumeration command

**Files:**
- Modify: `apps/station/src-tauri/Cargo.toml` (windows-sys features)
- Modify: `apps/station/src-tauri/src/printer.rs`
- Modify: `apps/station/src-tauri/src/lib.rs:43-54` (register the command)

**Interfaces:**
- Produces: Tauri command `list_usb_printers() -> Result<Vec<UsbPrinter>, String>` where `UsbPrinter` serializes as `{ "name": string, "port": string }` (camelCase); pure fn `filter_usb_printers(Vec<(String, String)>) -> Vec<UsbPrinter>`.
- Consumed by: Task 4's `invoke("list_usb_printers")`.

- [ ] **Step 1: Write the failing filter tests**

Append to the `tests` module in `apps/station/src-tauri/src/printer.rs`:

```rust
    #[test]
    fn filter_usb_printers_keeps_only_usb_ports_case_insensitively() {
        let filtered = super::filter_usb_printers(vec![
            ("Zebra ZD421".to_string(), "USB001".to_string()),
            ("Office Laser".to_string(), "192.168.0.20".to_string()),
            ("TSC TE200".to_string(), "usb002".to_string()),
            ("Microsoft Print to PDF".to_string(), "PORTPROMPT:".to_string()),
        ]);
        let pairs: Vec<(String, String)> =
            filtered.into_iter().map(|p| (p.name, p.port)).collect();
        assert_eq!(
            pairs,
            vec![
                ("Zebra ZD421".to_string(), "USB001".to_string()),
                ("TSC TE200".to_string(), "usb002".to_string()),
            ]
        );
    }

    #[test]
    fn filter_usb_printers_returns_empty_for_no_printers() {
        assert!(super::filter_usb_printers(Vec::new()).is_empty());
    }
```

Also extend the test module's `use` line: `use super::{decode_payload, resolve_socket_addr};` stays, the new tests reference `super::filter_usb_printers` directly.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: compile error "cannot find function `filter_usb_printers`".

- [ ] **Step 3: Implement the filter, the Windows enumeration, and the command**

In `apps/station/src-tauri/src/printer.rs`, change the serde import to include `Serialize`:

```rust
use serde::{Deserialize, Serialize};
```

Then add below `decode_payload`:

```rust
/// One installed Windows printer queue bound to a USB port. Identified by the
/// spooler queue name (stable across replugging), not the `USBnnn` port.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinter {
    pub name: String,
    pub port: String,
}

/// Keeps only queues whose port says USB (`USB001`, ...). Pure so it is
/// testable on every OS; the Win32 enumeration behind it is not.
pub fn filter_usb_printers(printers: Vec<(String, String)>) -> Vec<UsbPrinter> {
    printers
        .into_iter()
        .filter(|(_, port)| port.to_ascii_uppercase().starts_with("USB"))
        .map(|(name, port)| UsbPrinter { name, port })
        .collect()
}

/// `async` + `spawn_blocking` for the same reason as `print_bytes`: the
/// spooler RPC is blocking and must not stall the IPC thread.
#[tauri::command]
pub async fn list_usb_printers() -> Result<Vec<UsbPrinter>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<UsbPrinter>, String> {
        #[cfg(windows)]
        {
            Ok(filter_usb_printers(spooler::enumerate_local_printers()?))
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Windows print-spooler access: enumeration here, RAW printing added by the
/// next task. Everything unsafe stays inside this module.
#[cfg(windows)]
mod spooler {
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W,
    };

    pub(super) fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }

    pub(super) fn last_error(call: &str) -> String {
        format!("{call} failed: {}", std::io::Error::last_os_error())
    }

    /// Local queues as (queue name, port name) pairs. The first
    /// `EnumPrintersW` call intentionally measures the needed buffer size.
    pub fn enumerate_local_printers() -> Result<Vec<(String, String)>, String> {
        unsafe {
            let mut needed = 0u32;
            let mut returned = 0u32;
            EnumPrintersW(
                PRINTER_ENUM_LOCAL,
                std::ptr::null(),
                2,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut returned,
            );
            if needed == 0 {
                return Ok(Vec::new());
            }
            let mut buffer = vec![0u8; needed as usize];
            if EnumPrintersW(
                PRINTER_ENUM_LOCAL,
                std::ptr::null(),
                2,
                buffer.as_mut_ptr(),
                needed,
                &mut needed,
                &mut returned,
            ) == 0
            {
                return Err(last_error("EnumPrintersW"));
            }
            let infos = std::slice::from_raw_parts(
                buffer.as_ptr() as *const PRINTER_INFO_2W,
                returned as usize,
            );
            Ok(infos
                .iter()
                .map(|info| (from_wide(info.pPrinterName), from_wide(info.pPortName)))
                .collect())
        }
    }
}
```

In `apps/station/src-tauri/Cargo.toml`, extend the windows-sys features:

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = [
  "Win32_Storage_FileSystem",
  "Win32_Foundation",
  "Win32_Graphics_Printing",
] }
```

In `apps/station/src-tauri/src/lib.rs`, add to the `generate_handler!` list after `printer::print_bytes,`:

```rust
            printer::list_usb_printers,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: PASS, including the two new filter tests. On macOS the `spooler` module does not compile at all (`cfg(windows)`), so also compile-check the Windows side:

```bash
rustup target add x86_64-pc-windows-msvc
cargo check --manifest-path apps/station/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: `cargo check` succeeds. If exact `windows-sys` 0.61 signatures differ (pointer mutability, `PWSTR` vs `PCWSTR`), adjust the calls in the `spooler` module until this check passes — the check is the source of truth for signatures. If the msvc target cannot check locally (missing toolchain pieces), state that explicitly in the task report and rely on the `station-windows-build` CI workflow.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src-tauri/Cargo.toml apps/station/src-tauri/src/printer.rs apps/station/src-tauri/src/lib.rs
git commit -m "feat(station): enumerate USB printers via the Windows spooler"
```

### Task 3: Rust — `PrintTarget::Usb` and spooler RAW printing

**Files:**
- Modify: `apps/station/src-tauri/src/printer.rs`

**Interfaces:**
- Consumes: `spooler::wide`, `spooler::last_error` from Task 2.
- Produces: `PrintTarget::Usb { printer: String }` (serde tag `"usb"`, field `printer`); `fn print_to_target(target: PrintTarget, bytes: &[u8]) -> Result<(), String>` used by `print_bytes`. Task 4's TS `{ kind: "usb"; printer: string }` must match this serde shape exactly.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `printer.rs`:

```rust
    #[test]
    fn deserializes_a_usb_print_target() {
        let target: super::PrintTarget =
            serde_json::from_str(r#"{"kind":"usb","printer":"Zebra ZD421"}"#).unwrap();
        match target {
            super::PrintTarget::Usb { printer } => assert_eq!(printer, "Zebra ZD421"),
            _ => panic!("expected the usb variant"),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn usb_printing_reports_windows_only_off_windows() {
        let err = super::print_to_target(
            super::PrintTarget::Usb {
                printer: "Zebra ZD421".to_string(),
            },
            b"^XA^XZ",
        )
        .unwrap_err();
        assert!(err.contains("Windows"), "error should say Windows-only: {err}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: compile error — no `Usb` variant, no `print_to_target`.

- [ ] **Step 3: Implement the variant and refactor `print_bytes`**

In `printer.rs`, add the variant to `PrintTarget`:

```rust
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrintTarget {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
    Usb { printer: String },
}
```

Extract the match from `print_bytes` into a sync function (the existing Serial/Tcp bodies move verbatim) and add the Usb arm:

```rust
/// Synchronous dispatch to one transport. Split out of `print_bytes` so the
/// non-Windows USB error is unit-testable without the Tauri runtime.
fn print_to_target(target: PrintTarget, bytes: &[u8]) -> Result<(), String> {
    match target {
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(&port, baud)
                .timeout(Duration::from_secs(5))
                .open()
                .map_err(|e| e.to_string())?;
            handle.write_all(bytes).map_err(|e| e.to_string())?;
            handle.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Tcp { host, port } => {
            let addr = resolve_socket_addr(&host, port)?;
            let mut stream =
                TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            stream.write_all(bytes).map_err(|e| e.to_string())?;
            stream.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Usb { printer } => {
            #[cfg(windows)]
            {
                spooler::print_raw(&printer, bytes)
            }
            #[cfg(not(windows))]
            {
                let _ = printer;
                Err("USB printing is only available on Windows".to_string())
            }
        }
    }
}
```

`print_bytes` becomes:

```rust
#[tauri::command]
pub async fn print_bytes(target: PrintTarget, payload_base64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_base64)?;
    tauri::async_runtime::spawn_blocking(move || print_to_target(target, &bytes))
        .await
        .map_err(|e| e.to_string())?
}
```

(Keep the existing doc comment about `spawn_blocking` on `print_bytes`.)

Add RAW printing to the `spooler` module (extend its imports):

```rust
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW,
        StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_2W,
    };
```

```rust
    /// Sends raw ZPL/TSPL bytes through the spooler with datatype RAW, so the
    /// driver renders nothing and the printer firmware interprets its native
    /// language. Handles are closed on every path.
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
        let printer_w = wide(printer);
        let doc_name = wide("Markiro label");
        let datatype = wide("RAW");
        unsafe {
            let mut handle = std::ptr::null_mut();
            if OpenPrinterW(printer_w.as_ptr(), &mut handle, std::ptr::null()) == 0 {
                return Err(format!(
                    "printer \"{printer}\": {}",
                    last_error("OpenPrinterW")
                ));
            }
            let result = print_document(handle, printer, &doc_name, &datatype, bytes);
            ClosePrinter(handle);
            result
        }
    }

    unsafe fn print_document(
        handle: *mut core::ffi::c_void,
        printer: &str,
        doc_name: &[u16],
        datatype: &[u16],
        bytes: &[u8],
    ) -> Result<(), String> {
        let doc = DOC_INFO_1W {
            pDocName: doc_name.as_ptr() as *mut u16,
            pOutputFile: std::ptr::null_mut(),
            pDatatype: datatype.as_ptr() as *mut u16,
        };
        if StartDocPrinterW(handle, 1, &doc as *const _ as *const u8) == 0 {
            return Err(format!(
                "printer \"{printer}\": {}",
                last_error("StartDocPrinterW")
            ));
        }
        let page_result = (|| {
            if StartPagePrinter(handle) == 0 {
                return Err(format!(
                    "printer \"{printer}\": {}",
                    last_error("StartPagePrinter")
                ));
            }
            let mut written = 0u32;
            let write_ok = WritePrinter(
                handle,
                bytes.as_ptr() as *const core::ffi::c_void,
                bytes.len() as u32,
                &mut written,
            );
            let write_err = (write_ok == 0 || written != bytes.len() as u32)
                .then(|| format!("printer \"{printer}\": {}", last_error("WritePrinter")));
            EndPagePrinter(handle);
            write_err.map_or(Ok(()), Err)
        })();
        EndDocPrinter(handle);
        page_result
    }
```

Note: exact parameter types for `StartDocPrinterW`/`OpenPrinterW`/handle types come from `windows-sys` 0.61 — the `cargo check --target x86_64-pc-windows-msvc` in the next step is the source of truth; adjust casts until it passes without changing the call sequence or error texts.

- [ ] **Step 4: Run tests and the Windows compile check**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
cargo check --manifest-path apps/station/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: tests PASS (including both new ones); Windows check compiles. Same CI fallback rule as Task 2.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src-tauri/src/printer.rs
git commit -m "feat(station): print raw label bytes to USB printers via spooler RAW"
```

### Task 4: TS contract and hardware config

**Files:**
- Modify: `apps/station/src/lib/hardware.ts`
- Modify: `apps/station/src/lib/hardware-config.ts`
- Modify: `apps/station/test/hardware-config.test.ts`
- Modify: `apps/station/test/hardware.test.ts` (mock objects)
- Modify: `apps/station/test/workstation-setup.test.tsx` (`hardware()` helper)
- Modify: `apps/station/test/App.test.tsx` (`hardwareMock`)

**Interfaces:**
- Consumes: Rust command `list_usb_printers` (Task 2) returning `{ name, port }[]`; serde shape `{"kind":"usb","printer":...}` (Task 3).
- Produces: `PrintTarget` union member `{ kind: "usb"; printer: string }`; `interface UsbPrinterInfo { name: string; port: string }`; `HardwareContract.listUsbPrinters(): Promise<UsbPrinterInfo[]>`; `parsePrinter` accepting the usb shape. Tasks 5–6 rely on these exact names.

- [ ] **Step 1: Write the failing config tests**

Append to `apps/station/test/hardware-config.test.ts` inside `describe("hardware config", ...)`:

```ts
  it("round-trips a USB printer target", async () => {
    const exec = await makeExec();
    const usb: HardwareConfig = {
      scanner: null,
      printer: { kind: "usb", printer: "Zebra ZD421" },
      printerLanguage: "tspl",
      verifyPrintedLabel: false,
    };
    await saveHardwareConfig(exec, usb);
    expect(await loadHardwareConfig(exec)).toEqual(usb);
  });

  it("drops a stored USB printer with an empty queue name", async () => {
    const exec = await makeExec();
    await exec.run("INSERT INTO station_meta (key, value) VALUES (?,?)", [
      "hardware_config",
      JSON.stringify({
        scanner: null,
        printer: { kind: "usb", printer: "" },
        printerLanguage: "zpl",
        verifyPrintedLabel: false,
      }),
    ]);
    expect((await loadHardwareConfig(exec)).printer).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @markiro/station exec vitest run test/hardware-config.test.ts
```

Expected: FAIL — TS error: `kind: "usb"` is not assignable to `PrintTarget`.

- [ ] **Step 3: Extend the contract and the parser**

In `apps/station/src/lib/hardware.ts`, replace the `PrintTarget` type and extend the contract:

```ts
export type PrintTarget =
  | { kind: "serial"; port: string; baud: number }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "usb"; printer: string };

/** One installed Windows printer queue on a USB port. */
export interface UsbPrinterInfo {
  name: string;
  port: string;
}
```

Add to `HardwareContract` (after `listScannerPorts`):

```ts
  /** Installed USB label printers; empty on non-Windows platforms. */
  listUsbPrinters(): Promise<UsbPrinterInfo[]>;
```

Add to `tauriHardware` (after `listScannerPorts`):

```ts
  listUsbPrinters: () => invoke<UsbPrinterInfo[]>("list_usb_printers"),
```

In `apps/station/src/lib/hardware-config.ts`, extend `parsePrinter`:

```ts
function parsePrinter(value: unknown): PrintTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as {
    kind?: unknown;
    port?: unknown;
    baud?: unknown;
    host?: unknown;
    printer?: unknown;
  };
  if (t.kind === "serial" && typeof t.port === "string" && t.port.length > 0) {
    return { kind: "serial", port: t.port, baud: typeof t.baud === "number" ? t.baud : 9600 };
  }
  if (t.kind === "tcp" && typeof t.host === "string" && t.host.length > 0) {
    return { kind: "tcp", host: t.host, port: typeof t.port === "number" ? t.port : 9100 };
  }
  if (t.kind === "usb" && typeof t.printer === "string" && t.printer.length > 0) {
    return { kind: "usb", printer: t.printer };
  }
  return null;
}
```

Update every `HardwareContract` mock so typecheck stays green — add one line after each mock's `listScannerPorts` entry:

- `apps/station/test/workstation-setup.test.tsx`, `hardware()` helper: `listUsbPrinters: async () => [],`
- `apps/station/test/hardware.test.ts`, both inline `hw: HardwareContract` objects: `listUsbPrinters: async () => [],`
- `apps/station/test/App.test.tsx`, the `vi.hoisted` `hardwareMock`: `listUsbPrinters: vi.fn<() => Promise<{ name: string; port: string }[]>>(async () => []),`

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @markiro/station exec vitest run test/hardware-config.test.ts test/hardware.test.ts
pnpm --filter @markiro/station typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/hardware.ts apps/station/src/lib/hardware-config.ts apps/station/test/hardware-config.test.ts apps/station/test/hardware.test.ts apps/station/test/workstation-setup.test.tsx apps/station/test/App.test.tsx
git commit -m "feat(station): add the USB print target to the hardware contract and config"
```

### Task 5: USB transport in the printer setup panel

**Files:**
- Modify: `apps/station/src/ui/setup/PrinterSetupPanel.tsx`
- Modify: `apps/station/src/i18n/en.json` (`setup` section)
- Modify: `apps/station/src/i18n/ru.json` (`setup` section)
- Test: `apps/station/test/workstation-setup.test.tsx` (compile-level only in this task; behavior tests come with the wiring in Task 6)

**Interfaces:**
- Consumes: `UsbPrinterInfo` from Task 4.
- Produces: new `PrinterSetupPanelProps` members — `usbPrinters: readonly UsbPrinterInfo[]`, `usbPrinter: string`, `onUsbPrinterChange: (name: string) => void`, `onUsbRefresh: () => void`. Task 6 passes these from `WorkstationSetup`.

- [ ] **Step 1: Add the i18n keys (both languages, lockstep)**

In `apps/station/src/i18n/en.json`, inside the `setup` object after `"transportSerial"`:

```json
    "transportUsb": "USB",
    "usbPrinterList": "USB printer",
    "usbRefresh": "Refresh list",
    "usbNotFound": "No USB printers found. Check the connection and that the printer is installed in Windows.",
    "usbMissingSaved": "{{name}} (configured, not detected)",
```

In `apps/station/src/i18n/ru.json`, same position:

```json
    "transportUsb": "USB",
    "usbPrinterList": "USB-принтер",
    "usbRefresh": "Обновить список",
    "usbNotFound": "USB-принтеры не найдены. Проверьте подключение и установку принтера в Windows.",
    "usbMissingSaved": "{{name}} (настроен, не обнаружен)",
```

Run the parity check:

```bash
pnpm --filter @markiro/station exec vitest run test/i18n.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Extend the panel**

In `apps/station/src/ui/setup/PrinterSetupPanel.tsx`:

Import the type:

```ts
import type { PrintTarget, UsbPrinterInfo } from "../../lib/hardware.js";
```

Add to `PrinterSetupPanelProps` (after `serialBaud`):

```ts
  usbPrinters: readonly UsbPrinterInfo[];
  usbPrinter: string;
```

and after `onSerialBaudChange`:

```ts
  onUsbPrinterChange: (name: string) => void;
  onUsbRefresh: () => void;
```

Destructure the four new props in the component signature.

Add the transport choice after the `serial` entry in `transportChoices`:

```ts
    { value: "usb", label: t("setup.transportUsb") },
```

Inside the component, before `return`, build the choices (a selected printer missing from a fresh scan stays visible so refresh cannot silently drop the stored configuration):

```ts
  const usbChoices = [
    ...(usbPrinter !== "" && !usbPrinters.some((p) => p.name === usbPrinter)
      ? [{ value: usbPrinter, label: t("setup.usbMissingSaved", { name: usbPrinter }) }]
      : []),
    ...usbPrinters.map((p) => ({ value: p.name, label: `${p.name} · ${p.port}` })),
  ];
```

In the `setup-panel__fields` block, add a `usb` branch between the `serial` branch and the final `noPrinterHint` fallback:

```tsx
        ) : transport === "usb" ? (
          <>
            {usbChoices.length > 0 ? (
              <fieldset className="setup-choice-group">
                <legend>{t("setup.usbPrinterList")}</legend>
                <div className="setup-choice-group__options">
                  {usbChoices.map((choice) => (
                    <label className="setup-touch-choice" key={choice.value}>
                      <input
                        type="radio"
                        name="usb-printer"
                        checked={usbPrinter === choice.value}
                        disabled={disabled}
                        onChange={() => onUsbPrinterChange(choice.value)}
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="setup-panel__empty">{t("setup.usbNotFound")}</p>
            )}
            <Button
              size="floor"
              variant="secondary"
              disabled={disabled || busy}
              onClick={onUsbRefresh}
            >
              {t("setup.usbRefresh")}
            </Button>
          </>
        ) : (
```

Update the test-print button's disabled condition:

```tsx
          disabled={
            busy ||
            disabled ||
            transport === "none" ||
            (transport === "tcp"
              ? host.length === 0
              : transport === "serial"
                ? serialPort.length === 0
                : usbPrinter.length === 0)
          }
```

- [ ] **Step 3: Verify it compiles (call site updates land in Task 6)**

```bash
pnpm --filter @markiro/station typecheck
```

Expected: exactly one category of error — `WorkstationSetup.tsx` missing the four new `PrinterSetupPanel` props. Any other error means Step 2 is wrong; fix before moving on. (Task 6 fixes the call site; the two tasks land as separate commits but Task 5's commit intentionally leaves typecheck red at the call site — if the executor's process forbids a red intermediate commit, squash Tasks 5 and 6 into one commit at the end of Task 6 instead.)

- [ ] **Step 4: Commit**

```bash
git add apps/station/src/ui/setup/PrinterSetupPanel.tsx apps/station/src/i18n/en.json apps/station/src/i18n/ru.json
git commit -m "feat(station): add the USB transport option to the printer setup panel"
```

### Task 6: Wire USB into WorkstationSetup

**Files:**
- Modify: `apps/station/src/pages/WorkstationSetup.tsx`
- Test: `apps/station/test/workstation-setup.test.tsx`

**Interfaces:**
- Consumes: `HardwareContract.listUsbPrinters` (Task 4), `PrinterSetupPanel` props (Task 5).
- Produces: end-to-end USB flow — detection list, refresh, selection, test print with `{ kind: "usb", printer }`, persistence through `buildConfig`/`saveHardwareConfig`.

- [ ] **Step 1: Write the failing behavior tests**

Append to `apps/station/test/workstation-setup.test.tsx` inside `describe("WorkstationSetup", ...)`. The `hardware()` helper already defaults `listUsbPrinters: async () => []` (Task 4).

```tsx
  const defaultProps = {
    exec: noopExec,
    sound: { muted: false, volume: 1 },
    onSoundChange: () => {},
    onConfigChange: () => {},
    onDone: () => {},
  };

  it("sends a test print to the selected USB printer", async () => {
    const print = vi.fn<(target: PrintTarget, bytes: Uint8Array) => Promise<void>>(
      async () => {},
    );
    const hw = hardware({
      listUsbPrinters: async () => [
        { name: "Zebra ZD421", port: "USB001" },
        { name: "TSC TE200", port: "USB002" },
      ],
      print,
    });
    render(<WorkstationSetup hw={hw} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Zebra ZD421 · USB001" }));
    fireEvent.click(screen.getByRole("button", { name: "Test print" }));
    await waitFor(() =>
      expect(print).toHaveBeenCalledWith(
        { kind: "usb", printer: "Zebra ZD421" },
        expect.any(Uint8Array),
      ),
    );
  });

  it("shows the empty hint and refreshes the USB list on demand", async () => {
    const listUsbPrinters = vi
      .fn<() => Promise<{ name: string; port: string }[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "Zebra ZD421", port: "USB001" }]);
    render(<WorkstationSetup hw={hardware({ listUsbPrinters })} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    expect(await screen.findByText(/No USB printers found/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect(await screen.findByRole("radio", { name: "Zebra ZD421 · USB001" })).toBeDefined();
  });

  it("keeps a configured USB printer selectable when detection no longer lists it", async () => {
    const storedExec: SqlExecutor = {
      run: async () => {},
      all: async <T,>() =>
        [
          {
            value: JSON.stringify({
              scanner: null,
              printer: { kind: "usb", printer: "Zebra ZD421" },
              printerLanguage: "tspl",
              verifyPrintedLabel: false,
            }),
          },
        ] as T[],
    };
    render(<WorkstationSetup hw={hardware()} {...defaultProps} exec={storedExec} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    const missing = await screen.findByRole("radio", {
      name: "Zebra ZD421 (configured, not detected)",
    });
    expect((missing as HTMLInputElement).checked).toBe(true);
  });

  it("saves the USB printer into the hardware config", async () => {
    const onConfigChange = vi.fn();
    const hw = hardware({
      listUsbPrinters: async () => [{ name: "TSC TE200", port: "USB002" }],
    });
    render(
      <WorkstationSetup hw={hw} {...defaultProps} onConfigChange={onConfigChange} />,
    );
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(await screen.findByRole("radio", { name: "TSC TE200 · USB002" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(onConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ printer: { kind: "usb", printer: "TSC TE200" } }),
      ),
    );
  });

  it("rejects finishing with the USB transport and no printer chosen", async () => {
    render(<WorkstationSetup hw={hardware()} {...defaultProps} />);
    await screen.findByText("COM3");
    await selectSetupTab("Printer");
    fireEvent.click(screen.getByRole("radio", { name: "USB" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      await screen.findByText(/Enter the required printer connection details/),
    ).toBeDefined();
  });
```

If a `defaultProps`-style helper already exists in the file, reuse it instead of adding a duplicate.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @markiro/station exec vitest run test/workstation-setup.test.tsx
```

Expected: FAIL — the "USB" transport radio does not render (props not passed) and typecheck errors from Task 5's pending call site.

- [ ] **Step 3: Wire the state, effects, and config**

In `apps/station/src/pages/WorkstationSetup.tsx`:

Import the type (extend the existing hardware import):

```ts
import type { HardwareContract, PrintTarget, UsbPrinterInfo } from "../lib/hardware.js";
```

Add state after `printerBaud`:

```ts
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinterInfo[]>([]);
  const [usbPrinter, setUsbPrinter] = useState("");
```

Add a detection effect next to the scanner-port effect:

```ts
  useEffect(() => {
    void hw
      .listUsbPrinters()
      .then(setUsbPrinters)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : t("setup.failed")),
      );
  }, [hw, t]);
```

In the config-load effect, add a branch before the `else` that sets `"none"`:

```ts
        } else if (config.printer?.kind === "usb") {
          setPrinterTransport("usb");
          setUsbPrinter(config.printer.printer);
        } else {
```

Add the refresh handler next to `openScanner`:

```ts
  async function refreshUsbPrinters() {
    setBusy(true);
    setError(null);
    try {
      setUsbPrinters(await hw.listUsbPrinters());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }
```

In `buildConfig`, add a branch after the `serial` branch:

```ts
    } else if (printerTransport === "usb") {
      if (usbPrinter === "") return { ok: false, error: t("setup.printerFieldRequired") };
      printer = { kind: "usb", printer: usbPrinter };
    }
```

Pass the new props to `PrinterSetupPanel` (after `serialBaud={printerBaud}`):

```tsx
          usbPrinters={usbPrinters}
          usbPrinter={usbPrinter}
```

and after `onSerialBaudChange={setPrinterBaud}`:

```tsx
          onUsbPrinterChange={setUsbPrinter}
          onUsbRefresh={() => void refreshUsbPrinters()}
```

- [ ] **Step 4: Run the tests and package gates**

```bash
pnpm --filter @markiro/station exec vitest run test/workstation-setup.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all five new tests PASS, every pre-existing test still PASS, typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/pages/WorkstationSetup.tsx apps/station/test/workstation-setup.test.tsx
git commit -m "feat(station): wire USB printer detection and selection into setup"
```

### Task 7: Acceptance checklist, final gates, and report

**Files:**
- Modify: `docs/hardware-acceptance-checklist.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a documented physical-acceptance section and a green full station gate.

- [ ] **Step 1: Add the USB acceptance items**

Read `docs/hardware-acceptance-checklist.md` first and follow its existing section format. Add a "USB printer" section with these items (adapted to the file's structure and language):

- USB-подключённый Zebra (ZPL) обнаруживается в списке настройки; тестовая печать выходит корректно.
- USB-подключённый TSC (TSPL) обнаруживается; тестовая печать выходит корректно.
- Печать этикетки короба по USB: кириллица и DataMatrix идентичны выводу того же шаблона по TCP.
- Выдёргивание USB-кабеля в смене: печать даёт видимую ошибку, линия не блокируется, после переподключения печать восстанавливается без перенастройки.
- Обнаружение фильтрует не-USB очереди (сетевые, PDF) — они не появляются в списке.

- [ ] **Step 2: Run the full station gates**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
cargo check --manifest-path apps/station/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
pnpm format:check
git diff --check
```

Expected: all green. Report any skipped or environment-limited check explicitly.

- [ ] **Step 3: Commit and report**

```bash
git add docs/hardware-acceptance-checklist.md
git commit -m "docs: add USB printer items to the hardware acceptance checklist"
```

Final report must state: behavior changed, files changed, automated checks run with results, and that Windows runtime behavior (`EnumPrintersW`, spooler RAW output) and physical Zebra/TSC printing are NOT verified by these checks — they are compile-checked at most and remain on the hardware acceptance checklist.

---

## Self-Review Notes

- Spec coverage: decisions 1–7 map to Tasks 2 (enumeration, filter, Windows-only), 3 (RAW printing, no-PDF path by construction, Usb variant), 4 (contract/config, queue-name identity, backward compat), 5 (list+refresh UX, missing-saved marker, i18n), 6 (wiring, validation, save), 7 (physical acceptance documentation). "Printer language unchanged" is a constraint, not a task — no code touches it.
- Existing print call sites (`App.tsx:1022`, work screen, print verification) pass `config.printer` through `hw.print` untyped-narrowed, so the union extension needs no changes there; typecheck in Tasks 4/6 proves it.
- Type consistency: `UsbPrinter { name, port }` (Rust, camelCase serde) ⇄ `UsbPrinterInfo { name, port }` (TS); `{ kind: "usb", printer }` matches serde `Usb { printer }` with lowercase tag `kind`.
