import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeeBadgesSection } from "../src/pages/employees/EmployeeBadgesSection.js";
import type { EmployeeDto } from "../src/pages/employees/api.js";

const JANE: EmployeeDto = {
  id: "1",
  fullName: "Jane Doe",
  role: "Кассир",
  status: "active",
  badges: [
    {
      id: "b1",
      badgeCode: "AAA111",
      label: "Основной бейдж",
      issuedAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    },
    {
      id: "b2",
      badgeCode: "BBB222",
      label: null,
      issuedAt: "2025-12-01T00:00:00.000Z",
      revokedAt: "2025-12-15T00:00:00.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubBadgePost(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST" && url === "/api/employees/1/badges"
        ? jsonResponse(status, body)
        : jsonResponse(200, { items: [JANE] }),
    ),
  );
}

function stubBadgeDelete(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" && url === "/api/employees/1/badges/b1"
        ? jsonResponse(status, body)
        : jsonResponse(200, { items: [JANE] }),
    ),
  );
}

function renderBadgesSection(
  employee: EmployeeDto = JANE,
  reporters = {
    onDirtyChange: vi.fn(),
    onBusyChange: vi.fn(),
    onErrorChange: vi.fn(),
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...reporters,
    ...render(
      <QueryClientProvider client={queryClient}>
        <EmployeeBadgesSection employee={employee} {...reporters} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EmployeeBadgesSection", () => {
  it("preserves badge inputs and reports a persistent issue error", async () => {
    stubBadgePost(409, { message: "Badge code already active" });
    const reporters = {
      onDirtyChange: vi.fn(),
      onBusyChange: vi.fn(),
      onErrorChange: vi.fn(),
    };
    renderBadgesSection(JANE, reporters);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Код бейджа"), "AAA111");
    await user.type(screen.getByLabelText("Метка"), "Резервный");
    await user.click(screen.getByRole("button", { name: "Выпустить бейдж" }));

    const section = screen.getByRole("region", { name: "Бейджи" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Badge code already active",
    );
    expect((screen.getByLabelText("Код бейджа") as HTMLInputElement).value).toBe("AAA111");
    expect((screen.getByLabelText("Метка") as HTMLInputElement).value).toBe("Резервный");
    expect(reporters.onErrorChange).toHaveBeenCalledWith(true);
  });

  it("clears successful issue inputs and reports dirty and busy transitions", async () => {
    let resolvePost: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          if (init?.method === "POST" && url === "/api/employees/1/badges") {
            resolvePost = resolve;
            return;
          }
          resolve(jsonResponse(200, { items: [JANE] }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reporters = {
      onDirtyChange: vi.fn(),
      onBusyChange: vi.fn(),
      onErrorChange: vi.fn(),
    };
    renderBadgesSection(JANE, reporters);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Код бейджа"), "CCC333");
    await user.click(screen.getByRole("button", { name: "Выпустить бейдж" }));

    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenCalledWith(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/employees/1/badges",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ badgeCode: "CCC333", label: null }),
      }),
    );
    expect(reporters.onDirtyChange).toHaveBeenCalledWith(true);

    resolvePost?.(jsonResponse(201, JANE));

    await waitFor(() => {
      expect((screen.getByLabelText("Код бейджа") as HTMLInputElement).value).toBe("");
      expect(reporters.onDirtyChange).toHaveBeenCalledWith(false);
      expect(reporters.onBusyChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("confirms badge revoke and keeps a failed confirmation open", async () => {
    stubBadgeDelete(409, { message: "Badge is in use" });
    renderBadgesSection(JANE);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Отозвать" }));
    const dialog = screen.getByRole("alertdialog", { name: "Отозвать бейдж?" });
    await user.click(within(dialog).getByRole("button", { name: "Отозвать" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Badge is in use");
  });

  it("sends the existing badge DELETE path after a confirmed revoke", async () => {
    stubBadgeDelete(204, undefined);
    renderBadgesSection(JANE);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Отозвать" }));
    const dialog = screen.getByRole("alertdialog", { name: "Отозвать бейдж?" });
    await user.click(within(dialog).getByRole("button", { name: "Отозвать" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/employees/1/badges/b1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
