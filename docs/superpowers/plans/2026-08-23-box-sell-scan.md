# Box Sell-Codes Mobile Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мобильная страница админки, где кассир вводит/сканирует SSCC короба и получает DataMatrix коды содержимого по одному на весь экран, чтобы касса сканировала их с телефона.

**Architecture:** Новый read-only эндпоинт `GET /boxes/sell-codes?sscc=` в существующем модуле `apps/api/src/modules/boxes/` (переиспользует `resolveBoxRegistryFacts` из kiosk/box-registry.service — тот же путь, которым pickup-orders достаёт `canonicalRaw`). В админке — новый роут `boxes/sell` под `RequireCapability(OPERATIONS_READ)`, mobile-first страница с тремя состояниями (ввод SSCC → показ кодов по одному → финал), рендер DataMatrix через lazy-чанк по образцу `pages/pickup/ItemCode.tsx`.

**Tech Stack:** NestJS 11 + Drizzle (API), Vite + React 19 + react-router 8 + TanStack Query + react-i18next (admin), bwip-js через `@markiro/domain`, vitest + supertest / testing-library.

**Spec:** `docs/superpowers/specs/2026-08-23-box-sell-scan-design.md`

## Global Constraints

- Схема БД НЕ меняется — миграций в этом плане нет, `@markiro/db` пересобирать не нужно (но в свежем worktree он должен быть собран, см. ниже).
- Свежий worktree перед началом: `pnpm install`, затем `pnpm --filter @markiro/db build && pnpm --filter @markiro/domain build && pnpm --filter @markiro/ui build` (у пакетов `main: ./dist/index.js`, без сборки vitest падает `Failed to resolve entry`).
- Фильтр тестов по файлу: `pnpm --filter <pkg> exec vitest run <pattern>` — форма `test -- <pattern>` НЕ фильтрует.
- API e2e требуют окружение (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `PAIRING_CODE_PEPPER` ≥16 символов, `PLATFORM_AUTH_URL`, `SAAS_ADMIN_ORIGIN`). Файлы обёрнуты в `describe.skipIf(!ready)` — «зелёный» прогон со skipped-файлами НЕ является подтверждением. Рецепт одноразовой БД: `docker exec q-postgres-1 psql -U markiro -d postgres -c "CREATE DATABASE markiro_sellcodes;"`, затем из `packages/db` `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_sellcodes pnpm exec drizzle-kit migrate`, тесты гонять с тем же инлайн-окружением, в конце DROP DATABASE.
- Каждый новый API e2e-файл ОБЯЗАН вызывать `listenOnLoopback(app)` из `apps/api/test/support/listen-loopback.ts` после `app.init()` — иначе флейк `Parse Error: Expected HTTP/`.
- Тексты UI — через react-i18next, ключи в `apps/admin/src/i18n/ru.json` И `en.json` (пространство `pages.boxSell.*`). Русский — основной язык.
- Никогда `prettier --write .` — только затронутые пути.
- Этот план содержит JSX-блоки: файл плана уже добавлен в `.prettierignore` (не убирать).
- Финальный гейт перед сдачей: `pnpm turbo lint typecheck test build --concurrency=1` и отдельно `pnpm format:check`; после — `graphify update .` если существует `graphify-out/graph.json`.

---

### Task 1: API — эндпоинт `GET /boxes/sell-codes` + аудит

**Files:**
- Modify: `apps/api/src/authorization/security-audit.service.ts` (добавить `sensitiveRead`)
- Modify: `apps/api/src/modules/boxes/dto.ts` (query-схема + response DTO)
- Modify: `apps/api/src/modules/boxes/boxes.service.ts` (метод `getSellCodes`)
- Modify: `apps/api/src/modules/boxes/boxes.controller.ts` (роут + аудит-вызов)
- Test: `apps/api/test/box-sell-codes.e2e.test.ts`

**Interfaces:**
- Consumes: `resolveBoxRegistryFacts`, `BoxRegistryCandidate` из `apps/api/src/modules/kiosk/box-registry.service.ts`; `parseScannedSscc`, `canonicalizeKm`, `formatSsccWithAi` из `@markiro/domain`; `SecurityAuditService` (глобальный `AuthorizationModule`).
- Produces: `GET /boxes/sell-codes?sscc=<scanner-raw-or-18-digits>` → 200 `BoxSellCodesDto { boxId: string; sscc: string; productName: string; itemCount: number; items: Array<{ codeHash: string; rawKm: string; gtin14: string; serial: string }> }`; 400 `invalid_sscc`; 404 `box_not_found`; 409 `box_not_closed` | `box_disassembled` | `box_empty`; 403 без `operations.read`. Поле `sscc` в ответе — 20 знаков с AI «00» (`formatSsccWithAi`).

- [ ] **Step 1: Написать падающий e2e-тест**

Создать `apps/api/test/box-sell-codes.e2e.test.ts`. Каркас, `beforeAll`-бутстрап и хелперы `deviceKey`/`createActiveProduct`/`openShiftForProduct`/`scan`/`postBatch` (и локальный интерфейс `ClosureFixture`) скопировать дословно из `apps/api/test/boxes.e2e.test.ts` (тот же паттерн: фикстуры строятся только через `/station/scans`, `listenOnLoopback(app)` обязателен). Фикстуры в `beforeAll` (общий `productId`, общий `operatorId` — как в boxes.e2e):

