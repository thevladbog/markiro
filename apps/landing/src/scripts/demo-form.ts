import type { Locale } from "../content/pages";
import { type DemoLead, validateDemoLead } from "../lib/demo-form";
import { canUseCategory, readConsent } from "../lib/consent";

export interface DemoRequestPayload extends DemoLead {
  readonly captchaToken: string;
  readonly consentVersion: string;
  readonly locale: Locale;
  readonly requestId: string;
  readonly sourcePath: string;
  readonly website: string;
}

type DemoErrorCode =
  | "captcha_invalid"
  | "captcha_unavailable"
  | "invalid_request"
  | "rate_limited"
  | "submission_disabled"
  | "submission_unavailable";

export interface DemoResponse {
  readonly code?: DemoErrorCode;
  readonly ok: boolean;
  readonly status: number;
}

export interface DemoFormRuntime {
  readonly createRequestId: () => string;
  readonly currentPath: () => string;
  readonly request: (endpoint: string, payload: DemoRequestPayload) => Promise<DemoResponse>;
  readonly resetCaptcha: (form: HTMLFormElement) => void;
  readonly track: (eventName: string, properties: Readonly<Record<string, string>>) => void;
}

type FieldName = "company" | "email" | "name" | "phone";
type InputName = FieldName | "consent" | "smart-token" | "website";

const PUBLIC_ERROR_CODES = new Set<DemoErrorCode>([
  "captcha_invalid",
  "captcha_unavailable",
  "invalid_request",
  "rate_limited",
  "submission_disabled",
  "submission_unavailable",
]);

const COPY = {
  en: {
    captcha: "Complete the captcha again",
    checking: "Check the highlighted fields",
    consent: "Confirm that you accept the personal-data terms",
    network: "The request was not sent. Check your connection and try again.",
    rateLimited: "Too many requests. Wait a few minutes and try again.",
    request: "Request a demonstration",
    sending: "Sending request",
    sendingStatus: "Sending request...",
    server: "The request was not sent. Try again later.",
    successHeading: "Request received",
    successText: "We will contact you to review the line and prepare a focused demonstration.",
    unavailable: "Online submission is not connected yet. Try again later.",
  },
  ru: {
    captcha: "Подтвердите, что вы не робот, ещё раз",
    checking: "Проверьте отмеченные поля",
    consent: "Подтвердите согласие на обработку персональных данных",
    network: "Заявка не отправлена: проверьте соединение и повторите попытку.",
    rateLimited: "Слишком много запросов. Подождите несколько минут и повторите.",
    request: "Запросить демонстрацию",
    sending: "Отправляем запрос",
    sendingStatus: "Отправляем запрос...",
    server: "Заявка не отправлена. Попробуйте ещё раз позже.",
    successHeading: "Запрос получили",
    successText: "Свяжемся с вами, чтобы разобрать линию и подготовить предметную демонстрацию.",
    unavailable: "Отправка формы пока не подключена. Попробуйте позже.",
  },
} as const;

function formLocale(form: HTMLFormElement): Locale {
  return form.dataset.locale === "en" ? "en" : "ru";
}

function formInput(form: HTMLFormElement, name: InputName): HTMLInputElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Demo form is missing the ${name} input`);
  }
  return element;
}

function consentInput(form: HTMLFormElement): HTMLInputElement {
  return formInput(form, "consent");
}

function setFormStatus(form: HTMLFormElement, message: string, state: "error" | "idle"): void {
  const status = form.querySelector<HTMLElement>("[data-form-status]");
  if (status === null) return;
  status.textContent = message;
  status.dataset.state = state;
}

function setSubmitting(form: HTMLFormElement, submitting: boolean, locale: Locale): void {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button === null) return;
  button.disabled = submitting;
  button.setAttribute("aria-busy", String(submitting));
  const label = button.querySelector("span");
  if (label !== null) label.textContent = submitting ? COPY[locale].sending : COPY[locale].request;
}

function clearFieldErrors(form: HTMLFormElement): void {
  for (const name of ["name", "company", "email", "phone"] as const) {
    const input = formInput(form, name);
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    const message = form.querySelector<HTMLElement>(`#${name}-error`);
    if (message !== null) message.textContent = "";
  }

  const consent = form.elements.namedItem("consent");
  if (consent instanceof HTMLInputElement) {
    consent.removeAttribute("aria-invalid");
    consent.removeAttribute("aria-describedby");
  }
  const consentError = form.querySelector<HTMLElement>("[data-consent-error]");
  if (consentError !== null) consentError.textContent = "";
  const captchaError = form.querySelector<HTMLElement>("[data-captcha-error]");
  if (captchaError !== null) captchaError.textContent = "";
}

function showFieldErrors(form: HTMLFormElement, errors: Partial<Record<FieldName, string>>): void {
  clearFieldErrors(form);
  let firstInvalid: HTMLInputElement | null = null;

  for (const name of ["name", "company", "email", "phone"] as const) {
    const error = errors[name];
    if (error === undefined) continue;
    const input = formInput(form, name);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", `${name}-error`);
    const message = form.querySelector<HTMLElement>(`#${name}-error`);
    if (message !== null) message.textContent = error;
    firstInvalid ??= input;
  }

  firstInvalid?.focus();
}

function showConsentError(form: HTMLFormElement, message: string): void {
  const consent = consentInput(form);
  consent.setAttribute("aria-invalid", "true");
  consent.setAttribute("aria-describedby", "consent-error");
  const error = form.querySelector<HTMLElement>("[data-consent-error]");
  if (error !== null) error.textContent = message;
  consent.focus();
}

