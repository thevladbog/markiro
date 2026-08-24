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
    origin: "yandex",
    fallbackReason: null,
    packageFallbackReason: null,
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
    expect(screen.getByText("Source: Markiro (Yandex)")).toBeDefined();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
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

  it("shows discovery and package fallback as distinct informational status", () => {
    const controller = {
      ...controllerFixture(),
      origin: "github" as const,
      fallbackReason: "primary-unavailable" as const,
      packageFallbackReason: "timeout" as const,
    };
    render(
      <UpdateCenter
        controller={controller}
        activeShift={false}
        pendingOutbox={0}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText("GitHub backup source used")).toBeDefined();
    expect(
      screen.getByText(
        "Checked through the GitHub backup because the primary source was unavailable.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("The update package was downloaded through the GitHub backup."),
    ).toBeDefined();
  });

  it("uses distinct calm copy for origin mismatch and integrity failure", () => {
    const { rerender } = render(
      <UpdateCenter
        controller={{ ...controllerFixture(), error: "origin-mismatch" }}
        activeShift={false}
        pendingOutbox={0}
        onBack={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "The update sources do not match. Installation was stopped; Station work continues.",
      ),
    ).toBeDefined();

    rerender(
      <UpdateCenter
        controller={{ ...controllerFixture(), error: "integrity-failed" }}
        activeShift={false}
        pendingOutbox={0}
        onBack={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "Update integrity could not be verified. Installation was stopped; Station work continues.",
      ),
    ).toBeDefined();
  });
});