- `closedBox`: смена A, два скана `aa`,`bb` в `boxId:"sell1"`, затем closure `{ boxId: "sell1", sscc: "123456789012345675", closedAt: "2026-01-01T00:00:00.000Z", operatorId }`.
- Случай `box_not_closed` e2e-тестом не покрывается: `boxes.sscc` присваивается только при закрытии, поэтому найти незакрытый короб по SSCC невозможно. Проверка в сервисе остаётся как защита инварианта (см. doc-комментарий в Step 3c).
- `disassembledBox`: смена C, скан `dd` в `boxId:"sell3"`, closure `{ sscc: "123456789012345682", closedAt: "2026-01-01T00:00:00.000Z" }`, затем exception `kind:"disassemble"` (дословно по образцу теста "surfaces a non-null disassembledAt" из boxes.e2e.test.ts, с `codeHash: null`).
- `otherTenant`: второй агент `signUpAndActivate(other)`, свой девайс, свой продукт/смена, скан `zz` в `boxId:"sell9"`, closure `{ sscc: "123456789012345699", closedAt: "2026-01-01T00:00:00.000Z", operatorId: null }`.

Сами тесты:

```ts
it("returns the closed box's active codes with rawKm", async () => {
  const res = await agent.get("/boxes/sell-codes?sscc=123456789012345675").expect(200);
  const body = res.body as {
    boxId: string;
    sscc: string;
    productName: string;
    itemCount: number;
    items: { codeHash: string; rawKm: string; gtin14: string; serial: string }[];
  };
  expect(body.sscc).toBe("00123456789012345675");
  expect(body.productName).toBe("Cola");
  expect(body.itemCount).toBe(2);
  const serials = body.items.map((item) => item.serial).sort();
  expect(serials).toEqual(["S-aa", "S-bb"]);
  for (const item of body.items) {
    expect(item.rawKm).toContain(`01${VALID_GTIN14}21`);
    expect(item.gtin14).toBe(VALID_GTIN14);
    expect(item.codeHash).toMatch(/^[0-9a-f]{64}$/);
  }
});

it("accepts scanner-decorated SSCC input (AI 00 prefix)", async () => {
  const res = await agent.get("/boxes/sell-codes?sscc=00123456789012345675").expect(200);
  expect((res.body as { boxId: string }).boxId).toBeTruthy();
});

it("rejects a malformed sscc with 400", async () => {
  await agent.get("/boxes/sell-codes?sscc=not-an-sscc").expect(400);
});

it("404s an unknown sscc", async () => {
  const res = await agent.get("/boxes/sell-codes?sscc=123456789012345691").expect(404);
  expect((res.body as { code?: string }).code).toBe("box_not_found");
});

it("409s a disassembled box", async () => {
  const res = await agent.get("/boxes/sell-codes?sscc=123456789012345682").expect(409);
  expect((res.body as { code?: string }).code).toBe("box_disassembled");
});

it("does not resolve another tenant's box (404, not 403/409)", async () => {
  const res = await agent.get("/boxes/sell-codes?sscc=123456789012345699").expect(404);
  expect((res.body as { code?: string }).code).toBe("box_not_found");
});

// Cabinet-only route: контроллер помечен `RequirePermissions(OPERATIONS_READ)`
// в режиме "cabinet", поэтому станционный api-key (который TenantGuard
// принимает для резолва тенанта) обязан получить 403 — тот же паттерн, что
// описан в doc-комментарии BoxesController.
it("rejects a station api-key with 403", async () => {
  await request(app!.getHttpServer())
    .get("/boxes/sell-codes?sscc=123456789012345675")
    .set("x-api-key", stationKey)
    .expect(403);
});

it("audit-logs each successful read", async () => {
  const audit = app!.get(SecurityAuditService);
  const spy = vi.spyOn(audit, "sensitiveRead");
  await agent.get("/boxes/sell-codes?sscc=123456789012345675").expect(200);
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({ action: "boxes.sell_codes.read" }),
  );
  spy.mockRestore();
});
```

Для последних двух тестов добавить импорты: `vi` из `vitest`, `SecurityAuditService` из `../src/authorization/security-audit.service`. NB: тест на аудит упадёт компиляцией, пока метода `sensitiveRead` нет — это ожидаемая часть красной фазы.

Примечания для SSCC фикстур: значения `123456789012345675`, `123456789012345682`, `123456789012345699`, `123456789012345691` должны проходить `isValidSscc` (mod-10 check digit). `...675` и `...683`/`...690` уже используются в boxes.e2e.test.ts как валидные; ПЕРЕД написанием теста проверить чек-цифры остальных через node-однострочник:

```bash
node -e "const s=p=>{let sum=0;for(let i=0;i<17;i++){sum+=Number(p[i])*(i%2===0?3:1)}return p.slice(0,17)+String((10-(sum%10))%10)};for(const p of ['12345678901234567','12345678901234568','12345678901234569']) console.log(s(p+'0'))"
```

и подставить в фикстуры/тесты реально валидные значения (в assertions использовать те же строки, что в closure-фикстурах).

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd apps/api && DATABASE_URL=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=... PAIRING_CODE_PEPPER=... PLATFORM_AUTH_URL=http://localhost:3001 SAAS_ADMIN_ORIGIN=http://localhost:5473 npx vitest run box-sell-codes
```

Expected: FAIL — все запросы получают 404 (роут не существует). Проверить, что файл НЕ skipped (счётчик skipped = 0).

- [ ] **Step 3: Реализация**

3a. `apps/api/src/authorization/security-audit.service.ts` — добавить интерфейс и метод (после `deviceCredentialMutation`):

```ts
interface SensitiveReadEvent {
  tenantId: string;
  userId: string | null;
  action: string;
  resourceId: string | null;
}
```

```ts
  /**
   * A successful read of data whose exposure matters (raw KM payloads for
   * the box sell-codes screen): logged with the same structured shape as
   * mutations so the audit trail answers "who saw box X's codes and when".
   */
  sensitiveRead(event: SensitiveReadEvent): void {
    this.logger.log(
      JSON.stringify({
        tenantId: event.tenantId,
        userId: event.userId,
        action: event.action,
        resourceId: event.resourceId,
        outcome: "succeeded",
      }),
    );
  }
