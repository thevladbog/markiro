// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { selectInvoiceTariff, showInvoiceAccepted, tariffFromSearch } from "./invoice";

function render(): HTMLSelectElement {
  document.body.innerHTML = `
    <a href="/stoimost/?tarif=workshop#schet" data-invoice-tariff="workshop">Получить счёт</a>
    <section id="schet">
      <select name="tariffCode"><option value="start">Старт</option><option value="line" selected>Линия</option><option value="workshop">Цех</option></select>
      <input name="inn" />
    </section>`;
  return document.querySelector("select") as HTMLSelectElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("invoice tariff preselection", () => {
  it("accepts only published tariff codes", () => {
    expect(tariffFromSearch("?tarif=start")).toBe("start");
    expect(tariffFromSearch("?tarif=gold")).toBeNull();
    expect(tariffFromSearch("")).toBeNull();
  });

  it("selects the tariff from the address", () => {
    const select = render();
    const dispose = selectInvoiceTariff(
      document,
      { location: { search: "?tarif=start" } as Location, history: window.history },
      select,
    );
    expect(select.value).toBe("start");
    dispose();
  });

  it("switches the tariff in place when the link points at this page", () => {
    const select = render();
    Element.prototype.scrollIntoView = vi.fn();
    const replaceState = vi.fn();
    const dispose = selectInvoiceTariff(
      document,
      { location: { search: "" } as Location, history: { replaceState } as unknown as History },
      select,
    );
    document.querySelector<HTMLAnchorElement>("a")?.click();
    expect(select.value).toBe("workshop");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/stoimost/?tarif=workshop#schet");
    expect(document.activeElement).toBe(document.querySelector('[name="inn"]'));
    dispose();
  });

  it("confirms the request with the chosen tariff and address", () => {
    document.body.innerHTML = `
      <form><select name="tariffCode"><option value="line" data-tariff-name="Линия" selected>«Линия»</option></select></form>
      <div data-invoice-success tabindex="-1" hidden>
        <p data-invoice-success-text data-template="Счёт по тарифу «{tariff}» пришлём на {email}."></p>
      </div>`;
    const form = document.querySelector("form") as HTMLFormElement;
    showInvoiceAccepted(document, form, "buh@zavod.ru");
    expect(form.hidden).toBe(true);
    const success = document.querySelector<HTMLElement>("[data-invoice-success]");
    expect(success?.hidden).toBe(false);
    expect(success?.textContent?.trim()).toBe("Счёт по тарифу «Линия» пришлём на buh@zavod.ru.");
    expect(document.activeElement).toBe(success);
  });
});
