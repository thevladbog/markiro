import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const pairingMock = vi.hoisted(() => ({
  redeemStationPairing: vi.fn(),
  persistStationProvisioning: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("../src/lib/pairing.js", () => pairingMock);

import i18n from "../src/i18n/index.js";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
import { Enrollment } from "../src/pages/Enrollment.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  invokeMock.mockReset();
  pairingMock.redeemStationPairing.mockReset();
  pairingMock.persistStationProvisioning.mockReset();
});

describe("Enrollment", () => {
  it("starts with only the short code flow and persists before signaling success", async () => {
    pairingMock.redeemStationPairing.mockResolvedValue({
      ok: true,
      provisioning: {
        deviceId: "device-1",
        deviceName: "Packing station",
        tenantId: "tenant-1",
        organizationName: "Factory",
        apiKey: "station-credential",
        serverUrl: "https://station.example",
        operators: [],
      },
    });
    pairingMock.persistStationProvisioning.mockResolvedValue(undefined);
    const onEnrolled = vi.fn();

    render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={onEnrolled}
        pairingServerUrl="https://api.factory.example"
      />,
    );

    expect(screen.getByLabelText("Pairing code")).toBeDefined();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.queryByLabelText("Device key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));

    await waitFor(() => expect(pairingMock.persistStationProvisioning).toHaveBeenCalledTimes(1));
    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(pairingMock.redeemStationPairing).toHaveBeenCalledWith(
      "https://api.factory.example",
      "12345678",
    );
    expect(pairingMock.persistStationProvisioning.mock.invocationCallOrder[0]).toBeLessThan(
      onEnrolled.mock.invocationCallOrder[0]!,
    );
  });

  it("sends recovery pairing to the retained trusted API base exactly", async () => {
    const provisioning = {
      deviceId: "device-1",
      deviceName: "Packing station",
      tenantId: "tenant-1",
      organizationName: "Factory",
      apiKey: "replacement-credential",
      serverUrl: "https://retained.factory.example",
      operators: [],
    };
    pairingMock.redeemStationPairing.mockResolvedValue({ ok: true, provisioning });
    pairingMock.persistStationProvisioning.mockResolvedValue(undefined);

    render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={() => {}}
        pairingServerUrl="https://retained.factory.example"
        expectedDeviceId="device-1"
      />,
    );

    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));

    await waitFor(() =>
      expect(pairingMock.redeemStationPairing).toHaveBeenCalledWith(
        "https://retained.factory.example",
        "12345678",
      ),
    );
    expect(pairingMock.persistStationProvisioning).toHaveBeenCalledWith(
      provisioning,
      expect.objectContaining({ machineId: "machine-1", expectedDeviceId: "device-1" }),
    );
    expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();
  });

  it("shows a stable expired state without persisting", async () => {
    pairingMock.redeemStationPairing.mockResolvedValue({ ok: false, error: "expired" });
    const onEnrolled = vi.fn();
    render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={onEnrolled}
        pairingServerUrl="https://api.factory.example"
      />,
    );

    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));

    await waitFor(() => expect(screen.getByText("This pairing code has expired.")).toBeDefined());
    expect(pairingMock.persistStationProvisioning).not.toHaveBeenCalled();
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it("accepts an eight-digit scanner capture into the same pairing field", () => {
    let listener: ScanListener | null = null;
    const scanSource: ScanSource = {
      start(next) {
        listener = next;
        return () => {};
      },
    };
    render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
        scanSource={scanSource}
      />,
    );

    act(() => listener?.("12345678"));

    expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("12345678");
  });

  it("keeps legacy URL and credential entry behind the explicit service action", async () => {
    render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));

    expect(screen.getByLabelText("Server URL")).toBeDefined();
    expect(screen.getByLabelText("Device key")).toBeDefined();
  });

  it("shows setup-required and does not redeem when no trusted pairing base is configured", () => {
    render(<Enrollment machineId="machine-1" onEnrolled={() => {}} pairingServerUrl={null} />);

    expect(screen.getByText("Station API setup is required before pairing.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));

    expect(pairingMock.redeemStationPairing).not.toHaveBeenCalled();
  });
});
