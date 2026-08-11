import { describe, expect, it } from "vitest";
import { buildPlatformAuth, type Db } from "../src/index.js";

describe("buildPlatformAuth", () => {
  it("uses a separate route, cookie namespace, origin, and only the two-factor plugin", () => {
    const auth = buildPlatformAuth({} as Db, {
      secret: "0123456789abcdef0123456789abcdef",
      baseURL: "https://api.example.test",
      trustedOrigins: ["https://saas.example.test"],
    });

    expect(auth.options.basePath).toBe("/api/platform-auth");
    expect(auth.options.trustedOrigins).toEqual(["https://saas.example.test"]);
    expect(auth.options.plugins?.map((plugin) => plugin.id)).toEqual(["two-factor"]);
    expect(auth.options.advanced).toMatchObject({
      cookiePrefix: "markiro-platform",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
    });
  });
});
