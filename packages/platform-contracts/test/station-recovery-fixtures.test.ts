import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  stationRecoveryRequestSchema,
  stationRecoveryResponseSchema,
} from "../src/station-recovery.js";

const cases = z
  .array(z.object({ name: z.string(), valid: z.boolean(), response: z.unknown() }))
  .parse(
    JSON.parse(
      readFileSync(new URL("../fixtures/station-recovery/responses.json", import.meta.url), "utf8"),
    ),
  );

describe("shared Kotlin and TypeScript recovery response fixtures", () => {
  it.each(cases)("$name", ({ response, valid }) => {
    expect(stationRecoveryResponseSchema.safeParse(response).success).toBe(valid);
  });
});

const requestCases = z
  .array(z.object({ name: z.string(), valid: z.boolean(), request: z.unknown() }))
  .parse(
    JSON.parse(
      readFileSync(new URL("../fixtures/station-recovery/requests.json", import.meta.url), "utf8"),
    ),
  );
describe("shared Kotlin and TypeScript recovery request fixtures", () => {
  it.each(requestCases)("$name", ({ request, valid }) => {
    expect(stationRecoveryRequestSchema.safeParse(request).success).toBe(valid);
  });
});