```

3b. `apps/api/src/modules/boxes/dto.ts` — добавить:

```ts
import { parseScannedSscc } from "@markiro/domain";
```

```ts
/**
 * GET /boxes/sell-codes query. Accepts whatever the cashier's camera or
 * keyboard produced -- `parseScannedSscc` strips the `]C1` AIM prefix,
 * a printed `(00)` and the bare `00` AI, and validates the check digit --
 * so the stored bare-18-digit form is what reaches the service.
 */
export const sellCodesQuerySchema = z.object({
  sscc: z.string().transform((value, ctx) => {
    const parsed = parseScannedSscc(value.trim());
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "invalid_sscc" });
      return z.NEVER;
    }
    return parsed;
  }),
});
export type SellCodesQueryDto = z.infer<typeof sellCodesQuerySchema>;

/** One live code of a sellable box; `rawKm` feeds `renderDataMatrixSvg` client-side. */
export interface BoxSellCodeItemDto {
  codeHash: string;
  rawKm: string;
  gtin14: string;
  serial: string;
}

/** GET /boxes/sell-codes response. `sscc` is AI-00-prefixed (20 digits), as everywhere cabinet-facing. */
export interface BoxSellCodesDto {
  boxId: string;
  sscc: string;
  productName: string;
  itemCount: number;
  items: BoxSellCodeItemDto[];
}
```

3c. `apps/api/src/modules/boxes/boxes.service.ts` — добавить импорты и метод:

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { canonicalizeKm, formatSsccWithAi } from "@markiro/domain";
import {
  resolveBoxRegistryFacts,
  type BoxRegistryCandidate,
} from "../kiosk/box-registry.service";
import type {
  BoxDto,
  BoxSellCodesDto,
  ListBoxesQueryDto,
  ListBoxesResponseDto,
} from "./dto";
```

```ts
  /**
   * Sell-at-register view: one closed box's live codes WITH their raw KM
   * payloads. This is deliberately the only cabinet endpoint that exposes
   * `codes.canonicalRaw` (BoxCardItemDto stays hash+serial only); the
   * membership/current-owner resolution is `resolveBoxRegistryFacts` -- the
   * exact query pickup-orders' box-order-resolver already trusts for the
   * same "which codes does this box really hold" question.
   *
   * `box_not_closed` is unreachable through this lookup today (`boxes.sscc`
   * is only assigned by the closure ingest path), but the guard stays: the
   * invariant this endpoint sells against is "closed and untouched", not
   * "has an sscc".
   */
  async getSellCodes(tenantId: string, sscc: string): Promise<BoxSellCodesDto> {
    const candidates = (await this.db
      .select({
        id: schema.boxes.id,
        shiftId: schema.boxes.shiftId,
        terminalId: schema.boxes.terminalId,
        sscc: schema.boxes.sscc,
        productId: schema.shifts.productId,
        productGtin14: schema.products.gtin14,
        productName: schema.products.name,
        closedAt: schema.boxes.closedAt,
        closureReceivedAt: schema.boxes.closureReceivedAt,
        disassembledAt: schema.boxes.disassembledAt,
        registryVersion: schema.boxes.registryVersion,
        updatedAt: schema.boxes.updatedAt,
      })
      .from(schema.boxes)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.boxes.tenantId),
          eq(schema.shifts.id, schema.boxes.shiftId),
        ),
      )
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.shifts.tenantId),
          eq(schema.products.id, schema.shifts.productId),
        ),
      )
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)))
      .limit(1)) as (BoxRegistryCandidate & { productName: string })[];

    const candidate = candidates[0];
    if (!candidate) throw new NotFoundException({ code: "box_not_found" });
    if (candidate.closedAt === null) throw new ConflictException({ code: "box_not_closed" });
    if (candidate.disassembledAt !== null)
      throw new ConflictException({ code: "box_disassembled" });

    const facts = await resolveBoxRegistryFacts(this.db, tenantId, [candidate]);
    const items = (facts.get(candidate.id) ?? [])
      .filter(
        (fact) =>
          fact.removedAt === null && fact.displacedAt === null && fact.canonicalRaw !== null,
      )
      .map((fact) => {
        const parsed = canonicalizeKm(fact.canonicalRaw!);
        return {
          codeHash: fact.codeHash,
          rawKm: fact.canonicalRaw!,
          gtin14: parsed.gtin14,
          serial: parsed.serial,
        };
      });
    if (items.length === 0) throw new ConflictException({ code: "box_empty" });

    return {
      boxId: candidate.id,
      sscc: formatSsccWithAi(sscc),
      productName: candidate.productName,
      itemCount: items.length,
      items,
    };
  }
```

3d. `apps/api/src/modules/boxes/boxes.controller.ts` — импорты + роут. ВАЖНО: статический сегмент `sell-codes` конфликтов не создаёт (в контроллере нет `:id`-роутов), но метод разместить ПЕРЕД возможными будущими параметрическими роутами; аудит — в контроллере, по образцу api-keys.controller.ts:

