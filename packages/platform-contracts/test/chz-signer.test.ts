import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chzSignerContracts,
  chzSignerPairRequestSchema,
  chzSignerPairResponseSchema,
  chzSignerTaskCompleteSchema,
  chzSignerTaskFailSchema,
  chzSignerTaskSchema,
  chzTrueApiAuthPayloadSchema,
} from "../src/chz-signer.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/chz-signer/${name}`, import.meta.url), "utf8"));

describe("chz-signer contracts", () => {
  it("accept the shared fixtures (Rust signer-core parses the same files)", () => {
    expect(() => chzSignerPairRequestSchema.parse(fixture("pair-request.json"))).not.toThrow();
    expect(() => chzSignerPairResponseSchema.parse(fixture("pair-response.json"))).not.toThrow();
    expect(() => chzSignerTaskSchema.parse(fixture("task.json"))).not.toThrow();
    expect(() => chzSignerTaskCompleteSchema.parse(fixture("task-complete.json"))).not.toThrow();
    expect(() => chzSignerTaskFailSchema.parse(fixture("task-fail.json"))).not.toThrow();
  });

  it("rejects a malformed pairing code", () => {
    expect(
      chzSignerPairRequestSchema.safeParse({
        pairingCode: "1234",
        hostname: "PC",
        appVersion: "0.1.0",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown task fail codes and extra keys", () => {
    expect(chzSignerTaskFailSchema.safeParse({ errorCode: "NOPE", message: "x" }).success).toBe(
      false,
    );
    expect(
      chzSignerTaskCompleteSchema.safeParse({
        token: "t",
        expiresAt: "2026-08-28T10:00:00.000Z",
        certThumbprint: "ab",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects extra keys in the new strict schemas", () => {
    // OMS auth payload with extra field
    expect(
      chzSignerContracts.omsAuthPayload.safeParse({
        trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
        omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        extra: "field",
      }).success,
    ).toBe(false);

    // Sign detached payload with extra field
    expect(
      chzSignerContracts.signDetachedPayload.safeParse({
        purpose: "oms_order",
        orderId: "3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
        dataBase64: "AQIDBAU=",
        extra: "field",
      }).success,
    ).toBe(false);

    // Signature complete with extra field
    expect(
      chzSignerContracts.signatureComplete.safeParse({
        signatureBase64: "AQIDBAU=",
        certThumbprint: "AB12",
        extra: "field",
      }).success,
    ).toBe(false);
  });

  it("requires a valid inn shape in the auth payload", () => {
    expect(
      chzSignerTaskSchema.safeParse({
        id: "3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
        type: "true_api_auth",
        payload: { trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api", inn: "12345" },
      }).success,
    ).toBe(false);
  });

  it("defaults legacy auth tasks to JWT and accepts the explicit UUID format", () => {
    const legacy = chzTrueApiAuthPayloadSchema.parse({
      trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
    });
    expect(legacy).not.toHaveProperty("tokenFormat");
    expect(legacy.tokenFormat ?? "jwt").toBe("jwt");
    expect(
      chzTrueApiAuthPayloadSchema.parse({
        trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
        tokenFormat: "uuid",
      }).tokenFormat,
    ).toBe("uuid");
    expect(
      chzTrueApiAuthPayloadSchema.safeParse({
        trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
        tokenFormat: "opaque",
      }).success,
    ).toBe(false);
  });

  it("accepts a long True API JWT in a completion report", () => {
    expect(
      chzSignerTaskCompleteSchema.safeParse({
        token: "x".repeat(16_384),
        expiresAt: "2026-08-31T12:00:00.000Z",
        certThumbprint: "AB12",
      }).success,
    ).toBe(true);
  });
});

describe("signer task union", () => {
  it("parses an oms_auth task with СУЗ-issued omsConnection", () => {
    const task = chzSignerContracts.task.parse(fixture("task-oms-auth.json"));
    expect(task.type).toBe("oms_auth");
    if (task.type === "oms_auth") {
      // Verify the fixture carries СУЗ's documented value exactly
      expect(task.payload.omsConnection).toBe("11b1abc1-f1ee-11db-1a11-f11ac11111e1");
    }
  });

  it("rejects malformed omsConnection values", () => {
    expect(
      chzSignerContracts.task.safeParse({
        id: "3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
        type: "oms_auth",
        payload: {
          trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
          omsConnection: "not-a-guid",
        },
      }).success,
    ).toBe(false);
  });
  it("parses a sign_detached task and its signature completion", () => {
    const task = chzSignerContracts.task.parse(fixture("task-sign-detached.json"));
    expect(task.type).toBe("sign_detached");
    const done = chzSignerContracts.taskCompleteBody.parse(fixture("task-complete-signature.json"));
    expect("signatureBase64" in done).toBe(true);
  });
  it("rejects an unknown task type", () => {
    expect(() => chzSignerContracts.task.parse({ id: crypto.randomUUID(), type: "nope", payload: {} })).toThrow();
  });
});
