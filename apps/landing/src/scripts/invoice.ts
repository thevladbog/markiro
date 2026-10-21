import { TARIFF_CODES } from "../content/pricing";

/**
 * «Уже решили? Получить счёт» carries the tariff in `?tarif=` so the invoice form
 * opens with it selected, from the home page and from /stoimost/ itself.
 */
export function tariffFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("tarif");
  return value !== null && (TARIFF_CODES as readonly string[]).includes(value) ? value : null;
}

export function selectInvoiceTariff(
  root: Document,
  browserWindow: Pick<Window, "location" | "history">,
  select: HTMLSelectElement | null,
): () => void {
  if (select === null) return () => undefined;
  const choose = (code: string | null): void => {
    if (code !== null && [...select.options].some((option) => option.value === code)) {
      select.value = code;
    }
  };
  choose(tariffFromSearch(browserWindow.location.search));

  const onClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-invoice-tariff]");
    if (link === null) return;
    event.preventDefault();
    choose(link.dataset.invoiceTariff ?? null);
    const target = root.getElementById(link.hash.slice(1));
    browserWindow.history.replaceState(null, "", `${link.pathname}${link.search}${link.hash}`);
    target?.scrollIntoView({ block: "start" });
    root.querySelector<HTMLInputElement>('[name="inn"]')?.focus({ preventScroll: true });
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

/** Swaps the invoice form for «Запрос счёта принят» with the chosen tariff and address. */
export function showInvoiceAccepted(root: Document, form: HTMLFormElement, email: string): void {
  const success = root.querySelector<HTMLElement>("[data-invoice-success]");
  const text = success?.querySelector<HTMLElement>("[data-invoice-success-text]");
  const select = form.querySelector<HTMLSelectElement>('select[name="tariffCode"]');
  const tariff = select?.selectedOptions[0]?.dataset.tariffName ?? "";
  if (text) {
    text.textContent = (text.dataset.template ?? "")
      .replace("{tariff}", tariff)
      .replace("{email}", email);
  }
  form.hidden = true;
  if (success) {
    success.hidden = false;
    success.focus();
  }
}