```ts
import { SecurityAuditService } from "../../authorization/security-audit.service";
import {
  listBoxesQuerySchema,
  sellCodesQuerySchema,
  type BoxSellCodesDto,
  type ListBoxesQueryDto,
  type ListBoxesResponseDto,
  type SellCodesQueryDto,
} from "./dto";
```

```ts
  constructor(
    private readonly boxesService: BoxesService,
    private readonly audit: SecurityAuditService,
  ) {}

  /**
   * Sell-at-register: the ONLY cabinet read that returns raw KM payloads,
   * so each successful call is audit-logged (who viewed which box's codes).
   */
  @Get("sell-codes")
  async getSellCodes(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(sellCodesQuerySchema)) query: SellCodesQueryDto,
  ): Promise<BoxSellCodesDto> {
    const result = await this.boxesService.getSellCodes(req.tenantId!, query.sscc);
    this.audit.sensitiveRead({
      tenantId: req.tenantId!,
      userId: req.userId ?? null,
      action: "boxes.sell_codes.read",
      resourceId: result.boxId,
    });
    return result;
  }
```

- [ ] **Step 4: Прогнать тест — зелёный**

Та же команда, что в Step 2. Expected: PASS, файл не skipped. Дополнительно прогнать соседний `npx vitest run boxes.e2e` — существующий листинг не сломан.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/authorization/security-audit.service.ts apps/api/src/modules/boxes apps/api/test/box-sell-codes.e2e.test.ts
git commit -m "feat(api): box sell-codes endpoint with raw KM payloads"
```

---

### Task 2: Admin — страница `boxes/sell` (ручной ввод SSCC, показ по одному)

**Files:**
- Create: `apps/admin/src/pages/boxes/sell-api.ts`
- Create: `apps/admin/src/pages/boxes/SellCode.tsx`
- Create: `apps/admin/src/pages/boxes/SellBoxPage.tsx`
- Create: `apps/admin/src/pages/boxes/sell.css`
- Modify: `apps/admin/src/app.tsx` (роут `boxes/sell`)
- Modify: `apps/admin/src/pages/boxes/index.tsx` (кнопка в PageHeader)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/box-sell.test.tsx`

**Interfaces:**
- Consumes: Task 1's `GET /boxes/sell-codes?sscc=` (`BoxSellCodesDto`); `apiFetch`/`ApiRequestError` из `../../api/client.js`; `renderDataMatrixSvg`, `parseScannedSscc`, `formatSsccHri` из `@markiro/domain`; `PageHeader`, `Alert`, `Spinner` из `@markiro/ui`.
- Produces: роут `/boxes/sell`; default-export `SellCode({ rawKm, fallbackLabel })` (lazy-чанк); `useBoxSellCodes(sscc: string | undefined): UseQueryResult<BoxSellCodesDto, Error>`; CSS-классы `mk-sell-*`. Task 3 добавит в `SellBoxPage` камеру — страница должна экспортировать точку встраивания: колбэк `handleDetected(raw: string)` (см. Step 3, он уже есть как общий обработчик сабмита).

- [ ] **Step 1: Написать падающий компонентный тест**

