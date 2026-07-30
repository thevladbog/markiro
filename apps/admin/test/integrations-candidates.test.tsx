import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogPage } from "../src/pages/catalog/index.js";
import { ProductForm } from "../src/pages/catalog/ProductForm.js";
import { CandidatesQueue } from "../src/pages/integrations/CandidatesQueue.js";

// Общего рендер-хелпера в этом репозитории нет -- каждый админ-тест пишет
// свой `render*`/стаб `fetch` заново, см. `apps/admin/test/counterparties.test.tsx`
// строки 15-30 и `apps/admin/test/integrations-channel.test.tsx`.
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

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface CandidateFixture {
  id: string;
  externalRef: string;
  name: string;
  article: string | null;
  suggestedProductId?: string | null;
}

function toCandidateDto(fixture: CandidateFixture) {
  return {
    id: fixture.id,
    externalRef: fixture.externalRef,
    name: fixture.name,
    article: fixture.article,
    unit: null,
    price: null,
    priceType: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    hidden: false,
    suggestedProductId: fixture.suggestedProductId ?? null,
  };
}

/** The working (`hidden=false`) queue fixture -- reset before every test, overridden by `stubCandidates`. */
let workingFixture: CandidateFixture[] = [];
/** The hidden (`hidden=true`) queue fixture. */
let hiddenFixture: CandidateFixture[] = [];
/** How `GET /integrations/commerceml/candidates` (either view) should behave for `renderQueue`. */
let queueListMode: "ok" | "pending" | "error" = "ok";
/** When set, the `.../link` call for this one candidate id answers 409 instead of 200. */
let failLinkCandidateId: string | null = null;

/** Every POST .../link call, as `(candidateId, productId)`. */
const linkSpy = vi.fn();
/** Every GET .../candidates call, as its full path (including query string). */
const listSpy = vi.fn();
/** Every DELETE /products/:id/external-link call, as the product id. */
const unlinkSpy = vi.fn();

beforeEach(() => {
  workingFixture = [];
  hiddenFixture = [];
  queueListMode = "ok";
  failLinkCandidateId = null;
  linkSpy.mockClear();
  listSpy.mockClear();
  unlinkSpy.mockClear();
});

/** `stubCandidates([...])` -- overrides the working-queue fixture for one test. */
function stubCandidates(fixtures: CandidateFixture[]): void {
  workingFixture = fixtures;
}

/** `stubLinkFailure(id)` -- makes the `.../link` call for this one candidate answer 409, as the server's real atomic `UPDATE ... WHERE external_ref IS NULL` does when the target product is already taken. */
function stubLinkFailure(candidateId: string): void {
  failLinkCandidateId = candidateId;
}

function renderQueue() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";

    if (method === "GET" && path.startsWith("/api/integrations/commerceml/candidates")) {
      listSpy(path);
      if (queueListMode === "pending") return new Promise<Response>(() => {});
      if (queueListMode === "error") return jsonResponse(500, { message: "Internal error" });
      const hidden = path.includes("hidden=true");
      const fixtures = hidden ? hiddenFixture : workingFixture;
      return jsonResponse(200, { candidates: fixtures.map(toCandidateDto) });
    }

    const linkMatch = /^\/api\/integrations\/commerceml\/candidates\/([^/]+)\/link$/.exec(path);
    if (method === "POST" && linkMatch) {
      const candidateId = linkMatch[1]!;
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as { productId: string };
      linkSpy(candidateId, body.productId);
      if (candidateId === failLinkCandidateId) {
        return jsonResponse(409, { message: "Товар уже связан с другой позицией" });
      }
      return jsonResponse(200, undefined);
    }

    if (
      method === "POST" &&
      /^\/api\/integrations\/commerceml\/candidates\/[^/]+\/(hide|unhide)$/.test(path)
    ) {
      return jsonResponse(200, undefined);
    }

    // `useProducts()` (the manual-link picker's product list) -- empty is fine, none of these tests pick manually.
    return jsonResponse(200, { items: [] });
  });

  vi.stubGlobal("fetch", fetchMock);

  return render(
    <QueryClientProvider client={newQueryClient()}>
      <CandidatesQueue type="commerceml" />
    </QueryClientProvider>,
  );
}

/** How many working candidates `renderCatalog`'s plaque check should see. */
let candidateCountFixture = 0;

function stubCandidateCount(count: number): void {
  candidateCountFixture = count;
}

