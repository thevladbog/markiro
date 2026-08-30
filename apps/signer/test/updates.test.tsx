import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const notifyMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }));
vi.mock("../src/lib/bridge.js", () => ({
  bridge: { notifyUpdateAvailable: (version: string) => notifyMock(version) },
}));

import "../src/i18n/index.js";
import { UpdateBanner } from "../src/components/UpdateBanner.js";
import { announceUpdate, checkForUpdate } from "../src/lib/updates.js";

describe("signer updates", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    checkMock.mockReset();
    relaunchMock.mockReset();
    notifyMock.mockReset();
    notifyMock.mockResolvedValue(undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("reports no update when the mirror has nothing newer", async () => {
    checkMock.mockResolvedValue(null);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("surfaces an available update without installing it", async () => {
    const downloadAndInstall = vi.fn();
    checkMock.mockResolvedValue({ version: "0.2.0", body: "fixes", downloadAndInstall });

    const update = await checkForUpdate();

    expect(update).toMatchObject({ version: "0.2.0", notes: "fixes" });
    // Installing restarts the agent, and the agent is what keeps the tenant's
    // token fresh. A restart nobody asked for reads as a dead integration.
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("survives a mirror that cannot be reached", async () => {
    checkMock.mockRejectedValue(new Error("ENOTFOUND releases.markiro.app"));
    // Losing token refresh because an update check failed would be far worse
    // than running an old build.
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("renders nothing when there is no update", () => {
    const { container } = render(<UpdateBanner update={null} onInstalled={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("installs and relaunches only when the operator asks", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall });
    const update = await checkForUpdate();

    render(<UpdateBanner update={update} onInstalled={() => undefined} />);
    expect(screen.getByText(/0\.2\.0/)).toBeTruthy();
    expect(downloadAndInstall).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /обнов/i }));

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("announces a version to the tray at most once", async () => {
    // An operator who decided to install later must not be told again on
    // every daily check.
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();
    const announced = new Set<string>();

    await announceUpdate(update!, announced);
    await announceUpdate(update!, announced);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith("0.2.0");
  });

  it("still shows the banner when the tray refuses the notification", async () => {
    notifyMock.mockRejectedValue(new Error("notifications are disabled"));
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();

    await expect(announceUpdate(update!, new Set())).resolves.toBeUndefined();
  });

  it("keeps the agent usable when an install fails", async () => {
    const downloadAndInstall = vi.fn().mockRejectedValue(new Error("download failed"));
    checkMock.mockResolvedValue({ version: "0.2.0", body: null, downloadAndInstall });
    const update = await checkForUpdate();

    render(<UpdateBanner update={update} onInstalled={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: /обнов/i }));

    // The banner reports the failure and stays; it must not take the window down.
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBeTruthy();
  });
});
