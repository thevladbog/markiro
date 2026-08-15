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

  it("audits station creation without credential or pairing-code plaintext", async () => {
    const created = {
      id: "station_1",
      name: "Packing station",
      lineId: null,
      lineName: null,
      lifecycle: "awaiting_pairing",
      pairedAt: null,
      revokedAt: null,
      lastSeenAt: null,
      createdAt: new Date(),
    };
    const service = { create: vi.fn().mockResolvedValue(created) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    const result = await controller.create(req, { name: "Packing station", lineId: null });

    expect(result).toEqual(created);
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.create",
      resourceId: "station_1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("plaintext");
  });

  it("audits station update with its durable resource ID", async () => {
    const service = { update: vi.fn().mockResolvedValue({ id: "station_1" }) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    await controller.update(req, "station_1", { lineId: null });

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.update",
      resourceId: "station_1",
      outcome: "succeeded",
    });
  });

  it("audits station revocation after the service succeeds", async () => {
    const service = { revoke: vi.fn().mockResolvedValue(undefined) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    await controller.revoke(req, "station_2");

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.revoke",
      resourceId: "station_2",
      outcome: "succeeded",
    });
  });

  it("audits a rejected station-device creation with a failed outcome and no body data", async () => {
    const service = { create: vi.fn().mockRejectedValue(new Error("create failed")) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    await expect(controller.create(req, { name: "Packing station", lineId: null })).rejects.toThrow(
      "create failed",
    );
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.create",
      resourceId: null,
      outcome: "failed",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("Packing station");
  });

  it("audits a rejected station update with the durable resource ID and no request-body metadata", async () => {
    const service = { update: vi.fn().mockRejectedValue(new Error("update failed")) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    await expect(
      controller.update(req, "station_2", { name: "Secret station name" }),
    ).rejects.toThrow("update failed");

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.update",
      resourceId: "station_2",
      outcome: "failed",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain(
      "Secret station name",
    );
  });

  it("audits a rejected station revoke with the durable resource ID", async () => {
    const service = { revoke: vi.fn().mockRejectedValue(new Error("revoke failed")) };
    const audit = auditDouble();
    const controller = new StationDevicesController(service as never, {} as never, audit as never);

    await expect(controller.revoke(req, "station_3")).rejects.toThrow("revoke failed");

    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_device.revoke",
      resourceId: "station_3",
      outcome: "failed",
    });
  });

  it("audits station pairing-code issuance without the plaintext code", async () => {
    const pairing = {
      issueCode: vi.fn().mockResolvedValue({
        code: "12345678",
        expiresAt: new Date("2026-08-06T12:00:00.000Z"),
      }),
    };
    const audit = auditDouble();
    const controller = new StationDevicesController({} as never, pairing as never, audit as never);

    const result = await controller.issuePairingCode(req, "station_4");

    expect(result).toEqual({ code: "12345678", expiresAt: new Date("2026-08-06T12:00:00.000Z") });
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_pairing_code.issue",
      resourceId: "station_4",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("12345678");
  });

  it("audits rejected station pairing-code issuance with the durable device id", async () => {
    const pairing = { issueCode: vi.fn().mockRejectedValue(new Error("issuance failed")) };
    const audit = auditDouble();
    const controller = new StationDevicesController({} as never, pairing as never, audit as never);

    await expect(controller.issuePairingCode(req, "station_5")).rejects.toThrow("issuance failed");
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "station_pairing_code.issue",
      resourceId: "station_5",
      outcome: "failed",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("issuance failed");
  });

  it("does not let audit sink failures replace completed station mutations", async () => {
    const created = { id: "station_create" };
    const updated = { id: "station_update" };
    const issued = { code: "87654321", expiresAt: new Date("2026-08-06T12:00:00.000Z") };
    const service = {
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockResolvedValue(updated),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    const pairing = { issueCode: vi.fn().mockResolvedValue(issued) };
    const audit = {
      credentialMutation: vi.fn(() => {
        throw new Error("audit sink unavailable");
      }),
    };
    const controller = new StationDevicesController(
      service as never,
      pairing as never,
      audit as never,
    );

    await expect(controller.create(req, { name: "Packing station", lineId: null })).resolves.toBe(
      created,
    );
    await expect(controller.update(req, "station_update", { lineId: null })).resolves.toBe(updated);
    await expect(controller.revoke(req, "station_revoke")).resolves.toBeUndefined();
    await expect(controller.issuePairingCode(req, "station_issue")).resolves.toBe(issued);

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.create",
          resourceId: "station_create",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.update",
          resourceId: "station_update",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.revoke",
          resourceId: "station_revoke",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_pairing_code.issue",
          resourceId: "station_issue",
          outcome: "succeeded",
        },
      ],
    ]);
  });

  it("does not let audit sink failures mask rejected station mutations", async () => {
    const createError = new Error("create business failure");
    const updateError = new Error("update business failure");
    const revokeError = new Error("revoke business failure");
    const issueError = new Error("issue business failure");
    const service = {
      create: vi.fn().mockRejectedValue(createError),
      update: vi.fn().mockRejectedValue(updateError),
      revoke: vi.fn().mockRejectedValue(revokeError),
    };
    const pairing = { issueCode: vi.fn().mockRejectedValue(issueError) };
    const audit = {
      credentialMutation: vi.fn(() => {
        throw new Error("audit sink unavailable");
      }),
    };
    const controller = new StationDevicesController(
      service as never,
      pairing as never,
      audit as never,
    );

    await expect(controller.create(req, { name: "Packing station", lineId: null })).rejects.toBe(
      createError,
    );
    await expect(controller.update(req, "station_update", { lineId: null })).rejects.toBe(
      updateError,
    );
    await expect(controller.revoke(req, "station_revoke")).rejects.toBe(revokeError);
    await expect(controller.issuePairingCode(req, "station_issue")).rejects.toBe(issueError);

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.create",
          resourceId: null,
          outcome: "failed",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.update",
          resourceId: "station_update",
          outcome: "failed",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_device.revoke",
          resourceId: "station_revoke",
          outcome: "failed",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "station_pairing_code.issue",
          resourceId: "station_issue",
          outcome: "failed",
        },
      ],
    ]);
  });

  it("audits kiosk creation with the cabinet actor and durable result id", async () => {
    const created = { id: "kiosk_1" };
    const kiosks = { createKiosk: vi.fn().mockResolvedValue(created) };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    const result = await controller.createKiosk(req, {
      name: "Front gate",
      dayLimitPerEmployee: 5,
      showPrices: true,
      printEmployeeQrOnSlip: false,
    });

    expect(result).toBe(created);
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk.create",
      resourceId: "kiosk_1",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("Front gate");
  });

  it("audits rejected kiosk creation without request-body data", async () => {
    const businessError = new Error("create failed with internal detail");
    const kiosks = { createKiosk: vi.fn().mockRejectedValue(businessError) };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    await expect(
      controller.createKiosk(req, {
        name: "Sensitive kiosk name",
        dayLimitPerEmployee: 5,
        showPrices: true,
        printEmployeeQrOnSlip: false,
      }),
    ).rejects.toBe(businessError);
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk.create",
      resourceId: null,
      outcome: "failed",
    });
    const calls = JSON.stringify(audit.credentialMutation.mock.calls);
    expect(calls).not.toContain("Sensitive kiosk name");
    expect(calls).not.toContain("internal detail");
  });

  it("audits kiosk update/change-place success and failure against the route id", async () => {
    const updated = { id: "kiosk_2" };
    const kiosks = {
      updateKiosk: vi
        .fn()
        .mockResolvedValueOnce({ kiosk: updated, auditAction: "kiosk.update" })
        .mockRejectedValueOnce(new Error("update failed")),
    };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    await expect(controller.updateKiosk(req, "kiosk_2", { location: "Loading bay" })).resolves.toBe(
      updated,
    );
    await expect(
      controller.updateKiosk(req, "kiosk_2", { location: "Secret place" }),
    ).rejects.toThrow("update failed");

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.update",
          resourceId: "kiosk_2",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.update",
          resourceId: "kiosk_2",
          outcome: "failed",
        },
      ],
    ]);
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("Secret place");
  });

  it("classifies actual kiosk PATCH lifecycle transitions without duplicating audit", async () => {
    const archived = { id: "kiosk_3", status: "archived" };
    const unchanged = { id: "kiosk_3", status: "archived" };
    const reactivated = { id: "kiosk_3", status: "active" };
    const kiosks = {
      updateKiosk: vi
        .fn()
        .mockResolvedValueOnce({ kiosk: archived, auditAction: "kiosk.archive" })
        .mockResolvedValueOnce({ kiosk: unchanged, auditAction: "kiosk.update" })
        .mockResolvedValueOnce({ kiosk: reactivated, auditAction: "kiosk.unbind" })
        .mockRejectedValueOnce(new Error("archive failed")),
    };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    await expect(
      controller.updateKiosk(req, "kiosk_3", { status: "archived", name: "Archived name" }),
    ).resolves.toBe(archived);
    await expect(controller.updateKiosk(req, "kiosk_3", { status: "archived" })).resolves.toBe(
      unchanged,
    );
    await expect(
      controller.updateKiosk(req, "kiosk_3", { status: "active", location: "New place" }),
    ).resolves.toBe(reactivated);
    await expect(controller.updateKiosk(req, "kiosk_3", { status: "archived" })).rejects.toThrow(
      "archive failed",
    );

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.archive",
          resourceId: "kiosk_3",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.update",
          resourceId: "kiosk_3",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.unbind",
          resourceId: "kiosk_3",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.archive",
          resourceId: "kiosk_3",
          outcome: "failed",
        },
      ],
    ]);
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

  it("audits rejected kiosk pairing-code issuance without the error or code", async () => {
    const pairing = { issueCode: vi.fn().mockRejectedValue(new Error("issuance failed")) };
    const audit = auditDouble();
    const controller = new KiosksController({} as never, pairing as never, audit as never);

    await expect(controller.issuePairingCode(req, "kiosk_2")).rejects.toThrow("issuance failed");
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk_pairing_code.issue",
      resourceId: "kiosk_2",
      outcome: "failed",
    });
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("issuance failed");
  });

  it("audits kiosk archive and unbind outcomes with only the durable resource id", async () => {
    const kiosks = {
      archiveKiosk: vi.fn().mockResolvedValue(undefined),
      unbindKiosk: vi.fn().mockRejectedValue(new Error("unbind failed")),
    };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    await controller.archiveKiosk(req, "kiosk_3");
    await expect(controller.unbindKiosk(req, "kiosk_3")).rejects.toThrow("unbind failed");

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.archive",
          resourceId: "kiosk_3",
          outcome: "succeeded",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.unbind",
          resourceId: "kiosk_3",
          outcome: "failed",
        },
      ],
    ]);
    expect(JSON.stringify(audit.credentialMutation.mock.calls)).not.toContain("unbind failed");
  });

  it("audits rejected archive and successful unbind outcomes independently", async () => {
    const kiosks = {
      archiveKiosk: vi.fn().mockRejectedValue(new Error("archive failed")),
      unbindKiosk: vi.fn().mockResolvedValue(undefined),
    };
    const audit = auditDouble();
    const controller = new KiosksController(kiosks as never, {} as never, audit as never);

    await expect(controller.archiveKiosk(req, "kiosk_4")).rejects.toThrow("archive failed");
    await controller.unbindKiosk(req, "kiosk_4");

    expect(audit.credentialMutation.mock.calls).toEqual([
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.archive",
          resourceId: "kiosk_4",
          outcome: "failed",
        },
      ],
      [
        {
          tenantId: "org_1",
          userId: "user_1",
          action: "kiosk.unbind",
          resourceId: "kiosk_4",
          outcome: "succeeded",
        },
      ],
    ]);
  });

  it("best-effort audits rejected kiosk enrollment without obscuring the business error", async () => {
    const businessError = new Error("enroll failed");
    const kiosks = { enroll: vi.fn().mockRejectedValue(businessError) };
    const pairing = {};
    const audit = {
      credentialMutation: vi.fn(() => {
        throw new Error("audit sink unavailable");
      }),
    };
    const controller = new KiosksController(kiosks as never, pairing as never, audit as never);

    await expect(controller.enroll(req, "kiosk_1")).rejects.toBe(businessError);
    expect(audit.credentialMutation).toHaveBeenCalledWith({
      tenantId: "org_1",
      userId: "user_1",
      action: "kiosk.enroll",
      resourceId: "kiosk_1",
      outcome: "failed",
    });
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
