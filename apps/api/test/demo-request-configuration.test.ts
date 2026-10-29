import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env";
import { DemoRequestsModule } from "../src/modules/demo-requests/demo-requests.module";
import { DEMO_REQUEST_SUBMISSION_ENABLED } from "../src/modules/demo-requests/demo-request-submission.guard";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

describe("legacy demo intake configuration", () => {
  it.each([undefined, "ysc2_fixture"])(
    "requires its CAPTCHA key independently of lead intake: %s",
    (key) => {
      const env = loadEnv({
        ...PLATFORM_TEST_ENV,
        DATABASE_URL: "postgres://unused:unused@localhost/test",
        BETTER_AUTH_SECRET: "insecure-test-auth-placeholder",
        PAIRING_CODE_PEPPER: "insecure-test-pepper",
        BETTER_AUTH_URL: "http://localhost:3000",
        LANDING_DEMO_SUBMISSION_ENABLED: "true",
        LANDING_ORIGIN: "https://markiro.example",
        LANDING_DEMO_RECIPIENT: "owner@example.test",
        LANDING_DEMO_REPLY_TO: "hello@example.test",
        ...(key === undefined ? {} : { SMARTCAPTCHA_SERVER_KEY: key }),
      });
      const provider = DemoRequestsModule.forRoot(env).providers?.find(
        (value) =>
          typeof value === "object" &&
          "provide" in value &&
          value.provide === DEMO_REQUEST_SUBMISSION_ENABLED,
      );
      if (typeof provider !== "object" || !("useValue" in provider))
        throw new Error("missing demo switch");
      expect(provider.useValue).toBe(key !== undefined);
    },
  );
});
