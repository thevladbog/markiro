import { type DemoLead, validateDemoLead } from "../lib/demo-form";
import { canUseCategory, readConsent } from "../lib/consent";
import type { Locale } from "../content/pages";

export interface DemoResponse {
  readonly ok: boolean;
  readonly status: number;
}

export interface DemoFormRuntime {
  readonly request: (endpoint: string, lead: DemoLead) => Promise<DemoResponse>;
  readonly track: (eventName: string, properties: Readonly<Record<string, string>>) => void;
}

type FieldName = "company" | "name" | "phone";

const COPY = {
  en: {
    checking: "Check the highlighted fields",
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
    checking: "Проверьте отмеченные поля",
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

function formInput(form: HTMLFormElement, name: FieldName): HTMLInputElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Demo form is missing the ${name} input`);
  }
  return element;
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
  for (const name of ["name", "company", "phone"] as const) {
    const input = formInput(form, name);
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    const message = form.querySelector<HTMLElement>(`#${name}-error`);
    if (message !== null) message.textContent = "";
  }
}

function showFieldErrors(form: HTMLFormElement, errors: Partial<Record<FieldName, string>>): void {
  clearFieldErrors(form);
  let firstInvalid: HTMLInputElement | null = null;

  for (const name of ["name", "company", "phone"] as const) {
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
    if (endpoint === undefined || endpoint.length === 0) {
      setFormStatus(form, copy.unavailable, "error");
      runtime.track("landing_form_error", { errorClass: "unavailable" });
      return;
    }

    submitting = true;
    setSubmitting(form, true, locale);
    setFormStatus(form, copy.sendingStatus, "idle");

    try {
      const response = await runtime.request(endpoint, validation.value);
      if (response.ok) {
        runtime.track("landing_form_success", {});
        showSuccess(form, locale);
        return;
      }

      if (response.status === 429) {
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

export function browserDemoFormRuntime(browserWindow: Window & typeof globalThis): DemoFormRuntime {
  return {
    request: async (endpoint, lead) => {
      const response = await browserWindow.fetch(endpoint, {
        body: JSON.stringify(lead),
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { ok: response.ok, status: response.status };
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
