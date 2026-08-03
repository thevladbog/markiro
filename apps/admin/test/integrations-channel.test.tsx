import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { ChannelPage } from "../src/pages/integrations/ChannelPage.js";
import i18n from "../src/i18n/index.js";
import type * as IntegrationsApiModule from "../src/pages/integrations/api.js";
import { channelDetailQueryKey, type JournalSessionDto } from "../src/pages/integrations/api.js";

const { credentialHookMountSpy } = vi.hoisted(() => ({ credentialHookMountSpy: vi.fn() }));

vi.mock("../src/pages/integrations/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationsApiModule>();
  return {
    ...actual,
    useIssueCredentials: (type: string) => {
      credentialHookMountSpy(type);
      return actual.useIssueCredentials(type);
    },
  };
});

// Общего рендер-хелпера в этом репозитории НЕТ: каждый админ-тест объявляет
// свой `renderPage`/`render*` и глушит `fetch` -- см.
// `apps/admin/test/counterparties.test.tsx` строки 15-30 и
// `apps/admin/test/pickup-detail.test.tsx` (MemoryRouter + Routes для
// параметризованного маршрута). Повторяем тот же приём здесь, а не заводим
// `test/support/`.

// `vitest.config.ts` не включает `test.globals`, поэтому Testing Library не
// подчищает DOM между тестами сама -- без `cleanup()` узлы от `render()`
// копятся в `document.body` между тестами этого файла.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  patchSpy.mockClear();
  credentialHookMountSpy.mockClear();
  journalSessions = [];
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** `iso(-1)` -- "a day ago"; `iso(-2)` -- "two days ago". Relative to render time. */
function iso(daysOffset: number): string {
  return new Date(Date.now() + daysOffset * 86_400_000).toISOString();
}

const ISSUED_LOGIN = "mk-1c-a1b2c3d4";
const ISSUED_SECRET = "R4nd0mExchangeSecretValue==";

/** Captures every `PATCH /integrations/:type` call as `(path, parsedBody)`. */
const patchSpy = vi.fn();

/** Sessions the next `GET /integrations/:type/journal` call answers with. */
let journalSessions: JournalSessionDto[] = [];

/** `stubJournal([...])` -- overrides the journal fixture for one test. */
function stubJournal(sessions: JournalSessionDto[]): void {
  journalSessions = sessions;
}

/**
 * `i18n/*.json`'s `integrations.channel` keys are camelCase
 * (`publicApi`, `gisMtFiles`, `chestnyZnak`), not the snake_case `type` the
 * server/tests use on the wire -- every prior test in this file only ever
 * rendered `"commerceml"` (where the two happen to be spelled the same), so
 * this mismatch never mattered until a `public_api` test needed a real
 * `labelKey` too. `i18n.test.tsx`'s "throws instead of silently rendering a
 * missing key" guard means a wrong `labelKey` here fails loudly (not with a
 * blank title), which is how this was caught.
 */
const LABEL_KEY_SEGMENT: Record<string, string> = {
  commerceml: "commerceml",
  public_api: "publicApi",
  gis_mt_files: "gisMtFiles",
  chestny_znak: "chestnyZnak",
};

function defaultDetail(type: string) {
  return {
    type,
    labelKey: `integrations.channel.${LABEL_KEY_SEGMENT[type] ?? type}`,
    state: "working",
    lastEventAt: null,
    settings: {},
    silentAfterHours: 48,
    credentialLogin: null,
  };
}

/** Which branch each of the page's four requests should take for one test. */
interface FetchMockOptions {
  journalMode?: "ok" | "pending" | "error";
  /** `GET /integrations/:type` -- the channel-detail request the page itself depends on. */
  detailMode?: "ok" | "pending" | "error";
  /** `PATCH /integrations/:type`. */
  settingsMode?: "ok" | "error";
  /** `POST /integrations/:type/credentials`. "network-error" throws instead of resolving a non-ok `Response`, to exercise the non-`ApiRequestError` fallback branch in `handleIssueCredentials`. */
  issueMode?: "ok" | "error" | "network-error";
  detailSettings?: Record<string, unknown>;
}

