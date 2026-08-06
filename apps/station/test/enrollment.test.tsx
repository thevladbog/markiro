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
  vi.unstubAllGlobals();
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
      expect.any(AbortSignal),
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
        expect.any(AbortSignal),
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

  it("does not persist or publish a code response that resolves after unmount", async () => {
    let resolveRedeem!: (value: {
      ok: true;
      provisioning: {
        deviceId: string;
        deviceName: string;
        tenantId: string;
        organizationName: string;
        apiKey: string;
        serverUrl: string;
        operators: never[];
      };
    }) => void;
    pairingMock.redeemStationPairing.mockReturnValue(
      new Promise((resolve) => {
        resolveRedeem = resolve;
      }),
    );
    const oldEnrolled = vi.fn();

    const oldView = render(
      <Enrollment
        machineId="old-machine"
        onEnrolled={oldEnrolled}
        pairingServerUrl="https://old.factory.example"
      />,
    );
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));
    await waitFor(() => expect(pairingMock.redeemStationPairing).toHaveBeenCalledTimes(1));
    oldView.unmount();

    const newView = render(
      <Enrollment
        machineId="new-machine"
        expectedDeviceId="new-device"
        onEnrolled={() => {}}
        pairingServerUrl="https://new.factory.example"
      />,
    );
    resolveRedeem({
      ok: true,
      provisioning: {
        deviceId: "old-device",
        deviceName: "Old station",
        tenantId: "old-tenant",
        organizationName: "Old factory",
        apiKey: "old-key",
        serverUrl: "https://old.factory.example",
        operators: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pairingMock.persistStationProvisioning).not.toHaveBeenCalled();
    expect(oldEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByText("Station connected")).toBeNull();
    newView.unmount();
  });

  it("does not write or publish a service response that resolves after unmount", async () => {
    let resolveWhoami!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveWhoami = resolve;
          }),
      ),
    );
    const oldEnrolled = vi.fn();

    const oldView = render(
      <Enrollment
        machineId="old-machine"
        onEnrolled={oldEnrolled}
        pairingServerUrl="https://old.factory.example"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://old.factory.example" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "old-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect service credentials" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    oldView.unmount();

    const newView = render(
      <Enrollment
        machineId="new-machine"
        expectedDeviceId="new-device"
        onEnrolled={() => {}}
        pairingServerUrl="https://new.factory.example"
      />,
    );
    resolveWhoami(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
    expect(oldEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByText("Station connected")).toBeNull();
    newView.unmount();
  });

  it("resets a pending code operation on lifecycle change and accepts a new valid attempt", async () => {
    let resolveOldRedeem!: (value: {
      ok: true;
      provisioning: {
        deviceId: string;
        deviceName: string;
        tenantId: string;
        organizationName: string;
        apiKey: string;
        serverUrl: string;
        operators: never[];
      };
    }) => void;
    pairingMock.redeemStationPairing
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldRedeem = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        provisioning: {
          deviceId: "new-device",
          deviceName: "New station",
          tenantId: "new-tenant",
          organizationName: "New factory",
          apiKey: "new-key",
          serverUrl: "https://new.factory.example",
          operators: [],
        },
      });
    pairingMock.persistStationProvisioning.mockResolvedValue(undefined);
    const oldEnrolled = vi.fn();
    const newEnrolled = vi.fn();

    const view = render(
      <Enrollment
        machineId="old-machine"
        onEnrolled={oldEnrolled}
        pairingServerUrl="https://old.factory.example"
      />,
    );
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pairing…" })).toBeDefined());

    view.rerender(
      <Enrollment
        machineId="new-machine"
        onEnrolled={newEnrolled}
        pairingServerUrl="https://new.factory.example"
      />,
    );
    expect(screen.getByRole("button", { name: "Pair station" })).toBeDefined();
    expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("");

    resolveOldRedeem({
      ok: true,
      provisioning: {
        deviceId: "old-device",
        deviceName: "Old station",
        tenantId: "old-tenant",
        organizationName: "Old factory",
        apiKey: "old-key",
        serverUrl: "https://old.factory.example",
        operators: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pairingMock.persistStationProvisioning).not.toHaveBeenCalled();
    expect(oldEnrolled).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "87654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair station" }));
    await waitFor(() => expect(pairingMock.persistStationProvisioning).toHaveBeenCalledTimes(1));
    expect(pairingMock.persistStationProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "new-device", apiKey: "new-key" }),
      expect.objectContaining({ machineId: "new-machine" }),
    );
    expect(newEnrolled).toHaveBeenCalledTimes(1);
  });

  it("resets pending service state and clears secret inputs on a normal lifecycle change", async () => {
    let resolveOldWhoami!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveOldWhoami = resolve;
          }),
      ),
    );

    const view = render(
      <Enrollment
        machineId="old-machine"
        onEnrolled={() => {}}
        pairingServerUrl="https://old.factory.example"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://secret-old.factory.example" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "secret-old-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect service credentials" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    view.rerender(
      <Enrollment
        machineId="new-machine"
        onEnrolled={() => {}}
        pairingServerUrl="https://new.factory.example"
      />,
    );
    expect(screen.getByRole("button", { name: "Pair station" })).toBeDefined();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.queryByLabelText("Device key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Device key") as HTMLInputElement).value).toBe("");

    resolveOldWhoami(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
  });

  it("closes service mode and blocks its pending writer when lifecycle becomes recovery", async () => {
    let resolveOldWhoami!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveOldWhoami = resolve;
          }),
      ),
    );

    const view = render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://service.factory.example" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "service-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect service credentials" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    view.rerender(
      <Enrollment
        machineId="machine-1"
        expectedDeviceId="durable-device"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
      />,
    );
    expect(screen.getByLabelText("Pairing code")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.queryByLabelText("Device key")).toBeNull();

    resolveOldWhoami(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
  });

  it("removes fresh service credential controls when lifecycle becomes recovery", () => {
    const view = render(
      <Enrollment
        machineId="machine-1"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Service setup" }));
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://service.factory.example" },
    });
    fireEvent.change(screen.getByLabelText("Device key"), { target: { value: "service-key" } });

    view.rerender(
      <Enrollment
        machineId="machine-1"
        expectedDeviceId="durable-device"
        onEnrolled={() => {}}
        pairingServerUrl="https://api.factory.example"
      />,
    );

    expect(screen.getByLabelText("Pairing code")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Service setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect service credentials" })).toBeNull();
    expect(screen.queryByLabelText("Server URL")).toBeNull();
    expect(screen.queryByLabelText("Device key")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("write_config", expect.anything());
  });
});