function renderCatalog() {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith("/api/integrations/commerceml/candidates")) {
      const fixtures: CandidateFixture[] = Array.from(
        { length: candidateCountFixture },
        (_, i) => ({
          id: `c${i}`,
          externalRef: `g${i}`,
          name: `Товар ${i}`,
          article: null,
        }),
      );
      return jsonResponse(200, { candidates: fixtures.map(toCandidateDto) });
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);

  return render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <CatalogPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderProductCard({
  externalRef,
  externalName,
}: {
  externalRef: string;
  externalName: string;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "DELETE" && path === "/api/products/p-1/external-link") {
      unlinkSpy("p-1");
      return jsonResponse(200, undefined);
    }
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);

  return render(
    <QueryClientProvider client={newQueryClient()}>
      <ProductForm
        open
        mode="edit"
        productId="p-1"
        externalRef={externalRef}
        initialValues={{
          gtin: "04600000000018",
          name: externalName,
          productGroup: "",
          boxCapacity: "",
          palletCapacity: "",
          unitPrice: "",
          egaisCode: "",
          defaultCounterpartyId: "",
          defaultLabelTemplateId: "",
        }}
        counterparties={[]}
        labelTemplates={[]}
        onSubmit={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("CandidatesQueue", () => {
  it("предлагает три действия, а не только создание", async () => {
    stubCandidates([
      {
        id: "c1",
        externalRef: "guid-9",
        name: "Новинка",
        article: "N-1",
        suggestedProductId: null,
      },
    ]);
    renderQueue();
    expect(await screen.findByRole("button", { name: /связать/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /создать/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /скрыть/i })).toBeDefined();
  });

  it("даёт подтвердить подсказки пачкой — первый обмен приносит весь каталог", async () => {
    stubCandidates([
      {
        id: "c1",
        externalRef: "g1",
        name: "Жигулёвское 0,5",
        article: null,
        suggestedProductId: "p-1",
      },
      { id: "c2", externalRef: "g2", name: "Вода 1,0", article: null, suggestedProductId: "p-2" },
    ]);
    renderQueue();
    await userEvent.click(
      await screen.findByRole("button", { name: /подтвердить все подсказки/i }),
    );
    expect(linkSpy).toHaveBeenCalledTimes(2);
  });

  // Fix 1 (review, Task 14 follow-up): a single 409 in the batch used to
  // reject the whole `Promise.all`, so the operator saw one nondeterministic
  // error toast with no idea 49 of 50 candidates had actually linked. Now
  // every candidate settles independently and the toast reports the true
  // tally.
  it("подтверждение пачкой переживает единичный 409 и честно считает итог", async () => {
    stubCandidates([
      {
        id: "c1",
        externalRef: "g1",
        name: "Жигулёвское 0,5",
        article: null,
        suggestedProductId: "p-1",
      },
      { id: "c2", externalRef: "g2", name: "Вода 1,0", article: null, suggestedProductId: "p-2" },
      { id: "c3", externalRef: "g3", name: "Квас 1,5", article: null, suggestedProductId: "p-3" },
    ]);
    stubLinkFailure("c2");
    renderQueue();

    await userEvent.click(
      await screen.findByRole("button", { name: /подтвердить все подсказки/i }),
    );

    // The toast reports both numbers -- two linked, one rejected -- rather
    // than a single binary success/failure verdict.
    expect(await screen.findByText(/связано: 2, отклонено: 1/i)).toBeDefined();

    // All three were attempted (no short-circuit on the first rejection),
    // and the two that didn't hit the 409 really did link.
    expect(linkSpy).toHaveBeenCalledTimes(3);
    expect(linkSpy).toHaveBeenCalledWith("c1", "p-1");
    expect(linkSpy).toHaveBeenCalledWith("c3", "p-3");
  });

  it("скрытые доступны под фильтром", async () => {
    renderQueue();
    await userEvent.click(await screen.findByRole("checkbox", { name: /показать скрытые/i }));
    expect(listSpy).toHaveBeenLastCalledWith(expect.stringContaining("hidden=true"));
  });

  it("каталог зовёт в очередь, когда там что-то есть", async () => {
    stubCandidateCount(3);
    renderCatalog();
    expect(await screen.findByText(/в обмене появились новые товары/i)).toBeDefined();
  });

  it("карточка товара показывает связь и даёт её разорвать", async () => {
    renderProductCard({ externalRef: "guid-1", externalName: "Жигулёвское 0,5" });
    await userEvent.click(await screen.findByRole("button", { name: /разорвать связь/i }));
    expect(unlinkSpy).toHaveBeenCalledWith("p-1");
  });

  // Брифа 08 требования к спискам (пустое состояние, загрузка, ошибка --
  // каждое своим тестом) относятся и к очереди кандидатов -- это новый
  // список, ровно тот случай, для которого правило написано.
  it("показывает пустое состояние, когда очередь пуста", async () => {
    renderQueue();
    expect(await screen.findByText(/очередь пуста/i)).toBeDefined();
  });

  it("показывает спиннер, пока очередь ещё не загрузилась", async () => {
    queueListMode = "pending";
    renderQueue();
    // `@markiro/ui`'s toast() viewport is a module-level singleton that
    // outlives `cleanup()` (see `apps/admin/test/integrations-channel.test.tsx`'s
    // note on the same thing) -- an earlier test's toast can still carry its
    // own `role="status"`, so scope the search to this card instead of a bare
    // `screen.findByRole("status")`.
    const card = (await screen.findByText(/очередь несопоставленных/i)).closest(".mk-card");
    if (!card) throw new Error("expected to find the candidates queue card");
    expect(within(card as HTMLElement).getByRole("status")).toBeDefined();
    expect(screen.queryByText(/очередь пуста/i)).toBeNull();
  });

  it("показывает ошибку, когда запрос очереди не удался", async () => {
    queueListMode = "error";
    renderQueue();
    expect(await screen.findByText(/не удалось загрузить очередь/i)).toBeDefined();
    expect(screen.queryByText(/очередь пуста/i)).toBeNull();
  });
});
