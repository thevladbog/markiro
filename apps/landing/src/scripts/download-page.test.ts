// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StandaloneRelease } from "../lib/release";
import { initDownloadPage } from "./download-page";
import { initDownloadFollowup } from "./download-followup";

const RELEASE: StandaloneRelease = {
  version: "0.4.0",
  releasedAt: "2026-10-18T09:00:00Z",
  installerUrl:
    "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
  fileName: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
  sha256: "3f9c1e7a52d84b06c9e1f3a7d20b5e8c41f6a9d3b7e2c05f18a4d6b9e3c7f201",
  sizeBytes: 64_987_136,
  notes: [],
};

function render(): void {
  document.body.innerHTML = `
    <section data-download-start><div data-release-fact hidden><dd data-release="version"></dd></div><dd data-release="size"></dd></section>
    <section data-download-ready hidden>
      <div data-loading-only hidden><h2 tabindex="-1" data-ready-heading>Проверяем установщик</h2></div>
      <div data-release-only>
        <h2 tabindex="-1" data-ready-heading>Ссылка готова</h2>
        <span data-ready-email></span>
        <p data-release="file"></p><code data-release="sha256"></code>
        <a href="#" data-release-link>Скачать</a>
        <button type="button" data-copy="sha256" data-copied-label="SHA-256 скопирован">copy</button>
      </div>
      <div data-pending-only hidden>
        <h2 tabindex="-1" data-ready-heading>Версия готовится</h2>
        <span data-ready-email></span><button type="button" data-release-retry>Проверить ещё раз</button>
      </div>
      <p data-copy-status></p>
    </section>
    <section data-download-after hidden></section>
    <code data-release="command"></code>`;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("download page", () => {
  it("does not restore a stale accepted view after the visitor edits email during manifest loading", async () => {
    render();
    window.scrollTo = vi.fn();
    const start = document.querySelector<HTMLElement>("[data-download-start]")!;
    start.innerHTML =
      '<form data-consent-version="v1"><input name="email" value="old@example.test"><input name="company" value="Производство"><input name="consent" type="checkbox" checked></form>';
    document
      .querySelector("[data-download-ready]")
      ?.insertAdjacentHTML("beforeend", "<button data-change-email>Изменить почту</button>");
    let finish: (value: StandaloneRelease | null) => void = () => {};
    const pending = new Promise<StandaloneRelease | null>((resolve) => {
      finish = resolve;
    });
    const page = initDownloadPage(document, { fetchRelease: () => pending, copy: vi.fn() });
    const followup = initDownloadFollowup(
      document,
      start.querySelector("form")!,
      {
        createRequestId: () => "id",
        currentPath: () => "/skachat/",
        firstTouch: () => ({}),
        request: vi.fn(),
        track: vi.fn(),
      },
      () => page.edit(),
    );
    const accepted = page.accept("old@example.test");
    document.querySelector<HTMLButtonElement>("[data-change-email]")?.click();
    expect(start.hidden).toBe(false);
    finish(RELEASE);
    await accepted;
    expect(start.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("[data-download-ready]")?.hidden).toBe(true);
    await page.accept("corrected@example.test");
    expect(document.querySelector("[data-ready-email]")?.textContent).toBe(
      "corrected@example.test",
    );
    followup.dispose();
    page.dispose();
  });
  it("acknowledges the accepted lead while release metadata is still loading", async () => {
    render();
    let finish: (value: StandaloneRelease | null) => void = () => {};
    const pending = new Promise<StandaloneRelease | null>((resolve) => {
      finish = resolve;
    });
    const page = initDownloadPage(document, { fetchRelease: () => pending, copy: vi.fn() });
    const accepted = page.accept("buyer@example.test");
    expect(document.querySelector<HTMLElement>("[data-download-start]")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-loading-only]")?.hidden).toBe(false);
    finish(RELEASE);
    await accepted;
    expect(document.querySelector<HTMLElement>("[data-loading-only]")?.hidden).toBe(true);
    page.dispose();
  });
  it("rechecks a missing release without resubmitting the lead", async () => {
    render();
    window.scrollTo = vi.fn();
    const fetchRelease = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RELEASE);
    const page = initDownloadPage(document, { fetchRelease, copy: vi.fn() });
    await page.accept("buyer@example.test");
    document.querySelector<HTMLButtonElement>("[data-release-retry]")?.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>("[data-download-ready]")?.dataset.release).toBe(
        "ready",
      ),
    );
    expect(fetchRelease).toHaveBeenCalledTimes(3);
    page.dispose();
  });
  it("reads latest.json only once the visitor turns to the form", () => {
    render();
    const fetchRelease = vi.fn(() => Promise.resolve(RELEASE));
    const page = initDownloadPage(document, { fetchRelease, copy: vi.fn() });
    expect(fetchRelease).not.toHaveBeenCalled();
    page.prefetch();
    page.prefetch();
    expect(fetchRelease).toHaveBeenCalledOnce();
    page.dispose();
  });

  it("fills the facts on first use and shows the link once the form is accepted", async () => {
    render();
    window.scrollTo = vi.fn();
    const page = initDownloadPage(document, {
      fetchRelease: vi.fn(() => Promise.resolve(RELEASE)),
      copy: vi.fn(() => Promise.resolve()),
    });
    page.prefetch();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector("[data-release-fact]")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector('[data-release="version"]')?.textContent).toBe("0.4.0");
    expect(document.querySelector('[data-release="size"]')?.textContent).toBe("62 МБ");

    await page.accept("ivan@zavod.ru");
    expect(document.querySelector("[data-download-start]")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("[data-download-ready]")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("[data-download-after]")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector("[data-pending-only]")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("[data-release-link]")?.getAttribute("href")).toBe(
      RELEASE.installerUrl,
    );
    expect(document.querySelector('[data-release="command"]')?.textContent).toBe(
      "Get-FileHash .\\markiro-standalone-0.4.0-windows-x86_64-setup.exe -Algorithm SHA256",
    );
    expect(document.querySelector("[data-ready-email]")?.textContent).toBe("ivan@zavod.ru");
    expect(document.activeElement?.textContent).toBe("Ссылка готова");
    page.dispose();
  });

  it("retries the pointer once and then says the version is being prepared", async () => {
    render();
    window.scrollTo = vi.fn();
    const fetchRelease = vi.fn(() => Promise.resolve(null));
    const page = initDownloadPage(document, { fetchRelease, copy: vi.fn() });
    await page.accept("ivan@zavod.ru");
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-release-only]")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("[data-pending-only]")?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement?.textContent).toBe("Версия готовится");
    page.dispose();
  });

  it("copies the hash and announces it", async () => {
    render();
    const copy = vi.fn(() => Promise.resolve());
    const page = initDownloadPage(document, {
      fetchRelease: vi.fn(() => Promise.resolve(RELEASE)),
      copy,
    });
    page.prefetch();
    await Promise.resolve();
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>('[data-copy="sha256"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-copy-status]")?.textContent).toBe("SHA-256 скопирован");
    });
    expect(copy).toHaveBeenCalledWith(RELEASE.sha256);
    page.dispose();
  });
});
