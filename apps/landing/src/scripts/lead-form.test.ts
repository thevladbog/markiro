// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { initLeadForm, LEAD_FORM_COPY, type LeadFormRuntime, type LeadResponse } from "./lead-form";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function renderDownload(endpoint = "/api/landing-leads"): HTMLFormElement {
  document.body.innerHTML = `
    <form data-lead-form data-intent="download" data-consent-version="MKR-PD-02/2026.08/01"
      ${endpoint.length > 0 ? `data-endpoint="${endpoint}"` : ""}>
      <fieldset data-lead-fields>
        <input id="d-email" name="email" value=" Ivan@Zavod.ru " />
        <p id="d-email-error" data-error-for="email"></p>
        <input id="d-company" name="company" value="ООО «Пивоварня»" />
        <p id="d-company-error" data-error-for="company"></p>
        <input name="website" value="" />
        <input id="d-consent" name="consent" type="checkbox" checked />
        <p id="d-consent-error" data-error-for="consent"></p>
        <div class="smart-captcha"></div>
        <input name="smart-token" type="hidden" value="captcha-token" />
        <p data-captcha-error tabindex="-1"></p>
        <div data-lead-alert hidden></div>
        <button type="submit" data-lead-submit>
          <span data-label="idle">Скачать пробную версию</span>
          <span data-label="sending" hidden>Отправляем…</span>
          <span data-label="retry" hidden>Отправить ещё раз</span>
        </button>
      </fieldset>
      <p data-form-status></p>
    </form>`;
  return document.querySelector("form") as HTMLFormElement;
}

function renderInvoice(): HTMLFormElement {
  document.body.innerHTML = `
    <form data-lead-form data-intent="invoice" data-endpoint="/api/landing-leads" data-consent-version="v1">
      <fieldset data-lead-fields>
        <input id="i-inn" name="inn" value="77070838" />
        <p id="i-inn-error" data-error-for="inn"></p>
        <select id="i-tariff" name="tariffCode"><option value="line" selected>Линия</option><option value="start">Старт</option></select>
        <p id="i-tariff-error" data-error-for="tariffCode"></p>
        <input id="i-email" name="email" value="ivan@zavod" />
        <p id="i-email-error" data-error-for="email"></p>
        <input name="website" value="" />
        <input id="i-consent" name="consent" type="checkbox" />
        <p id="i-consent-error" data-error-for="consent"></p>
        <div class="smart-captcha"></div>
        <input name="smart-token" type="hidden" value="captcha-token" />
        <p data-captcha-error tabindex="-1"></p>
        <div data-lead-alert hidden></div>
        <button type="submit" data-lead-submit><span data-label="idle">Получить счёт</span><span data-label="sending" hidden></span><span data-label="retry" hidden></span></button>
      </fieldset>
      <p data-form-status></p>
    </form>`;
  return document.querySelector("form") as HTMLFormElement;
}

function runtime(responses: readonly (LeadResponse | Error)[] = [{ ok: true, status: 202 }]) {
  let index = 0;
  const value: LeadFormRuntime = {
    createRequestId: vi.fn(() => REQUEST_ID),
    currentPath: vi.fn(() => "/skachat/"),
    firstTouch: vi.fn(() => ({
      utm: { source: "yandex", medium: "cpc" },
      referrer: "https://ya.ru/",
    })),
    request: vi.fn(() => {
      const response = responses[index++] ?? responses.at(-1);
      if (response === undefined) throw new Error("no response");
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }),
    track: vi.fn(),
  };
  return value;
}

