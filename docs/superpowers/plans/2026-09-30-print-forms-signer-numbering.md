# Печатные формы: номер КП, подпись с расшифровкой, новая вкладка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** КП получает сквозной номер `MRK-CO-NNNNNN`, документы с подписью и печатью показывают «И. О. Фамилия» из контакта организации и ставят печать в правый слот, а HTML/PDF КП открываются в новой вкладке.

**Architecture:** Три независимые правки. (1) Общая функция `openDocumentInNewTab` в saas-admin, на неё переходят страницы КП, счёта и акта. (2) Чистая функция `nextOfferNumber` и запрос максимального номера внутри `publish` под уже существующей глобальной блокировкой. (3) Чистые функции `formatSignerName` и `signaturePlan` в `print-document-layout.ts` решают, что печатать, а два рендерера (HTML и react-pdf) только рисуют по этому плану.

**Tech Stack:** TypeScript strict (NestJS, Drizzle, React, react-i18next), Vitest, `@react-pdf/renderer` 4.6.1, pnpm/turbo.

Спека: `docs/superpowers/specs/2026-09-30-print-forms-signer-numbering-design.md`. Читать её целиком перед началом.

## Global Constraints

- Номер КП: `MRK-CO-` плюс шесть цифр, без года; следующий = максимальный существующий `MRK-CO-<цифры>` + 1; счётчик начинается с `MRK-CO-000001`.
- Уже опубликованные `KP-…` не переименовываются и в счётчике не участвуют. Запасной номер `KP-<год>-<uuid8>` удаляется. Миграции БД нет.
- Подпись/печать/расшифровка только в варианте `printVariant: "signed"` и только для продавца с ИНН `SIGNED_PRINT_SELLER_TAX_ID`; эта проверка (`resolvePrintVariant`) остаётся как есть. Чистый вариант (пустая линия, пунктирное «МЕСТО ДЛЯ ПЕЧАТИ») не меняется.
- ФИО берётся из `seller.contact.name` замороженного слепка продавца («Наша организация → Контакт для документов → Контактное лицо»). Форматы: три слова → «И. О. Фамилия»; два слова → «И. Фамилия»; составное имя → инициалы через дефис («А.-М.»); пусто/`null` → линия остаётся пустой; одно слово или больше трёх слов → как введено (пробелы схлопываются).
- Печать: КП и счёт — в правом слоте 31 мм (без пунктирной рамки и надписи); акт — у правого края колонки исполнителя. Подпись лежит на поле подписи, ФИО стоит после косой черты.
- Правка одинаково в HTML (`print-document-html.ts`) и в PDF (`print-document-pdf.tsx`).
- HTML/PDF в saas-admin открываются в новой вкладке: пустая вкладка открывается синхронно в обработчике клика, `opener = null`, после ответа `location.replace(url)`, при ошибке вкладка закрывается, при блокировке — сообщение. Кабинет тенанта (`apps/admin`) не трогаем.
- Нет нового поля профиля продавца, нет проверки соответствия ФИО и картинки подписи, не трогаем соглашения (`platform-agreements`).
- Репозиторий: TS strict с `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`, без `any` и `!`; `import type` для типов; видимый текст только через i18n (ru и en); Prettier; в конце commit-сообщения строка `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Не переписывать сохранённые документы и слепки. Существующие тесты не ослаблять.

**Окружение (песочница Claude Code).** Перед каждой командой `pnpm` задавать `pnpm_config_verify_deps_before_run=false`, иначе pnpm начнёт переустановку и сотрёт `node_modules`. Все примеры ниже даны с этой переменной. Локальный `git` вызывать как `/usr/bin/git`. В свежем worktree один раз собрать зависимости: `pnpm_config_verify_deps_before_run=false pnpm turbo run build --filter='@markiro/api^...' --filter='@markiro/saas-admin^...'`.

## Карта файлов

| Файл                                                                                                   | Ответственность                                                      |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/saas-admin/src/pages/documents/openDocumentInNewTab.ts` (новый)                                  | открыть подписанную ссылку в новой вкладке, не уводя текущую         |
| `apps/saas-admin/src/pages/offers/OfferDocuments.tsx`                                                  | КП: кнопки HTML/PDF через общую функцию, сообщение о блокировке      |
| `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx`, `.../billing-acts/BillingActDetailPage.tsx` | те же кнопки через общую функцию, поведение прежнее                  |
| `apps/api/src/modules/platform-offers/offer-number.ts` (новый)                                         | `nextOfferNumber`: следующий `MRK-CO-NNNNNN`                         |
| `apps/api/src/modules/platform-offers/platform-offers.service.ts`                                      | `publish`: номер по счётчику, без запасного uuid                     |
| `apps/api/src/modules/billing/print-document-layout.ts`                                                | `formatSignerName`, `signaturePlan` — что печатать в подписном блоке |
| `apps/api/src/modules/billing/print-document-html.ts`                                                  | подписной блок и CSS для HTML                                        |
| `apps/api/src/modules/billing/print-document-pdf.tsx`                                                  | подписной блок и стили для PDF                                       |

---

### Task 0: Зафиксировать спеку и план

**Files:**

- Add: `docs/superpowers/specs/2026-09-30-print-forms-signer-numbering-design.md`
- Add: `docs/superpowers/plans/2026-09-30-print-forms-signer-numbering.md`

- [ ] **Step 1: Проверить, что ветка правильная**

Run: `/usr/bin/git rev-parse --abbrev-ref HEAD && /usr/bin/git status --short`
Expected: `claude/print-forms-signer-numbering` и две строки `??` для этих двух файлов.

- [ ] **Step 2: Прогнать Prettier**

Run: `pnpm_config_verify_deps_before_run=false pnpm exec prettier --check docs/superpowers/specs/2026-09-30-print-forms-signer-numbering-design.md docs/superpowers/plans/2026-09-30-print-forms-signer-numbering.md`
Expected: `All matched files use Prettier code style!` (если нет — `--write` и повторить).

- [ ] **Step 3: Commit**

```bash
/usr/bin/git add docs/superpowers/specs/2026-09-30-print-forms-signer-numbering-design.md docs/superpowers/plans/2026-09-30-print-forms-signer-numbering.md
/usr/bin/git commit -m "docs: spec and plan for offer numbering, signer name and new-tab documents" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 1: HTML/PDF в новой вкладке (КП, счёт, акт)

**Files:**

- Create: `apps/saas-admin/src/pages/documents/openDocumentInNewTab.ts`
- Create: `apps/saas-admin/test/open-document-in-new-tab.test.ts`
- Modify: `apps/saas-admin/src/pages/offers/OfferDocuments.tsx:53-56` и кнопка на строках 98-109
- Modify: `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx:262-274`
- Modify: `apps/saas-admin/src/pages/billing-acts/BillingActDetailPage.tsx:56-68`
- Modify: `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json` (блок `offerWorkspace`, рядом с `htmlHint`, строка 102)
- Test: `apps/saas-admin/test/offers-workspace.test.tsx`

**Interfaces:**

- Produces: `openDocumentInNewTab(getUrl: () => Promise<string>): boolean` — `false`, если браузер заблокировал вкладку (тогда `getUrl` не вызывается); иначе `true`, а вкладка закроется сама при ошибке `getUrl`.

- [ ] **Step 1: Написать падающий тест общей функции**

Создать `apps/saas-admin/test/open-document-in-new-tab.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDocumentInNewTab } from "../src/pages/documents/openDocumentInNewTab.js";

