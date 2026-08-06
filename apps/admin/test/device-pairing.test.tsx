import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { DeviceDrawer } from "../src/pages/devices/DeviceDrawer.js";
import { DeviceActions } from "../src/pages/devices/DeviceActions.js";
import { PairingCodePanel } from "../src/pages/devices/PairingCodePanel.js";

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function renderDrawer(
  queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <DeviceDrawer
          open
          allowStation
          allowKiosk
          canIssueKiosk
          organizationName="Markiro"
          onClose={vi.fn()}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("keeps the one-time pairing secret only in the active drawer and clears its mutation state on close", async () => {
  let issueCount = 0;
  const print = vi.fn();
  vi.stubGlobal("print", print);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/lines") return response({ items: [] });
      if (url === "/api/station-devices" && init?.method === "POST")
        return response({ id: "station-1", name: "Packing" });
      if (url === "/api/station-devices/station-1/pairing-code" && init?.method === "POST")
        return response(
          ++issueCount === 1
            ? { code: "12345678", expiresAt: "2026-08-06T12:00:00.000Z" }
            : { code: "87654321", expiresAt: "2026-08-06T12:01:00.000Z" },
        );
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const { queryClient } = renderDrawer();
  fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Packing" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));

  await screen.findAllByText("1234 5678");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(document.location.search).not.toContain("12345678");
  expect(screen.getByText("Код цифрами: 12345678")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Распечатать инструкцию" }));
  expect(print).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: "Создать новый код" }));
  await screen.findAllByText("8765 4321");
  expect(issueCount).toBe(2);
  expect(screen.queryByText("Код цифрами: 12345678")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Готово" }));
  await waitFor(() => expect(screen.queryByText("1234 5678")).toBeNull());
  expect(
    queryClient
      .getMutationCache()
      .getAll()
      .every((mutation) => !JSON.stringify(mutation.state.data).includes("87654321")),
  ).toBe(true);
});

it("uses the server expiry and replaces the reveal with an expired state", () => {
  render(
    <ThemeProvider defaultTheme="light">
      <PairingCodePanel
        pairing={{ code: "12345678", expiresAt: new Date(Date.now() - 1_000).toISOString() }}
        issuedAt={new Date().toISOString()}
        deviceName="Packing"
        deviceType="station"
        placeName="Line 1"
        organizationName="Markiro"
        regenerating={false}
        onRegenerate={vi.fn()}
      />
    </ThemeProvider>,
  );
  expect(screen.getByText("Срок действия кода истёк. Создайте новый код.")).toBeDefined();
  expect(screen.queryByText("1234 5678")).toBeNull();
  expect(screen.getByRole("button", { name: "Создать новый код" })).toBeDefined();
});

it("uses the type-specific destructive endpoint only after confirmation", async () => {
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/kiosks/kiosk-1");
    expect(init?.method).toBe("DELETE");
    return { ok: true, status: 204, json: async () => undefined } as Response;
  });
  vi.stubGlobal("fetch", request);
  const onPair = vi.fn();
  const onReassign = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <DeviceActions
            device={{
              id: "kiosk-1",
              type: "kiosk",
              name: "Lobby",
              place: { id: null, name: "Entrance" },
              status: "online",
              lastSeenAt: null,
              paired: true,
            }}
            canReassign
            canManageCredentials
            onPair={onPair}
            onReassign={onReassign}
          />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Переназначить" }));
  fireEvent.click(screen.getByRole("button", { name: "Выдать новый код" }));
  expect(onReassign).toHaveBeenCalledOnce();
  expect(onPair).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Отозвать устройство?" })).getByRole("button", {
      name: "Отозвать",
    }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
});

it("preserves a failed reassignment drawer and never issues or revokes a credential", async () => {
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/lines") return response({ items: [] });
    expect(String(input)).toBe("/api/kiosks/kiosk-1");
    expect(init?.method).toBe("PATCH");
    return {
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "busy" }),
    } as Response;
  });
  vi.stubGlobal("fetch", request);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <DeviceDrawer
          open
          allowStation
          allowKiosk
          canIssueKiosk
          mode="reassign"
          device={{
            id: "kiosk-1",
            type: "kiosk",
            name: "Lobby",
            place: { id: null, name: "Entrance" },
            status: "online",
            lastSeenAt: null,
            paired: true,
          }}
          onClose={vi.fn()}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("Расположение"), { target: { value: "Warehouse" } });
  fireEvent.click(screen.getByRole("button", { name: "Переназначить" }));
  await screen.findByText("Не удалось переназначить устройство");
  expect(screen.getByRole("dialog", { name: "Переназначить устройство" })).toBeDefined();
  expect(request.mock.calls.map(([input]) => String(input))).toEqual([
    "/api/lines",
    "/api/kiosks/kiosk-1",
  ]);
});

it("keeps a failed revoke confirmation recoverable and presents the print/countdown copy in English", async () => {
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      attempts += 1;
      if (attempts === 1)
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          json: async () => ({ message: "offline" }),
        } as Response;
      return { ok: true, status: 204, json: async () => undefined } as Response;
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ThemeProvider defaultTheme="light">
        <MemoryRouter>
          <DeviceActions
            device={{
              id: "station-1",
              type: "station",
              name: "Packing",
              place: { id: null, name: null },
              status: "online",
              lastSeenAt: null,
              paired: true,
            }}
            canReassign
            canManageCredentials
            onPair={vi.fn()}
            onReassign={vi.fn()}
          />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));
  const confirmation = screen.getByRole("dialog", { name: "Отозвать устройство?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Отозвать" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("dialog", { name: "Отозвать устройство?" })).toBeDefined();
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Отозвать устройство?" })).getByRole("button", {
      name: "Отозвать",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Отозвать устройство?" })).toBeNull(),
  );

  await i18n.changeLanguage("en");
  render(
    <ThemeProvider defaultTheme="light">
      <PairingCodePanel
        pairing={{ code: "12345678", expiresAt: new Date(Date.now() + 61_000).toISOString() }}
        issuedAt={new Date().toISOString()}
        deviceName="Packing"
        deviceType="station"
        placeName="Line 1"
        organizationName="Markiro"
        regenerating={false}
        onRegenerate={vi.fn()}
      />
    </ThemeProvider>,
  );
  expect(screen.getByText(/Remaining: 0?1:0[01]/)).toBeDefined();
  expect(screen.getByText("Device pairing instructions")).toBeDefined();
  expect(screen.getByText("Code digits: 12345678")).toBeDefined();
});
