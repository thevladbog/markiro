import { isTariffCode, validateDownloadLead } from "../lib/lead-form";
import type { LandingLeadPayload, LeadFormRuntime } from "./lead-form";

/** Explicit repeat-mail action; never retries the initial form as a second request. */
export function initDownloadFollowup(
  root: Document,
  form: HTMLFormElement,
  runtime: LeadFormRuntime,
  onEdit?: () => void,
) {
  const button = root.querySelector<HTMLButtonElement>("[data-resend-link]");
  const status = root.querySelector<HTMLElement>("[data-followup-status]");
  type DownloadPayload = Extract<LandingLeadPayload, { intent: "download" }>;
  let saved: Omit<DownloadPayload, "requestId"> | null = null;
  let attempt: DownloadPayload | null = null;
  let deadline = 0;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const message = (text: string): void => {
    if (status) status.textContent = text;
  };
  const update = (): void => {
    if (!button) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    button.disabled = busy || seconds > 0;
    button.textContent = busy
      ? "Отправляем ещё раз…"
      : seconds > 0
        ? `Повторить письмо через ${seconds} с`
        : "Отправить письмо ещё раз";
    if (!seconds && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const cooldown = (): void => {
    deadline = Date.now() + 60_000;
    if (timer !== undefined) clearInterval(timer);
    timer = setInterval(update, 1000);
    update();
  };
  const read = (name: string): string => {
    const value = new FormData(form).get(name);
    return typeof value === "string" ? value : "";
  };
  const accepted = (): void => {
    const result = validateDownloadLead({ email: read("email"), company: read("company") });
    const version = form.dataset.consentVersion;
    if (!result.ok || !version) return;
    const touch = runtime.firstTouch(),
      code = read("tariffCode");
    saved = {
      ...result.value,
      intent: "download",
      consentVersion: version,
      locale: "ru",
      sourcePath: runtime.currentPath(),
      website: read("website"),
      ...(isTariffCode(code) ? { tariffCode: code } : {}),
      ...(touch.utm ? { utm: touch.utm } : {}),
      ...(touch.referrer ? { referrer: touch.referrer } : {}),
    };
    attempt = null;
    message("");
    cooldown();
  };
  const resend = async (): Promise<void> => {
    const endpoint = form.dataset.endpoint;
    if (busy || Date.now() < deadline || !saved || !endpoint) return;
    attempt ??= { ...saved, requestId: runtime.createRequestId() };
    busy = true;
    update();
    try {
      const response = await runtime.request(endpoint, attempt);
      if (response.ok) {
        attempt = null;
        message("Письмо поставлено в очередь отправки ещё раз.");
        cooldown();
      } else
        message(
          response.status === 429
            ? "Слишком много запросов. Подождите несколько минут и повторите."
            : "Не удалось отправить письмо повторно. Адрес и ссылка сохранены; можно скачать файл или повторить попытку.",
        );
    } catch {
      message(
        "Не удалось отправить письмо повторно. Адрес и ссылка сохранены; можно скачать файл или повторить попытку.",
      );
    } finally {
      busy = false;
      update();
    }
  };
  const onClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-resend-link]")) void resend();
    if (event.target.closest("[data-change-email]") && !busy) {
      onEdit?.();
      for (const el of root.querySelectorAll<HTMLElement>(
        "[data-download-ready], [data-download-after]",
      ))
        el.hidden = true;
      const start = root.querySelector<HTMLElement>("[data-download-start]");
      if (start) start.hidden = false;
      const consent = form.querySelector<HTMLInputElement>('[name="consent"]');
      if (consent) consent.checked = false;
      form.querySelector<HTMLInputElement>('[name="email"]')?.focus();
    }
  };
  root.addEventListener("click", onClick);
  return {
    accepted,
    dispose: () => {
      root.removeEventListener("click", onClick);
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