`apps/admin/test/box-sell.test.tsx` — паттерн из `apps/admin/test/box-card.test.tsx` (jsonResponse/stubFetch/createMemoryRouter/AccessProvider). i18n в тестах админки инициализируется глобально (см. `apps/admin/test/i18n.test.tsx` и setup-файл vitest) — assertions писать по русским строкам, как в box-card.test.tsx.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { SellBoxPage } from "../src/pages/boxes/SellBoxPage.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const SELL_CODES = {
  boxId: "b1",
  sscc: "00123456789012345675",
  productName: "Вода Кристальная 0,5",
  itemCount: 2,
  items: [
    { codeHash: "a".repeat(64), rawKm: "0104006381333931" + "21S-aa", gtin14: "04006381333931", serial: "S-aa" },
    { codeHash: "b".repeat(64), rawKm: "0104006381333931" + "21S-bb", gtin14: "04006381333931", serial: "S-bb" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubFetch(status = 200, body: unknown = SELL_CODES) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/boxes/sell-codes?")) return jsonResponse(status, body);
    return jsonResponse(404, { message: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const router = createMemoryRouter(
    createRoutesFromElements(<Route path="/boxes/sell" element={<SellBoxPage />} />),
    { initialEntries: ["/boxes/sell"] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SellBoxPage", () => {
  it("walks entry → per-code display → finish", async () => {
    stubFetch();
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    // Первый код: счётчик, продукт, серийник-подпись; DataMatrix из lazy-чанка.
    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("Вода Кристальная 0,5")).toBeTruthy();
    expect(await screen.findByText("S-aa")).toBeTruthy();

    // Назад недоступна на первом коде.
    expect(screen.getByRole("button", { name: "Назад" }).hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    expect(await screen.findByText("S-bb")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Все 2 кода показаны")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следующий короб" }));
    expect(await screen.findByLabelText("SSCC короба")).toBeTruthy();
  });

  it("rejects a malformed SSCC locally without a network call", async () => {
    const fetchMock = stubFetch();
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "12345");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Неверный SSCC — проверьте 18 цифр кода")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a per-code error message for a disassembled box", async () => {
    stubFetch(409, { code: "box_disassembled", message: "conflict" });
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Короб уже разобран — коды показать нельзя")).toBeTruthy();
  });

  it("shows 'not found' for an unknown box", async () => {
    stubFetch(404, { code: "box_not_found", message: "not found" });
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Короб не найден")).toBeTruthy();
  });
});
```

Примечание: `rawKm` в фикстуре собран конкатенацией, чтобы строка была валидным GS1-КМ для bwip-js (`01` + VALID_GTIN14 из API-тестов + `21` + serial). Если `renderDataMatrixSvg` в jsdom на нём падает — это нормальный путь `fallbackLabel`, и тест на `S-aa` всё равно проходит (подпись серийника рендерится отдельно от SVG, см. Step 3).

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --filter @markiro/admin exec vitest run box-sell
```

Expected: FAIL — `SellBoxPage` не существует (ошибка резолва импорта).

- [ ] **Step 3: Реализация**

3a. `apps/admin/src/pages/boxes/sell-api.ts`:

```ts
/**
 * Fetcher + hook for GET /boxes/sell-codes (sell-at-register view). Kept
 * separate from ./api.ts: this endpoint returns raw KM payloads and is
 * consumed only by SellBoxPage.
 */
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";

/** Mirrors `apps/api/src/modules/boxes/dto.ts`'s BoxSellCodesDto. */
export interface BoxSellCodeItemDto {
  codeHash: string;
  rawKm: string;
  gtin14: string;
  serial: string;
}

export interface BoxSellCodesDto {
  boxId: string;
  sscc: string;
  productName: string;
  itemCount: number;
  items: BoxSellCodeItemDto[];
}

export function useBoxSellCodes(sscc: string | undefined): UseQueryResult<BoxSellCodesDto> {
  return useQuery({
    queryKey: ["boxes", "sell-codes", sscc],
    queryFn: () =>
      apiFetch<BoxSellCodesDto>(`/boxes/sell-codes?${new URLSearchParams({ sscc: sscc! })}`),
    enabled: Boolean(sscc),
    // Коды короба не меняются, пока кассир листает; повторный запрос среди
    // показа только мешает (потеря сети — обычное дело у кассы).
    staleTime: Infinity,
    retry: false,
  });
}
```

3b. `apps/admin/src/pages/boxes/SellCode.tsx` — дословно по образцу `pages/pickup/ItemCode.tsx`, но крупный:

```tsx
import { renderDataMatrixSvg } from "@markiro/domain";

/**
 * Full-screen DataMatrix for the sell-at-register flow. Same contract as
 * pickup's ItemCode (default export for React.lazy, try/catch around
 * bwip-js, dangerouslySetInnerHTML of the raw <svg> string) -- see that
 * module's comment for why. Sized by the .mk-sell-code class instead of
 * inline 64px.
 */
export default function SellCode({
  rawKm,
  fallbackLabel,
}: {
  rawKm: string;
  fallbackLabel: string;
}) {
  let svg: string | null;
  try {
    svg = renderDataMatrixSvg(rawKm);
  } catch {
    svg = null;
  }

  if (!svg) {
    return <div className="mk-sell-code mk-sell-code--fallback">{fallbackLabel}</div>;
  }

  return <div className="mk-sell-code" dangerouslySetInnerHTML={{ __html: svg }} />;
}
```

3c. `apps/admin/src/pages/boxes/SellBoxPage.tsx`:

```tsx
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatSsccHri, parseScannedSscc } from "@markiro/domain";
import { Alert, PageHeader, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useBoxSellCodes } from "./sell-api.js";

import "./sell.css";

const SellCode = lazy(() => import("./SellCode.js"));

/**
 * Sell-at-register (спека 2026-08-23-box-sell-scan-design.md): кассир вводит
 * SSCC закрытого короба и листает его DataMatrix-коды по одному во весь
 * экран, чтобы касса сканировала их с телефона. Read-only: статус короба не
 * меняется. Один код на экране за раз -- сканер кассы не должен зацепить
 * соседний код.
 */
export function SellBoxPage() {
  const { t } = useTranslation();

  const [ssccInput, setSsccInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [sscc, setSscc] = useState<string | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const touchStartX = useRef<number | null>(null);

  const { data, isPending, error } = useBoxSellCodes(sscc);

  // Пока идёт показ кодов, экран телефона не должен гаснуть. Wake Lock
  // может быть недоступен (iOS < 16.4, http) -- тогда молча живём без него.
  useEffect(() => {
    if (!data || finished) return;
    let lock: { release(): Promise<void> } | null = null;
    let cancelled = false;
    navigator.wakeLock
      ?.request("screen")
      .then((sentinel) => {
        if (cancelled) void sentinel.release();
        else lock = sentinel;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void lock?.release().catch(() => {});
    };
  }, [data, finished]);

  const handleDetected = useCallback((raw: string) => {
    const parsed = parseScannedSscc(raw);
    if (parsed === null) {
      setInputError("invalidSscc");
      return;
    }
    setInputError(null);
    setIndex(0);
    setFinished(false);
    setSscc(parsed);
  }, []);

  const reset = useCallback(() => {
    setSscc(undefined);
    setSsccInput("");
    setInputError(null);
    setIndex(0);
    setFinished(false);
  }, []);

  if (sscc === undefined || (error !== null && sscc !== undefined)) {
    const errorKey =
      error instanceof ApiRequestError
        ? error.code === "box_not_found"
          ? "boxNotFound"
          : error.code === "box_disassembled"
            ? "boxDisassembled"
            : error.code === "box_empty"
              ? "boxEmpty"
              : error.code === "box_not_closed"
                ? "boxNotClosed"
                : "loadFailed"
        : error
          ? "loadFailed"
          : null;
    return (
      <div className="mk-sell">
        <PageHeader title={t("pages.boxSell.title")} />
        <form
          className="mk-sell-entry"
          onSubmit={(event) => {
            event.preventDefault();
            handleDetected(ssccInput);
          }}
        >
          <label className="mk-sell-entry__label" htmlFor="sell-sscc">
            {t("pages.boxSell.ssccLabel")}
          </label>
          <input
            id="sell-sscc"
            className="mk-sell-entry__input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="00123456789012345675"
            value={ssccInput}
            onChange={(event) => setSsccInput(event.target.value)}
          />
          <button type="submit" className="mk-sell-entry__submit">
            {t("pages.boxSell.find")}
          </button>
          {inputError !== null && (
            <Alert kind="error">{t(`pages.boxSell.errors.${inputError}`)}</Alert>
          )}
          {errorKey !== null && (
            <Alert kind="error">{t(`pages.boxSell.errors.${errorKey}`)}</Alert>
          )}
        </form>
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="mk-sell mk-sell--center">
        <Spinner />
      </div>
    );
  }

  if (finished) {
    return (
      <div className="mk-sell mk-sell--center">
        <div className="mk-sell-done">
          <div className="mk-sell-done__title">
            {t("pages.boxSell.done", { count: data.itemCount })}
          </div>
          <div className="mk-sell-done__sscc">{formatSsccHri(data.sscc)}</div>
          <button type="button" className="mk-sell-entry__submit" onClick={reset}>
            {t("pages.boxSell.nextBox")}
          </button>
        </div>
      </div>
    );
  }

  const item = data.items[index]!;
  const goPrev = () => setIndex((current) => Math.max(0, current - 1));
  const goNext = () => {
    if (index + 1 >= data.itemCount) setFinished(true);
    else setIndex((current) => current + 1);
  };
  return (
    <div
      className="mk-sell"
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        if (startX === null) return;
        const delta = (event.changedTouches[0]?.clientX ?? startX) - startX;
        // Порог 60px: короткие касания при удержании телефона у сканера не
        // должны листать код.
        if (delta <= -60) goNext();
        else if (delta >= 60) goPrev();
      }}
    >
      <div className="mk-sell-head">
        <div className="mk-sell-head__counter">{`${index + 1} / ${data.itemCount}`}</div>
        <div className="mk-sell-head__product">{data.productName}</div>
        <div className="mk-sell-head__sscc">{formatSsccHri(data.sscc)}</div>
      </div>
      <div className="mk-sell-progress">
        <div
          className="mk-sell-progress__bar"
          style={{ width: `${((index + 1) / data.itemCount) * 100}%` }}
        />
      </div>
      <div className="mk-sell-stage">
        <Suspense fallback={<Spinner />}>
          <SellCode key={item.codeHash} rawKm={item.rawKm} fallbackLabel={item.serial} />
        </Suspense>
        <div className="mk-sell-stage__serial">{item.serial}</div>
      </div>
      <div className="mk-sell-nav">
        <button
          type="button"
          className="mk-sell-nav__prev"
          disabled={index === 0}
          onClick={goPrev}
        >
          {t("pages.boxSell.prev")}
        </button>
        <button type="button" className="mk-sell-nav__next" onClick={goNext}>
          {t("pages.boxSell.next")}
        </button>
      </div>
    </div>
  );
}
```

ВАЖНО: сверить пропсы `Alert`/`Spinner` c реальным API `@markiro/ui` (посмотреть использование в `pages/boxes/index.tsx` — там `<Alert kind="error">`? Если сигнатура иная, привести к фактической). `navigator.wakeLock` типизирован в современном lib.dom; если typecheck ругается — локальный интерфейс `WakeLockSentinelLike` вместо any.

3d. `apps/admin/src/pages/boxes/sell.css` — mobile-first, крупные тач-зоны, белая сцена под DataMatrix:

```css
/* Sell-at-register: телефон в руке кассира. Крупные тач-зоны, один код на
   экран, чисто-белая сцена под DataMatrix для контраста со сканером. */
.mk-sell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 480px;
  margin: 0 auto;
  min-height: calc(100dvh - 120px);
}
.mk-sell--center {
  align-items: center;
  justify-content: center;
}
.mk-sell-entry {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mk-sell-entry__input {
  font-family: var(--font-mono, monospace);
  font-size: 18px;
  padding: 12px;
}
.mk-sell-entry__submit {
  min-height: 48px;
  font-size: 16px;
}
.mk-sell-head {
  display: grid;
  gap: 2px;
  text-align: center;
}
.mk-sell-head__counter {
  font-size: 22px;
  font-weight: 600;
}
.mk-sell-head__sscc {
  font-family: var(--font-mono, monospace);
  opacity: 0.7;
  font-size: 13px;
}
.mk-sell-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-2, #eee);
  overflow: hidden;
}
.mk-sell-progress__bar {
  height: 100%;
  background: var(--accent, #2563eb);
}
.mk-sell-stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #fff;
  border-radius: 12px;
  padding: 16px;
}
.mk-sell-code {
  width: min(78vw, 360px);
  aspect-ratio: 1;
  background: #fff;
}
.mk-sell-code svg {
  width: 100%;
  height: 100%;
}
.mk-sell-code--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono, monospace);
}
.mk-sell-stage__serial {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  color: #444;
}
.mk-sell-nav {
  display: flex;
  gap: 8px;
}
.mk-sell-nav__prev {
  flex: 1;
  min-height: 60px;
  font-size: 16px;
}
.mk-sell-nav__next {
  flex: 2;
  min-height: 60px;
  font-size: 18px;
  font-weight: 600;
}
.mk-sell-done {
  display: grid;
  gap: 16px;
  text-align: center;
}
.mk-sell-done__title {
  font-size: 20px;
  font-weight: 600;
}
.mk-sell-done__sscc {
  font-family: var(--font-mono, monospace);
  opacity: 0.7;
}
```

Перед коммитом сверить CSS-переменные (`--bg-2`, `--accent`, `--font-mono`) с реальными именами в `packages/ui/src/components.css` и заменить на фактические токены проекта; кнопкам задать существующий базовый класс кнопки из `@markiro/ui` (посмотреть, каким классом рендерятся кнопки на страницах, например в conflicts/boxes), а не изобретать свой.

3e. i18n — в `apps/admin/src/i18n/ru.json` под `pages` добавить:

```json
"boxSell": {
  "title": "Продажа коробом",
  "ssccLabel": "SSCC короба",
  "find": "Найти короб",
  "prev": "Назад",
  "next": "Далее",
  "done_one": "Все {{count}} код показаны",
  "done_few": "Все {{count}} кода показаны",
  "done_many": "Все {{count}} кодов показаны",
  "nextBox": "Следующий короб",
  "openScanner": "Сканировать этикетку",
  "closeScanner": "Закрыть камеру",
  "errors": {
    "invalidSscc": "Неверный SSCC — проверьте 18 цифр кода",
    "boxNotFound": "Короб не найден",
    "boxDisassembled": "Короб уже разобран — коды показать нельзя",
    "boxEmpty": "В коробе нет активных кодов",
    "boxNotClosed": "Короб ещё не закрыт на линии",
    "loadFailed": "Не удалось загрузить короб — проверьте связь и повторите",
    "cameraFailed": "Камера недоступна — введите SSCC вручную"
  }
}
```

и в `en.json` английские аналоги (`"done_one": "All {{count}} code shown"`, `"done_other": "All {{count}} codes shown"` и т.д.). Формы плюрализации сверить с тем, как уже сделаны count-ключи в ru.json (поискать `_many` в файле; если проект использует другой стиль — повторить его).

3f. `apps/admin/src/app.tsx` — импорт и роут (рядом с роутом `boxes`):

```tsx
import { SellBoxPage } from "./pages/boxes/SellBoxPage.js";
```

```tsx
        <Route
          path="boxes/sell"
          element={
            <RequireCapability capability={C.OPERATIONS_READ}>
              <SellBoxPage />
            </RequireCapability>
          }
        />
```

3g. `apps/admin/src/pages/boxes/index.tsx` — кнопка-ссылка в шапке:

```tsx
import { Link } from "react-router";
```

```tsx
      <PageHeader
        title={t("pages.boxes.title")}
        actions={
          <Link className="mk-button" to="/boxes/sell">
            {t("pages.boxSell.title")}
          </Link>
        }
      />
```

(класс `mk-button` заменить на фактический класс кнопки/ссылки-кнопки из `@markiro/ui`, как в 3d.)

- [ ] **Step 4: Прогнать тесты — зелёные**

```bash
pnpm --filter @markiro/admin exec vitest run box-sell
pnpm --filter @markiro/admin exec vitest run boxes access-routing
```

Expected: PASS все. `access-routing` ловит регрессии в таблице роутов.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/boxes apps/admin/src/app.tsx apps/admin/src/i18n apps/admin/test/box-sell.test.tsx
git commit -m "feat(admin): mobile box sell-codes page"
```

---

### Task 3: Admin — сканирование SSCC камерой (BarcodeDetector + zxing-фолбэк)

**Files:**
- Create: `apps/admin/src/pages/boxes/SsccScanner.tsx`
- Modify: `apps/admin/src/pages/boxes/SellBoxPage.tsx` (кнопка «Сканировать этикетку», lazy-подключение)
- Modify: `apps/admin/src/pages/boxes/sell.css` (блок камеры)
- Modify: `apps/admin/package.json` (`@zxing/browser` + `@zxing/library`)
- Test: `apps/admin/test/box-sell.test.tsx` (дополнить)

**Interfaces:**
- Consumes: Task 2's `handleDetected(raw: string)`; `parseScannedSscc` (валидация уже внутри `handleDetected`).
- Produces: default-export `SsccScanner({ onDetected, onError }: { onDetected: (raw: string) => void; onError: () => void })` — рендерит `<video>`, зовёт `onDetected` с сырой строкой штрихкода, `onError` при отказе камеры/библиотеки; сам останавливает треки на unmount.

- [ ] **Step 1: Дополнить тест (jsdom без камеры)**

В `apps/admin/test/box-sell.test.tsx` добавить:

```tsx
  it("hides the camera button when mediaDevices is unavailable (jsdom)", () => {
    stubFetch();
    renderPage();
    expect(screen.queryByRole("button", { name: "Сканировать этикетку" })).toBeNull();
  });

  it("shows the camera button when mediaDevices exists", () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn() },
    });
    stubFetch();
    renderPage();
    expect(screen.getByRole("button", { name: "Сканировать этикетку" })).toBeTruthy();
  });