function showCaptchaError(form: HTMLFormElement, message: string): void {
  const error = form.querySelector<HTMLElement>("[data-captcha-error]");
  if (error === null) return;
  error.textContent = message;
  error.focus();
}

function showSuccess(form: HTMLFormElement, locale: Locale): void {
  const copy = COPY[locale];
  const confirmation = document.createElement("div");
  confirmation.className = "demo-success";
  confirmation.dataset.demoSuccess = "";
  confirmation.tabIndex = -1;
  confirmation.innerHTML = `
    <span class="demo-success__mark" aria-hidden="true"></span>
    <h3>${copy.successHeading}</h3>
    <p>${copy.successText}</p>
  `;
  form.replaceWith(confirmation);
  confirmation.focus();
}

export function initDemoForm(form: HTMLFormElement, runtime: DemoFormRuntime): () => void {
  let submitting = false;
  let started = false;
  const requestId = runtime.createRequestId();
  const locale = formLocale(form);
  const copy = COPY[locale];

  const onInput = (): void => {
    if (started) return;
    started = true;
    runtime.track("landing_form_start", {});
  };

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;

    const validation = validateDemoLead(
      {
        company: formInput(form, "company").value,
        email: formInput(form, "email").value,
        name: formInput(form, "name").value,
        phone: formInput(form, "phone").value,
      },
      locale,
    );

    if (!validation.ok) {
      showFieldErrors(form, validation.errors);
      setFormStatus(form, copy.checking, "error");
      runtime.track("landing_form_error", { errorClass: "validation" });
      return;
    }

    clearFieldErrors(form);
    const endpoint = form.dataset.endpoint;
    const consentVersion = form.dataset.consentVersion;
    if (
      endpoint === undefined ||
      endpoint.length === 0 ||
      consentVersion === undefined ||
      consentVersion.length === 0
    ) {
      setFormStatus(form, copy.unavailable, "error");
      runtime.track("landing_form_error", { errorClass: "unavailable" });
      return;
    }

    if (!consentInput(form).checked) {
      showConsentError(form, copy.consent);
      setFormStatus(form, copy.checking, "error");
      runtime.track("landing_form_error", { errorClass: "validation" });
      return;
    }

    const captchaTokenInput = formInput(form, "smart-token");
    const captchaToken = captchaTokenInput.value.trim();
    if (captchaToken.length === 0) {
      showCaptchaError(form, copy.captcha);
      setFormStatus(form, copy.checking, "error");
      runtime.track("landing_form_error", { errorClass: "validation" });
      return;
    }

    const payload: DemoRequestPayload = {
      ...validation.value,
      captchaToken,
      consentVersion,
      locale,
      requestId,
      sourcePath: runtime.currentPath(),
      website: formInput(form, "website").value,
    };

    submitting = true;
    setSubmitting(form, true, locale);
    setFormStatus(form, copy.sendingStatus, "idle");

    try {
      const response = await runtime.request(endpoint, payload);
      if (response.ok && response.status === 202) {
        runtime.track("landing_form_success", {});
        showSuccess(form, locale);
        return;
      }

      if (response.code === "captcha_invalid") {
        captchaTokenInput.value = "";
        runtime.resetCaptcha(form);
        showCaptchaError(form, copy.captcha);
        setFormStatus(form, copy.checking, "error");
        runtime.track("landing_form_error", { errorClass: "captcha" });
      } else if (response.status === 429 || response.code === "rate_limited") {
        setFormStatus(form, copy.rateLimited, "error");
        runtime.track("landing_form_error", { errorClass: "rate_limited" });
      } else {
        setFormStatus(form, copy.server, "error");
        runtime.track("landing_form_error", { errorClass: "server" });
      }
    } catch {
      setFormStatus(form, copy.network, "error");
      runtime.track("landing_form_error", { errorClass: "network" });
    } finally {
      submitting = false;
      if (form.isConnected) setSubmitting(form, false, locale);
    }
  };

  const handleSubmit = (event: SubmitEvent): void => {
    void onSubmit(event);
  };

  form.addEventListener("input", onInput, { once: true });
  form.addEventListener("submit", handleSubmit);

  return () => {
    form.removeEventListener("input", onInput);
    form.removeEventListener("submit", handleSubmit);
  };
}

function readErrorCode(value: unknown): DemoErrorCode | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const code = value.code;
  return typeof code === "string" && PUBLIC_ERROR_CODES.has(code as DemoErrorCode)
    ? (code as DemoErrorCode)
    : undefined;
}

export function browserDemoFormRuntime(browserWindow: Window & typeof globalThis): DemoFormRuntime {
  return {
    createRequestId: () => browserWindow.crypto.randomUUID(),
    currentPath: () => browserWindow.location.pathname,
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
        code = readErrorCode(await response.json());
      } catch {
        code = undefined;
      }
      return code === undefined
        ? { ok: false, status: response.status }
        : { code, ok: false, status: response.status };
    },
    resetCaptcha: () => {
      const captchaWindow = browserWindow as typeof browserWindow & {
        smartCaptcha?: { reset: () => void };
      };
      captchaWindow.smartCaptcha?.reset();
    },
    track: (eventName, properties) => {
      if (!canUseCategory(readConsent(browserWindow.localStorage), "analytics")) return;
      browserWindow.dispatchEvent(
        new browserWindow.CustomEvent("markiro:analytics", {
          detail: { eventName, properties },
        }),
      );
    },
  };
}
