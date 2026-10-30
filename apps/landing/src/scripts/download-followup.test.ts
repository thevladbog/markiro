// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initDownloadFollowup } from "./download-followup";
import type { LeadFormRuntime } from "./lead-form";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});
it("resends the saved download with a fresh id, keeps that id on retry, and enforces the cooldown", async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<section data-download-start hidden><form data-intent="download" data-endpoint="/api/landing-leads" data-consent-version="v1"><input name="email" value="buyer@example.test"><input name="company" value="Производство"><input name="tariffCode" value="line"><input name="consent" type="checkbox" checked><input name="website" value=""></form></section><section data-download-ready><button data-resend-link>Отправить письмо ещё раз</button><button data-change-email>Изменить почту</button><p data-followup-status></p></section>';
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true, status: 202 });
  const runtime: LeadFormRuntime = {
    request,
    createRequestId: () => "22222222-2222-4222-8222-222222222222",
    currentPath: () => "/skachat/",
    firstTouch: () => ({}),
    track: vi.fn(),
  };
  const form = document.querySelector("form")!;
  const subject = initDownloadFollowup(document, form, runtime);
  subject.accepted();
  const button = document.querySelector<HTMLButtonElement>("[data-resend-link]")!;
  expect(button.disabled).toBe(true);
  button.click();
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000);
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-followup-status]")?.textContent).toContain("Не удалось");
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1]);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    intent: "download",
    email: "buyer@example.test",
    company: "Производство",
    tariffCode: "line",
  });
  expect(button.disabled).toBe(true);
  document.querySelector<HTMLButtonElement>("[data-change-email]")?.click();
  expect(document.querySelector<HTMLElement>("[data-download-ready]")?.hidden).toBe(true);
  expect(document.querySelector<HTMLElement>("[data-download-start]")?.hidden).toBe(false);
  expect(form.querySelector<HTMLInputElement>('[name="consent"]')?.checked).toBe(false);
  expect(document.activeElement).toBe(form.querySelector('[name="email"]'));
  subject.dispose();
});
