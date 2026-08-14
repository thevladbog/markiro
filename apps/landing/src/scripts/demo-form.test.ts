// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { initDemoForm, type DemoFormRuntime, type DemoResponse } from "./demo-form";

function renderForm(endpoint = "/api/demo-requests"): HTMLFormElement {
  document.body.innerHTML = `
    <form data-demo-form ${endpoint.length > 0 ? `data-endpoint="${endpoint}"` : ""}>
      <label for="name">Имя</label>
      <input id="name" name="name" value="Анна" />
      <span id="name-error"></span>
      <label for="company">Компания</label>
      <input id="company" name="company" value="Завод Север" />
      <span id="company-error"></span>
      <label for="phone">Телефон</label>
      <input id="phone" name="phone" value="8 (999) 123-45-67" />
      <span id="phone-error"></span>
      <button type="submit"><span>Запросить демонстрацию</span></button>
      <p data-form-status aria-live="polite"></p>
    </form>
  `;
  const form = document.querySelector<HTMLFormElement>("form");
  if (form === null) throw new Error("Form fixture is missing");
  return form;
}

function runtime(response: DemoResponse | Error = { ok: true, status: 201 }): DemoFormRuntime {
  return {
    request: vi.fn(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    ),
    track: vi.fn(),
  };
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
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

  it("posts only the normalized lead and replaces the form with a focused confirmation", async () => {
    const form = renderForm();
    const currentRuntime = runtime();
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(currentRuntime.request).toHaveBeenCalledWith("/api/demo-requests", {
      company: "Завод Север",
      name: "Анна",
      phone: "+79991234567",
    });
    const confirmation = document.querySelector<HTMLElement>("[data-demo-success]");
    expect(confirmation?.textContent).toContain("Запрос получили");
    expect(document.activeElement).toBe(confirmation);
    expect(currentRuntime.track).toHaveBeenCalledWith("landing_form_success", {});
  });

  it("blocks a duplicate submit while the first request is pending", async () => {
    const form = renderForm();
    let resolveRequest: ((response: DemoResponse) => void) | undefined;
    const currentRuntime: DemoFormRuntime = {
      request: vi.fn(
        () =>
          new Promise<DemoResponse>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
      track: vi.fn(),
    };
    initDemoForm(form, currentRuntime);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(currentRuntime.request).toHaveBeenCalledOnce();
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    resolveRequest?.({ ok: true, status: 201 });
    await Promise.resolve();
  });

  it("retains values and gives retry guidance after rate limiting", async () => {
    const form = renderForm();
    const currentRuntime = runtime({ ok: false, status: 429 });
    initDemoForm(form, currentRuntime);

    await submit(form);

    expect(form.isConnected).toBe(true);
    expect((form.elements.namedItem("company") as HTMLInputElement).value).toBe("Завод Север");
    expect(form.querySelector("[data-form-status]")?.textContent).toContain(
      "Слишком много запросов",
    );
    expect(currentRuntime.track).toHaveBeenCalledWith("landing_form_error", {
      errorClass: "rate_limited",
    });
  });

  it("reports a network failure without claiming that the request was queued", async () => {
    const form = renderForm();
    const currentRuntime = runtime(new Error("offline"));
    initDemoForm(form, currentRuntime);

    await submit(form);

    const message = form.querySelector("[data-form-status]")?.textContent ?? "";
    expect(message).toContain("не отправлена");
    expect(message).not.toContain("очеред");
    expect(form.isConnected).toBe(true);
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
