import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";
import type {
  DadataAddressSuggestion,
  DadataBankSuggestion,
  DadataOrganizationSuggestion,
} from "@markiro/platform-contracts";

import { AddressSuggestField } from "../src/pages/legal/AddressSuggestField";
import { BankSuggestField } from "../src/pages/legal/BankSuggestField";
import { OrganizationSuggestField } from "../src/pages/legal/OrganizationSuggestField";
import "../src/i18n/index";
import { jsonResponse } from "./render";

const ORGANIZATION: DadataOrganizationSuggestion = {
  value: "ПАО СБЕРБАНК",
  kind: "legal_entity",
  fullName: "ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО СБЕРБАНК",
  displayName: "ПАО СБЕРБАНК",
  inn: "7707083893",
  kpp: "773601001",
  ogrn: "1027700132195",
  ogrnip: null,
  legalAddress: null,
};

const ADDRESS: DadataAddressSuggestion = {
  value: "г Москва, ул Тверская, д 1",
  fiasId: "7710010010000010001",
  kladrId: "77000000000000100",
  postalCode: "125009",
  region: "Москва",
  city: "Москва",
  settlement: null,
  street: "Тверская",
  house: "1",
  block: null,
  flat: null,
  latitude: "55.757",
  longitude: "37.613",
  qualityCode: "0",
  completenessCode: "0",
};

const BANK: DadataBankSuggestion = {
  value: "ПАО СБЕРБАНК",
  bic: "044525225",
  bankName: "ПАО СБЕРБАНК",
  correspondentAccount: "30101810400000000225",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderField(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="light">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>,
  );
}

function OrganizationHarness() {
  const [value, setValue] = useState("");
  return (
    <OrganizationSuggestField
      value={value}
      onValueChange={setValue}
      onSelect={(suggestion) => setValue(suggestion.value)}
    />
  );
}

function AddressHarness() {
  const [value, setValue] = useState("");
  return (
    <AddressSuggestField
      label="Адрес"
      value={value}
      onValueChange={setValue}
      onSelect={(suggestion) => setValue(suggestion.value)}
    />
  );
}

function BankHarness({
  onSelect = vi.fn(),
}: {
  onSelect?: (suggestion: DadataBankSuggestion) => void;
}) {
  const [value, setValue] = useState("");
  return <BankSuggestField value={value} onValueChange={setValue} onSelect={onSelect} />;
}

describe("DaData suggestion fields", () => {
  it("starts at three characters after 250 ms and keeps manual input editable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "no_results", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    renderField(<OrganizationHarness />);
    const input = screen.getByLabelText("Организация или ИНН");

    fireEvent.change(input, { target: { value: "аб" } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "абв" } });
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(input.getAttribute("disabled")).toBeNull();
    expect(screen.getByText("Ничего не найдено — заполните поля вручную")).toBeDefined();
  });

  it("queries an exact INN immediately", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "no_results", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    renderField(<OrganizationHarness />);

    fireEvent.change(screen.getByLabelText("Организация или ИНН"), {
      target: { value: "7707083893" },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("queries an exact BIC immediately", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "no_results", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    renderField(<BankHarness />);

    fireEvent.change(screen.getByLabelText("Банк или БИК"), { target: { value: BANK.bic } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("suppresses a selected organization result until the operator edits again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [ORGANIZATION] })),
    );
    renderField(<OrganizationHarness />);
    const input = screen.getByLabelText("Организация или ИНН");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Сбер" } });
    await screen.findByRole("listbox");

    fireEvent.click(screen.getByRole("option", { name: ORGANIZATION.value }));
    expect(input).toHaveProperty("value", ORGANIZATION.value);
    expect(screen.queryByRole("listbox")).toBeNull();

    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(input, { target: { value: `${ORGANIZATION.value} ` } });
    expect(await screen.findByRole("listbox")).toBeDefined();
  });

  it("closes an address menu before applying a pointer selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [ADDRESS] })),
    );
    renderField(<AddressHarness />);
    const input = screen.getByLabelText("Адрес");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Твер" } });
    await screen.findByRole("listbox");

    fireEvent.mouseDown(screen.getByRole("option", { name: ADDRESS.value }));
    fireEvent.click(screen.getByRole("option", { name: ADDRESS.value }));
    expect(input).toHaveProperty("value", ADDRESS.value);
    expect(screen.queryByRole("listbox")).toBeNull();

    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects the active option with ArrowDown and Enter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [ORGANIZATION] })),
    );
    renderField(<OrganizationHarness />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Организация или ИНН");

    await user.click(input);
    await user.type(input, "Сбер");
    const listbox = await screen.findByRole("listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: ORGANIZATION.value }).id,
    );
    await user.keyboard("{Enter}");

    expect(input).toHaveProperty("value", ORGANIZATION.value);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("dismisses an open bank menu on Escape without selecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [BANK] })),
    );
    const onSelect = vi.fn();
    renderField(<BankHarness onSelect={onSelect} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Банк или БИК");

    await user.click(input);
    await user.type(input, "Сбер");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("dismisses a bank menu when focus leaves the complete field control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [BANK] })),
    );
    renderField(
      <>
        <BankHarness />
        <button type="button">Вне подсказок</button>
      </>,
    );
    const user = userEvent.setup();
    const input = screen.getByLabelText("Банк или БИК");

    await user.click(input);
    await user.type(input, "Сбер");
    await screen.findByRole("listbox");
    fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "Вне подсказок" }) });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("dismisses a bank menu when a pointer leaves the field control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { status: "ready", items: [BANK] })),
    );
    renderField(
      <>
        <BankHarness />
        <button type="button">Вне подсказок</button>
      </>,
    );
    const user = userEvent.setup();
    const input = screen.getByLabelText("Банк или БИК");

    await user.click(input);
    await user.type(input, "Сбер");
    await screen.findByRole("listbox");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Вне подсказок" }));

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