function createFetchMock(options: FetchMockOptions = {}) {
  const {
    journalMode = "ok",
    detailMode = "ok",
    settingsMode = "ok",
    issueMode = "ok",
    detailSettings = {},
  } = options;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "GET" && /\/journal$/.test(path)) {
      if (journalMode === "pending") return new Promise<Response>(() => {});
      if (journalMode === "error") return jsonResponse(500, { message: "Internal error" });
      return jsonResponse(200, { sessions: journalSessions });
    }
    if (method === "POST" && /\/credentials$/.test(path)) {
      if (issueMode === "network-error") throw new Error("network down");
      if (issueMode === "error") {
        return jsonResponse(500, { message: "Сбой выпуска учётных данных" });
      }
      return jsonResponse(200, { login: ISSUED_LOGIN, secret: ISSUED_SECRET });
    }
    if (method === "PATCH") {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      patchSpy(path, body);
      if (settingsMode === "error") {
        return jsonResponse(500, { message: "Сервер отклонил настройки" });
      }
      const type = path.split("/").pop()!;
      return jsonResponse(200, { ...defaultDetail(type), settings: body });
    }
    // `GET /integrations/public_api/keys` -- `ApiKeysPanel`'s own list,
    // mounted by `ChannelPage` alongside everything else for `public_api`.
    // Handled explicitly (an empty list) rather than falling through to the
    // plain channel-detail branch below: that branch's response has no
    // `keys` field at all, which would leave `ApiKeysPanel`'s query
    // resolving to `undefined` data -- incidental, not something this file's
    // `public_api` test should depend on.
    if (method === "GET" && /\/keys$/.test(path)) {
      return jsonResponse(200, { keys: [] });
    }
    // Plain `GET /integrations/:type` -- the channel-detail fallback.
    if (detailMode === "pending") return new Promise<Response>(() => {});
    if (detailMode === "error") return jsonResponse(500, { message: "Internal error" });
    const type = path.split("/").pop()!;
    return jsonResponse(200, { ...defaultDetail(type), settings: detailSettings });
  });
}

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const INTEGRATIONS_READ_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ],
};

const INTEGRATIONS_READ_CREDENTIALS_MANAGE_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ, CABINET_CAPABILITY.CREDENTIALS_MANAGE],
};

function renderChannel(
  type: string,
  options: FetchMockOptions = {},
  access: AccessDocument = ADMIN_ACCESS,
) {
  const fetchMock = createFetchMock(options);
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={[`/integrations/${type}`]}>
          <Routes>
            <Route path="/integrations/:type" element={<ChannelPage />} />
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
  // Most tests only need `screen`; the resync/mutation-cache tests below also
  // need direct access to `queryClient` (to simulate an external update, or to
  // inspect the mutation cache after `unmount()`).
  return { ...view, queryClient, fetchMock };
}