const newTab = () => ({ opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe("openDocumentInNewTab", () => {
  it("opens the tab before the URL is known and navigates it afterwards", async () => {
    const target = newTab();
    const open = vi.fn().mockReturnValue(target);
    vi.stubGlobal("open", open);
    let resolveUrl: (url: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });

    expect(openDocumentInNewTab(() => pending)).toBe(true);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(target.opener).toBeNull();
    expect(target.location.replace).not.toHaveBeenCalled();

    resolveUrl("https://objects.example.test/doc.pdf");
    await vi.waitFor(() =>
      expect(target.location.replace).toHaveBeenCalledWith("https://objects.example.test/doc.pdf"),
    );
    expect(target.close).not.toHaveBeenCalled();
  });

  it("closes the blank tab when the URL cannot be obtained", async () => {
    const target = newTab();
    vi.stubGlobal("open", vi.fn().mockReturnValue(target));

    expect(openDocumentInNewTab(() => Promise.reject(new Error("unavailable")))).toBe(true);

    await vi.waitFor(() => expect(target.close).toHaveBeenCalledOnce());
    expect(target.location.replace).not.toHaveBeenCalled();
  });

  it("reports a blocked tab without requesting the URL", () => {
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    const getUrl = vi.fn(() => Promise.resolve("https://objects.example.test/doc.pdf"));

    expect(openDocumentInNewTab(getUrl)).toBe(false);
    expect(getUrl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin exec vitest run test/open-document-in-new-tab.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pages/documents/openDocumentInNewTab.js"`.

- [ ] **Step 3: Написать функцию**

Создать `apps/saas-admin/src/pages/documents/openDocumentInNewTab.ts`:

```ts
/**
 * Opens a print form in a new tab without navigating the current page.
 *
 * The blank tab has to be opened synchronously inside the click handler: after an
 * `await` the browser treats `window.open` as a pop-up and blocks it. Returns
 * `false` when the browser blocked the tab (the URL is then never requested).
 */
export function openDocumentInNewTab(getUrl: () => Promise<string>): boolean {
  const target = window.open("about:blank", "_blank");
  if (!target) return false;
  target.opener = null;
  void getUrl()
    .then((url) => target.location.replace(url))
    .catch(() => target.close());
  return true;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin exec vitest run test/open-document-in-new-tab.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Добавить маршрут скачивания в стенд КП и два падающих теста**

В `apps/saas-admin/test/offers-workspace.test.tsx`, внутри `install(...)`, сразу перед строкой `if (path.endsWith("/documents") && method === "POST")` (около строки 233) добавить:

```tsx
if (path.endsWith("/download"))
  return jsonResponse(200, { url: "https://objects.example.test/offers/document.html" });
```

Внутри `describe("offers workspace", ...)` сразу перед тестом `it("shows server names, saved line summary, localized money and server count without row detail requests", ...)` вставить:

```tsx
function publishedWithReadyHtml() {
  const data = workspace();
  data.offer = {
    ...data.offer,
    status: "published",
    number: "MRK-CO-000001",
    publishedAt: NOW,
    publishedByPlatformUserId: "platform-accountant",
    paidAt: null,
  };
  data.actions = { ...data.actions, publish: false };
  data.documents = [
    {
      id: ID,
      revision: 2,
      format: "html",
      printVariant: "clean",
      status: "ready",
      contentType: "text/html",
      byteSize: 1200,
      sha256: fingerprint,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  return data;
}

it("opens a ready offer document in a new tab and leaves the offer page in place", async () => {
  install(publishedWithReadyHtml());
  const target = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.fn().mockReturnValue(target);
  vi.stubGlobal("open", open);
  const user = userEvent.setup();
  renderSaasApp({ initialEntry: `/offers/${ID}` });

  await user.click(await screen.findByRole("button", { name: "Открыть HTML" }));

  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  await waitFor(() =>
    expect(target.location.replace).toHaveBeenCalledWith(
      "https://objects.example.test/offers/document.html",
    ),
  );
  expect(target.opener).toBeNull();
  expect(screen.getByRole("button", { name: "Открыть HTML" })).toBeDefined();
});

it("reports a blocked offer document tab", async () => {
  install(publishedWithReadyHtml());
  vi.stubGlobal(
    "open",
    vi.fn(() => null),
  );
  const user = userEvent.setup();
  renderSaasApp({ initialEntry: `/offers/${ID}` });

  await user.click(await screen.findByRole("button", { name: "Открыть HTML" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Браузер заблокировал открытие печатной формы",
  );
});
```

- [ ] **Step 6: Убедиться, что оба теста падают**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin exec vitest run test/offers-workspace.test.tsx -t "offer document"`
Expected: FAIL. Первый — `open` не вызывался (страница КП идёт через `window.location.assign`), второй — нет `alert`.

- [ ] **Step 7: Добавить текст сообщения в оба языка**

В `apps/saas-admin/src/i18n/ru.json` в блоке `offerWorkspace` после строки `"htmlHint": "Готовый HTML можно распечатать средствами браузера.",` добавить:

```json
    "popupBlocked": "Браузер заблокировал открытие печатной формы. Разрешите всплывающие окна и повторите.",
```

В `apps/saas-admin/src/i18n/en.json` после `"htmlHint": "Ready HTML can be printed using the browser.",` добавить:

```json
    "popupBlocked": "The browser blocked the print form. Allow pop-ups and try again.",
```

- [ ] **Step 8: Перевести страницу КП на общую функцию**

В `apps/saas-admin/src/pages/offers/OfferDocuments.tsx` добавить импорт рядом с остальными относительными:

```tsx
import { openDocumentInNewTab } from "../documents/openDocumentInNewTab.js";
```

Заменить блок

```tsx
const download = useMutation({
  mutationFn: (id: string) => downloadOfferDocument(workspace.offer.id, id),
  onSuccess: ({ url }) => window.location.assign(url),
});
```

на

```tsx
const [popupBlocked, setPopupBlocked] = useState(false);
const download = useMutation({
  mutationFn: (id: string) => downloadOfferDocument(workspace.offer.id, id),
});
const openDocument = (id: string) => {
  setPopupBlocked(false);
  const opened = openDocumentInNewTab(() => download.mutateAsync(id).then(({ url }) => url));
  if (!opened) setPopupBlocked(true);
};
```

Кнопку `onClick={() => download.mutate(item.id)}` заменить на `onClick={() => openDocument(item.id)}`.

Сразу после существующего блока `{documents.error || generate.error || download.error ? ( ... ) : null}` добавить:

```tsx
{
  popupBlocked ? <Alert tone="error">{t("offerWorkspace.popupBlocked")}</Alert> : null;
}
```

- [ ] **Step 9: Перевести счёт и акт на ту же функцию**

В `apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx` добавить импорт `import { openDocumentInNewTab } from "../documents/openDocumentInNewTab.js";` и заменить функцию (строки 262-274) на

```tsx
const openDocument = (documentId: string) => {
  setDownloadBlocked(false);
  const opened = openDocumentInNewTab(() =>
    downloadDocument.mutateAsync(documentId).then(({ url }) => url),
  );
  if (!opened) setDownloadBlocked(true);
};
```

В `apps/saas-admin/src/pages/billing-acts/BillingActDetailPage.tsx` добавить тот же импорт и заменить функцию (строки 56-68) на тот же код.

- [ ] **Step 10: Прогнать тесты КП, счёта и акта**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin exec vitest run test/open-document-in-new-tab.test.ts test/offers-workspace.test.tsx test/billing-flow.test.tsx test/billing-acts-workflow.test.tsx`
Expected: PASS во всех четырёх файлах, включая прежние тесты счёта и акта («opens their signed download URLs», «reports a blocked print-form window», «keeps both document targets…»).

- [ ] **Step 11: Гейты пакета**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin lint && pnpm_config_verify_deps_before_run=false pnpm exec prettier --check apps/saas-admin/src apps/saas-admin/test`
Expected: без ошибок.

- [ ] **Step 12: Commit**

```bash
/usr/bin/git add apps/saas-admin/src/pages/documents/openDocumentInNewTab.ts apps/saas-admin/src/pages/offers/OfferDocuments.tsx apps/saas-admin/src/pages/billing/InvoiceDetailPage.tsx apps/saas-admin/src/pages/billing-acts/BillingActDetailPage.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/open-document-in-new-tab.test.ts apps/saas-admin/test/offers-workspace.test.tsx
/usr/bin/git commit -m "fix(saas-admin): open offer HTML and PDF in a new tab" -m "The offer page navigated the current tab with window.location.assign. It now uses the same blank-tab-first pattern as invoices and acts, extracted into openDocumentInNewTab and shared by all three pages, with a message when the browser blocks the tab." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Номер КП `MRK-CO-NNNNNN`

**Files:**

- Create: `apps/api/src/modules/platform-offers/offer-number.ts`
- Create: `apps/api/test/offer-number.test.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts` (импорт на строке 10; `publish`, строки 203-221 и 260-265)
- Test: `apps/api/test/catalog-sales-without-lifecycle-policy.test.ts:217`

**Interfaces:**

- Produces: `nextOfferNumber(last: string | null | undefined): string` — следующий номер после `last`; `last`, не похожий на `MRK-CO-<цифры>`, считается отсутствием номера.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/offer-number.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { nextOfferNumber } from "../src/modules/platform-offers/offer-number";

describe("nextOfferNumber", () => {
  it.each([
    [undefined, "MRK-CO-000001"],
    [null, "MRK-CO-000001"],
    ["MRK-CO-000001", "MRK-CO-000002"],
    ["MRK-CO-000041", "MRK-CO-000042"],
    ["MRK-CO-000009", "MRK-CO-000010"],
    ["MRK-CO-999999", "MRK-CO-1000000"],
  ])("follows %s with %s", (last, next) => {
    expect(nextOfferNumber(last)).toBe(next);
  });

  it("starts a fresh counter after numbers of the previous format", () => {
    expect(nextOfferNumber("KP-2026-000007")).toBe("MRK-CO-000001");
    expect(nextOfferNumber("KP-2026-3F8A12BC")).toBe("MRK-CO-000001");
    expect(nextOfferNumber("MRK-CO-12AB")).toBe("MRK-CO-000001");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/offer-number.test.ts`
Expected: FAIL — не найден модуль `offer-number`.

- [ ] **Step 3: Написать функцию**

Создать `apps/api/src/modules/platform-offers/offer-number.ts`:

```ts
const OFFER_NUMBER = /^MRK-CO-([0-9]+)$/;

/** The number that follows `last` in the global commercial-offer sequence (`MRK-CO-000001`, …). */
export function nextOfferNumber(last: string | null | undefined): string {
  const digits = last?.match(OFFER_NUMBER)?.[1] ?? "0";
  return `MRK-CO-${(BigInt(digits) + 1n).toString().padStart(6, "0")}`;
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/offer-number.test.ts`
Expected: PASS, 9 проверок.

- [ ] **Step 5: Дописать проверку формата в существующий тест публикации с БД**

В `apps/api/test/catalog-sales-without-lifecycle-policy.test.ts` строку

```ts
expect((await offers.publish(actor, offer.id, undefined, 3)).status).toBe("published");
```

заменить на

```ts
expect((await offers.publish(actor, offer.id, undefined, 3)).status).toBe("published");
const [stored] = await db
  .select({ number: schema.commercialOffers.number })
  .from(schema.commercialOffers)
  .where(eq(schema.commercialOffers.id, offer.id));
expect(stored?.number).toMatch(/^MRK-CO-\d{6,}$/);
```

- [ ] **Step 6: Поднять одноразовую БД и убедиться, что тест падает на старой публикации**

Тест ходит в Postgres, поэтому команды ниже выполнять с отключённой песочницей (нужны docker и сокеты). Переменные окружения для API брать из джобы `verify-api-tests` в `.github/workflows/ci.yml` (там же генерируется тестовый `CHZ_TOKEN_ENCRYPTION_KEY`).

```bash
docker run -d --name markiro-print-postgres -e POSTGRES_USER=markiro -e POSTGRES_PASSWORD=markiro -e POSTGRES_DB=markiro -p 127.0.0.1:55434:5432 postgres:16-alpine
DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55434/markiro pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/db db:migrate
```

Затем запустить тест с окружением из `ci.yml` и `DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55434/markiro`:

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/catalog-sales-without-lifecycle-policy.test.ts`
Expected: FAIL — `expected 'KP-2026-000001' to match /^MRK-CO-\d{6,}$/`.

- [ ] **Step 7: Перевести `publish` на счётчик**

В `apps/api/src/modules/platform-offers/platform-offers.service.ts`:

1. Строка 10: `import { and, asc, desc, eq } from "drizzle-orm";` → `import { and, asc, desc, eq, sql } from "drizzle-orm";`. Рядом с локальными импортами (после `./platform-offer-draft`) добавить `import { nextOfferNumber } from "./offer-number";`.

2. В выборке `located` (строки 203-211) удалить строку `revision: schema.commercialOffers.revision,` — она больше не нужна.

3. Заменить строки 213-221:

```ts
const offerYear = new Date().getFullYear();
const primaryNumber = `KP-${offerYear}-${located.revision.toString().padStart(6, "0")}`;
const fallbackNumber = `KP-${offerYear}-${canonicalOfferId.slice(0, 8).toUpperCase()}`;
await acquireBillingWorkflowLocks(tx, located.tenantId, [
  { kind: "offer_family", id: located.familyId },
  { kind: "offer", id: canonicalOfferId },
  { kind: "offer_number", id: primaryNumber },
  { kind: "offer_number", id: fallbackNumber },
]);
```

на

```ts
await acquireBillingWorkflowLocks(tx, located.tenantId, [
  { kind: "offer_family", id: located.familyId },
  { kind: "offer", id: canonicalOfferId },
]);
```

(глобальная блокировка `lockSellerPolicy(tx)` на строке 202 уже сериализует все публикации, поэтому отдельные блокировки по строке номера не нужны.)

4. Заменить строки 260-265:

```ts
const [latest] = await tx
  .select({ number: schema.commercialOffers.number })
  .from(schema.commercialOffers)
  .where(eq(schema.commercialOffers.number, primaryNumber))
  .limit(1);
const number = latest ? fallbackNumber : primaryNumber;
```

на

```ts
const numberSuffix = sql<string>`coalesce(
        nullif(ltrim(substring(${schema.commercialOffers.number} from 8), '0'), ''),
        '0'
      )`;
const [latest] = await tx
  .select({ number: schema.commercialOffers.number })
  .from(schema.commercialOffers)
  .where(sql`${schema.commercialOffers.number} ~ '^MRK-CO-[0-9]+$'`)
  .orderBy(desc(sql`length(${numberSuffix})`), desc(sql`${numberSuffix} collate "C"`))
  .limit(1);
const number = nextOfferNumber(latest?.number);
```

`substring(... from 8)` отбрасывает `MRK-CO-` (7 символов); порядок «длина, затем значение» даёт настоящий максимум и после `999999`.

- [ ] **Step 8: Убедиться, что тесты проходят**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/offer-number.test.ts test/catalog-sales-without-lifecycle-policy.test.ts test/billing-workflow-locks.test.ts test/platform-offers.service.test.ts`
Expected: PASS (с тем же `DATABASE_URL` и окружением, что в шаге 6). Если какой-то из тестов с БД ссылается на `KP-` как на результат публикации, поправить ожидание на `MRK-CO-`; тесты, которые сами вставляют `KP-…` строки в БД, не трогать.

- [ ] **Step 9: Гейты пакета и уборка**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api lint`
Expected: без ошибок.

Run: `docker rm -f markiro-print-postgres` (после Task 6, если контейнер нужен для полного прогона API; иначе сейчас).

- [ ] **Step 10: Commit**

```bash
/usr/bin/git add apps/api/src/modules/platform-offers/offer-number.ts apps/api/src/modules/platform-offers/platform-offers.service.ts apps/api/test/offer-number.test.ts apps/api/test/catalog-sales-without-lifecycle-policy.test.ts
/usr/bin/git commit -m "feat(offers): number commercial offers MRK-CO-NNNNNN from a global counter" -m "The number used to be KP-<year>-<family revision>, which is not a global counter: the second client's first offer collided with the first client's and silently fell back to a uuid-based number. Publishing now takes max(existing MRK-CO number)+1 under the existing global seller-policy lock, like invoices. Published KP-... numbers are left as they are." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Правила подписного блока (`formatSignerName`, `signaturePlan`)

**Files:**

- Modify: `apps/api/src/modules/billing/print-document-layout.ts` (добавить после `resolvePrintVariant`, строка 22)
- Create: `apps/api/test/print-signature-plan.test.ts`

**Interfaces:**

- Produces:
  - `formatSignerName(value: unknown): string | null`
  - `type SealPlacement = "none" | "slot" | "column"`
  - `interface SignaturePlan { signed: boolean; signerName: string | null; seal: SealPlacement }`
  - `signaturePlan(model: PrintDocumentModel, variant: PrintDocumentVariant): SignaturePlan` — чистый вариант даёт `{ signed: false, signerName: null, seal: "none" }`; подписанный — `signed: true`, имя из `model.seller.contact.name`, печать `"column"` для акта и `"slot"` для КП и счёта.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/api/test/print-signature-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatSignerName, signaturePlan } from "../src/modules/billing/print-document-layout";
import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";

const model = (kind: PrintDocumentModel["kind"], contact: unknown): PrintDocumentModel => ({
  kind,
  number: "MRK-CO-000001",
  status: "published",
  issuedOrPublishedAt: new Date("2026-09-30T00:00:00.000Z"),
  dueOrExpiresAt: null,
  seller: { legalName: "ИП Богатырев Владислав Сергеевич", taxId: "234106228141", contact },
  buyer: { legalName: "ООО Покупатель" },
  lines: [],
  subtotal: "0.00",
  vatTotal: "0.00",
  total: "0.00",
  termsHtml: null,
});

describe("formatSignerName", () => {
  it.each([
    ["Богатырев Владислав Сергеевич", "В. С. Богатырев"],
    ["  Богатырев   Владислав   Сергеевич  ", "В. С. Богатырев"],
    ["Богатырёв Владислав Сергеевич", "В. С. Богатырёв"],
    ["Иванов Иван", "И. Иванов"],
    ["Иванова Анна-Мария Сергеевна", "А.-М. С. Иванова"],
    ["Иванов-Петров Иван Сергеевич", "И. С. Иванов-Петров"],
    ["Иванов", "Иванов"],
    ["Иванов Иван Иванович оглы", "Иванов Иван Иванович оглы"],
    ["Иванов   Иван   Иванович   оглы", "Иванов Иван Иванович оглы"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatSignerName(input)).toBe(expected);
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}]])("prints nothing for %j", (input) => {
    expect(formatSignerName(input)).toBeNull();
  });
});

describe("signaturePlan", () => {
  const contact = { name: "Богатырев Владислав Сергеевич", email: null, phone: null };

  it("plans nothing for the clean variant, even when the contact has a name", () => {
    expect(signaturePlan(model("offer", contact), "clean")).toEqual({
      signed: false,
      signerName: null,
      seal: "none",
    });
  });

  it.each(["offer", "invoice"] as const)(
    "signs a %s with the contact name and a seal in the right slot",
    (kind) => {
      expect(signaturePlan(model(kind, contact), "signed")).toEqual({
        signed: true,
        signerName: "В. С. Богатырев",
        seal: "slot",
      });
    },
  );

  it("puts the seal at the edge of the executor column on an act", () => {
    expect(signaturePlan(model("act", contact), "signed")).toEqual({
      signed: true,
      signerName: "В. С. Богатырев",
      seal: "column",
    });
  });

  it.each([
    [{ name: null, email: null, phone: null }],
    [{ name: "  ", email: null, phone: null }],
    [null],
    [undefined],
    ["Богатырев Владислав Сергеевич"],
  ])("leaves the name blank when the frozen contact is %j", (unusable) => {
    expect(signaturePlan(model("offer", unusable), "signed").signerName).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-plan.test.ts`
Expected: FAIL — `formatSignerName` / `signaturePlan` не экспортируются.

- [ ] **Step 3: Написать функции**

В `apps/api/src/modules/billing/print-document-layout.ts` сразу после `resolvePrintVariant` (после строки 22) добавить:

```ts
const initial = (word: string) => `${word.charAt(0).toUpperCase()}.`;

/**
 * «Фамилия Имя Отчество» → «И. О. Фамилия»; «Фамилия Имя» → «И. Фамилия». A compound given
 * name keeps hyphenated initials («А.-М.»). Anything else (one word, more than three) is
 * printed as entered rather than guessing initials; empty input prints nothing.
 */
export function formatSignerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const [surname, ...given] = words;
  if (surname === undefined || given.length === 0 || given.length > 2) return words.join(" ");
  const initials = given.map((word) => word.split("-").map(initial).join("-"));
  return `${initials.join(" ")} ${surname}`;
}

export type SealPlacement = "none" | "slot" | "column";

export interface SignaturePlan {
  signed: boolean;
  signerName: string | null;
  seal: SealPlacement;
}

function signerNameOf(model: PrintDocumentModel): string | null {
  const contact = model.seller.contact;
  return typeof contact === "object" && contact !== null && "name" in contact
    ? formatSignerName(contact.name)
    : null;
}

/**
 * What the signature block prints. Both renderers draw from this plan, so the name and the
 * seal position cannot diverge between HTML and PDF. The name comes from the seller contact
 * frozen with the document; without one the decoding stays a blank line.
 */
export function signaturePlan(
  model: PrintDocumentModel,
  variant: PrintDocumentVariant,
): SignaturePlan {
  if (variant !== "signed") return { signed: false, signerName: null, seal: "none" };
  return {
    signed: true,
    signerName: signerNameOf(model),
    seal: model.kind === "act" ? "column" : "slot",
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Гейты и commit**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api lint`
Expected: без ошибок.

```bash
/usr/bin/git add apps/api/src/modules/billing/print-document-layout.ts apps/api/test/print-signature-plan.test.ts
/usr/bin/git commit -m "feat(billing): plan the signature block from the frozen seller contact" -m "formatSignerName turns the contact's full name into initials and surname; signaturePlan decides the printed name and where the seal goes so the HTML and PDF renderers draw from one source." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Подписной блок в HTML

**Files:**

- Modify: `apps/api/src/modules/billing/print-document-html.ts` (импорт, строки 18-20; `signatureBlock`/`closing`, строки 124-144; вызов на строке 162; CSS-строка на строке 160)
- Create: `apps/api/test/print-signature-html.test.ts`

**Interfaces:**

- Consumes: `signaturePlan`, `SignaturePlan` из Task 3.

- [ ] **Step 1: Написать падающие тесты структуры**

Создать `apps/api/test/print-signature-html.test.ts`:

```ts
import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";

const model = (
  kind: PrintDocumentModel["kind"],
  contactName: string | null,
): PrintDocumentModel => ({
  kind,
  number: kind === "offer" ? "MRK-CO-000001" : "MRK-INV-000001",
  status: "issued",
  issuedOrPublishedAt: new Date("2026-09-30T00:00:00.000Z"),
  dueOrExpiresAt: null,
  seller: {
    legalName: "Индивидуальный предприниматель Богатырев Владислав Сергеевич",
    taxId: SIGNED_PRINT_SELLER_TAX_ID,
    contact: { name: contactName, email: null, phone: null },
  },
  buyer: { legalName: "ООО Покупатель" },
  lines: [],
  subtotal: "0.00",
  vatTotal: "0.00",
  total: "0.00",
  termsHtml: null,
});

const NAME = "Богатырев Владислав Сергеевич";
const SEALED_SLOT = /<div class="stamp stamp--sealed"><img class="legal-seal"[^>]*><\/div>/;

describe("signed print form signature block", () => {
  it.each(["offer", "invoice"] as const)(
    "prints the signer name and puts the %s seal into the right slot",
    (kind) => {
      const html = renderPrintHtml(model(kind, NAME), { printVariant: "signed" });
      expect(html).toContain('<span class="signer-name">В. С. Богатырев</span>');
      expect(html).toMatch(SEALED_SLOT);
      expect(html).not.toContain("МЕСТО ДЛЯ ПЕЧАТИ");
      expect(html.split('class="legal-seal"')).toHaveLength(2);
      expect(html.split('class="authorized-signature"')).toHaveLength(2);
      const block = html.match(/<div class="signature signature--signed">.*?<\/small>/s)?.[0] ?? "";
      expect(block).toContain('class="authorized-signature"');
      expect(block).not.toContain('class="legal-seal"');
    },
  );

  it("lays the signature over the signature field, before the slash", () => {
    const html = renderPrintHtml(model("offer", NAME), { printVariant: "signed" });
    expect(html).toMatch(
      /<span class="signature-field"><img class="authorized-signature"[^>]*>________________<\/span><span class="signature-slash"> \/ <\/span><span class="signer-name">/,
    );
  });

  it("puts the act seal at the edge of the executor column and keeps the customer block", () => {
    const html = renderPrintHtml(model("act", NAME), { printVariant: "signed" });
    expect(html).toContain('<section class="signing signing--act">');
    expect(html).not.toContain("stamp--sealed");
    const executor =
      html.match(/<div class="signature signature--signed">.*?<\/small>(.*?)<\/div>/s)?.[1] ?? "";
    expect(executor).toContain('<img class="legal-seal"');
    expect(html).toContain("ЗАКАЗЧИК");
    expect(html.split('class="legal-seal"')).toHaveLength(2);
  });

  it("keeps a blank decoding line when the contact has no name", () => {
    const html = renderPrintHtml(model("offer", null), { printVariant: "signed" });
    expect(html).not.toContain('class="signer-name"');
    expect(html).toContain('<span class="signature-slash"> / </span>____________________');
  });

  it("escapes the contact name", () => {
    const html = renderPrintHtml(model("offer", 'Иванов <b>Иван</b> "Иванович"'), {
      printVariant: "signed",
    });
    expect(html).not.toContain("<b>Иван</b>");
    expect(html).toContain('class="signer-name"');
  });
});

describe("clean print form signature block", () => {
  it("is unchanged: blank line and the dashed stamp placeholder, no name and no images", () => {
    const html = renderPrintHtml(model("offer", NAME), { printVariant: "clean" });
    expect(html).toContain("<span>________________ / ____________________</span>");
    expect(html).toContain('<div class="stamp"><span>МЕСТО ДЛЯ ПЕЧАТИ</span></div>');
    expect(html).not.toContain("signer-name");
    expect(html).not.toContain("legal-seal");
    expect(html).not.toContain("authorized-signature");
  });

  it("gives an act two equal signature columns", () => {
    const html = renderPrintHtml(model("act", NAME), { printVariant: "clean" });
    expect(html).toContain('<section class="signing signing--act">');
    expect(html).toContain("ИСПОЛНИТЕЛЬ");
    expect(html).toContain("ЗАКАЗЧИК");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-html.test.ts`
Expected: FAIL — нет `signer-name`, нет `stamp--sealed`, нет `signing--act`.

- [ ] **Step 3: Переписать подписной блок**

В `apps/api/src/modules/billing/print-document-html.ts`:

1. В список импорта из `./print-document-layout` (строки 5-20) добавить `signaturePlan,` (по алфавиту после `resolvePrintVariant,`) и `type SignaturePlan,` (рядом с `type PrintRenderOptions,`).

2. Заменить строки 124-144 (`signatureBlock` и `closing`) целиком на:

```ts
const sealImage = `<img class="legal-seal" src="${legalSealDataUri}" alt="Печать поставщика">`;

const cleanSignatureLine = "<span>________________ / ____________________</span>";

const signedSignatureLine = (signerName: string | null) =>
  `<div class="signature-line"><span class="signature-field"><img class="authorized-signature" src="${authorizedSignatureDataUri}" alt="Подпись уполномоченного лица">________________</span><span class="signature-slash"> / </span>${signerName ? `<span class="signer-name">${escape(signerName)}</span>` : "____________________"}</div>`;

const signatureBlock = (label: string, plan: SignaturePlan | null) =>
  `<div class="signature${plan ? " signature--signed" : ""}"><div class="section-label">${label}</div>${plan ? signedSignatureLine(plan.signerName) : cleanSignatureLine}<small>подпись / расшифровка</small>${plan?.seal === "column" ? sealImage : ""}</div>`;

const closing = (model: PrintDocumentModel, plan: SignaturePlan) => {
  const terms =
    model.kind === "offer" && model.termsHtml
      ? `<section class="terms"><div class="section-label">УСЛОВИЯ СОТРУДНИЧЕСТВА</div>${sanitizeOfferTermsHtml(model.termsHtml)}</section>`
      : "";
  const payment =
    model.kind === "invoice"
      ? `<section class="purpose"><div class="section-label">НАЗНАЧЕНИЕ ПЛАТЕЖА</div><p>${escape(paymentPurpose(model))}</p></section>`
      : '<p class="offer-notice">Не является счётом на оплату</p>';
  const provider = signatureBlock(
    model.kind === "act" ? "ИСПОЛНИТЕЛЬ" : "ПОСТАВЩИК",
    plan.signed ? plan : null,
  );
  const counterpart =
    model.kind === "act"
      ? signatureBlock("ЗАКАЗЧИК", null)
      : plan.seal === "slot"
        ? `<div class="stamp stamp--sealed">${sealImage}</div>`
        : '<div class="stamp"><span>МЕСТО ДЛЯ ПЕЧАТИ</span></div>';
  return `${totals(model)}${terms}${payment}<section class="signing${model.kind === "act" ? " signing--act" : ""}">${provider}${counterpart}</section>`;
};
```

(Строку `payment` оставить как есть — «Не является счётом на оплату» на акте — отдельная известная проблема вне этого плана.)

3. В `renderPrintHtml` заменить `${closing(model, printVariant === "signed")}` на `${closing(model, signaturePlan(model, printVariant))}`.

- [ ] **Step 4: Поправить CSS**

В той же строке `const styles = ...` заменить фрагмент

```
.signing{display:grid;grid-template-columns:1fr 31mm;gap:12mm;align-items:end;margin-top:5mm}.signing--signed{grid-template-columns:1fr 1fr}.signature{position:relative;min-height:31mm}.signature span{display:block;margin-top:8mm}.signature small{display:block;color:#777c75;margin-top:1mm}.signature--signed span{margin-top:18mm}.authorized-signature{position:absolute;left:9mm;bottom:5mm;width:43mm;height:23mm;object-fit:contain;z-index:1}.legal-seal{position:absolute;left:39mm;bottom:-1mm;width:31mm;height:31mm;object-fit:contain;z-index:2}.stamp{width:31mm;height:31mm;border:1px dashed #a9ada5;background:#f2f3f0;display:flex;align-items:center;justify-content:center;text-align:center;color:#9a9e97;font-size:7px;letter-spacing:.6px}
```

на

```
.signing{display:grid;grid-template-columns:1fr 31mm;gap:12mm;align-items:end;margin-top:5mm}.signing--act{grid-template-columns:1fr 1fr}.signature{position:relative;min-height:31mm}.signature>span{display:block;margin-top:8mm}.signature small{display:block;color:#777c75;margin-top:1mm}.signature-line{margin-top:15mm;white-space:nowrap}.signature-field{position:relative;display:inline-block}.authorized-signature{position:absolute;left:50%;bottom:-.5mm;transform:translateX(-50%);height:14mm;width:auto;max-width:34mm;z-index:1}.legal-seal{display:block;width:31mm;height:31mm;object-fit:contain}.signature .legal-seal{position:absolute;right:0;bottom:0}.stamp{width:31mm;height:31mm;border:1px dashed #a9ada5;background:#f2f3f0;display:flex;align-items:center;justify-content:center;text-align:center;color:#9a9e97;font-size:7px;letter-spacing:.6px}.stamp--sealed{border:0;background:none}
```

Замена делается через Edit по этому уникальному фрагменту; остальную часть строки не менять. Значения высоты подписи (`14mm`), отступа (`15mm`) и положения печати — начальные; точная подгонка в Task 6.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-html.test.ts test/print-document-renderer.test.ts test/billing-act-print-document.test.ts test/print-document-model.test.ts`
Expected: PASS во всех файлах. Прежние тесты («renders signed offers with supplier images and no counterparty stamp placeholder», «renders an authorized seller signature and seal only for the signed variant») остаются зелёными без правок: атрибуты `class="authorized-signature"` и `class="legal-seal"` сохранены, один раз каждый.

- [ ] **Step 6: Гейты и commit**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api lint`
Expected: без ошибок.

```bash
/usr/bin/git add apps/api/src/modules/billing/print-document-html.ts apps/api/test/print-signature-html.test.ts
/usr/bin/git commit -m "feat(billing): signer name, signature field and right-hand seal in HTML print forms" -m "In the signed variant the seller contact's name is printed after the slash, the signature lies on the signature field, and the seal moves to the right-hand slot (offer, invoice) or the edge of the executor column (act) instead of covering the signature. The act's two signature columns are now equal in HTML." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Подписной блок в PDF

**Files:**

- Modify: `apps/api/src/modules/billing/print-document-pdf.tsx` (импорт из layout; стили на строках 175-204; `Signature` на 388-404; `Closing` на 406-455; вызов на 556)
- Create: `apps/api/test/print-signature-pdf.test.ts`

**Interfaces:**

- Consumes: `signaturePlan`, `SignaturePlan` из Task 3.

- [ ] **Step 1: Написать падающий тест**

Создать `apps/api/test/print-signature-pdf.test.ts`. Текст в PDF лежит в подмножествах глифов и не ищется по байтам, поэтому тест проверяет, что отрисовка проходит для каждого вида документа и что имя меняет результат (рендер детерминирован, есть отдельный тест «deterministic PDF bytes»); присутствие текста проверяется вручную в Task 6 через `pdftotext`.

```ts
import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";

import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";

const model = (
  kind: PrintDocumentModel["kind"],
  contactName: string | null,
): PrintDocumentModel => ({
  kind,
  number: "MRK-CO-000001",
  status: "issued",
  issuedOrPublishedAt: new Date("2026-09-30T00:00:00.000Z"),
  dueOrExpiresAt: null,
  seller: {
    legalName: "Индивидуальный предприниматель Богатырев Владислав Сергеевич",
    taxId: SIGNED_PRINT_SELLER_TAX_ID,
    contact: { name: contactName, email: null, phone: null },
  },
  buyer: { legalName: "ООО Покупатель" },
  lines: [],
  subtotal: "0.00",
  vatTotal: "0.00",
  total: "0.00",
  termsHtml: null,
});

describe("signed PDF print forms", () => {
  it.each(["offer", "invoice", "act"] as const)(
    "renders a signed %s and changes the bytes with the signer name",
    async (kind) => {
      const named = await renderPrintPdf(model(kind, "Богатырев Владислав Сергеевич"), {
        printVariant: "signed",
      });
      const anonymous = await renderPrintPdf(model(kind, null), { printVariant: "signed" });
      expect(named.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(named.equals(anonymous)).toBe(false);
    },
  );

  it.each(["offer", "invoice", "act"] as const)(
    "ignores the contact name in the clean %s variant",
    async (kind) => {
      const named = await renderPrintPdf(model(kind, "Богатырев Владислав Сергеевич"), {
        printVariant: "clean",
      });
      const anonymous = await renderPrintPdf(model(kind, null), { printVariant: "clean" });
      expect(named.equals(anonymous)).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-pdf.test.ts`
Expected: FAIL — `named.equals(anonymous)` для подписанных даёт `true` (имя ещё не печатается).

- [ ] **Step 3: Обновить стили**

В `apps/api/src/modules/billing/print-document-pdf.tsx` заменить три записи `signedSignatureLine`, `authorizedSignature`, `legalSeal` (строки 176-193) на:

```ts
  signedLine: { flexDirection: "row", alignItems: "flex-end", marginTop: 45 },
  signatureField: { position: "relative" },
  authorizedSignature: {
    position: "absolute",
    left: 0,
    bottom: -2,
    width: 82,
    height: 40,
    objectFit: "contain",
  },
  legalSeal: { width: 88, height: 88, objectFit: "contain" },
  legalSealColumn: {
    position: "absolute",
    right: 0,
    bottom: -3,
    width: 76,
    height: 76,
    objectFit: "contain",
  },
```

Записи `signatureLine`, `signatureHint`, `stamp`, `stampText` оставить.

- [ ] **Step 4: Переписать `Signature` и `Closing`**

В импорт из `./print-document-layout` добавить `signaturePlan,` и `type SignaturePlan,`.

Заменить функцию `Signature` (строки 388-404) на:

```tsx
function Signature({ label, plan }: { label: string; plan: SignaturePlan | null }) {
  return (
    <View style={styles.signature}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {plan ? (
        <View style={styles.signedLine}>
          <View style={styles.signatureField}>
            <Image style={styles.authorizedSignature} src={authorizedSignature} cache={false} />
            <Text>________________</Text>
          </View>
          <Text> / </Text>
          <Text>{plan.signerName ?? "____________________"}</Text>
        </View>
      ) : (
        <Text style={styles.signatureLine}>________________ / ____________________</Text>
      )}
      <Text style={styles.signatureHint}>подпись / расшифровка</Text>
      {plan?.seal === "column" ? (
        <Image style={styles.legalSealColumn} src={legalSeal} cache={false} />
      ) : null}
    </View>
  );
}
```

В `Closing` заменить сигнатуру `function Closing({ model, signed }: { model: PrintDocumentModel; signed: boolean })` на `function Closing({ model, plan }: { model: PrintDocumentModel; plan: SignaturePlan })` и последний блок `<View style={styles.signing} wrap={false}> ... </View>` на:

```tsx
<View style={styles.signing} wrap={false}>
  <Signature
    label={model.kind === "act" ? "ИСПОЛНИТЕЛЬ" : "ПОСТАВЩИК"}
    plan={plan.signed ? plan : null}
  />
  {model.kind === "act" ? (
    <Signature label="ЗАКАЗЧИК" plan={null} />
  ) : plan.seal === "slot" ? (
    <Image style={styles.legalSeal} src={legalSeal} cache={false} />
  ) : (
    <View style={styles.stamp}>
      <Text style={styles.stampText}>МЕСТО ДЛЯ ПЕЧАТИ</Text>
    </View>
  )}
</View>
```

Вызов на строке 556: `<Closing model={model} signed={printVariant === "signed"} />` → `<Closing model={model} plan={signaturePlan(model, printVariant)} />`.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/print-signature-pdf.test.ts test/print-document-renderer.test.ts test/billing-act-print-document.test.ts`
Expected: PASS. Тест «renders the NPD tax basis into deterministic PDF bytes» подтверждает, что детерминизм сохранён.

- [ ] **Step 6: Гейты и commit**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api lint`
Expected: без ошибок.

```bash
/usr/bin/git add apps/api/src/modules/billing/print-document-pdf.tsx apps/api/test/print-signature-pdf.test.ts
/usr/bin/git commit -m "feat(billing): signer name, signature field and right-hand seal in PDF print forms" -m "Same layout as the HTML renderer, driven by the shared signature plan: name after the slash, signature on the signature field, seal in the right-hand slot (offer, invoice) or at the edge of the executor column (act)." -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Сверка вида и итоговые гейты

Здесь подгоняется геометрия (высота подписи над линией, положение печати) по отрисованным изображениям, потому что автотесты структуру проверяют, а внешний вид — нет.

**Files:**

- Modify (только если подгонка нужна): `apps/api/src/modules/billing/print-document-html.ts` (CSS-строка), `apps/api/src/modules/billing/print-document-pdf.tsx` (стили)
- Временный файл, в конце удалить: `apps/api/test/zz-scratch-render.test.ts`

- [ ] **Step 1: Создать временный рендер шести вариантов**

Создать `apps/api/test/zz-scratch-render.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";

import { renderPrintHtml } from "../src/modules/billing/print-document-html";
import { renderPrintPdf } from "../src/modules/billing/print-document-pdf";
import type { PrintDocumentModel } from "../src/modules/billing/print-document-model";

const out = process.env.SCRATCH_OUT ?? "/tmp/claude-501/print-after";

const base: PrintDocumentModel = {
  kind: "offer",
  number: "MRK-CO-000001",
  status: "published",
  issuedOrPublishedAt: new Date("2026-09-30T03:35:00.000Z"),
  dueOrExpiresAt: new Date("2026-10-02T20:59:59.000Z"),
  seller: {
    legalName: "Индивидуальный предприниматель Богатырев Владислав Сергеевич",
    taxId: "234106228141",
    registrationId: "326237500395950",
    registrationKind: "ogrnip",
    address: "Краснодарский край, Ленинградский р-н, ст-ца Ленинградская, ул Грузская, д 26",
    bankAccount: "40802810120001146182",
    bankName: 'ООО "Банк Точка"',
    bic: "044525104",
    correspondentAccount: "30101810745374525104",
    currency: "RUB",
    taxPolicy: { kind: "without_vat", regime: "npd" },
    contact: {
      name: process.env.SCRATCH_NAME ?? "Богатырев Владислав Сергеевич",
      email: null,
      phone: null,
    },
  },
  buyer: {
    legalName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РЭБЕЛ ЭППЛ"',
    taxId: "9705119097",
    kpp: "773401001",
    registrationId: "1187746552542",
    address: "г Москва, 1-й Силикатный проезд, д 10 стр 2",
  },
  lines: [
    {
      position: 1,
      name: "Программа для ЭВМ «Перевал.Маркировка»",
      description: "Компьютерная программа",
      unit: "шт.",
      quantity: 1,
      unitPrice: "180000.00",
      vatIncluded: false,
      lineTotal: "180000.00",
    },
  ],
  subtotal: "180000.00",
  vatTotal: "0.00",
  total: "180000.00",
  termsHtml: null,
};

it("renders samples", async () => {
  mkdirSync(out, { recursive: true });
  const docs: Array<[string, PrintDocumentModel]> = [
    ["offer", base],
    [
      "invoice",
      {
        ...base,
        kind: "invoice",
        number: "MRK-INV-000001",
        status: "issued",
        dueOrExpiresAt: null,
      },
    ],
    [
      "act",
      {
        ...base,
        kind: "act",
        number: "MRK-ACT-000001",
        sourceNumber: "MRK-INV-000001",
        status: "issued",
        dueOrExpiresAt: null,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        serviceUsage: [],
      },
    ],
  ];
  for (const [name, model] of docs) {
    for (const printVariant of ["clean", "signed"] as const) {
      writeFileSync(
        `${out}/${name}-${printVariant}.pdf`,
        await renderPrintPdf(model, { printVariant }),
      );
      writeFileSync(
        `${out}/${name}-${printVariant}.html`,
        renderPrintHtml(model, { printVariant }),
      );
    }
  }
});
```

- [ ] **Step 2: Отрисовать и проверить текст расшифровки в PDF**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/zz-scratch-render.test.ts`
Expected: PASS, файлы в `/tmp/claude-501/print-after/`.

Run: `cd /tmp/claude-501/print-after && for f in offer invoice act; do pdftotext -layout $f-signed.pdf - | grep -c "В. С. Богатырев"; pdftotext -layout $f-clean.pdf - | grep -c "В. С. Богатырев"; done`
Expected: для каждого вида `1` (подписанный) и `0` (чистый).

- [ ] **Step 3: Посмотреть PDF-раскладку**

Run: `cd /tmp/claude-501/print-after && for f in offer-signed invoice-signed act-signed act-clean; do pdftoppm -png -r 90 -f 1 -l 1 $f.pdf $f; done`

Открыть `offer-signed-1.png`, `invoice-signed-1.png`, `act-signed-1.png`, `act-clean-1.png` инструментом Read. Проверить глазами: подпись лежит на левой части линии до косой черты; после косой черты «В. С. Богатырев»; печать справа (КП, счёт — в правом слоте; акт — у правого края колонки исполнителя, не заходит на колонку заказчика и не закрывает имя); чистый акт без изменений. Если нет — подправить `signedLine.marginTop`, `authorizedSignature.{bottom,width,height}`, `legalSeal*` в `print-document-pdf.tsx` и повторить шаг 2-3.

- [ ] **Step 4: Посмотреть HTML-раскладку**

Хром в песочнице не запускается (Mach-порты), поэтому эту команду выполнять с отключённой песочницей:

```bash
CH=$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell
for f in offer-signed invoice-signed act-signed act-clean; do "$CH" --no-sandbox --disable-gpu --hide-scrollbars --window-size=900,1400 --screenshot=/tmp/claude-501/print-after/$f-html.png file:///tmp/claude-501/print-after/$f.html; done
```

Открыть четыре `*-html.png` через Read и проверить то же самое, плюс: у чистого акта колонка заказчика теперь такой же ширины, как колонка исполнителя (раньше «/ ____» переносилась на вторую строку). Подправить CSS-строку (`.signature-line` margin-top, `.authorized-signature` height/bottom, `.signature .legal-seal`) и повторить.

- [ ] **Step 5: Проверить длинное имя**

Run: `SCRATCH_NAME="Иванова-Петрова Анна-Мария Александровна" pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api exec vitest run test/zz-scratch-render.test.ts` и снова отрисовать `act-signed` (PDF и HTML).
Expected: имя «А.-М. А. Иванова-Петрова» не наезжает на печать в колонке акта. Если наезжает — уменьшить печать колонки (`legalSealColumn` / `.signature .legal-seal`) или сдвинуть её вправо, но не уводить в колонку заказчика.

- [ ] **Step 6: Удалить временный файл и артефакты**

Run: `rm apps/api/test/zz-scratch-render.test.ts && /usr/bin/git status --short`
Expected: чистое дерево, если подгонка не меняла код; иначе только `print-document-html.ts` и/или `print-document-pdf.tsx`.

- [ ] **Step 7: Если геометрия менялась — закоммитить подгонку**

```bash
/usr/bin/git add apps/api/src/modules/billing/print-document-html.ts apps/api/src/modules/billing/print-document-pdf.tsx
/usr/bin/git commit -m "fix(billing): tune signature and seal geometry against rendered forms" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Итоговые гейты пакетов**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin test && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/saas-admin build`
Expected: без падений (полный набор saas-admin на 30.09.2026: 56 файлов, 589 тестов плюс новые).

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/api build`
Expected: без ошибок.

Полный прогон API (`pnpm --filter @markiro/api test`) идёт ~10 минут и требует БД и окружения из `.github/workflows/ci.yml` (job `verify-api-tests`), без песочницы. Запустить его и записать результат; файлы `print-*.test.ts`, `billing-act-print-document.test.ts`, `platform-offers*.test.ts`, `offer-*` должны быть зелёными. Флейки под нагрузкой (например, `inventory-snapshot.e2e`) фиксировать и разбирать, а не считать успехом повторного запуска.

Run: `pnpm_config_verify_deps_before_run=false pnpm exec prettier --check apps/api/src apps/api/test apps/saas-admin/src apps/saas-admin/test docs/superpowers && /usr/bin/git diff --check origin/main...HEAD`
Expected: без замечаний.

- [ ] **Step 9: Убрать одноразовую БД и проверить дерево**

Run: `docker rm -f markiro-print-postgres; /usr/bin/git status --short && /usr/bin/git log --oneline origin/main..HEAD`
Expected: чистое дерево; коммиты: docs, новая вкладка, номер КП, план подписи, HTML, PDF (+ подгонка, если была).

- [ ] **Step 10: Итоговый отчёт**

В отчёте отдельно перечислить: что изменено; автоматические проверки и результаты; ручные проверки (картинки шести вариантов, `pdftotext`); что не проверялось (печать на бумаге, PDF в разных просмотрщиках, реальный saas-admin за 2FA); известную проблему вне плана — HTML-акт печатает «Не является счётом на оплату» (`payment` в `closing`), в PDF её нет. Push и PR не выполнять без отдельной команды владельца.
