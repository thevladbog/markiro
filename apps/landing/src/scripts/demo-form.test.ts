// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserDemoFormRuntime,
  initDemoForm,
  type DemoFormRuntime,
  type DemoRequestPayload,
  type DemoResponse,
} from "./demo-form";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function renderForm(endpoint = "/api/demo-requests", locale: "ru" | "en" = "ru"): HTMLFormElement {
  document.body.innerHTML = `
    <form
      data-demo-form
      data-locale="${locale}"
      data-consent-version="MKR-PD-02/2026.08.01"
      data-source-path="${locale === "en" ? "/en/" : "/"}"
      ${endpoint.length > 0 ? `data-endpoint="${endpoint}"` : ""}
    >
      <label for="name">Имя</label>
      <input id="name" name="name" value="Анна" />
      <span id="name-error"></span>
      <label for="company">Компания</label>
      <input id="company" name="company" value="Завод Север" />
      <span id="company-error"></span>
      <label for="email">Email</label>
      <input id="email" name="email" value=" ANNA@EXAMPLE.TEST " />
      <span id="email-error"></span>
      <label for="phone">Телефон</label>
      <input id="phone" name="phone" value="8 (999) 123-45-67" />
      <span id="phone-error"></span>
      <div aria-hidden="true">
        <label for="website">Website</label>
        <input id="website" name="website" value="" />
      </div>
      <input id="consent" name="consent" type="checkbox" checked required />
      <span id="consent-error" data-consent-error></span>
      <div class="smart-captcha"></div>
      <input name="smart-token" type="hidden" value="captcha-token" />
      <p id="captcha-error" data-captcha-error tabindex="-1"></p>
      <button type="submit"><span>Запросить демонстрацию</span></button>
      <p data-form-status aria-live="polite"></p>
    </form>
  `;
  const form = document.querySelector<HTMLFormElement>("form");
  if (form === null) throw new Error("Form fixture is missing");
  return form;
}

function runtime(
  responses: readonly (DemoResponse | Error)[] = [{ ok: true, status: 202 }],
  requestIds: readonly string[] = [REQUEST_ID],
): DemoFormRuntime {
  let responseIndex = 0;
  let requestIdIndex = 0;
  return {
    createRequestId: vi.fn(() => requestIds[requestIdIndex++] ?? requestIds.at(-1) ?? REQUEST_ID),
    currentPath: vi.fn(() => "/"),
    request: vi.fn(() => {
      const response = responses[responseIndex++] ?? responses.at(-1);
      if (response === undefined) throw new Error("Runtime fixture requires one response");
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }),
    resetCaptcha: vi.fn(),
    track: vi.fn(),
  };
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fieldValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(
    ["name", "company", "email", "phone"].map((name) => [
      name,
      (form.elements.namedItem(name) as HTMLInputElement).value,
    ]),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "fetch");
  Reflect.deleteProperty(window, "smartCaptcha");
  vi.restoreAllMocks();
});

