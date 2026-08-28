import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OrgProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PROFILE = {
  gln: "4601112222005",
  gs1Prefixes: ["4600000"],
  inn: "7701234567",
  timeZone: "Europe/Moscow",
  pickupLimitsEnabled: true,
  logoUrl: null as string | null,
  logoRevision: null as string | null,
  defaultBoxLabelTemplateId: null as string | null,
};
const EMPTY_PROFILE = { ...PROFILE, gln: null, gs1Prefixes: [], inn: null };
const COUNTER = { extensionDigit: 0, nextSerial: 45_000, minSerial: 40_000, blockedBy: null };
const COUNTER_BLOCKED = {
  ...COUNTER,
  blockedBy: { kind: "active_shift", shiftId: "s-1", shiftNumber: "AUG26-003" },
};
const LABEL_TEMPLATES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Короб 100 × 75",
    widthMm: 100,
    heightMm: 75,
    dpi: 203 as const,
    language: "zpl" as const,
    updatedAt: "2026-08-14T08:00:00.000Z",
  },
];

/** Routes the shared `fetch` mock by URL/method -- both GET/PUT `/org/profile` and its `/sscc` sibling are called on this one page. */
function routeFetch(overrides: {
  profile?: (init?: RequestInit) => Response | Promise<Response>;
  sscc?: (init?: RequestInit) => Response | Promise<Response>;
  logo?: (init?: RequestInit) => Response | Promise<Response>;
  labelTemplates?: (init?: RequestInit) => Response | Promise<Response>;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/org/profile/logo") {
      return overrides.logo ? overrides.logo(init) : jsonResponse(204, undefined);
    }
    if (url === "/api/org/profile/sscc") {
      return overrides.sscc ? overrides.sscc(init) : jsonResponse(200, COUNTER);
    }
    if (url === "/api/label-templates") {
      return overrides.labelTemplates
        ? overrides.labelTemplates(init)
        : jsonResponse(200, { items: LABEL_TEMPLATES });
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
  it("shows and saves the tenant operational timezone with the profile fields", async () => {
    let profile = PROFILE;
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          profile = { ...profile, timeZone: "Asia/Yekaterinburg" };
        }
        return jsonResponse(200, profile);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const timeZone = (await within(profileCard).findByLabelText(
      "Часовой пояс производства",
    )) as HTMLSelectElement;
    expect(timeZone.value).toBe("Europe/Moscow");
    fireEvent.change(timeZone, { target: { value: "Asia/Yekaterinburg" } });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            gln: PROFILE.gln,
            inn: PROFILE.inn,
            timeZone: "Asia/Yekaterinburg",
            gs1Prefixes: PROFILE.gs1Prefixes,
          }),
        }),
      ),
    );
    const successToast = await screen.findByText("Профиль сохранён");
    const toastStatus = successToast.closest("[role=status]");
    if (!toastStatus) throw new Error("Profile success toast not found");
    fireEvent.click(within(toastStatus as HTMLElement).getByRole("button", { name: "Закрыть" }));
  });

  it("preserves a valid stored timezone outside the curated production list", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        profile: () => jsonResponse(200, { ...PROFILE, timeZone: "Europe/London" }),
      }),
    );

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const timeZone = (await within(profileCard).findByLabelText(
      "Часовой пояс производства",
    )) as HTMLSelectElement;
    expect(timeZone.value).toBe("Europe/London");
    expect(within(timeZone).getByRole("option", { name: "Europe/London" })).toBeDefined();
  });

  it("shows the box-label default selector, its tenant templates, and the template library link", async () => {
    vi.stubGlobal("fetch", routeFetch({}));

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const selector = (await within(profileCard).findByLabelText(
      "Шаблон этикетки короба по умолчанию",
    )) as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(within(selector).getByRole("option", { name: "Не выбран" })).toBeDefined();
    expect(within(selector).getByRole("option", { name: "Короб 100 × 75" })).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Открыть библиотеку шаблонов" }).getAttribute("href"),
    ).toBe("/labels");
  });

  it("saves a selected default box-label template UUID", async () => {
    const selectedId = LABEL_TEMPLATES[0]?.id;
    if (!selectedId) throw new Error("Label template fixture is missing");
    let profile = PROFILE;
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          profile = { ...profile, defaultBoxLabelTemplateId: selectedId };
        }
        return jsonResponse(200, profile);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    fireEvent.change(
      await within(profileCard).findByLabelText("Шаблон этикетки короба по умолчанию"),
      { target: { value: selectedId } },
    );
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            gln: PROFILE.gln,
            inn: PROFILE.inn,
            timeZone: PROFILE.timeZone,
            gs1Prefixes: PROFILE.gs1Prefixes,
            defaultBoxLabelTemplateId: selectedId,
          }),
        }),
      ),
    );
    const successToast = await screen.findByText("Профиль сохранён");
    const toastStatus = successToast.closest("[role=status]");
    if (!toastStatus) throw new Error("Profile success toast not found");
    fireEvent.click(within(toastStatus as HTMLElement).getByRole("button", { name: "Закрыть" }));
  });

  it("clears the saved default box-label template with an explicit null", async () => {
    const selectedId = LABEL_TEMPLATES[0]?.id;
    if (!selectedId) throw new Error("Label template fixture is missing");
    let profile: typeof PROFILE = { ...PROFILE, defaultBoxLabelTemplateId: selectedId };
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          profile = { ...profile, defaultBoxLabelTemplateId: null };
        }
        return jsonResponse(200, profile);
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const selector = (await within(profileCard).findByLabelText(
      "Шаблон этикетки короба по умолчанию",
    )) as HTMLSelectElement;
    expect(selector.value).toBe(selectedId);
    fireEvent.change(selector, { target: { value: "" } });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            gln: PROFILE.gln,
            inn: PROFILE.inn,
            timeZone: PROFILE.timeZone,
            gs1Prefixes: PROFILE.gs1Prefixes,
            defaultBoxLabelTemplateId: null,
          }),
        }),
      ),
    );
    const successToast = await screen.findByText("Профиль сохранён");
    const toastStatus = successToast.closest("[role=status]");
    if (!toastStatus) throw new Error("Profile success toast not found");
    fireEvent.click(within(toastStatus as HTMLElement).getByRole("button", { name: "Закрыть" }));
  });

  it("keeps a deleted saved template visible and blocks saving until a valid template is selected", async () => {
    const staleId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = routeFetch({
      profile: () => jsonResponse(200, { ...PROFILE, defaultBoxLabelTemplateId: staleId }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const selector = (await within(profileCard).findByLabelText(
      "Шаблон этикетки короба по умолчанию",
    )) as HTMLSelectElement;
    expect(selector.value).toBe(staleId);
    expect(
      within(selector).getByRole("option", { name: "Недоступный шаблон (удалён)" }),
    ).toBeDefined();
    expect(
      within(profileCard).getByText(
        "Выбранный шаблон больше недоступен. Обновите список или выберите другой шаблон.",
      ),
    ).toBeDefined();
    const save = within(profileCard).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    expect(within(profileCard).getByRole("button", { name: "Обновить шаблоны" })).toBeDefined();

    fireEvent.change(selector, { target: { value: LABEL_TEMPLATES[0]?.id } });
    expect(save).toHaveProperty("disabled", false);
  });

  it("keeps a deleted saved template unavailable when refreshing the template list fails", async () => {
    const staleId = "22222222-2222-4222-8222-222222222222";
    let labelTemplateRequests = 0;
    const fetchMock = routeFetch({
      profile: () => jsonResponse(200, { ...PROFILE, defaultBoxLabelTemplateId: staleId }),
      labelTemplates: () => {
        labelTemplateRequests += 1;
        return labelTemplateRequests === 1
          ? jsonResponse(200, { items: LABEL_TEMPLATES })
          : jsonResponse(500, { message: "template library unavailable" });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const selector = (await within(profileCard).findByLabelText(
      "Шаблон этикетки короба по умолчанию",
    )) as HTMLSelectElement;
    const save = within(profileCard).getByRole("button", { name: "Сохранить" });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Обновить шаблоны" }));

    await waitFor(() => expect(labelTemplateRequests).toBe(2));
    expect(selector.value).toBe(staleId);
    expect(
      within(selector).getByRole("option", { name: "Недоступный шаблон (удалён)" }),
    ).toBeDefined();
    expect(
      within(profileCard).getByText(
        "Выбранный шаблон больше недоступен. Обновите список или выберите другой шаблон.",
      ),
    ).toBeDefined();
    expect(save).toHaveProperty("disabled", true);
    expect(within(profileCard).getByRole("button", { name: "Обновить шаблоны" })).toBeDefined();
  });

  it("saves the all-kiosk pickup-limit toggle and explains that employee values are retained", async () => {
    const fetchMock = routeFetch({
      profile: (init) =>
        init?.method === "PUT"
          ? jsonResponse(200, { ...PROFILE, pickupLimitsEnabled: false })
          : jsonResponse(200, PROFILE),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const toggle = await screen.findByRole("checkbox", {
      name: "Применять лимиты суммарно во всех киосках",
    });
    expect(toggle.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByText(/значения сотрудников останутся/i)).toBeDefined();
    fireEvent.click(toggle);
    fireEvent.click(
      within(await cardOf("Политика выдачи")).getByRole("button", { name: "Сохранить" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ pickupLimitsEnabled: false }),
        }),
      ),
    );
    const successToast = await screen.findByText("Политика выдачи сохранена");
    const toastStatus = successToast.closest("[role=status]");
    if (!toastStatus) throw new Error("Pickup policy success toast not found");
    fireEvent.click(within(toastStatus as HTMLElement).getByRole("button", { name: "Закрыть" }));
  });

  it("uses Markiro fallback, rejects unsupported logo input, then previews and removes the normalized logo", async () => {
    let profile = PROFILE;
    const revision = "11111111-1111-4111-8111-111111111111";
    const fetchMock = routeFetch({
      profile: () => jsonResponse(200, profile),
      logo: (init) => {
        if (init?.method === "POST") {
          profile = {
            ...profile,
            logoRevision: revision,
            logoUrl: `/org/profile/logo/${revision}`,
          };
          return jsonResponse(201, { logoRevision: revision, logoUrl: profile.logoUrl });
        }
        profile = { ...profile, logoRevision: null, logoUrl: null };
        return jsonResponse(204, undefined);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByLabelText("Логотип Markiro по умолчанию")).toBeDefined();
    expect(screen.getByRole("button", { name: "Загрузить логотип" })).toBeDefined();
    const input = screen.getByTestId("file-drop-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["svg"], "logo.svg", { type: "image/svg+xml" })] },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("JPEG, PNG или WebP");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(input, {
      target: { files: [new File(["png"], "logo.png", { type: "image/png" })] },
    });
    const preview = await screen.findByRole("img", { name: "Логотип организации" });
    expect(preview.getAttribute("src")).toBe(`/api/org/profile/logo/${revision}`);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/org/profile/logo",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Удалить логотип" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile/logo",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(await screen.findByLabelText("Логотип Markiro по умолчанию")).toBeDefined();
  });

  it("preserves dirty INN and prefix drafts across logo, policy and profile-cache updates", async () => {
    let profile = PROFILE;
    const revision = "22222222-2222-4222-8222-222222222222";
    let profileGetCount = 0;
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          const input = JSON.parse(String(init.body)) as { pickupLimitsEnabled?: boolean };
          profile = {
            ...profile,
            ...(input.pickupLimitsEnabled === undefined
              ? {}
              : { pickupLimitsEnabled: input.pickupLimitsEnabled }),
          };
          return jsonResponse(200, profile);
        }
        profileGetCount += 1;
        return jsonResponse(200, profile);
      },
      logo: (init) => {
        if (init?.method === "POST") {
          profile = {
            ...profile,
            logoRevision: revision,
            logoUrl: `/org/profile/logo/${revision}`,
          };
          return jsonResponse(201, {
            logoRevision: revision,
            logoUrl: profile.logoUrl,
          });
        }
        profile = { ...profile, logoRevision: null, logoUrl: null };
        return jsonResponse(204, undefined);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const inn = within(profileCard).getByLabelText("ИНН") as HTMLInputElement;
    const prefixes = within(profileCard).getByLabelText("Префиксы GS1") as HTMLInputElement;
    const defaultTemplate = within(profileCard).getByLabelText(
      "Шаблон этикетки короба по умолчанию",
    ) as HTMLSelectElement;
    fireEvent.change(inn, { target: { value: "7707654321" } });
    fireEvent.change(prefixes, { target: { value: "4600000, 4609999" } });
    fireEvent.change(defaultTemplate, { target: { value: LABEL_TEMPLATES[0]?.id } });

    const logoInput = screen.getByTestId("file-drop-input") as HTMLInputElement;
    fireEvent.change(logoInput, {
      target: { files: [new File(["png"], "logo.png", { type: "image/png" })] },
    });
    await screen.findByRole("img", { name: "Логотип организации" });
    expect(inn.value).toBe("7707654321");
    expect(prefixes.value).toBe("4600000, 4609999");
    expect(defaultTemplate.value).toBe(LABEL_TEMPLATES[0]?.id);

    fireEvent.click(screen.getByRole("button", { name: "Удалить логотип" }));
    await screen.findByLabelText("Логотип Markiro по умолчанию");
    expect(inn.value).toBe("7707654321");
    expect(prefixes.value).toBe("4600000, 4609999");
    expect(defaultTemplate.value).toBe(LABEL_TEMPLATES[0]?.id);

    const getsBeforePolicySave = profileGetCount;
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Применять лимиты суммарно во всех киосках" }),
    );
    fireEvent.click(
      within(await cardOf("Политика выдачи")).getByRole("button", { name: "Сохранить" }),
    );
    await waitFor(() => expect(profileGetCount).toBeGreaterThan(getsBeforePolicySave));
    expect(inn.value).toBe("7707654321");
    expect(prefixes.value).toBe("4600000, 4609999");
    expect(defaultTemplate.value).toBe(LABEL_TEMPLATES[0]?.id);
  });

  it("adopts a clean profile refetch", async () => {
    let profile = PROFILE;
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          profile = {
            ...profile,
            inn: "7709999999",
            gs1Prefixes: ["4609999"],
            pickupLimitsEnabled: false,
          };
        }
        return jsonResponse(200, profile);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const profileCard = await cardOf("Профиль организации");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Применять лимиты суммарно во всех киосках" }),
    );
    fireEvent.click(
      within(await cardOf("Политика выдачи")).getByRole("button", { name: "Сохранить" }),
    );

    expect(await within(profileCard).findByDisplayValue("7709999999")).toBeDefined();
    expect(within(profileCard).getByDisplayValue("4609999")).toBeDefined();
  });

  it("adopts a successful profile save before a cross-card cache update", async () => {
    const savedProfile = {
      ...PROFILE,
      inn: "7708888888",
      gs1Prefixes: ["4608888"],
    };
    const refetchedProfile = {
      ...savedProfile,
      inn: "7707777777",
      gs1Prefixes: ["4607777"],
      logoRevision: "33333333-3333-4333-8333-333333333333",
      logoUrl: "/org/profile/logo/33333333-3333-4333-8333-333333333333",
    };
    let saved = false;
    let resolveRefetch: ((response: Response) => void) | undefined;
    const refetch = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    const fetchMock = routeFetch({
      profile: (init) => {
        if (init?.method === "PUT") {
          saved = true;
          return jsonResponse(200, savedProfile);
        }
        return saved ? refetch : jsonResponse(200, PROFILE);
      },
      logo: () =>
        jsonResponse(201, {
          logoRevision: refetchedProfile.logoRevision,
          logoUrl: refetchedProfile.logoUrl,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const profileCard = await cardOf("Профиль организации");
    const inn = within(profileCard).getByLabelText("ИНН") as HTMLInputElement;
    const prefixes = within(profileCard).getByLabelText("Префиксы GS1") as HTMLInputElement;
    fireEvent.change(inn, { target: { value: savedProfile.inn } });
    fireEvent.change(prefixes, { target: { value: savedProfile.gs1Prefixes.join(", ") } });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Профиль сохранён");

    fireEvent.change(screen.getByTestId("file-drop-input"), {
      target: { files: [new File(["png"], "logo.png", { type: "image/png" })] },
    });
    await screen.findByRole("img", { name: "Логотип организации" });
    expect(inn.value).toBe(savedProfile.inn);
    expect(prefixes.value).toBe(savedProfile.gs1Prefixes.join(", "));

    resolveRefetch?.(jsonResponse(200, refetchedProfile));
    expect(await within(profileCard).findByDisplayValue(refetchedProfile.inn)).toBeDefined();
    expect(
      within(profileCard).getByDisplayValue(refetchedProfile.gs1Prefixes.join(", ")),
    ).toBeDefined();
  });

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

    expect((await screen.findByText("Загрузка…")).closest('[role="status"]')).not.toBeNull();
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
    const updatedProfile = {
      ...EMPTY_PROFILE,
      gln: "6291041500213",
      gs1Prefixes: ["4600000", "4600001"],
      inn: null,
    };
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
            timeZone: PROFILE.timeZone,
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

    expect(await screen.findByText("Введите целое число от 1 до 9 999 999")).toBeDefined();
    const putCallsAfter = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    ).length;
    expect(putCallsAfter).toBe(putCallsBefore);
  });

  it("normalizes a historical zero counter to one and refuses a new zero value", async () => {
    const fetchMock = routeFetch({
      sscc: () => jsonResponse(200, { extensionDigit: 0, nextSerial: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const ssccCard = await cardOf("Счётчик SSCC для коробов");
    const nextSerialInput = (await within(ssccCard).findByLabelText(
      "Начальный серийный номер",
    )) as HTMLInputElement;
    expect(nextSerialInput.value).toBe("1");

    fireEvent.change(nextSerialInput, { target: { value: "0" } });
    const putCallsBefore = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    ).length;
    fireEvent.click(within(ssccCard).getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Введите целое число от 1 до 9 999 999")).toBeDefined();
    const putCallsAfter = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    ).length;
    expect(putCallsAfter).toBe(putCallsBefore);
  });

  it("locks the sscc counter while a shift is active and names the shift", async () => {
    vi.stubGlobal("fetch", routeFetch({ sscc: () => jsonResponse(200, COUNTER_BLOCKED) }));
    renderPage();

    const card = await cardOf("Счётчик SSCC для коробов");
    const input = await within(card).findByLabelText("Начальный серийный номер");
    await waitFor(() => expect(input).toHaveProperty("disabled", true));
    expect(within(card).getByText(/AUG26-003/)).toBeDefined();
    expect(within(card).getByRole("button", { name: "Сохранить" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows the floor the server reported rather than a hardcoded one", async () => {
    vi.stubGlobal("fetch", routeFetch({}));
    renderPage();

    const card = await cardOf("Счётчик SSCC для коробов");
    // 45 000 is the counter (the value the next BLOCK is cut from -- not the
    // next label's serial, which is wherever the station's current block has
    // got to), 40 000 the floor -- both come from the server; the form must
    // not invent either.
    await waitFor(() => expect(within(card).getByText(/40\s?000/)).toBeDefined());
    expect(within(card).getByRole("button", { name: "Сохранить" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("says nothing has been printed yet instead of 'напечатано до 0' (final review, finding 4)", async () => {
    // The floor for a box counter with nothing printed is 1, and the hint's
    // "printed through" is minSerial - 1 -- which used to render as
    // "Уже напечатано до 0".
    vi.stubGlobal(
      "fetch",
      routeFetch({ sscc: () => jsonResponse(200, { ...COUNTER, nextSerial: 1, minSerial: 1 }) }),
    );
    renderPage();

    const card = await cardOf("Счётчик SSCC для коробов");
    await waitFor(() => expect(within(card).getByText(/Ещё ничего не напечатано/)).toBeDefined());
    expect(within(card).queryByText(/напечатано до 0/)).toBeNull();
  });
});
