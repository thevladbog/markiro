import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import i18n from "../src/i18n/index.js";
import { LinesPage } from "../src/pages/lines/index.js";
import { LinePanelRoute } from "../src/pages/lines/LinePanelRoute.js";

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const OPERATIONS_WRITE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const LINE = {
  id: "line-1",
  name: "Розлив",
  createdAt: "2026-08-12T10:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage({
  access = OPERATIONS_WRITE_ACCESS,
  initialEntries = ["/lines"],
}: {
  access?: AccessDocument;
  initialEntries?: string[];
} = {}) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route path="/lines" element={<LinesPage />}>
        <Route path="new" element={<LinePanelRoute mode="create" />} />
        <Route path=":lineId/edit" element={<LinePanelRoute mode="edit" />} />
      </Route>,
    ),
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("LinesPage states and permissions", () => {
  it("shows an explicit loading state without the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Производственные линии не добавлены")).toBeNull();
  });

  it("shows an explicit error state and retries the line list", async () => {
    let listRequests = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/lines/presence") return jsonResponse(200, { items: [] });
      listRequests += 1;
      return listRequests === 1
        ? jsonResponse(500, { message: "Unavailable" })
        : jsonResponse(200, { items: [LINE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Производственные линии не добавлены")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText(LINE.name)).toBeDefined();
    expect(listRequests).toBe(2);
    expect(
      screen.queryByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeNull();
  });

  it("explains the empty state and exposes create only to a writer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );

    const writer = renderPage();

    expect(await screen.findByText("Производственные линии не добавлены")).toBeDefined();
    expect(
      screen.getByText(
        "Создайте линию, чтобы группировать смены и назначать стационарным терминалам рабочее место по умолчанию.",
      ),
    ).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Создать линию" }).length).toBeGreaterThan(0);

    writer.unmount();
    renderPage({ access: OPERATIONS_READ_ONLY });

    expect(await screen.findByText("Производственные линии не добавлены")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать линию" })).toBeNull();
  });

  it("renders line name, creation date, explanation, count, and writer actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [LINE] })),
    );

    renderPage();

    expect(await screen.findByRole("heading", { name: "Производственные линии" })).toBeDefined();
    expect(
      screen.getByText(
        "Производственная линия группирует смены и задаёт стационарному терминалу рабочее место по умолчанию.",
      ),
    ).toBeDefined();
    expect((await screen.findByText("1 линия")).getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText(LINE.name)).toBeDefined();
    expect(screen.getByText(/12\.08\.2026/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDefined();
  });

  it("keeps populated reference data readable without mutation controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [LINE] })),
    );

    renderPage({ access: OPERATIONS_READ_ONLY });

    expect(await screen.findByText(LINE.name)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать линию" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Действия" })).toBeNull();
  });

  it("keeps the same line-management copy available in English", async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [LINE] })),
    );

    renderPage();

    expect(await screen.findByRole("heading", { name: "Production lines" })).toBeDefined();
    expect(
      screen.getByText(
        "A production line groups shifts and sets a stationary terminal's default workplace.",
      ),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Create line" })).toBeDefined();
    expect(await screen.findByRole("columnheader", { name: "Created" })).toBeDefined();
  });
});

