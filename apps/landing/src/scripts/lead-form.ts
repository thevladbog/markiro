import { readFirstTouch, type FirstTouch, type SessionStore } from "../lib/first-touch";
import {
  type LeadErrors,
  type LeadField,
  type LeadIntent,
  validateDownloadLead,
  validateInvoiceLead,
} from "../lib/lead-form";
import { LATEST_RELEASE_URL, parseLatestRelease, type StandaloneRelease } from "../lib/release";
import { browserDemoFormRuntime, readDemoErrorCode, type DemoErrorCode } from "./demo-form";

/**
 * The two lead forms of the standalone pages: «get the installer» on /skachat/
 * and «get an invoice» on /stoimost/. Both post to `/api/landing-leads`
 * (spec 2026-10-20, section 15.3); the captcha, honeypot and consent mechanics are
 * the demo form's.
 */

interface LeadPayloadBase {
  readonly captchaToken: string;
  readonly consentVersion: string;
  readonly email: string;
  readonly locale: "ru";
  readonly referrer?: string;
  readonly requestId: string;
  readonly sourcePath: string;
  readonly utm?: FirstTouch["utm"];
  readonly website: string;
}

export type LandingLeadPayload =
  | (LeadPayloadBase & { readonly intent: "download"; readonly company: string })
  | (LeadPayloadBase & {
      readonly intent: "invoice";
      readonly inn: string;
      readonly tariffCode: string;
    });

export interface LeadResponse {
  readonly code?: DemoErrorCode;
  readonly ok: boolean;
  readonly status: number;
}

export interface LeadAccepted {
  readonly email: string;
  readonly intent: LeadIntent;
  readonly tariffCode?: string;
}

export interface LeadFormRuntime {
  readonly createRequestId: () => string;
  readonly currentPath: () => string;
  readonly firstTouch: () => FirstTouch;
  readonly loadCaptcha: () => void;
  readonly request: (endpoint: string, payload: LandingLeadPayload) => Promise<LeadResponse>;
  readonly resetCaptcha: (form: HTMLFormElement) => void;
  readonly track: (eventName: string, properties: Readonly<Record<string, string>>) => void;
  readonly whenNear: (element: Element, callback: () => void) => () => void;
}

export const LEAD_FORM_COPY = {
  captcha: "Подтвердите, что вы не робот, ещё раз",
  checking: "Проверьте отмеченные поля",
  consent: "Нужно согласие на обработку данных",
  networkHeading: "Не получилось отправить",
  networkText: "Данные в форме сохранены. Попробуйте ещё раз или напишите на hello@markiro.app.",
  rateLimited: "Слишком много запросов. Подождите несколько минут и повторите.",
  sending: "Отправляем…",
  unavailable: "Отправка формы пока не подключена. Напишите на hello@markiro.app.",
} as const;

const FIELDS: Readonly<Record<LeadIntent, readonly LeadField[]>> = {
  download: ["email", "company"],
  invoice: ["inn", "tariffCode", "email"],
};

function formIntent(form: HTMLFormElement): LeadIntent {
  return form.dataset.intent === "invoice" ? "invoice" : "download";
}

