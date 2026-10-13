import { describe, expect, it, vi } from "vitest";

import {
  createTauriAboutApi,
  ExternalLinkError,
  readSystem,
} from "../src/office/info/about-api.js";
import { SUPPORT_CONTACTS, supportMailLink } from "../src/office/info/contacts.js";

const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80";

describe("readSystem", () => {
  it("tells Windows 11 from Windows 10 by the platform version of the client hints", async () => {
    const hints = (platformVersion: string) => ({
      getHighEntropyValues: async () => ({
        platformVersion,
        architecture: "x86",
        bitness: "64",
      }),
    });
    expect(await readSystem(WIN_UA, hints("15.0.0"))).toEqual({
      os: "Windows 11",
      arch: "x64",
      webview: "WebView2 130.0.2849.80",
    });
    expect((await readSystem(WIN_UA, hints("10.0.0"))).os).toBe("Windows 10");
  });

  it("names both when the webview gives no hints, and survives hints that fail", async () => {
    expect(await readSystem(WIN_UA, undefined)).toEqual({
      os: "Windows 10 / 11",
      arch: null,
      webview: "WebView2 130.0.2849.80",
    });
    const failing = {
      getHighEntropyValues: async () => {
        throw new Error("blocked");
      },
    };
    expect((await readSystem(WIN_UA, failing)).os).toBe("Windows 10 / 11");
  });

  it("reads other systems by their user agent", async () => {
    expect(
      (await readSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", undefined)).os,
    ).toBe("macOS");
    expect((await readSystem("Mozilla/5.0 (X11; Linux x86_64)", undefined)).os).toBe("Linux");
  });
});

describe("createTauriAboutApi", () => {
  it("opens a link through the shell's command and reads its refusal code", async () => {
    const call = vi.fn(async () => null);
    await createTauriAboutApi(call).openLink("https://markiro.app");
    expect(call).toHaveBeenCalledWith("open_external_link", { link: "https://markiro.app" });

    for (const code of ["invalid_request", "unsupported", "launch"] as const) {
      const refusing = createTauriAboutApi(async () => {
        throw code;
      });
      await expect(refusing.openLink("https://markiro.app")).rejects.toMatchObject({
        name: "ExternalLinkError",
        code,
      });
    }
    const odd = createTauriAboutApi(async () => {
      throw "something else";
    });
    const error = await odd.openLink("https://markiro.app").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExternalLinkError);
    expect((error as ExternalLinkError).code).toBe("launch");
  });
});

describe("SUPPORT_CONTACTS", () => {
  it("holds the public contacts and nothing more: no phone, no hours", () => {
    expect(Object.keys(SUPPORT_CONTACTS).sort()).toEqual([
      "companyName",
      "email",
      "requisites",
      "site",
    ]);
    expect(SUPPORT_CONTACTS.email).toBe("hello@markiro.app");
    expect(SUPPORT_CONTACTS.site).toEqual({ url: "https://markiro.app", label: "markiro.app" });
    expect(supportMailLink()).toBe("mailto:hello@markiro.app");
  });
});
