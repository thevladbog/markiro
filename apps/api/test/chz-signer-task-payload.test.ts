import { afterEach, describe, expect, it } from "vitest";

import {
  buildChzOmsAuthPayload,
  buildChzTrueApiAuthPayload,
} from "../src/modules/signer-agents/chz-constants";

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

  it("restores the legacy wire payload for an explicit JWT rollback", () => {
    process.env.CHZ_TRUE_API_TOKEN_FORMAT = "jwt";
    expect(buildChzTrueApiAuthPayload({ environment: "production" })).toEqual({
      trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api",
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

describe("CHZ oms_auth payload", () => {
  it("is null without an OMS connection and carries the connection otherwise", () => {
    expect(buildChzOmsAuthPayload({ environment: "sandbox" })).toBeNull();
    expect(
      buildChzOmsAuthPayload({
        environment: "sandbox",
        omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
        omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        mchdInn: "7712345678",
      }),
    ).toEqual({
      trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
      inn: "7712345678",
    });
  });
});
