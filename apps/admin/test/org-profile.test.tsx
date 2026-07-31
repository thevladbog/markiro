import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrgProfilePage } from "../src/pages/settings/OrgProfilePage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrgProfilePage />
    </QueryClientProvider>,
  );
}

const PROFILE = { gln: "4601112222005", gs1Prefixes: ["4600000"], inn: "7701234567" };
const EMPTY_PROFILE = { gln: null, gs1Prefixes: [], inn: null };
const COUNTER = { extensionDigit: 0, nextSerial: 45_000 };

/** Routes the shared `fetch` mock by URL/method -- both GET/PUT `/org/profile` and its `/sscc` sibling are called on this one page. */
function routeFetch(overrides: {
  profile?: (init?: RequestInit) => Response | Promise<Response>;
  sscc?: (init?: RequestInit) => Response | Promise<Response>;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/org/profile/sscc") {
      return overrides.sscc ? overrides.sscc(init) : jsonResponse(200, COUNTER);
    }
    if (url === "/api/org/profile") {
      return overrides.profile ? overrides.profile(init) : jsonResponse(200, PROFILE);
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  });
}

/** Waits for a Card's title to appear, then scopes queries to that Card. */
async function cardOf(titleText: string): Promise<HTMLElement> {
  const titleEl = await screen.findByText(titleText);
  const el = titleEl.closest(".mk-card");
  if (!el) throw new Error(`Card not found for title "${titleText}"`);
  return el as HTMLElement;
}

