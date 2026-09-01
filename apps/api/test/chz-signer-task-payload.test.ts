import { afterEach, describe, expect, it } from "vitest";

import { buildChzTrueApiAuthPayload } from "../src/modules/signer-agents/chz-constants";

const previousTokenFormat = process.env.CHZ_TRUE_API_TOKEN_FORMAT;

afterEach(() => {
  if (previousTokenFormat === undefined) delete process.env.CHZ_TRUE_API_TOKEN_FORMAT;
  else process.env.CHZ_TRUE_API_TOKEN_FORMAT = previousTokenFormat;
});

describe("CHZ signer task payload", () => {
  it("sends the UUID format explicitly by default", () => {
    delete process.env.CHZ_TRUE_API_TOKEN_FORMAT;
    expect(buildChzTrueApiAuthPayload({ environment: "production" })).toEqual({
      trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
      tokenFormat: "uuid",
    });
  });

  it("keeps an explicit JWT rollback payload available", () => {
    process.env.CHZ_TRUE_API_TOKEN_FORMAT = "jwt";
    expect(buildChzTrueApiAuthPayload({ environment: "production" })).toEqual({
      trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
      tokenFormat: "jwt",
    });
  });

  it("propagates the explicit UUID mode together with an MCHD INN", () => {
    process.env.CHZ_TRUE_API_TOKEN_FORMAT = "uuid";
    expect(buildChzTrueApiAuthPayload({ environment: "sandbox", mchdInn: "7712345678" })).toEqual({
      trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      inn: "7712345678",
      tokenFormat: "uuid",
    });
  });
});
