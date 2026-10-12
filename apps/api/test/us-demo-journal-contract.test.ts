import { canonicalExportDigest } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  parseUsDemoIntent,
  parseUsDemoReceipt,
} from "../src/modules/traceability/demo/us-demo-journal-contract.js";

const operationKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recordId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const intent = (input: Record<string, unknown>) => ({
  stage: "receiving",
  operationKey,
  inputDigest: canonicalExportDigest(input),
  input,
});
const receipt = (result: Record<string, unknown>) => ({
  recordIds: [recordId],
  resultDigest: canonicalExportDigest(result),
  result,
});
const invalidInput = (input: unknown) => ({
  stage: "receiving",
  operationKey,
  inputDigest: "a".repeat(64),
  input,
});
const invalidResult = (result: unknown) => ({
  recordIds: [recordId],
  resultDigest: "a".repeat(64),
  result,
});

describe("US demo journal codec", () => {
  it("preserves JSON evidence strings exactly and does not freeze caller objects", () => {
    const input = {
      tlc: "  Ä\u0301😀".repeat(1000),
      quantity: "0500.00",
      empty: "",
      nested: { values: [null, true, 0, "\u001d"] },
    };
    expect(parseUsDemoIntent(intent(input)).input).toEqual(input);
    expect(parseUsDemoReceipt(receipt(input)).result).toEqual(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
    const parsed = parseUsDemoIntent(intent(input));
    input.nested.values.push("caller mutation");
    expect(parsed.input).not.toEqual(input);
  });

  it.each([
    "references",
    "receiving",
    "transformation",
    "cases",
    "shipping",
    "trace_readiness",
    "plan",
    "request",
    "package",
  ])("accepts stage %s", (stage) => {
    expect(parseUsDemoIntent({ ...intent({}), stage }).stage).toBe(stage);
  });

  it.each([
    { stage: "complete" },
    { operationKey: "bad" },
    { operationKey: operationKey.toUpperCase() },
    { inputDigest: "A".repeat(64) },
    { inputDigest: "a".repeat(63) },
    { extra: "private-marker" },
  ])("rejects malformed intent metadata with a finite private-safe error", (change) => {
    expect(() => parseUsDemoIntent({ ...intent({}), ...change })).toThrow(
      /^us_demo_intent_invalid$/,
    );
  });

  it.each([
    { recordIds: ["bad"] },
    { recordIds: [recordId.toUpperCase()] },
    { resultDigest: "A".repeat(64) },
    { extra: "private-marker" },
  ])("rejects malformed receipt metadata", (change) => {
    expect(() => parseUsDemoReceipt({ ...receipt({}), ...change })).toThrow(
      /^us_demo_receipt_invalid$/,
    );
  });

  it("verifies both content digests", () => {
    expect(() =>
      parseUsDemoIntent({ ...intent({ tlc: "original" }), input: { tlc: "changed" } }),
    ).toThrow("us_demo_intent_digest_mismatch");
    expect(() =>
      parseUsDemoReceipt({ ...receipt({ quantity: "100" }), result: { quantity: "101" } }),
    ).toThrow("us_demo_receipt_digest_mismatch");
  });

  it.each([
    null,
    [],
    "object required",
    { value: undefined },
    { value: 1n },
    { value: NaN },
    { value: Infinity },
    { value: () => 1 },
    { value: Symbol("private-marker") },
    { value: new Date() },
    { value: new Map() },
    { value: new Set() },
    { value: /x/ },
    { value: new Array<unknown>(2) },
    { value: "\ud800" },
    { value: "\udc00" },
    { value: "\ud800x" },
    { value: "a\0b" },
    { "\ud800": "invalid key" },
    { "a\0b": "invalid key" },
  ])("rejects non-JSON or invalid Unicode evidence without exposing values", (value) => {
    expect(() => parseUsDemoIntent(invalidInput(value))).toThrow(/^us_demo_json_invalid$/);
    expect(() => parseUsDemoReceipt(invalidResult(value))).toThrow(/^us_demo_json_invalid$/);
  });

  it("rejects cycles, hidden properties, symbol keys, accessors and nonplain objects without evaluating accessors", () => {
    const cycle: Record<string, unknown> = {};
    cycle["child"] = cycle;
    let reads = 0;
    const accessor = Object.defineProperty({}, "child", {
      enumerable: true,
      get: () => {
        reads++;
        return "private-marker";
      },
    });
    const hidden = Object.defineProperty({}, "hidden", { value: "private-marker" });
    const symbol = { [Symbol("private-marker")]: "hidden" };
    const array = Object.assign([1], { extra: true });
    for (const value of [
      cycle,
      accessor,
      hidden,
      symbol,
      { array },
      Object.create({ inherited: true }),
    ]) {
      expect(() => parseUsDemoIntent(invalidInput(value))).toThrow(/^us_demo_json_invalid$/);
    }
    expect(reads).toBe(0);
  });

  it.each([
    "password",
    "passwordHash",
    "access_token",
    "sessionToken",
    "COOKIE",
    "mfaSecret",
    "totp_seed",
    "backupCodes",
    "storageCredentials",
    "secretAccessKey",
    "accessKeyId",
    "api_key",
    "s3-storage-key",
    "objectKey",
    "signedUrl",
  ])("rejects secret-bearing key %s nested in objects and arrays", (key) => {
    const value = { rows: [{ [key]: "synthetic-private-marker" }] };
    expect(() => parseUsDemoIntent(intent(value))).toThrow(/^us_demo_json_secret_key$/);
    expect(() => parseUsDemoReceipt(receipt(value))).toThrow(/^us_demo_json_secret_key$/);
  });

  it.each(["authorization", "AUTHORIZATION", "privateKey", "private_key"])(
    "rejects credential-bearing alias %s in nested objects and arrays through both parsers",
    (key) => {
      for (const value of [
        { nested: { [key]: "synthetic-private-marker" } },
        { rows: [{ [key]: "synthetic-private-marker" }] },
      ]) {
        expect.soft(() => parseUsDemoIntent(intent(value))).toThrow(/^us_demo_json_secret_key$/);
        expect.soft(() => parseUsDemoReceipt(receipt(value))).toThrow(/^us_demo_json_secret_key$/);
      }
    },
  );

  it("accepts exactly 256 KiB serialized UTF-8 and rejects one byte over for input and result", () => {
    const exact = { value: "a".repeat(256 * 1024 - 12) };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(256 * 1024);
    expect(parseUsDemoIntent(intent(exact)).input).toEqual(exact);
    expect(parseUsDemoReceipt(receipt(exact)).result).toEqual(exact);
    const multibyteExact = { tlc: "😀".repeat(65533) + "aa" };
    expect(Buffer.byteLength(JSON.stringify(multibyteExact), "utf8")).toBe(256 * 1024);
    expect(parseUsDemoIntent(intent(multibyteExact)).input).toEqual(multibyteExact);
    expect(parseUsDemoReceipt(receipt(multibyteExact)).result).toEqual(multibyteExact);
    const oversized = { value: exact.value + "a" };
    for (const value of [oversized, { value: "😀".repeat(65536) }, { ["é".repeat(131072)]: 1 }]) {
      expect(() => parseUsDemoIntent(intent(value))).toThrow(/^us_demo_json_too_large$/);
      expect(() => parseUsDemoReceipt(receipt(value))).toThrow(/^us_demo_json_too_large$/);
    }
  });

  it("bounds container depth at 16 while accepting a maximum-depth object and array", () => {
    const atDepth = (depth: number, array = false): Record<string, unknown> => {
      let value: unknown = "leaf";
      for (let index = 1; index < depth; index++) value = array ? [value] : { child: value };
      return { child: value };
    };
    for (const array of [false, true]) {
      const exact = atDepth(16, array);
      expect(parseUsDemoIntent(intent(exact)).input).toEqual(exact);
      expect(parseUsDemoReceipt(receipt(exact)).result).toEqual(exact);
      expect(() => parseUsDemoIntent(intent(atDepth(17, array)))).toThrow(
        /^us_demo_json_too_deep$/,
      );
      expect(() => parseUsDemoReceipt(receipt(atDepth(17, array)))).toThrow(
        /^us_demo_json_too_deep$/,
      );
    }
  });
});