describe("initDemoForm", () => {
  it("shows field errors, focuses the first invalid field, and does not send", async () => {
    const form = renderForm();
    const currentRuntime = runtime();
    const name = form.elements.namedItem("name") as HTMLInputElement;
    name.value = "";
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("name-error");
    expect(document.querySelector("#name-error")?.textContent).toBe("Укажите имя");
    expect(document.activeElement).toBe(name);
    expect(currentRuntime.request).not.toHaveBeenCalled();
  });

  it("uses English validation and success copy for the English form", async () => {
    const invalidForm = renderForm("/api/demo-requests", "en");
    const name = invalidForm.elements.namedItem("name") as HTMLInputElement;
    name.value = "";
    initDemoForm(invalidForm, { ...runtime(), currentPath: () => "/en/" });

    await submit(invalidForm);
    expect(invalidForm.querySelector("#name-error")?.textContent).toBe("Enter your name");

    const validForm = renderForm("/api/demo-requests", "en");
    const phone = validForm.elements.namedItem("phone") as HTMLInputElement;
    phone.value = "+1 (202) 555-0114";
    initDemoForm(validForm, { ...runtime(), currentPath: () => "/en/" });
    await submit(validForm);
    expect(document.querySelector("[data-demo-success]")?.textContent).toContain(
      "Request received",
    );
  });

  it("posts the exact Task 4 payload and replaces the form with a focused confirmation", async () => {
    const form = renderForm();
    const currentRuntime = runtime();
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(currentRuntime.request).toHaveBeenCalledWith("/api/demo-requests", {
      captchaToken: "captcha-token",
      company: "Завод Север",
      consentVersion: "MKR-PD-02/2026.08.01",
      email: "anna@example.test",
      locale: "ru",
      name: "Анна",
      phone: "+79991234567",
      requestId: REQUEST_ID,
      sourcePath: "/",
      website: "",
    });
    const confirmation = document.querySelector<HTMLElement>("[data-demo-success]");
    expect(confirmation?.textContent).toContain("Запрос получили");
    expect(document.activeElement).toBe(confirmation);
    expect(currentRuntime.track).toHaveBeenCalledWith("landing_form_success", {});
  });

  it("reuses one request id across a 503 retry and creates a new id for a new form", async () => {
    const firstForm = renderForm();
    const currentRuntime = runtime(
      [
        { code: "submission_unavailable", ok: false, status: 503 },
        { ok: true, status: 202 },
        { ok: true, status: 202 },
      ],
      [REQUEST_ID, NEXT_REQUEST_ID],
    );
    initDemoForm(firstForm, currentRuntime);

    await submit(firstForm);
    await submit(firstForm);

    expect(currentRuntime.createRequestId).toHaveBeenCalledOnce();
    expect(currentRuntime.request).toHaveBeenNthCalledWith(
      1,
      "/api/demo-requests",
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
    expect(currentRuntime.request).toHaveBeenNthCalledWith(
      2,
      "/api/demo-requests",
      expect.objectContaining({ requestId: REQUEST_ID }),
    );

    const secondForm = renderForm();
    initDemoForm(secondForm, currentRuntime);
    await submit(secondForm);

    expect(currentRuntime.createRequestId).toHaveBeenCalledTimes(2);
    expect(currentRuntime.request).toHaveBeenNthCalledWith(
      3,
      "/api/demo-requests",
      expect.objectContaining({ requestId: NEXT_REQUEST_ID }),
    );
  });

  it("blocks a duplicate submit while the first request is pending", async () => {
    const form = renderForm();
    let resolveRequest: ((response: DemoResponse) => void) | undefined;
    const currentRuntime: DemoFormRuntime = {
      ...runtime(),
      request: vi.fn(
        () =>
          new Promise<DemoResponse>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };
    initDemoForm(form, currentRuntime);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(currentRuntime.request).toHaveBeenCalledOnce();
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    resolveRequest?.({ ok: true, status: 202 });
    await Promise.resolve();
  });

  it.each([
    {
      expected: "Слишком много запросов",
      response: { code: "rate_limited", ok: false, status: 429 } satisfies DemoResponse,
    },
    {
      expected: "Попробуйте ещё раз позже",
      response: { code: "submission_unavailable", ok: false, status: 503 } satisfies DemoResponse,
    },
    { expected: "проверьте соединение", response: new Error("offline") },
  ])("retains fields and allows retry after $expected", async ({ expected, response }) => {
    const form = renderForm();
    const values = fieldValues(form);
    const currentRuntime = runtime([response]);
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(form.isConnected).toBe(true);
    expect(fieldValues(form)).toEqual(values);
    expect(form.querySelector("[data-form-status]")?.textContent).toContain(expected);
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("resets an invalid captcha token and focuses its error", async () => {
    const form = renderForm();
    const token = form.elements.namedItem("smart-token") as HTMLInputElement;
    const captchaError = form.querySelector<HTMLElement>("[data-captcha-error]");
    const currentRuntime = runtime([{ code: "captcha_invalid", ok: false, status: 400 }]);
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(currentRuntime.resetCaptcha).toHaveBeenCalledWith(form);
    expect(token.value).toBe("");
    expect(captchaError?.textContent).toContain("Подтвердите");
    expect(document.activeElement).toBe(captchaError);
    expect(fieldValues(form).email).toBe(" ANNA@EXAMPLE.TEST ");
  });

  it.each(["consent", "smart-token"])(
    "does not request without the required %s value",
    async (missing) => {
      const form = renderForm();
      const currentRuntime = runtime();
      const input = form.elements.namedItem(missing) as HTMLInputElement;
      if (missing === "consent") input.checked = false;
      else input.value = "";
      initDemoForm(form, currentRuntime);

      await submit(form);

      expect(currentRuntime.request).not.toHaveBeenCalled();
      const error = form.querySelector(
        `[data-${missing === "consent" ? "consent" : "captcha"}-error]`,
      );
      expect(error).not.toBeNull();
      expect(error?.textContent).not.toBe("");
    },
  );

  it("treats an absent captcha token input as an incomplete challenge", async () => {
    const form = renderForm("/api/demo-requests", "en");
    (form.elements.namedItem("phone") as HTMLInputElement).value = "";
    const tokenInput = form.elements.namedItem("smart-token");
    if (!(tokenInput instanceof HTMLInputElement)) throw new Error("Token fixture is missing");
    tokenInput.remove();
    const captchaError = form.querySelector<HTMLElement>("[data-captcha-error]");
    const currentRuntime = runtime();
    initDemoForm(form, { ...currentRuntime, currentPath: () => "/en/" });

    await submit(form);

    expect(currentRuntime.request).not.toHaveBeenCalled();
    expect(currentRuntime.resetCaptcha).not.toHaveBeenCalled();
    expect(captchaError?.textContent).toContain("Complete the captcha again");
    expect(document.activeElement).toBe(captchaError);
  });

  it("keeps analytics properties free of form values and request metadata", async () => {
    const form = renderForm();
    const currentRuntime = runtime([{ code: "submission_unavailable", ok: false, status: 503 }]);
    initDemoForm(form, currentRuntime);

    form.dispatchEvent(new Event("input", { bubbles: true }));
    await submit(form);

    const serializedProperties = JSON.stringify(
      vi.mocked(currentRuntime.track).mock.calls.map(([, properties]) => properties),
    );
    for (const forbidden of [
      "Анна",
      "Завод Север",
      "ANNA@EXAMPLE.TEST",
      "8 (999) 123-45-67",
      "captcha-token",
      REQUEST_ID,
      "sourcePath",
    ]) {
      expect(serializedProperties).not.toContain(forbidden);
    }
    expect(currentRuntime.track).toHaveBeenCalledWith("landing_form_start", {});
    expect(currentRuntime.track).toHaveBeenCalledWith("landing_form_error", {
      errorClass: "server",
    });
  });

  it("does not make a request when the public endpoint is not configured", async () => {
    const form = renderForm("");
    const currentRuntime = runtime();
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(currentRuntime.request).not.toHaveBeenCalled();
    expect(form.querySelector("[data-form-status]")?.textContent).toContain("пока не подключена");
  });
});

describe("browserDemoFormRuntime", () => {
  it("posts JSON without credentials and exposes only the bounded public error code", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ code: "captcha_invalid", detail: "do not expose" }),
      ok: false,
      status: 400,
    });
    Object.defineProperty(window, "fetch", { configurable: true, value: fetch });
    const currentRuntime = browserDemoFormRuntime(window);
    const payload: DemoRequestPayload = {
      captchaToken: "captcha-token",
      company: "Factory",
      consentVersion: "MKR-PD-02/2026.08.01",
      email: "ada@example.test",
      locale: "en",
      name: "Ada",
      requestId: REQUEST_ID,
      sourcePath: "/en/",
      website: "",
    };

    await expect(currentRuntime.request("/api/demo-requests", payload)).resolves.toEqual({
      code: "captcha_invalid",
      ok: false,
      status: 400,
    });
    expect(fetch).toHaveBeenCalledWith("/api/demo-requests", {
      body: JSON.stringify(payload),
      credentials: "omit",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const reset = vi.fn();
    Object.defineProperty(window, "smartCaptcha", {
      configurable: true,
      value: { reset },
    });
    currentRuntime.resetCaptcha(document.createElement("form"));
    expect(reset).toHaveBeenCalledOnce();
  });
});