```

- [ ] **Step 2: Убедиться, что новые тесты падают**

```bash
pnpm --filter @markiro/admin exec vitest run box-sell
```

Expected: FAIL — кнопки «Сканировать этикетку» нет вовсе (первый новый тест пройдёт, второй упадёт).

- [ ] **Step 3: Реализация**

3a. Зависимость:

```bash
pnpm --filter @markiro/admin add @zxing/browser @zxing/library
```

(pnpm в репо пишет точные версии — `saveExact`; если install упрётся в карантин `minimumReleaseAge` — взять версию старше 7 дней, НЕ добавлять exclude.)

3b. `apps/admin/src/pages/boxes/SsccScanner.tsx`:

```tsx
import { useEffect, useRef } from "react";

/**
 * Camera SSCC scanner, lazy-loaded (default export) so neither camera glue
 * nor the zxing fallback reaches the main bundle. Native BarcodeDetector
 * (Android Chrome) is preferred; iOS Safari has no BarcodeDetector, so
 * @zxing/browser decodes frames from the same <video> element there.
 * Detection is throttled by requestAnimationFrame-loop (native) or zxing's
 * own callback; the FIRST successful decode wins -- parent validates via
 * parseScannedSscc and может показать ошибку, не закрывая камеру.
 */
export default function SsccScanner({
  onDetected,
  onError,
}: {
  onDetected: (raw: string) => void;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onErrorRef = useRef(onError);
  onDetectedRef.current = onDetected;
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let stopZxing: (() => void) | null = null;
    let rafId = 0;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video!.srcObject = stream;
        await video!.play();

        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (options: { formats: string[] }) => {
              detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;

        if (DetectorCtor) {
          const detector = new DetectorCtor({ formats: ["code_128"] });
          const tick = async () => {
            if (stopped) return;
            try {
              const found = await detector.detect(video!);
              if (found.length > 0) {
                onDetectedRef.current(found[0]!.rawValue);
                return;
              }
            } catch {
              // одиночный сбой кадра -- продолжаем
            }
            rafId = requestAnimationFrame(() => void tick());
          };
          rafId = requestAnimationFrame(() => void tick());
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          if (stopped) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoElement(video!, (result) => {
            if (result && !stopped) onDetectedRef.current(result.getText());
          });
          stopZxing = () => controls.stop();
        }
      } catch {
        if (!stopped) onErrorRef.current();
      }
    }

    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      stopZxing?.();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return <video ref={videoRef} className="mk-sell-scanner__video" muted playsInline />;
}
```

Сверить фактический API `@zxing/browser` (имя `decodeFromVideoElement` и форма `IScannerControls`) с установленной версией — при расхождении привести к реальной сигнатуре.

3c. `SellBoxPage.tsx` — на экране ввода добавить состояние `scanning` и кнопку (только при `navigator.mediaDevices`):

```tsx
const SsccScanner = lazy(() => import("./SsccScanner.js"));
```

внутри компонента:

```tsx
  const [scanning, setScanning] = useState(false);
  const cameraAvailable = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices);