describe("ChannelPage", () => {
  it("does not mount credential issuance for integrations.read + credentials.manage without integrations.write", async () => {
    const { fetchMock } = renderChannel(
      "commerceml",
      {},
      INTEGRATIONS_READ_CREDENTIALS_MANAGE_ACCESS,
    );

    expect(await screen.findByText("У вас нет доступа к этому разделу.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /выпустить/i })).toBeNull();
    expect(credentialHookMountSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/credentials"))).toBe(false);
  });

  it("mounts credential issuance only with integrations.write and credentials.manage", async () => {
    renderChannel("commerceml");

    expect(await screen.findByRole("button", { name: /выпустить/i })).toBeDefined();
    expect(credentialHookMountSpy).toHaveBeenCalledWith("commerceml");
  });

  it("hides integration mutations and credential issuance from read-only access", async () => {
    const { fetchMock } = renderChannel("commerceml", {}, INTEGRATIONS_READ_ACCESS);

    expect(await screen.findByText("У вас нет доступа к этому разделу.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /сохранить/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /выпустить/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /добавить строку/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/candidates"))).toBe(false);
  });

  it("показывает секрет обмена один раз и больше никогда", async () => {
    renderChannel("commerceml");
    await userEvent.click(await screen.findByRole("button", { name: /выпустить/i }));
    expect(await screen.findByText(/mk-1c-/)).toBeDefined();
    expect(screen.getByText(/больше он показан не будет/i)).toBeDefined();
  });

  it("поднимает неуспешный сеанс наверх журнала", async () => {
    stubJournal([
      { id: "s2", startedAt: iso(-1), finishedAt: iso(-1), outcome: "ok", summary: {}, events: [] },
      {
        id: "s1",
        startedAt: iso(-2),
        finishedAt: iso(-2),
        outcome: "error",
        summary: {},
        events: [],
      },
    ]);
    renderChannel("commerceml");
    const sessions = await screen.findAllByTestId("journal-session");
    // No `@testing-library/jest-dom` in this repo (see
    // `apps/admin/test/pickup.test.tsx`'s plain `toHaveProperty` uses for the
    // same reason) -- assert the raw attribute instead of `toHaveAttribute`.
    expect(sessions[0]?.getAttribute("data-outcome")).toBe("error");
  });

  it("показывает ответ протокола дословно — его читает специалист по 1С", async () => {
    stubJournal([
      {
        id: "s1",
        startedAt: iso(-1),
        finishedAt: iso(-1),
        outcome: "error",
        summary: {},
        events: [
          {
            at: iso(-1),
            direction: "in",
            outcome: "error",
            message: "Файл не разобран",
            details: { raw: "failure\nCommerceML: unexpected token at 12" },
          },
        ],
      },
    ]);
    renderChannel("commerceml");
    await userEvent.click(await screen.findByTestId("journal-session"));
    expect(await screen.findByText(/unexpected token at 12/)).toBeDefined();
  });

  // Fix 1 (review, Task 13 follow-up): `EventRow`'s `<summary>` sits inside
  // the session row, which is itself a click-to-toggle element -- clicking
  // the summary used to bubble up and collapse the very session it belongs
  // to, unmounting the just-expanded protocol response before it could be
  // read. Assert the session survives the click on its nested disclosure.
  it("раскрытие деталей события не схлопывает сеанс", async () => {
    stubJournal([
      {
        id: "s1",
        startedAt: iso(-1),
        finishedAt: iso(-1),
        outcome: "error",
        summary: {},
        events: [
          {
            at: iso(-1),
            direction: "in",
            outcome: "error",
            message: "Файл не разобран",
            details: { raw: "failure\nCommerceML: unexpected token at 12" },
          },
        ],
      },
    ]);
    renderChannel("commerceml");
    const session = await screen.findByTestId("journal-session");
    await userEvent.click(session);
    expect(session.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(screen.getByText("Ответ в протокол обмена"));

    expect(session.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/unexpected token at 12/)).toBeDefined();
  });

  it("сохраняет тип цены", async () => {
    renderChannel("commerceml");
    await userEvent.type(await screen.findByLabelText(/тип цены/i), "Розничная");
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));
    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({ priceType: "Розничная" }),
    );
  });

  // Fix 4 (review, Task 13 follow-up): `silentAfterHours` is registered with
  // `min: 1`, so an invalid value (0, here) makes `handleSubmit` refuse to
  // call the submit handler at all -- but `formState.errors` was never read,
  // so the operator got no toast, no message, nothing: the button looked
  // like it just silently did nothing. The field must show its own error.
  it("показывает ошибку валидации порога молчания и не отправляет форму", async () => {
    renderChannel("commerceml");
    const silentInput = await screen.findByLabelText(/порог молчания/i);
    await userEvent.clear(silentInput);
    await userEvent.type(silentInput, "0");
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(await screen.findByText(/минимум 1 час/i)).toBeDefined();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  // Брифа 08 требования к спискам (пустое состояние, загрузка, ошибка --
  // каждое своим тестом) относятся и к журналу этой страницы -- он остаётся
  // единственным списком на ней.
  it("показывает пустое состояние журнала, когда обменов ещё не было", async () => {
    renderChannel("commerceml");
    expect(await screen.findByText(/обменов ещё не было/i)).toBeDefined();
  });

  it("показывает спиннер, пока журнал ещё не загрузился", async () => {
    renderChannel("commerceml", { journalMode: "pending" });
    // Настройки уже отрисованы (деталь канала загрузилась), а спиннер журнала
    // всё ещё висит -- это должно быть отдельное состояние, а не блокировать
    // всю страницу.
    expect(await screen.findByLabelText(/тип цены/i)).toBeDefined();

    // `@markiro/ui`'s `toast()` viewport is a module-level singleton that
    // outlives `cleanup()` (see `pickup.test.tsx`'s note on the same thing),
    // so an earlier test's toast can still carry its own `role="status"` --
    // scope the search to the journal card instead of a bare
    // `findByRole("status")`.
    const journalCard = (await screen.findByText(/журнал/i)).closest(".mk-card");
    if (!journalCard) throw new Error("expected to find the journal card");
    expect(within(journalCard as HTMLElement).getByRole("status")).toBeDefined();
    expect(screen.queryByText(/обменов ещё не было/i)).toBeNull();
  });

  it("показывает ошибку, когда запрос журнала не удался", async () => {
    renderChannel("commerceml", { journalMode: "error" });
    expect(await screen.findByText(/не удалось загрузить журнал/i)).toBeDefined();
    expect(screen.queryByText(/обменов ещё не было/i)).toBeNull();
  });

  // Fix 1 (review, task 13 follow-up): `useIssueCredentials` used to be a
  // `useMutation`. `Mutation` extends `Removable` and only *schedules* its own
  // removal once its last observer unsubscribes (default `gcTime` five
  // minutes) -- since `main.tsx`'s `QueryClient` lives for the app's whole
  // session, the plaintext secret would still be sitting in the
  // `MutationCache` well after this page unmounts. `useIssueCredentials` is
  // now a plain async wrapper with no mutation cache entry at all -- assert
  // that directly instead of asserting on a timer.
  it("не оставляет секрет обмена в кэше мутаций после ухода со страницы", async () => {
    const { queryClient, unmount } = renderChannel("commerceml");
    await userEvent.click(await screen.findByRole("button", { name: /выпустить/i }));
    await screen.findByText(/mk-1c-/);

    unmount();

    const leaked = queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) => JSON.stringify(mutation.state.data ?? null).includes(ISSUED_SECRET));
    expect(leaked).toBe(false);
  });

  // Fix 2 (review, task 13 follow-up): `useForm`'s `defaultValues` used to be
  // captured once at mount and never resynced, even though TanStack Query's
  // default `refetchOnWindowFocus` means `channel` can change underneath this
  // form any time another admin saves new settings. Simulate that arrival
  // directly via `setQueryData` (indistinguishable, from the component's
  // point of view, from an actual background refetch resolving).
  it("пересинхронизирует форму настроек с чужим изменением и не отправляет старое значение", async () => {
    const { queryClient } = renderChannel("commerceml");
    const priceInput = (await screen.findByLabelText(/тип цены/i)) as HTMLInputElement;
    expect(priceInput.value).toBe("");

    await act(async () => {
      queryClient.setQueryData(channelDetailQueryKey("commerceml"), {
        ...defaultDetail("commerceml"),
        settings: { priceType: "Оптовая", splitWriteoffDocument: false },
      });
    });
    await screen.findByDisplayValue("Оптовая");

    // The operator only ever touches the checkbox -- never retypes the price
    // type -- so a broken resync would silently submit whatever `priceType`
    // the form was mounted with, reverting the other admin's change.
    await userEvent.click(screen.getByLabelText(/разделять документ списания/i));
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({ priceType: "Оптовая", splitWriteoffDocument: true }),
    );
  });

  it("не затирает уже набранное оператором, когда пришло чужое изменение", async () => {
    const { queryClient } = renderChannel("commerceml");
    const priceInput = (await screen.findByLabelText(/тип цены/i)) as HTMLInputElement;
    await userEvent.type(priceInput, "Моя правка");

    await act(async () => {
      queryClient.setQueryData(channelDetailQueryKey("commerceml"), {
        ...defaultDetail("commerceml"),
        settings: { priceType: "Чужое значение", splitWriteoffDocument: false },
      });
    });

    expect(priceInput.value).toBe("Моя правка");
  });

  // Fix 4 (review, task 13 follow-up): the page's own `isPending`/`isError`
  // branches for the channel-detail request had no coverage.
  it("показывает спиннер, пока карточка канала ещё не загрузилась", async () => {
    // `@markiro/ui`'s toast viewport is a module-level singleton that
    // outlives `cleanup()` (see the note above on the journal spinner test),
    // so an earlier test's toast can still carry its own `role="status"` --
    // scope the search to this render's own container instead of a bare
    // `screen.findByRole("status")`.
    const { container } = renderChannel("commerceml", { detailMode: "pending" });
    expect(await within(container).findByRole("status")).toBeDefined();
    expect(screen.queryByLabelText(/тип цены/i)).toBeNull();
  });

  it("показывает ошибку, когда запрос карточки канала не удался", async () => {
    renderChannel("commerceml", { detailMode: "error" });
    expect(await screen.findByText(/не удалось загрузить канал/i)).toBeDefined();
    expect(screen.queryByLabelText(/тип цены/i)).toBeNull();
  });

  // Fix 4, continued: the failure path for saving settings and for issuing
  // credentials was untested too.
  it("показывает ошибку и сохраняет введённое значение, когда сохранение настроек не удалось", async () => {
    renderChannel("commerceml", { settingsMode: "error" });
    const priceInput = (await screen.findByLabelText(/тип цены/i)) as HTMLInputElement;
    await userEvent.type(priceInput, "Розничная");
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(await screen.findByText(/сервер отклонил настройки/i)).toBeDefined();
    // The failed save must not be silently discarded from the field, and the
    // form must stay dirty (see Fix 2) so a later external update can't
    // clobber it either.
    expect(priceInput.value).toBe("Розничная");
  });

  it("показывает ошибку, когда выпуск учётных данных не удался", async () => {
    renderChannel("commerceml", { issueMode: "network-error" });
    await userEvent.click(await screen.findByRole("button", { name: /выпустить/i }));

    expect(await screen.findByText(/не удалось выпустить учётные данные/i)).toBeDefined();
    expect(screen.queryByText(/mk-1c-/)).toBeNull();
  });

  // Fix 1 (review, task 15 follow-up): `CredentialsSection` used to render
  // unconditionally for every channel type, so `public_api`'s settings card
  // carried a second, meaningless "Выпустить"/one-time-secret widget next to
  // `ApiKeysPanel`'s own -- a fully working button that minted a real
  // exchange login+secret nothing on the server ever checks for this
  // channel (see `channel-registry.ts`'s `usesExchangeCredentials` and
  // `IntegrationsService.issueCredentials`'s guard on it). `public_api`'s
  // real "settings" are the key list, not this.
  // Task 15 (И-2): the order-status-mapping sub-form -- a repeatable
  // key/value editor backed by `useFieldArray`, whose value half is a
  // `Controller`-wrapped `Select` (a controlled component), not a
  // `register()`-bound native `<select>` (which react-hook-form cannot
  // drive correctly for a controlled component like `@markiro/ui`'s `Select`).
  it("сохраняет тип документа списания, реквизит статуса и сопоставление статусов", async () => {
    renderChannel("commerceml");

    await userEvent.type(
      await screen.findByLabelText(/тип документа для списания/i),
      "СписаниеТоваров",
    );
    await userEvent.type(await screen.findByLabelText(/реквизит статуса заказа/i), "Статус");

    await userEvent.click(screen.getByRole("button", { name: /добавить строку/i }));
    await userEvent.type(screen.getByPlaceholderText(/внешнее значение/i), "ЗаказВыполнен");
    await userEvent.selectOptions(screen.getByRole("combobox"), "writtenoff");

    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({
        writeoffDocumentType: "СписаниеТоваров",
        orderStatusField: "Статус",
        statusMapping: { ЗаказВыполнен: "writtenoff" },
      }),
    );
  });

  it("отбрасывает строки сопоставления статусов с пустым внешним значением", async () => {
    renderChannel("commerceml");

    await userEvent.click(await screen.findByRole("button", { name: /добавить строку/i }));
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    const call = patchSpy.mock.calls.find((c) => c[0] === "/integrations/commerceml");
    expect(call).toBeDefined();
    expect(call?.[1]).not.toHaveProperty("statusMapping");
  });

  it("отправляет пустое сопоставление при удалении последней сохранённой строки", async () => {
    const { queryClient } = renderChannel("commerceml");
    await screen.findByLabelText(/тип цены/i);

    await act(async () => {
      queryClient.setQueryData(channelDetailQueryKey("commerceml"), {
        ...defaultDetail("commerceml"),
        settings: { statusMapping: { ЗаказВыполнен: "writtenoff" } },
      });
    });
    await screen.findByDisplayValue("ЗаказВыполнен");

    await userEvent.click(screen.getByRole("button", { name: /удалить/i }));
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({ statusMapping: {} }),
    );
  });

  it("явно очищает строковые настройки и восстанавливает очистку после перезагрузки", async () => {
    const configured = {
      writeoffDocumentType: "СписаниеТоваров",
      orderStatusField: "Статус",
      statusMapping: { ЗаказВыполнен: "writtenoff" },
    };
    const first = renderChannel("commerceml", { detailSettings: configured });
    const writeoffInput = (await screen.findByLabelText(
      /тип документа для списания/i,
    )) as HTMLInputElement;
    const statusFieldInput = screen.getByLabelText(/реквизит статуса заказа/i) as HTMLInputElement;

    await userEvent.clear(writeoffInput);
    await userEvent.clear(statusFieldInput);
    await userEvent.click(screen.getByRole("button", { name: /удалить/i }));
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));

    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({
        writeoffDocumentType: null,
        orderStatusField: null,
        statusMapping: {},
      }),
    );

    first.unmount();
    renderChannel("commerceml", {
      detailSettings: { writeoffDocumentType: null, orderStatusField: null, statusMapping: {} },
    });
    expect(
      ((await screen.findByLabelText(/тип документа для списания/i)) as HTMLInputElement).value,
    ).toBe("");
    expect((screen.getByLabelText(/реквизит статуса заказа/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /удалить/i })).toBeNull();
  });

  it("даёт каждой паре сопоставления уникальные переведённые имена с номером строки", async () => {
    renderChannel("commerceml");
    await userEvent.click(await screen.findByRole("button", { name: /добавить строку/i }));
    await userEvent.click(screen.getByRole("button", { name: /добавить строку/i }));

    expect(screen.getByRole("textbox", { name: "Внешнее значение, строка 1" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Внутренний статус, строка 1" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Внешнее значение, строка 2" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Внутренний статус, строка 2" })).toBeDefined();

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByRole("textbox", { name: "External value, row 1" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Internal status, row 1" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "External value, row 2" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Internal status, row 2" })).toBeDefined();

    await act(async () => {
      await i18n.changeLanguage("ru");
    });
  });

  it("не показывает выпуск учётных данных обмена для канала без обмена (public_api)", async () => {
    renderChannel("public_api");

    // Wait for `ApiKeysPanel` (public_api's own card) to render, so the page
    // is fully settled before asserting on what it does NOT show.
    await screen.findByText(/ключи публичного api/i);

    expect(screen.queryByText(/учётные данные обмена/i)).toBeNull();
    // Exactly one "Выпустить" button should remain -- `ApiKeysPanel`'s own.
    // Before this fix there were two: this one, plus `CredentialsSection`'s.
    expect(screen.getAllByRole("button", { name: /выпустить/i }).length).toBe(1);
  });
});
