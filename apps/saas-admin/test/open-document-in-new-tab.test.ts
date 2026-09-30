import { afterEach, describe, expect, it, vi } from "vitest";

import { openDocumentInNewTab } from "../src/pages/documents/openDocumentInNewTab.js";

const newTab = () => ({ opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe("openDocumentInNewTab", () => {
  it("opens the tab before the URL is known and navigates it afterwards", async () => {
    const target = newTab();
    const open = vi.fn().mockReturnValue(target);
    vi.stubGlobal("open", open);
    let resolveUrl: (url: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });

    expect(openDocumentInNewTab(() => pending)).toBe(true);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(target.opener).toBeNull();
    expect(target.location.replace).not.toHaveBeenCalled();

    resolveUrl("https://objects.example.test/doc.pdf");
    await vi.waitFor(() =>
      expect(target.location.replace).toHaveBeenCalledWith("https://objects.example.test/doc.pdf"),
    );
    expect(target.close).not.toHaveBeenCalled();
  });

  it("closes the blank tab when the URL cannot be obtained", async () => {
    const target = newTab();
    vi.stubGlobal("open", vi.fn().mockReturnValue(target));

    expect(openDocumentInNewTab(() => Promise.reject(new Error("unavailable")))).toBe(true);

    await vi.waitFor(() => expect(target.close).toHaveBeenCalledOnce());
    expect(target.location.replace).not.toHaveBeenCalled();
  });

  it("reports a blocked tab without requesting the URL", () => {
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    const getUrl = vi.fn(() => Promise.resolve("https://objects.example.test/doc.pdf"));

    expect(openDocumentInNewTab(getUrl)).toBe(false);
    expect(getUrl).not.toHaveBeenCalled();
  });
});