function control(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement | null {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? element
    : null;
}

function value(form: HTMLFormElement, name: string): string {
  return control(form, name)?.value ?? "";
}

function errorElement(form: HTMLFormElement, name: string): HTMLElement | null {
  return form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
}

function clearErrors(form: HTMLFormElement): void {
  for (const name of [...FIELDS[formIntent(form)], "consent"]) {
    const input = control(form, name);
    input?.removeAttribute("aria-invalid");
    input?.removeAttribute("aria-describedby");
    const message = errorElement(form, name);
    if (message !== null) message.textContent = "";
  }
  const captchaError = form.querySelector<HTMLElement>("[data-captcha-error]");
  if (captchaError !== null) captchaError.textContent = "";
}

function markInvalid(form: HTMLFormElement, name: string, message: string): HTMLElement | null {
  const input = control(form, name);
  const error = errorElement(form, name);
  if (error !== null) error.textContent = message;
  if (input !== null) {
    input.setAttribute("aria-invalid", "true");
    if (error?.id) input.setAttribute("aria-describedby", error.id);
  }
  return input;
}

function showFieldErrors(form: HTMLFormElement, errors: LeadErrors): void {
  let first: HTMLElement | null = null;
  for (const name of FIELDS[formIntent(form)]) {
    const message = errors[name];
    if (message === undefined) continue;
    const input = markInvalid(form, name, message);
    first ??= input;
  }
  first?.focus();
}

type FormState = "idle" | "sending" | "failed";

function setState(form: HTMLFormElement, state: FormState, message = ""): void {
  form.dataset.state = state;
  const fields = form.querySelector<HTMLFieldSetElement>("[data-lead-fields]");
  if (fields !== null) fields.disabled = state === "sending";
  const button = form.querySelector<HTMLButtonElement>("[data-lead-submit]");
  button?.setAttribute("aria-busy", String(state === "sending"));
  for (const label of form.querySelectorAll<HTMLElement>("[data-label]")) {
    const kind = label.dataset.label;
    label.hidden =
      kind === "sending"
        ? state !== "sending"
        : kind === "retry"
          ? state !== "failed"
          : state !== "idle";
  }
  const alert = form.querySelector<HTMLElement>("[data-lead-alert]");
  if (alert !== null) alert.hidden = state !== "failed";
  const status = form.querySelector<HTMLElement>("[data-form-status]");
  if (status !== null) status.textContent = message;
}

function setStatus(form: HTMLFormElement, message: string): void {
  const status = form.querySelector<HTMLElement>("[data-form-status]");
  if (status !== null) status.textContent = message;
}

export function initLeadForm(
  form: HTMLFormElement,
  runtime: LeadFormRuntime,
  onAccepted: (lead: LeadAccepted) => void,
): () => void {
  let submitting = false;
  let started = false;
  const requestId = runtime.createRequestId();
  const intent = formIntent(form);
  const placement = intent === "invoice" ? "invoice" : "download";

  const onInput = (): void => {
    if (started) return;
    started = true;
    runtime.track("landing_form_start", { placement });
  };

  const fail = (errorClass: string, message: string): void => {
    setStatus(form, message);
    runtime.track("landing_form_error", { errorClass, placement });
  };

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    runtime.track("landing_form_submit", { placement });
    clearErrors(form);

    const validation =
      intent === "invoice"
        ? validateInvoiceLead({
            email: value(form, "email"),
            inn: value(form, "inn"),
            tariffCode: value(form, "tariffCode"),
          })
        : validateDownloadLead({ company: value(form, "company"), email: value(form, "email") });

    const consent = control(form, "consent");
    const consentMissing = !(consent instanceof HTMLInputElement && consent.checked);

    if (!validation.ok) {
      showFieldErrors(form, validation.errors);
      if (consentMissing) markInvalid(form, "consent", LEAD_FORM_COPY.consent);
      fail("validation", LEAD_FORM_COPY.checking);
      return;
    }

    const endpoint = form.dataset.endpoint;
    const consentVersion = form.dataset.consentVersion;
    if (!endpoint || !consentVersion) {
      fail("unavailable", LEAD_FORM_COPY.unavailable);
      return;
    }

    if (consentMissing) {
      markInvalid(form, "consent", LEAD_FORM_COPY.consent)?.focus();
      fail("validation", LEAD_FORM_COPY.checking);
      return;
    }

    const captchaInput = control(form, "smart-token");
    const captchaToken = captchaInput?.value.trim() ?? "";
    if (captchaInput === null || captchaToken.length === 0) {
      const error = form.querySelector<HTMLElement>("[data-captcha-error]");
      if (error !== null) {
        error.textContent = LEAD_FORM_COPY.captcha;
        error.focus();
      }
      fail("validation", LEAD_FORM_COPY.checking);
      return;
    }

    const touch = runtime.firstTouch();
    const base: LeadPayloadBase = {
      captchaToken,
      consentVersion,
      email: validation.value.email,
      locale: "ru",
      requestId,
      sourcePath: runtime.currentPath(),
      website: value(form, "website"),
      ...(touch.utm === undefined ? {} : { utm: touch.utm }),
      ...(touch.referrer === undefined ? {} : { referrer: touch.referrer }),
    };
    const payload: LandingLeadPayload =
      "company" in validation.value
        ? { ...base, intent: "download", company: validation.value.company }
        : {
            ...base,
            intent: "invoice",
            inn: validation.value.inn,
            tariffCode: validation.value.tariffCode,
          };

    submitting = true;
    setState(form, "sending", LEAD_FORM_COPY.sending);

    try {
      const response = await runtime.request(endpoint, payload);
      if (response.ok) {
        runtime.track("landing_form_success", { placement });
        setState(form, "idle");
        onAccepted({
          email: payload.email,
          intent,
          ...(payload.intent === "invoice" ? { tariffCode: payload.tariffCode } : {}),
        });
        return;
      }

      if (response.code === "captcha_invalid") {
        captchaInput.value = "";
        runtime.resetCaptcha(form);
        setState(form, "idle");
        const error = form.querySelector<HTMLElement>("[data-captcha-error]");
        if (error !== null) {
          error.textContent = LEAD_FORM_COPY.captcha;
          error.focus();
        }
        fail("captcha", LEAD_FORM_COPY.checking);
      } else if (response.status === 429 || response.code === "rate_limited") {
        setState(form, "idle");
        fail("rate_limited", LEAD_FORM_COPY.rateLimited);
      } else {
        setState(form, "failed");
        fail("server", `${LEAD_FORM_COPY.networkHeading}. ${LEAD_FORM_COPY.networkText}`);
      }
    } catch {
      setState(form, "failed");
      fail("network", `${LEAD_FORM_COPY.networkHeading}. ${LEAD_FORM_COPY.networkText}`);
    } finally {
      submitting = false;
    }
  };

  const handleSubmit = (event: SubmitEvent): void => {
    void onSubmit(event);
  };

  form.addEventListener("input", onInput, { once: true });
  form.addEventListener("submit", handleSubmit);

  let stopWatching: () => void = () => undefined;
  let captchaRequested = false;
  const requestCaptcha = (): void => {
    if (captchaRequested) return;
    captchaRequested = true;
    stopWatching();
    form.removeEventListener("focusin", requestCaptcha);
    form.removeEventListener("pointerdown", requestCaptcha);
    runtime.loadCaptcha();
  };
  if (form.querySelector(".smart-captcha") !== null) {
    form.addEventListener("focusin", requestCaptcha);
    form.addEventListener("pointerdown", requestCaptcha);
    stopWatching = runtime.whenNear(form, requestCaptcha);
  }

  return () => {
    form.removeEventListener("input", onInput);
    form.removeEventListener("submit", handleSubmit);
    form.removeEventListener("focusin", requestCaptcha);
    form.removeEventListener("pointerdown", requestCaptcha);
    stopWatching();
  };
}