```

в форму экрана ввода, над полем SSCC:

```tsx
          {cameraAvailable && !scanning && (
            <button
              type="button"
              className="mk-sell-entry__submit"
              onClick={() => setScanning(true)}
            >
              {t("pages.boxSell.openScanner")}
            </button>
          )}
          {scanning && (
            <div className="mk-sell-scanner">
              <Suspense fallback={<Spinner />}>
                <SsccScanner
                  onDetected={(raw) => {
                    setScanning(false);
                    handleDetected(raw);
                  }}
                  onError={() => {
                    setScanning(false);
                    setInputError("cameraFailed");
                  }}
                />
              </Suspense>
              <button type="button" onClick={() => setScanning(false)}>
                {t("pages.boxSell.closeScanner")}
              </button>
            </div>
          )}
```

При успешном `handleDetected` с невалидной строкой камера уже закрыта и показана ошибка `invalidSscc` — приемлемо: кассир жмёт «Сканировать» ещё раз.

3d. `sell.css` добавить:

```css
.mk-sell-scanner {
  display: grid;
  gap: 8px;
}
.mk-sell-scanner__video {
  width: 100%;
  border-radius: 12px;
  background: #000;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}
```

- [ ] **Step 4: Прогнать тесты — зелёные**

```bash
pnpm --filter @markiro/admin exec vitest run box-sell
```

Expected: PASS все (включая оба новых).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/boxes apps/admin/package.json pnpm-lock.yaml apps/admin/test/box-sell.test.tsx
git commit -m "feat(admin): camera SSCC scanner for box sell flow"
```

---

### Task 4: Финальная проверка — гейты, браузерный смоук, graphify

**Files:**
- Modify: возможные точечные фиксы по результатам гейтов.

- [ ] **Step 1: Полный гейт**

```bash
pnpm turbo lint typecheck test build --concurrency=1
pnpm format:check
```

Expected: зелёно. Для API e2e проверить счётчик skipped (см. Global Constraints) — прогон без окружения «зелёный, но пустой» не считается.

- [ ] **Step 2: Браузерный смоук в мобильном вьюпорте**

Поднять admin dev-сервер через preview-инструменты (launch.json), API — с `NODE_ENV=test` и env из Global Constraints; создать пользователя по рецепту gotcha-12 (sign-up → organization/create → логин в UI, заполнить профиль). Открыть `/boxes/sell` в мобильном вьюпорте (375×812): проверить ввод SSCC (можно фиктивный валидный — увидеть «Короб не найден»), и при наличии данных — показ кода, крупные кнопки, прогресс. Скриншот приложить в итоговый отчёт. Камеру в headless-браузере не проверяем — достаточно, что кнопка скрыта/показана по feature-detect.

- [ ] **Step 3: graphify + commit остатков**

```bash
ls graphify-out/graph.json 2>/dev/null && graphify update .
git status --short
```

Закоммитить фиксы, если были:

```bash
git add -A && git commit -m "chore: post-gate fixes for box sell flow"
```
