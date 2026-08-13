import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StationBrand } from "../src/ui/StationBrand.js";

const stationRoot = process.cwd();

describe("Station brand assets", () => {
  it("keeps the approved wordmark and app icon geometry", async () => {
    const [fullLogo, appIcon] = await Promise.all([
      readFile(resolve(stationRoot, "src/assets/markiro-logo-on-dark.svg"), "utf8"),
      readFile(resolve(stationRoot, "src/assets/markiro-app-icon.svg"), "utf8"),
    ]);

    expect(fullLogo).toContain('fill="#3DDC7A"');
    expect(fullLogo).toContain(">маркиро</text>");
    expect(appIcon).toContain('viewBox="0 0 512 512"');
    expect(appIcon).toContain('<rect width="512" height="512" fill="#FAFAF8"');
    expect(appIcon).toContain('<g fill="#17161A"');
    expect(appIcon).not.toContain("<circle");
  });

  it("exposes the station brand name and caller-supplied descriptor", () => {
    render(createElement(StationBrand, { descriptor: "Рабочее место линии" }));

    expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
    expect(screen.getByText("Рабочее место линии")).toBeDefined();
  });

  it("lists all desktop icon formats for Tauri bundles", async () => {
    const config = JSON.parse(
      await readFile(resolve(stationRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );

    expect(config.bundle.icon).toEqual([
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico",
    ]);
    expect(config.bundle.windows.nsis).toMatchObject({
      installerIcon: "icons/icon.ico",
      installerHooks: "windows/installer-hooks.nsh",
    });
    expect(config.app.security.csp).toContain("img-src 'self' data:");
  });

  it("invalidates the Windows shell icon cache after installing refreshed shortcuts", async () => {
    const hooks = await readFile(
      resolve(stationRoot, "src-tauri/windows/installer-hooks.nsh"),
      "utf8",
    );

    expect(hooks).toContain("!macro NSIS_HOOK_POSTINSTALL");
    expect(hooks).toContain("SHChangeNotify");
    expect(hooks).toContain("0x08000000");
  });

  it("assigns the branded icon to the native window at startup", async () => {
    const source = await readFile(resolve(stationRoot, "src-tauri/src/lib.rs"), "utf8");

    expect(source).toContain('tauri::include_image!("./icons/128x128.png")');
    expect(source).toMatch(
      /get_webview_window\("main"\)[\s\S]*set_icon\(STATION_ICON\.clone\(\)\)/,
    );
  });
});