export function browserLeadFormRuntime(browserWindow: Window & typeof globalThis): LeadFormRuntime {
  const demo = browserDemoFormRuntime(browserWindow);
  const session: SessionStore = {
    getItem: (key) => browserWindow.sessionStorage.getItem(key),
    setItem: (key, item) => browserWindow.sessionStorage.setItem(key, item),
  };
  return {
    createRequestId: demo.createRequestId,
    currentPath: demo.currentPath,
    firstTouch: () => readFirstTouch(session),
    loadCaptcha: demo.loadCaptcha,
    request: async (endpoint, payload) => {
      const response = await browserWindow.fetch(endpoint, {
        body: JSON.stringify(payload),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) return { ok: true, status: response.status };
      let code: DemoErrorCode | undefined;
      try {
        code = readDemoErrorCode(await response.json());
      } catch {
        code = undefined;
      }
      return code === undefined
        ? { ok: false, status: response.status }
        : { code, ok: false, status: response.status };
    },
    resetCaptcha: demo.resetCaptcha,
    track: demo.track,
    whenNear: demo.whenNear,
  };
}

const RELEASE_TIMEOUT_MS = 8000;

/** `null` when the pointer is missing, unreachable or malformed: the page then says the version is being prepared. */
export async function fetchLatestRelease(
  browserWindow: Window & typeof globalThis,
): Promise<StandaloneRelease | null> {
  const controller = new browserWindow.AbortController();
  const timer = browserWindow.setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
  try {
    const response = await browserWindow.fetch(LATEST_RELEASE_URL, {
      cache: "no-cache",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseLatestRelease(await response.json());
  } catch {
    return null;
  } finally {
    browserWindow.clearTimeout(timer);
  }
}
