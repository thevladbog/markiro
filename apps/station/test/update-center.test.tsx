import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { UpdateCenter } from "../src/pages/UpdateCenter.js";
import type { StationUpdaterController } from "../src/lib/use-station-updater.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function controllerFixture(version = "0.1.0-beta.2"): StationUpdaterController {
  return {
    phase: "idle",
    persisted: {
      schemaVersion: 1,
      lastAttemptAt: "2026-08-11T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-08-11T00:00:00.000Z",
      available: { version, publishedAt: "2026-08-01T00:00:00.000Z" },
    },
    severity: "warn",
    error: null,
    downloadedBytes: 0,
    totalBytes: null,
    checkNow: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  };
}

describe("UpdateCenter", () => {
  it("shows a known version and requires confirmation before install", async () => {
    const controller = controllerFixture();
    render(
      <UpdateCenter
        controller={controller}
        activeShift={false}
        pendingOutbox={7}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText("0.1.0-beta.2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    expect(controller.install).not.toHaveBeenCalled();
    expect(screen.getByText("7 operations are still waiting to sync")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
    await waitFor(() => expect(controller.install).toHaveBeenCalledOnce());
  });

  it("allows checks but disables install during an active shift", () => {
    const controller = controllerFixture();
    render(
      <UpdateCenter controller={controller} activeShift pendingOutbox={0} onBack={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Download and install" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Leave the active shift before installing")).toBeDefined();
  });
});