describe("line create and rename panels", () => {
  it("disables an empty or whitespace-only name and validates the 200-character maximum", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, { items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage({ initialEntries: ["/lines/new"] });

    const input = await screen.findByLabelText("Название линии");
    const submit = screen.getByRole("button", { name: "Создать" });
    expect((input as HTMLInputElement).required).toBe(true);
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Укажите название линии",
    );
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "   " } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Л".repeat(201) } });
    fireEvent.click(submit);
    expect(await screen.findByText("Не более 200 символов")).toBeDefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("trims create payload, blocks duplicate pending submit, refetches, and closes on success", async () => {
    let resolveRefetch!: (response: Response) => void;
    const refetchResponse = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    let listRequests = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(201, LINE);
      if (url === "/api/lines/presence") return jsonResponse(200, { items: [] });
      listRequests += 1;
      return listRequests === 1 ? jsonResponse(200, { items: [] }) : refetchResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderPage({ initialEntries: ["/lines/new"] });

    fireEvent.change(await screen.findByLabelText("Название линии"), {
      target: { value: "  Розлив  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1),
    );
    const submit = screen.getByRole("button", { name: "Создать" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    await waitFor(() => expect(listRequests).toBe(2));
    expect(router.state.location.pathname).toBe("/lines/new");
    expect(screen.getByRole("dialog", { name: "Новая линия" })).toBeDefined();

    resolveRefetch(jsonResponse(200, { items: [LINE] }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/lines"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => url === "/api/lines" && init?.method === undefined,
        ),
      ).toHaveLength(2),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Розлив" }) }),
    );
  });

  it("trims the rename payload and closes after the shared list refetches", async () => {
    const renamed = { ...LINE, name: "Фасовка" };
    let resolveRefetch!: (response: Response) => void;
    const refetchResponse = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    let listRequests = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse(200, renamed);
      if (url === "/api/lines/presence") return jsonResponse(200, { items: [] });
      listRequests += 1;
      return listRequests === 1 ? jsonResponse(200, { items: [LINE] }) : refetchResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderPage({ initialEntries: ["/lines/line-1/edit"] });

    const input = await screen.findByLabelText("Название линии");
    fireEvent.change(input, { target: { value: "  Фасовка  " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(listRequests).toBe(2));
    expect(router.state.location.pathname).toBe("/lines/line-1/edit");
    expect(screen.getByRole("dialog", { name: "Изменить линию" })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Фасовка" }),
      }),
    );

    resolveRefetch(jsonResponse(200, { items: [renamed] }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/lines"));
    await waitFor(() => expect(screen.getByText("Фасовка")).toBeDefined());
  });

  it.each([
    {
      language: "ru",
      inputLabel: "Название линии",
      submitLabel: "Создать",
      panelTitle: "Новая линия",
      expected:
        "Достигнут лимит производственных линий по подписке. Увеличьте лимит или удалите неиспользуемую линию.",
    },
    {
      language: "en",
      inputLabel: "Line name",
      submitLabel: "Create",
      panelTitle: "New line",
      expected:
        "The subscription's production line limit has been reached. Increase the limit or delete an unused line.",
    },
  ])(
    "maps the message-less subscription quota response to localized inline copy in $language",
    async ({ language, inputLabel, submitLabel, panelTitle, expected }) => {
      await i18n.changeLanguage(language);
      const quotaResponse = {
        code: "subscription_limit_reached",
        entitlement: "lines",
        used: 2,
        limit: 2,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
          init?.method === "POST"
            ? jsonResponse(409, quotaResponse)
            : jsonResponse(200, { items: [] }),
        ),
      );
      renderPage({ initialEntries: ["/lines/new"] });

      const input = await screen.findByLabelText(inputLabel);
      fireEvent.change(input, { target: { value: "Розлив" } });
      fireEvent.click(screen.getByRole("button", { name: submitLabel }));

      expect(await screen.findByText(expected)).toBeDefined();
      expect((input as HTMLInputElement).value).toBe("Розлив");
      expect(screen.getByRole("dialog", { name: panelTitle })).toBeDefined();
    },
  );

  it.each([
    {
      language: "ru",
      mode: "create",
      initialEntries: ["/lines/new"],
      inputLabel: "Название линии",
      submitLabel: "Создать",
      panelTitle: "Новая линия",
      method: "POST",
      fallback: "Не удалось создать линию",
    },
    {
      language: "en",
      mode: "create",
      initialEntries: ["/lines/new"],
      inputLabel: "Line name",
      submitLabel: "Create",
      panelTitle: "New line",
      method: "POST",
      fallback: "Could not create the line",
    },
    {
      language: "ru",
      mode: "update",
      initialEntries: ["/lines/line-1/edit"],
      inputLabel: "Название линии",
      submitLabel: "Сохранить",
      panelTitle: "Изменить линию",
      method: "PATCH",
      fallback: "Не удалось обновить линию",
    },
    {
      language: "en",
      mode: "update",
      initialEntries: ["/lines/line-1/edit"],
      inputLabel: "Line name",
      submitLabel: "Save",
      panelTitle: "Edit line",
      method: "PATCH",
      fallback: "Could not update the line",
    },
  ])(
    "uses localized $mode fallback copy for an unmapped API error in $language",
    async ({
      language,
      mode,
      initialEntries,
      inputLabel,
      submitLabel,
      panelTitle,
      method,
      fallback,
    }) => {
      await i18n.changeLanguage(language);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
          init?.method === method
            ? jsonResponse(500, { message: "Database connection failed" })
            : jsonResponse(200, { items: mode === "create" ? [] : [LINE] }),
        ),
      );
      renderPage({ initialEntries });

      const input = await screen.findByLabelText(inputLabel);
      fireEvent.change(input, { target: { value: mode === "create" ? "Розлив" : "Фасовка" } });
      fireEvent.click(screen.getByRole("button", { name: submitLabel }));

      expect(await screen.findByText(fallback)).toBeDefined();
      expect(screen.queryByText("Database connection failed")).toBeNull();
      expect(screen.getByRole("dialog", { name: panelTitle })).toBeDefined();
    },
  );

  it("guards dirty dismissal until the user confirms discard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );
    const { router } = renderPage({ initialEntries: ["/lines", "/lines/new"] });

    fireEvent.change(await screen.findByLabelText("Название линии"), {
      target: { value: "Розлив" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Закрыть" }));

    expect(router.state.location.pathname).toBe("/lines/new");
    expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Не сохранять" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/lines"));
  });

  it("shows loading, retryable error, and not-found panel states", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/lines/presence") return jsonResponse(200, { items: [] });
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { message: "Unavailable" })
          : jsonResponse(200, { items: [] });
      }),
    );
    renderPage({ initialEntries: ["/lines/missing/edit"] });

    const panel = await screen.findByRole("dialog", { name: "Изменить линию" });
    expect(await within(panel).findByText("Не удалось загрузить данные линии.")).toBeDefined();
    fireEvent.click(within(panel).getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Линия не найдена")).toBeDefined();
    expect(screen.queryByLabelText("Название линии")).toBeNull();
  });
});