async function submit(form: HTMLFormElement): Promise<void> {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(form.dataset.state ?? "idle").not.toBe("sending");
  });
  await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("download lead form", () => {
  it.each(["download", "invoice"])(
    "rotates id when %s input changes after an ambiguous response",
    async (intent) => {
      const form = intent === "download" ? renderDownload() : renderInvoice();
      if (intent === "invoice") {
        (form.querySelector('[name="inn"]') as HTMLInputElement).value = "7707083893";
        (form.querySelector('[name="email"]') as HTMLInputElement).value = "billing@example.test";
        (form.querySelector('[name="consent"]') as HTMLInputElement).checked = true;
      }
      const current: LeadFormRuntime = {
        ...runtime([new Error("response lost after commit"), { ok: true, status: 202 }]),
        createRequestId: vi
          .fn()
          .mockReturnValueOnce(REQUEST_ID)
          .mockReturnValue("22222222-2222-4222-8222-222222222222"),
      };
      initLeadForm(form, current, vi.fn());
      await submit(form);
      if (intent === "download")
        (form.querySelector('[name="email"]') as HTMLInputElement).value = "corrected@example.test";
      else (form.querySelector('[name="tariffCode"]') as HTMLSelectElement).value = "start";
      await submit(form);
      const calls = (current.request as Mock).mock.calls as [
        string,
        { requestId: string; email: string; tariffCode?: string },
      ][];
      expect(calls[0]?.[1].requestId).not.toBe(calls[1]?.[1].requestId);
      expect(calls[1]?.[1]).toMatchObject(
        intent === "download" ? { email: "corrected@example.test" } : { tariffCode: "start" },
      );
    },
  );
  it.each(["start", "line", "workshop"])(
    "preserves selected %s through retry and acceptance",
    async (tariffCode) => {
      const form = renderDownload();
      form.insertAdjacentHTML(
        "beforeend",
        `<input type="hidden" name="tariffCode" value="${tariffCode}" />`,
      );
      const current = runtime([new Error("offline"), { ok: true, status: 202 }]);
      const accepted = vi.fn();
      initLeadForm(form, current, accepted);
      await submit(form);
      await submit(form);
      const calls = (current.request as Mock).mock.calls;
      expect(calls).toHaveLength(2);
      for (const call of calls)
        expect(call[1]).toMatchObject({ tariffCode, requestId: REQUEST_ID, intent: "download" });
      expect(accepted).toHaveBeenCalledWith({
        email: "ivan@zavod.ru",
        intent: "download",
        tariffCode,
      });
    },
  );
  it("posts the spec 15.3 body with the first-touch source and reports acceptance", async () => {
    const form = renderDownload();
    const current = runtime();
    const accepted = vi.fn();
    initLeadForm(form, current, accepted);
    await submit(form);

    expect(current.request).toHaveBeenCalledWith("/api/landing-leads", {
      company: "ООО «Пивоварня»",
      consentVersion: "MKR-PD-02/2026.08/01",
      email: "ivan@zavod.ru",
      intent: "download",
      locale: "ru",
      referrer: "https://ya.ru/",
      requestId: REQUEST_ID,
      sourcePath: "/skachat/",
      utm: { source: "yandex", medium: "cpc" },
      website: "",
    });
    expect(accepted).toHaveBeenCalledWith({ email: "ivan@zavod.ru", intent: "download" });
  });

  it("keeps the same request id on a retry so the API can deduplicate it", async () => {
    const form = renderDownload();
    const current = runtime([new Error("offline"), { ok: true, status: 202 }]);
    initLeadForm(form, current, vi.fn());
    await submit(form);

    expect(form.dataset.state).toBe("failed");
    expect(form.querySelector<HTMLElement>("[data-lead-alert]")?.hidden).toBe(false);
    expect(form.querySelector<HTMLElement>('[data-label="retry"]')?.hidden).toBe(false);
    expect(form.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe(" Ivan@Zavod.ru ");

    await submit(form);
    const calls = (current.request as Mock).mock.calls as [string, { requestId: string }][];
    expect(calls.map(([, payload]) => payload.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(form.querySelector<HTMLElement>("[data-lead-alert]")?.hidden).toBe(true);
  });

  it("does not send when the build has no endpoint", async () => {
    const form = renderDownload("");
    const current = runtime();
    initLeadForm(form, current, vi.fn());
    await submit(form);
    expect(current.request).not.toHaveBeenCalled();
    expect(form.querySelector("[data-form-status]")?.textContent).toBe(LEAD_FORM_COPY.unavailable);
  });

  it("submits without captcha fields or a third-party request", async () => {
    const form = renderDownload();
    form.querySelector('[name="smart-token"]')?.remove();
    form.querySelector(".smart-captcha")?.remove();
    const current = runtime();
    const accepted = vi.fn();
    initLeadForm(form, current, accepted);
    form.querySelector("input")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await submit(form);
    expect(accepted).toHaveBeenCalledWith({ email: "ivan@zavod.ru", intent: "download" });
    expect(current.request).toHaveBeenCalledOnce();
  });
});

describe("invoice lead form", () => {
  it("marks every invalid field, including consent, at the field", async () => {
    const form = renderInvoice();
    const current = runtime();
    initLeadForm(form, current, vi.fn());
    await submit(form);

    expect(current.request).not.toHaveBeenCalled();
    const inn = form.querySelector<HTMLInputElement>('[name="inn"]');
    expect(inn?.getAttribute("aria-invalid")).toBe("true");
    expect(inn?.getAttribute("aria-describedby")).toBe("i-inn-error");
    expect(form.querySelector("#i-inn-error")?.textContent).toBe(
      "ИНН — 10 цифр для организации или 12 для ИП",
    );
    expect(form.querySelector("#i-email-error")?.textContent).toBe(
      "Проверьте почту: не хватает домена, например zavod.ru",
    );
    expect(form.querySelector("#i-consent-error")?.textContent).toBe(LEAD_FORM_COPY.consent);
    expect(document.activeElement).toBe(inn);
  });

  it("sends the INN and tariff without a company", async () => {
    const form = renderInvoice();
    (form.querySelector('[name="inn"]') as HTMLInputElement).value = "7707083893";
    (form.querySelector('[name="email"]') as HTMLInputElement).value = "buh@zavod.ru";
    (form.querySelector('[name="consent"]') as HTMLInputElement).checked = true;
    const current = runtime();
    const accepted = vi.fn();
    initLeadForm(form, current, accepted);
    await submit(form);

    const [, payload] = (current.request as Mock).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toMatchObject({ intent: "invoice", inn: "7707083893", tariffCode: "line" });
    expect(payload).not.toHaveProperty("company");
    expect(accepted).toHaveBeenCalledWith({
      email: "buh@zavod.ru",
      intent: "invoice",
      tariffCode: "line",
    });
  });
});
