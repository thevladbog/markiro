import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
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
