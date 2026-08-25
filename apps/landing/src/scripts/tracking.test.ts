// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { CONSENT_STORAGE_KEY, serializeConsent } from "../lib/consent";
import { GTM_CONTAINER_ID, initConsentPanel, initTagManager } from "./tracking";

interface TestDataLayerWindow extends Window {
  dataLayer?: unknown[];
}

function renderConsentPanel(): void {
  document.body.innerHTML = `
    <section data-consent-panel hidden>
      <div data-consent-summary>
        <button type="button" data-consent-reject>Reject</button>
        <button type="button" data-consent-customize>Settings</button>
        <button type="button" data-consent-accept>Accept</button>
      </div>
      <div data-consent-details hidden>
        <input type="checkbox" data-consent-analytics>
        <input type="checkbox" data-consent-marketing>
        <button type="button" data-consent-save>Save</button>
      </div>
    </section>
    <button type="button" data-consent-settings>Cookie settings</button>
  `;
}

function consentCommands(dataLayer: readonly unknown[]): unknown[][] {
  return dataLayer.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("0" in item) || item[0] !== "consent") {
      return [];
    }
    return [Array.from(item as unknown as ArrayLike<unknown>)];
  });
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (window as TestDataLayerWindow).dataLayer;
});

describe("consent panel", () => {
  it("shows an undecided visitor an equal reject, settings, and accept choice", () => {
    renderConsentPanel();

    initConsentPanel(document, window);

    const panel = document.querySelector<HTMLElement>("[data-consent-panel]");
    expect(panel?.hidden).toBe(false);
    expect(
      panel?.querySelectorAll(
        "[data-consent-reject], [data-consent-customize], [data-consent-accept]",
      ),
    ).toHaveLength(3);
  });

  it("persists rejection and announces the versioned category decision", () => {
    renderConsentPanel();
    const decisions: Event[] = [];
    window.addEventListener("markiro:consent-changed", (event) => decisions.push(event));
    initConsentPanel(document, window);

    document.querySelector<HTMLButtonElement>("[data-consent-reject]")?.click();

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe(
      serializeConsent({ version: 1, analytics: false, marketing: false }),
    );
    expect(decisions).toHaveLength(1);
    expect(document.querySelector<HTMLElement>("[data-consent-panel]")?.hidden).toBe(true);
  });

  it("reopens settings and saves granular analytics-only consent", () => {
    renderConsentPanel();
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      serializeConsent({ version: 1, analytics: false, marketing: false }),
    );
    initConsentPanel(document, window);

    document.querySelector<HTMLButtonElement>("[data-consent-settings]")?.click();
    const analytics = document.querySelector<HTMLInputElement>("[data-consent-analytics]");
    const marketing = document.querySelector<HTMLInputElement>("[data-consent-marketing]");
    expect(document.querySelector<HTMLElement>("[data-consent-panel]")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("[data-consent-details]")?.hidden).toBe(false);
    expect(analytics?.checked).toBe(false);
    expect(marketing?.checked).toBe(false);

    if (analytics === null) throw new Error("Analytics checkbox is missing");
    analytics.checked = true;
    document.querySelector<HTMLButtonElement>("[data-consent-save]")?.click();

    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe(
      serializeConsent({ version: 1, analytics: true, marketing: false }),
    );
  });
});

describe("Google Tag Manager consent bridge", () => {
  it("sets denied defaults without loading Google before a choice", () => {
    initTagManager(document, window, GTM_CONTAINER_ID);

    const dataLayer = (window as TestDataLayerWindow).dataLayer ?? [];
    expect(document.querySelector("script[data-markiro-gtm]")).toBeNull();
    expect(Array.isArray(dataLayer[0])).toBe(false);
    expect(consentCommands(dataLayer)[0]).toEqual([
      "consent",
      "default",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
        functionality_storage: "granted",
        security_storage: "granted",
      },
    ]);
  });

  it("loads the configured container once after analytics consent", () => {
    initTagManager(document, window, GTM_CONTAINER_ID);
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      serializeConsent({ version: 1, analytics: true, marketing: false }),
    );

    window.dispatchEvent(
      new CustomEvent("markiro:consent-changed", {
        detail: { version: 1, analytics: true, marketing: false },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("markiro:consent-changed", {
        detail: { version: 1, analytics: true, marketing: false },
      }),
    );

    const scripts = document.querySelectorAll<HTMLScriptElement>("script[data-markiro-gtm]");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-KZ6P7NVF");
    const dataLayer = (window as TestDataLayerWindow).dataLayer ?? [];
    expect(consentCommands(dataLayer).at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "granted",
      },
    ]);
  });

  it("forwards landing events only while analytics consent is granted", () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      serializeConsent({ version: 1, analytics: true, marketing: false }),
    );
    initTagManager(document, window, GTM_CONTAINER_ID);

    window.dispatchEvent(
      new CustomEvent("markiro:analytics", {
        detail: { eventName: "landing_demo_click", properties: { placement: "hero" } },
      }),
    );
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      serializeConsent({ version: 1, analytics: false, marketing: false }),
    );
    window.dispatchEvent(
      new CustomEvent("markiro:consent-changed", {
        detail: { version: 1, analytics: false, marketing: false },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("markiro:analytics", {
        detail: { eventName: "landing_form_start", properties: {} },
      }),
    );

    const dataLayer = (window as TestDataLayerWindow).dataLayer ?? [];
    expect(dataLayer).toContainEqual({
      event: "landing_demo_click",
      placement: "hero",
    });
    expect(dataLayer).not.toContainEqual({ event: "landing_form_start" });
    expect(consentCommands(dataLayer).at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
      },
    ]);
  });
});
