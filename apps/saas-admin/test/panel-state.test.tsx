import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { ApiRequestError } from "../src/api/client.js";
import { PanelState } from "../src/components/PanelState.js";
import "../src/i18n/index.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPanel(props: React.ComponentProps<typeof PanelState>) {
  return render(
    <ThemeProvider defaultTheme="light">
      <PanelState {...props} />
    </ThemeProvider>,
  );
}

describe("PanelState", () => {
  it("renders accessible loading and empty states", () => {
    const loading = renderPanel({ loading: true, empty: false, error: null, children: null });
    expect(screen.getByRole("status").textContent).toContain("Загрузка");
    loading.unmount();

    renderPanel({ loading: false, empty: true, error: null, children: null });
    expect(screen.getByText("Нет данных для отображения")).toBeDefined();
  });

  it("uses safe contract copy, retries, and copies only the request ID", async () => {
    const retry = vi.fn();
    const writeText = vi.fn(async () => Promise.reject(new Error("clipboard unavailable")));
    const error = ApiRequestError.contract({
      endpoint: "/tenants",
      status: 200,
      issuePath: ["items", 0, "password"],
      requestId: REQUEST_ID,
      releaseSha: "release-1",
    });
    renderPanel({
      loading: false,
      empty: false,
      error,
      onRetry: retry,
      children: <div>must not render</div>,
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Формат ответа платформы изменился");
    expect(alert.textContent).not.toMatch(/password|items|server|zod/i);
    expect(alert.textContent).toContain(REQUEST_ID);
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    expect(retry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Скопировать ID запроса" }));
    expect(writeText).toHaveBeenCalledWith(REQUEST_ID);
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("does not offer an ineffective retry for authorization failures", () => {
    const error = new ApiRequestError(403, "ignored", "platform_forbidden", {
      kind: "authorization",
      endpoint: "/tenants",
      requestId: REQUEST_ID,
    });
    renderPanel({
      loading: false,
      empty: false,
      error,
      onRetry: vi.fn(),
      children: null,
    });

    expect(screen.getByRole("alert").textContent).toContain("Недостаточно прав");
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });
});