describe("line deletion", () => {
  it("deletes the exact line ID and closes the confirmation after refetch", async () => {
    let resolveRefetch!: (response: Response) => void;
    const refetchResponse = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    let listRequests = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse(204, undefined);
      if (url === "/api/lines/presence") return jsonResponse(200, { items: [] });
      listRequests += 1;
      return listRequests === 1 ? jsonResponse(200, { items: [LINE] }) : refetchResponse;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить линию?" });
    expect(within(dialog).getByText(LINE.name)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(listRequests).toBe(2));
    expect(screen.getByRole("alertdialog", { name: "Удалить линию?" })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/lines/line-1",
      expect.objectContaining({ method: "DELETE" }),
    );

    resolveRefetch(jsonResponse(200, { items: [] }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("Производственные линии не добавлены")).toBeDefined();
  });

  it.each([
    {
      language: "ru",
      deleteLabel: "Удалить",
      dialogTitle: "Удалить линию?",
      expected:
        "Линия используется в сменах или назначена одной или нескольким станциям. Снимите назначения и повторите удаление.",
    },
    {
      language: "en",
      deleteLabel: "Delete",
      dialogTitle: "Delete line?",
      expected:
        "This line is used by shifts or assigned to one or more stations. Remove those references and try again.",
    },
  ])(
    "maps a 409 to truthful recovery copy in $language and keeps the confirmation open",
    async ({ language, deleteLabel, dialogTitle, expected }) => {
      await i18n.changeLanguage(language);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
          init?.method === "DELETE"
            ? jsonResponse(409, { message: "Line is referenced" })
            : jsonResponse(200, { items: [LINE] }),
        ),
      );
      renderPage();

      fireEvent.click(await screen.findByRole("button", { name: deleteLabel }));
      const dialog = await screen.findByRole("alertdialog", { name: dialogTitle });
      fireEvent.click(within(dialog).getByRole("button", { name: deleteLabel }));

      expect(await within(dialog).findByText(expected)).toBeDefined();
      expect(screen.getByRole("alertdialog", { name: dialogTitle })).toBeDefined();
    },
  );

  it.each([
    {
      language: "ru",
      deleteLabel: "Удалить",
      dialogTitle: "Удалить линию?",
      fallback: "Не удалось удалить линию",
    },
    {
      language: "en",
      deleteLabel: "Delete",
      dialogTitle: "Delete line?",
      fallback: "Could not delete the line",
    },
  ])(
    "uses localized delete fallback copy for an unmapped API error in $language",
    async ({ language, deleteLabel, dialogTitle, fallback }) => {
      await i18n.changeLanguage(language);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) =>
          init?.method === "DELETE"
            ? jsonResponse(500, { message: "Database connection failed" })
            : jsonResponse(200, { items: [LINE] }),
        ),
      );
      renderPage();

      fireEvent.click(await screen.findByRole("button", { name: deleteLabel }));
      const dialog = await screen.findByRole("alertdialog", { name: dialogTitle });
      fireEvent.click(within(dialog).getByRole("button", { name: deleteLabel }));

      expect(await within(dialog).findByText(fallback)).toBeDefined();
      expect(within(dialog).queryByText("Database connection failed")).toBeNull();
      expect(screen.getByRole("alertdialog", { name: dialogTitle })).toBeDefined();
    },
  );
});
