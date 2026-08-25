import {
  canUseCategory,
  CONSENT_STORAGE_KEY,
  readConsent,
  serializeConsent,
  type ConsentState,
} from "../lib/consent";

export const GTM_CONTAINER_ID = "GTM-KZ6P7NVF";

const CONSENT_EVENT = "markiro:consent-changed";
const ANALYTICS_EVENT = "markiro:analytics";
const GTM_SCRIPT_SELECTOR = "script[data-markiro-gtm]";

interface DataLayerWindow extends Window {
  dataLayer?: unknown[];
}

interface AnalyticsEventDetail {
  readonly eventName: string;
  readonly properties: Readonly<Record<string, string>>;
}

type BrowserWindow = Window & typeof globalThis;

function storedConsent(browserWindow: BrowserWindow): ConsentState | null {
  return readConsent(browserWindow.localStorage);
}

function saveConsent(browserWindow: BrowserWindow, state: ConsentState): void {
  try {
    browserWindow.localStorage.setItem(CONSENT_STORAGE_KEY, serializeConsent(state));
  } catch {
    // The decision still applies to the current page when persistent storage is unavailable.
  }
  browserWindow.dispatchEvent(new browserWindow.CustomEvent(CONSENT_EVENT, { detail: state }));
}

export function initConsentPanel(root: Document, browserWindow: BrowserWindow): () => void {
  const panel = root.querySelector<HTMLElement>("[data-consent-panel]");
  const summary = panel?.querySelector<HTMLElement>("[data-consent-summary]");
  const details = panel?.querySelector<HTMLElement>("[data-consent-details]");
  const analytics = panel?.querySelector<HTMLInputElement>("[data-consent-analytics]");
  const marketing = panel?.querySelector<HTMLInputElement>("[data-consent-marketing]");
  const reject = panel?.querySelector<HTMLButtonElement>("[data-consent-reject]");
  const customize = panel?.querySelector<HTMLButtonElement>("[data-consent-customize]");
  const accept = panel?.querySelector<HTMLButtonElement>("[data-consent-accept]");
  const save = panel?.querySelector<HTMLButtonElement>("[data-consent-save]");
  const settings = [...root.querySelectorAll<HTMLButtonElement>("[data-consent-settings]")];
  let active = true;

  if (
    panel === null ||
    panel === undefined ||
    summary === null ||
    summary === undefined ||
    details === null ||
    details === undefined ||
    analytics === null ||
    analytics === undefined ||
    marketing === null ||
    marketing === undefined
  ) {
    return () => undefined;
  }

  const showDetails = (): void => {
    const current = storedConsent(browserWindow);
    analytics.checked = current?.analytics ?? false;
    marketing.checked = current?.marketing ?? false;
    summary.hidden = true;
    details.hidden = false;
    panel.hidden = false;
    analytics.focus();
  };

  const choose = (state: ConsentState): void => {
    saveConsent(browserWindow, state);
    panel.hidden = true;
  };

  const onReject = (): void => choose({ version: 1, analytics: false, marketing: false });
  const onAccept = (): void => choose({ version: 1, analytics: true, marketing: true });
  const onCustomize = (): void => showDetails();
  const onSave = (): void =>
    choose({ version: 1, analytics: analytics.checked, marketing: marketing.checked });

  reject?.addEventListener("click", onReject);
  customize?.addEventListener("click", onCustomize);
  accept?.addEventListener("click", onAccept);
  save?.addEventListener("click", onSave);
  for (const control of settings) control.addEventListener("click", onCustomize);

  summary.hidden = false;
  details.hidden = true;
  const revealInitialChoice = (): void => {
    if (!active) return;
    panel.hidden = storedConsent(browserWindow) !== null;
  };
  if (root.fonts === undefined) {
    revealInitialChoice();
  } else {
    void root.fonts.ready.then(revealInitialChoice, revealInitialChoice);
  }

  return () => {
    active = false;
    reject?.removeEventListener("click", onReject);
    customize?.removeEventListener("click", onCustomize);
    accept?.removeEventListener("click", onAccept);
    save?.removeEventListener("click", onSave);
    for (const control of settings) control.removeEventListener("click", onCustomize);
  };
}

function dataLayer(browserWindow: BrowserWindow): unknown[] {
  const target = browserWindow as DataLayerWindow;
  target.dataLayer ??= [];
  return target.dataLayer;
}

function pushGoogleConsent(
  target: unknown[],
  action: "default" | "update",
  state: ConsentState | null,
): void {
  const analytics = state?.analytics === true ? "granted" : "denied";
  const marketing = state?.marketing === true ? "granted" : "denied";
  const settings: Record<string, string> = {
    ad_personalization: marketing,
    ad_storage: marketing,
    ad_user_data: marketing,
    analytics_storage: analytics,
  };
  if (action === "default") {
    settings.functionality_storage = "granted";
    settings.security_storage = "granted";
  }
  function gtag(): void {
    // Google documents this native Arguments shape for commands consumed by dataLayer.
    // eslint-disable-next-line prefer-rest-params
    target.push(arguments);
  }
  Reflect.apply(gtag, undefined, ["consent", action, settings]);
}

function loadTagManager(root: Document, browserWindow: BrowserWindow, containerId: string): void {
  if (root.querySelector(GTM_SCRIPT_SELECTOR) !== null || !/^GTM-[A-Z0-9]+$/.test(containerId)) {
    return;
  }
  dataLayer(browserWindow).push({ "gtm.start": Date.now(), event: "gtm.js" });
  const script = root.createElement("script");
  script.async = true;
  script.dataset.markiroGtm = "";
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
  root.head.append(script);
}

function analyticsDetail(event: Event): AnalyticsEventDetail | null {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== "object" ||
    event.detail === null
  ) {
    return null;
  }
  const value = event.detail as Partial<AnalyticsEventDetail>;
  if (
    typeof value.eventName !== "string" ||
    value.eventName.length === 0 ||
    typeof value.properties !== "object" ||
    value.properties === null
  ) {
    return null;
  }
  return { eventName: value.eventName, properties: value.properties };
}

export function initTagManager(
  root: Document,
  browserWindow: BrowserWindow,
  containerId: string,
): () => void {
  const target = dataLayer(browserWindow);
  pushGoogleConsent(target, "default", null);

  const applyConsent = (): void => {
    const current = storedConsent(browserWindow);
    pushGoogleConsent(target, "update", current);
    if (canUseCategory(current, "analytics")) {
      loadTagManager(root, browserWindow, containerId);
    }
  };

  const onAnalytics = (event: Event): void => {
    if (!canUseCategory(storedConsent(browserWindow), "analytics")) return;
    const detail = analyticsDetail(event);
    if (detail === null) return;
    target.push({ ...detail.properties, event: detail.eventName });
  };

  browserWindow.addEventListener(CONSENT_EVENT, applyConsent);
  browserWindow.addEventListener(ANALYTICS_EVENT, onAnalytics);

  if (storedConsent(browserWindow) !== null) applyConsent();

  return () => {
    browserWindow.removeEventListener(CONSENT_EVENT, applyConsent);
    browserWindow.removeEventListener(ANALYTICS_EVENT, onAnalytics);
  };
}
