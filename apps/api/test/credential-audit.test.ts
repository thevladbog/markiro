import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysController } from "../src/modules/api-keys/api-keys.controller";
import { IntegrationsController } from "../src/modules/integrations/integrations.controller";
import { KiosksController } from "../src/modules/kiosks/kiosks.controller";
import { StationDevicesController } from "../src/modules/station-devices/station-devices.controller";
import type { RequestWithTenant } from "../src/tenancy/tenant.guard";

vi.mock("../src/env", () => ({
  loadEnv: () => ({ BETTER_AUTH_URL: "https://api.example.test" }),
}));

const req = { tenantId: "org_1", userId: "user_1" } as RequestWithTenant;

function auditDouble() {
  return { credentialMutation: vi.fn() };
}

describe("credential mutation audit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("audits public API key issuance without the plaintext key", async () => {
    const service = {
      create: vi.fn().mockResolvedValue({ id: "key_1", key: "mk_plaintext" }),
    };
    const audit = auditDouble();
    const controller = new ApiKeysController(service as never, audit as never);

    const result = await controller.create(req, { name: "Warehouse" });

    expect(result).toEqual({ id: "key_1", key: "mk_plaintext" });
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "public_api_key.issue",
      resourceId: "key_1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("mk_plaintext");
  });

  it("audits public API key revocation after the service succeeds", async () => {
    const service = { revoke: vi.fn().mockResolvedValue(undefined) };
    const audit = auditDouble();
    const controller = new ApiKeysController(service as never, audit as never);

    await controller.revoke(req, "key_2");

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "public_api_key.revoke",
      resourceId: "key_2",
      outcome: "succeeded",
    });
  });

  it("does not audit a rejected public API key mutation", async () => {
    const service = { create: vi.fn().mockRejectedValue(new Error("create failed")) };
    const audit = auditDouble();
    const controller = new ApiKeysController(service as never, audit as never);

    await expect(controller.create(req, { name: "Warehouse" })).rejects.toThrow("create failed");
    expect(audit.credentialMutation).not.toHaveBeenCalled();
  });

  it("audits station enrollment without the plaintext API key", async () => {
    const issued = {
      deviceId: "station_1",
      name: "Packing station",
      apiKey: "station-plaintext",
      serverUrl: "https://api.example.test",
    };
    const service = { enroll: vi.fn().mockResolvedValue(issued) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, audit as never);

    const result = await controller.enroll(req, { name: "Packing station" });

    expect(result).toEqual(issued);
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.enroll",
      resourceId: "station_1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("station-plaintext");
  });

  it("audits station revocation after the service succeeds", async () => {
    const service = { revoke: vi.fn().mockResolvedValue(undefined) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, audit as never);

    await controller.revoke(req, "station_2");

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.revoke",
      resourceId: "station_2",
      outcome: "succeeded",
    });
  });

  it("does not audit a rejected station-device mutation", async () => {
    const service = { enroll: vi.fn().mockRejectedValue(new Error("enroll failed")) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, audit as never);

    await expect(controller.enroll(req, { name: "Packing station" })).rejects.toThrow(
      "enroll failed",
    );
    expect(audit.credentialMutation).not.toHaveBeenCalled();
  });

  it("audits kiosk enrollment without the plaintext token", async () => {
    const kiosks = { enroll: vi.fn().mockResolvedValue({ token: "plain-token" }) };
    const pairing = {};
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, pairing as never, audit as never);

    const result = await controller.enroll(req, "kiosk_1");

    expect(result).toEqual({ token: "plain-token" });
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk.enroll",
      resourceId: "kiosk_1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("plain-token");
  });

  it("audits kiosk pairing-code issuance without the plaintext code", async () => {
    const expiresAt = new Date("2026-08-03T12:00:00.000Z");
    const kiosks = {};
    const pairing = {
      issueCode: vi.fn().mockResolvedValue({ code: "12345678", expiresAt }),
    };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, pairing as never, audit as never);

    const result = await controller.issuePairingCode(req, "kiosk_2");

    expect(result).toEqual({ code: "12345678", expiresAt });
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk_pairing_code.issue",
      resourceId: "kiosk_2",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("12345678");
  });

  it("does not audit a rejected kiosk mutation", async () => {
    const kiosks = { enroll: vi.fn().mockRejectedValue(new Error("enroll failed")) };
    const pairing = {};
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, pairing as never, audit as never);

    await expect(controller.enroll(req, "kiosk_1")).rejects.toThrow("enroll failed");
    expect(audit.credentialMutation).not.toHaveBeenCalled();
  });

  it("audits integration credential issuance without the plaintext login or secret", async () => {
    const integrations = {
      issueCredentials: vi.fn().mockResolvedValue({ login: "plain-login", secret: "plain-secret" }),
    };
    const audit = auditDouble();
    const controller = new IntegrationsController(integrations as never, audit as never);

    const result = await controller.issueCredentials(req, "commerceml");

    expect(result).toEqual({ login: "plain-login", secret: "plain-secret" });
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "integration_credentials.issue",
      resourceId: "commerceml",
      outcome: "succeeded",
    });
    const auditCalls = JSON.stringify(audit.credentialMutation.mock.calls);
    expect(auditCalls).not.toContain("plain-login");
    expect(auditCalls).not.toContain("plain-secret");
  });

  it("does not audit rejected integration credential issuance", async () => {
    const integrations = {
      issueCredentials: vi.fn().mockRejectedValue(new Error("issuance failed")),
    };
    const audit = auditDouble();
    const controller = new IntegrationsController(integrations as never, audit as never);

    await expect(controller.issueCredentials(req, "commerceml")).rejects.toThrow("issuance failed");
    expect(audit.credentialMutation).not.toHaveBeenCalled();
  });
});
