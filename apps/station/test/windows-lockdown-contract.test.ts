import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stationRoot = process.cwd();

describe("Windows lockdown contract", () => {
  it("covers the complete monitor above the taskbar after entering Tauri fullscreen", async () => {
    const [cargo, source] = await Promise.all([
      readFile(resolve(stationRoot, "src-tauri/Cargo.toml"), "utf8"),
      readFile(resolve(stationRoot, "src-tauri/src/commands.rs"), "utf8"),
    ]);

    expect(cargo).toContain('"Win32_Graphics_Gdi"');
    expect(cargo).toContain('"Win32_UI_WindowsAndMessaging"');
    expect(source).toContain("MonitorFromWindow");
    expect(source).toContain("GetMonitorInfoW");
    expect(source).toContain("SetWindowPos");
    expect(source).toContain("HWND_TOPMOST");
    expect(source).toContain("monitor.rcMonitor");

    const enter = source.slice(
      source.indexOf("pub fn enter_lockdown"),
      source.indexOf("pub fn exit_lockdown"),
    );
    expect(enter.indexOf("set_decorations(false)")).toBeLessThan(
      enter.indexOf("set_fullscreen(true)"),
    );
    expect(enter.indexOf("set_skip_taskbar(true)")).toBeLessThan(
      enter.indexOf("set_fullscreen(true)"),
    );
    expect(enter.indexOf("set_fullscreen(true)")).toBeLessThan(
      enter.indexOf("cover_current_monitor"),
    );
  });
});
