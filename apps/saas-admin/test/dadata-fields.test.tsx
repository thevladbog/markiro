import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { OrganizationSuggestField } from "../src/pages/legal/OrganizationSuggestField";
import "../src/i18n/index";
import { jsonResponse } from "./render";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness() {
  const [value, setValue] = useState("");
  return <OrganizationSuggestField value={value} onValueChange={setValue} onSelect={vi.fn()} />;
}

describe("DaData suggestion fields", () => {
  it("starts at three characters after 250 ms and keeps manual input editable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: "no_results", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider defaultTheme="light">
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>
      </ThemeProvider>,
    );
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
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider defaultTheme="light">
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    fireEvent.change(screen.getByLabelText("Организация или ИНН"), {
      target: { value: "7707083893" },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