describe("OrgProfilePage", () => {
  it("renders the profile fields and the derived prefix from the mocked GET responses", async () => {
    vi.stubGlobal("fetch", routeFetch({}));

    renderPage();

    expect(await screen.findByDisplayValue("4601112222005")).toBeDefined();
    expect(screen.getByDisplayValue("7701234567")).toBeDefined();
    expect(screen.getByDisplayValue("4600000")).toBeDefined();
    // Derived prefix -- the GLN's first 9 digits, shown read-only.
    expect(await screen.findByDisplayValue("460111222")).toBeDefined();
    expect(screen.getByDisplayValue("45000")).toBeDefined();
  });

  it("shows the prefix-unavailable hint and disables the counter save, without ever requesting the counter, when no GLN is set yet", async () => {
    // No `sscc` override: the real backend 400s `GET /org/profile/sscc` while
    // there's no GLN to derive a prefix from ("organisation profile has no
    // GLN"), so the query must not fire at all here -- if it did, routeFetch
    // would still resolve it with the default 200 below, masking the bug
    // this test exists to catch.
    const fetchMock = routeFetch({
      profile: () => jsonResponse(200, EMPTY_PROFILE),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(
      await screen.findByDisplayValue("Укажите GLN выше, чтобы увидеть производный префикс"),
    ).toBeDefined();
    const ssccCard = await cardOf("Счётчик SSCC для коробов");
    expect(within(ssccCard).getByRole("button", { name: "Сохранить" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.queryByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeNull();
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/org/profile/sscc")).toBe(false);
  });

  it("shows an error alert for the counter card when the counter request genuinely fails (a 500), distinct from the no-GLN case", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        // Profile has a GLN (so a prefix IS derivable and the query fires),
        // but the counter endpoint itself fails -- this must still surface
        // as a real error, not be swallowed the way the no-GLN case is.
        sscc: () => jsonResponse(500, { message: "boom" }),
      }),
    );

    renderPage();

    const ssccCard = await cardOf("Счётчик SSCC для коробов");
    expect(
      await within(ssccCard).findByText(
        "Не удалось загрузить данные. Обновите страницу или войдите заново.",
      ),
    ).toBeDefined();
  });

  it("shows a spinner (not the form) while the profile request is still pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Профиль организации")).toBeNull();
  });

  it("shows an error alert when the profile request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
  });

  it("submits a normalized PUT /org/profile payload on save and refetches", async () => {
    let didUpdate = false;
    const updatedProfile = { gln: "6291041500213", gs1Prefixes: ["4600000", "4600001"], inn: null };
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          didUpdate = true;
          return jsonResponse(200, updatedProfile);
        }
        return jsonResponse(200, didUpdate ? updatedProfile : EMPTY_PROFILE);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Профиль организации");

    const profileCard = await cardOf("Профиль организации");
    fireEvent.change(within(profileCard).getByLabelText("GLN"), {
      target: { value: "6291041500213" },
    });
    fireEvent.change(within(profileCard).getByLabelText("Префиксы GS1"), {
      target: { value: " 4600000 , 4600001 " },
    });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            gln: "6291041500213",
            inn: null,
            gs1Prefixes: ["4600000", "4600001"],
          }),
        }),
      );
    });

    // The derived prefix updates once the refetched profile lands.
    expect(await screen.findByDisplayValue("629104150")).toBeDefined();
  });

  it("invalidates the counter query too on a successful profile save, so it refetches without a window refocus or remount", async () => {
    let didUpdate = false;
    let ssccGetCount = 0;
    const updatedProfile = { ...PROFILE, inn: "7709000000" };
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          didUpdate = true;
          return jsonResponse(200, updatedProfile);
        }
        return jsonResponse(200, didUpdate ? updatedProfile : PROFILE);
      },
      sscc: () => {
        ssccGetCount += 1;
        return jsonResponse(200, COUNTER);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Профиль организации");
    // The GLN is already set at mount, so the counter query fires once on its own.
    await waitFor(() => expect(ssccGetCount).toBe(1));

    const profileCard = await cardOf("Профиль организации");
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({ method: "PUT" }),
      );
    });
    // Without invalidating the counter query, ssccGetCount would stay at 1.
    await waitFor(() => expect(ssccGetCount).toBeGreaterThanOrEqual(2));
  });

  it("shows a validation error for an invalid GLN check digit before submitting (no PUT)", async () => {
    const fetchMock = routeFetch({});
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Профиль организации");

    const profileCard = await cardOf("Профиль организации");
    // Correct length/format (13 digits) but wrong check digit.
    fireEvent.change(within(profileCard).getByLabelText("GLN"), {
      target: { value: "6291041500214" },
    });

    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Неверная контрольная цифра GLN")).toBeDefined();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
  });

  it("submits the starting serial via PUT /org/profile/sscc, fixed to extension digit 0", async () => {
    let didUpdate = false;
    const fetchMock = routeFetch({
      sscc: (init) => {
        if (init?.method === "PUT") {
          didUpdate = true;
          return jsonResponse(200, { extensionDigit: 0, nextSerial: 100 });
        }
        return jsonResponse(200, didUpdate ? { extensionDigit: 0, nextSerial: 100 } : COUNTER);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const ssccCard = await cardOf("Счётчик SSCC для коробов");
    const nextSerialInput = await within(ssccCard).findByLabelText("Начальный серийный номер");
    fireEvent.change(nextSerialInput, { target: { value: "100" } });
    fireEvent.click(within(ssccCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile/sscc",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ extensionDigit: 0, nextSerial: 100 }),
        }),
      );
    });
  });

  it("shows a validation error for a non-numeric starting serial (no PUT)", async () => {
    const fetchMock = routeFetch({});
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const ssccCard = await cardOf("Счётчик SSCC для коробов");
    const nextSerialInput = await within(ssccCard).findByLabelText("Начальный серийный номер");
    fireEvent.change(nextSerialInput, { target: { value: "not-a-number" } });

    const putCallsBefore = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    ).length;
    fireEvent.click(within(ssccCard).getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Введите целое число от 0 до 9 999 999")).toBeDefined();
    const putCallsAfter = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    ).length;
    expect(putCallsAfter).toBe(putCallsBefore);
  });
});
