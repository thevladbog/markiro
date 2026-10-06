import { createHmac, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, type SupportBrowserStack } from "./fixture";

async function post(context: BrowserContext, path: string, data: unknown, origin: string) {
  const response = await context.request.post(path, { data, headers: { Origin: origin } });
  expect(response.status(), `POST ${path}`).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function createCustomer(context: BrowserContext, stack: SupportBrowserStack) {
  const signedUp = await post(
    context,
    "/api/auth/sign-up/email",
    {
      email: `browser-${randomUUID()}@example.invalid`,
      password: `Pw-${randomUUID()}!Aa1`,
      name: "Browser Customer",
    },
    stack.adminUrl,
  );
  const created = await post(
    context,
    "/api/auth/organization/create",
    { name: "Browser Plant", slug: `browser-${randomUUID()}` },
    stack.adminUrl,
  );
  const tenantId = String(created.id);
  await post(
    context,
    "/api/auth/organization/set-active",
    { organizationId: tenantId },
    stack.adminUrl,
  );
  const profile = await context.request.patch("/api/profile", {
    data: { firstName: "Тест", lastName: "Пользователь", middleName: null },
    headers: { Origin: stack.adminUrl },
  });
  expect(profile.status()).toBe(200);
  const user = signedUp.user as { id: string };
  return { userId: user.id, tenantId };
}

async function openSupport(page: Page) {
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Поддержка", level: 1 })).toBeVisible();
}

function currentTotp(uri: string): string {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded) throw new Error("Expected local TOTP enrollment URI");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replaceAll("=", "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid local TOTP enrollment URI");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function createVerifiedOperator(context: BrowserContext, stack: SupportBrowserStack) {
  const password = `Pw-${randomUUID()}!Aa1`;
  const signedUp = await post(
    context,
    "/api/platform-auth/sign-up/email",
    { email: `operator-${randomUUID()}@example.invalid`, password, name: "Browser Operator" },
    stack.platformUrl,
  );
  const user = signedUp.user as { id: string };
  await stack.setPlatformRole(user.id);
  const enrollment = await post(
    context,
    "/api/platform-auth/two-factor/enable",
    { password },
    stack.platformUrl,
  );
  await post(
    context,
    "/api/platform-auth/two-factor/verify-totp",
    { code: currentTotp(String(enrollment.totpURI)), trustDevice: false },
    stack.platformUrl,
  );
  const me = await context.request.get("/api/platform/me");
  expect(me.status()).toBe(200);
}

test("episode pagination preserves later questions, draft ownership and cached outage recovery", async ({
  browser,
  stack,
}) => {
  const customer = await browser.newContext({ baseURL: stack.adminUrl });
  let releaseSend: (() => void) | undefined;
  let releaseList: (() => void) | undefined;
  try {
    await createCustomer(customer, stack);
    const ids: string[] = [];
    for (let index = 0; index < 51; index++) {
      const created = await customer.request.post("/api/support-chat/episodes", {
        data: { idempotencyKey: randomUUID() },
      });
      expect(created.status()).toBe(201);
      ids.push(((await created.json()) as { id: string }).id);
    }
    for (const [index, text] of [
      [0, "First episode marker"],
      [50, "Later episode marker"],
    ] as const)
      await stack.command({
        kind: "seedRemote",
        episodeId: ids[index]!,
        messages: [{ text, private: false }],
      });
    const page = await customer.newPage();
    let markListHeld!: () => void;
    const listHeld = new Promise<void>((resolve) => {
      markListHeld = resolve;
    });
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    // Delay the first real list request, without replacing auth, payload or API behavior.
    await page.route(
      "**/api/support-chat/episodes",
      async (route) => {
        markListHeld();
        await listReleased;
        await route.continue();
      },
      { times: 1 },
    );
    await openSupport(page);
    await listHeld;
    await expect(page.getByRole("button", { name: "Новый вопрос" })).toBeDisabled();
    releaseList();
    await expect(page.getByText("First episode marker", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Новый вопрос" })).toBeEnabled();
    await page.getByRole("button", { name: "Показать ещё вопросы" }).click();
    const questions = page
      .getByRole("navigation", { name: "Мои вопросы" })
      .getByRole("button", { name: "Вопрос", exact: true });
    await expect(questions).toHaveCount(51);
    await questions.nth(50).click();
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
    await expect(page.getByText("First episode marker", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("First episode marker", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Показать ещё вопросы" }).click();
    await questions.nth(50).click();
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Новый вопрос" }).click();
    await expect(questions).toHaveCount(52);
    // A newly created row is retained separately from paginated server pages.
    await questions.nth(51).click();
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
    await questions.nth(1).click();
    await expect(page.getByText("First episode marker", { exact: true })).toBeVisible();
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    // Delay transport only; the real authorized API still handles the request and response.
    await page.route(`**/api/support-chat/episodes/${ids[0]}/messages`, async (route) => {
      markHeld();
      await released;
      await route.continue();
    });
    await page.getByRole("textbox", { name: "Сообщение" }).fill("Held A message");
    await page.getByRole("button", { name: "Отправить" }).click();
    await held;
    await questions.nth(51).click();
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Сообщение" }).fill("B draft survives");
    const sent = page.waitForResponse((response) => response.url().includes(`${ids[0]}/messages`));
    releaseSend();
    expect((await sent).status()).toBe(201);
    await expect(page.getByRole("textbox", { name: "Сообщение" })).toHaveValue("B draft survives");
    await expect(page.getByRole("button", { name: "Отправить" })).toBeEnabled();
    await expect(page.getByText("Held A message", { exact: true })).toHaveCount(0);
    await stack.command({ kind: "failNextRead" });
    // The poll uses real Chatwoot failure and returns cached private history plus sync error.
    await expect(page.getByText("Нет связи с поддержкой. Попробуйте ещё раз.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(page.getByText("Нет связи с поддержкой. Попробуйте ещё раз.")).toHaveCount(0);
    await expect(page.getByText("Later episode marker", { exact: true })).toBeVisible();
  } finally {
    releaseList?.();
    releaseSend?.();
    await customer.close();
  }
});

test("private history over fifty messages stays live after exhausting older pages", async ({
  browser,
  stack,
}) => {
  const customer = await browser.newContext({ baseURL: stack.adminUrl });
  try {
    await createCustomer(customer, stack);
    const created = await customer.request.post("/api/support-chat/episodes", {
      data: { idempotencyKey: randomUUID() },
    });
    expect(created.status()).toBe(201);
    const episode = (await created.json()) as { id: string };
    await stack.command({
      kind: "seedRemote",
      episodeId: episode.id,
      messages: Array.from({ length: 65 }, (_, i) => ({
        text: `History message ${i}`,
        private: false,
      })),
    });
    // Use real reads to finish bounded private backfill before opening the browser.
    for (let i = 0; i < 2; i++)
      expect(
        (await customer.request.get(`/api/support-chat/episodes/${episode.id}`)).status(),
      ).toBe(200);
    const page = await customer.newPage();
    await openSupport(page);
    await expect(page.getByText("History message 64", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Показать ранние сообщения" }).click();
    await expect(page.getByText("History message 0", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Показать ранние сообщения" })).toHaveCount(0);
    await stack.command({
      kind: "seedRemote",
      episodeId: episode.id,
      messages: Array.from({ length: 80 }, (_, i) => [
        { text: `Burst message ${i}`, private: false },
        ...(i % 4 === 0
          ? [
              { text: `Private burst note ${i}`, private: true },
              { text: `Burst activity ${i}`, private: false, activity: true },
            ]
          : []),
      ]).flat(),
    });
    await expect(page.getByText(/^Burst message \d+$/)).toHaveCount(80, { timeout: 30_000 });
    await expect(page.getByText(/^History message \d+$/)).toHaveCount(65);
    expect(new Set(await page.getByText(/^Burst message \d+$/).allTextContents()).size).toBe(80);
    expect(new Set(await page.getByText(/^History message \d+$/).allTextContents()).size).toBe(65);
    await expect(page.getByText(/^Private burst note|^Burst activity/)).toHaveCount(0);
    await expect(page.getByText("History message 0", { exact: true })).toBeVisible();
  } finally {
    await customer.close();
  }
});

test("private cabinet and operator journey retains only public transcript with consent", async ({
  browser,
  stack,
}, testInfo) => {
  const customer = await browser.newContext({
    baseURL: stack.adminUrl,
    viewport: { width: 1280, height: 900 },
  });
  const operator = await browser.newContext({
    baseURL: stack.platformUrl,
    viewport: { width: 1280, height: 900 },
  });
  try {
    await createCustomer(customer, stack);
    await createVerifiedOperator(operator, stack);
    const page = await customer.newPage();
    await openSupport(page);
    await expect(page.getByRole("heading", { name: "Поддержка", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Новый вопрос" }).click();
    const longText = `Проверка линии: ${"длинное описание ".repeat(70)}`;
    await page.getByRole("textbox", { name: "Сообщение" }).fill(longText);
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.getByText(longText)).toBeVisible();
    const listed = await customer.request.get("/api/support-chat/episodes");
    expect(listed.status()).toBe(200);
    const episodeId = ((await listed.json()) as { items: Array<{ id: string }> }).items[0]!.id;
    const platformPage = await operator.newPage();
    await platformPage.goto(`/support/${episodeId}`);
    await expect(
      platformPage.getByRole("heading", { name: "Диалог поддержки", level: 1 }),
    ).toBeVisible();
    await platformPage
      .getByRole("textbox", { name: "Заголовок обращения" })
      .fill("Остановка линии");
    await platformPage
      .getByRole("textbox", { name: "Краткое описание" })
      .fill("Требуется техническая помощь");
    await platformPage.getByRole("button", { name: "Предложить создание обращения" }).click();
    await expect(platformPage.getByText("Ожидает решения клиента")).toBeVisible();
    await platformPage.screenshot({
      path: testInfo.outputPath("operator-ru-desktop.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Подтвердить перенос" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("support-ru-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Подтвердить перенос" }).click();
    await expect(page.getByText(/BR-/)).toBeVisible();
    await stack.command({
      kind: "seedRemote",
      episodeId,
      messages: [
        { text: "Operator public reply after consent", private: false },
        { text: "INTERNAL NOTE MUST STAY PRIVATE", private: true },
      ],
    });
    await stack.command({ kind: "sync", episodeId });
    await page.reload();
    await expect(page.getByText("Operator public reply after consent")).toBeVisible();
    await expect(page.getByText("INTERNAL NOTE MUST STAY PRIVATE")).toHaveCount(0);
    await platformPage.reload();
    await expect(platformPage.getByText("Operator public reply after consent")).toBeVisible();
    await platformPage.getByRole("button", { name: "EN", exact: true }).click();
    await expect(
      platformPage.getByRole("heading", { name: "Support conversation", level: 1 }),
    ).toBeVisible();
    await platformPage.setViewportSize({ width: 360, height: 800 });
    await platformPage.screenshot({
      path: testInfo.outputPath("operator-en-mobile.png"),
      fullPage: true,
    });
    expect(
      await platformPage.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    const requestLink = page.getByRole("link", { name: /BR-/ }).first();
    await requestLink.click();
    await expect(
      page.getByRole("heading", { name: "Переписка по обращению", level: 3 }),
    ).toBeVisible();
    await expect(page.getByText("Operator public reply after consent")).toBeVisible();
    await expect(page.getByText("INTERNAL NOTE MUST STAY PRIVATE")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("request-ru-desktop.png"), fullPage: true });
    await page.getByText("Operator public reply after consent").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("request-ru-transcript.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Переключить язык" }).click();
    await expect(
      page.getByRole("heading", { name: "Request conversation", level: 3 }),
    ).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("heading", { name: /Request BR-/ }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("request-en-mobile-top.png"),
      fullPage: true,
    });
    await page.getByText("Operator public reply after consent").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("request-en-mobile.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    await openSupport(page);
    await page.getByRole("button", { name: "Переключить язык" }).click();
    await expect(page.getByRole("heading", { name: "Support", level: 1 })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: testInfo.outputPath("support-en-mobile.png"), fullPage: true });
    await page.getByText("Operator public reply after consent").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("support-en-mobile-reply.png"),
      fullPage: true,
    });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(360);
    const platformDetail = await operator.request.get(
      `/api/platform/support-chat/episodes/${episodeId}`,
    );
    expect(platformDetail.status()).toBe(200);
    const detail = (await platformDetail.json()) as { request: { id: string } | null };
    expect(detail.request?.id).toBeTruthy();
    const transcript = await customer.request.get(
      `/api/billing/requests/${detail.request!.id}/transcript`,
    );
    expect(transcript.status()).toBe(200);
    const body = JSON.stringify(await transcript.json());
    expect(body).toContain("Operator public reply after consent");
    expect(body).not.toContain("INTERNAL NOTE MUST STAY PRIVATE");
  } finally {
    await operator.close();
    await customer.close();
  }
});

test("declining an operator proposal does not create a billing request", async ({
  browser,
  stack,
}) => {
  const customer = await browser.newContext({ baseURL: stack.adminUrl });
  const operator = await browser.newContext({ baseURL: stack.platformUrl });
  try {
    await createCustomer(customer, stack);
    await createVerifiedOperator(operator, stack);
    const customerPage = await customer.newPage();
    await openSupport(customerPage);
    await customerPage.getByRole("button", { name: "Новый вопрос" }).click();
    await customerPage
      .getByRole("textbox", { name: "Сообщение" })
      .fill("Вопрос без переноса в обращение");
    await customerPage.getByRole("button", { name: "Отправить" }).click();
    await expect(
      customerPage.getByText("Вопрос без переноса в обращение", { exact: true }),
    ).toBeVisible();
    const listed = await customer.request.get("/api/support-chat/episodes");
    expect(listed.status()).toBe(200);
    const episodeId = ((await listed.json()) as { items: Array<{ id: string }> }).items[0]!.id;
    const operatorPage = await operator.newPage();
    await operatorPage.goto(`/support/${episodeId}`);
    await expect(
      operatorPage.getByRole("heading", { name: "Диалог поддержки", level: 1 }),
    ).toBeVisible();
    await operatorPage
      .getByRole("textbox", { name: "Заголовок обращения" })
      .fill("Предложение без согласия");
    await operatorPage
      .getByRole("textbox", { name: "Краткое описание" })
      .fill("Не переносить историю");
    await operatorPage.getByRole("button", { name: "Предложить создание обращения" }).click();
    await expect(operatorPage.getByText("Ожидает решения клиента", { exact: true })).toBeVisible();
    await customerPage.reload();
    await customerPage.getByRole("button", { name: "Отказаться" }).click();
    await expect(customerPage.getByRole("button", { name: "Подтвердить перенос" })).toHaveCount(0);
    await operatorPage.reload();
    await expect(operatorPage.getByText("Клиент отказался")).toBeVisible();
    const detail = await operator.request.get(`/api/platform/support-chat/episodes/${episodeId}`);
    expect(detail.status()).toBe(200);
    expect(((await detail.json()) as { request: unknown }).request).toBeNull();
  } finally {
    await operator.close();
    await customer.close();
  }
});

test("existing billing request status and clarification reply remain usable", async ({
  browser,
  stack,
}) => {
  const customer = await browser.newContext({ baseURL: stack.adminUrl });
  const operator = await browser.newContext({ baseURL: stack.platformUrl });
  try {
    await createCustomer(customer, stack);
    await createVerifiedOperator(operator, stack);
    const created = await customer.request.post("/api/billing/requests", {
      data: {
        type: "other",
        description: "Existing billing flow smoke",
        idempotencyKey: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const request = (await created.json()) as { id: string; number: string };
    for (const status of ["under_review", "clarification_required"]) {
      const transition = await operator.request.post(
        `/api/platform/billing/requests/${request.id}/status`,
        {
          data: { status, idempotencyKey: randomUUID() },
        },
      );
      expect(transition.status(), `billing status ${status}`).toBe(201);
    }
    const customerPage = await customer.newPage();
    await customerPage.goto(`/billing/requests/${request.id}`);
    await expect(customerPage.getByText("Нужно уточнение", { exact: true })).toBeVisible();
    await customerPage
      .getByRole("textbox", { name: "Ответ на уточнение" })
      .fill("Сведения для продолжения заявки");
    await customerPage.getByRole("button", { name: "Отправить ответ" }).click();
    await expect(customerPage.getByText("Сведения для продолжения заявки")).toBeVisible();
    const operatorPage = await operator.newPage();
    await operatorPage.goto(`/billing-requests/${request.id}`);
    await expect(operatorPage.getByText("Сведения для продолжения заявки")).toBeVisible();
    await expect(operatorPage.getByText(request.number)).toBeVisible();
  } finally {
    await operator.close();
    await customer.close();
  }
});

test("another member cannot read the first user's episode and loses access after revocation", async ({
  browser,
  stack,
}) => {
  const first = await browser.newContext({ baseURL: stack.adminUrl });
  const second = await browser.newContext({ baseURL: stack.adminUrl });
  try {
    const a = await createCustomer(first, stack);
    const b = await createCustomer(second, stack);
    await stack.command({ kind: "addMember", tenantId: a.tenantId, userId: b.userId });
    await post(
      second,
      "/api/auth/organization/set-active",
      { organizationId: a.tenantId },
      stack.adminUrl,
    );
    const created = await first.request.post("/api/support-chat/episodes", {
      data: { idempotencyKey: randomUUID() },
    });
    expect(created.status()).toBe(201);
    const episodeId = ((await created.json()) as { id: string }).id;
    const denial = await second.request.get(`/api/support-chat/episodes/${episodeId}`);
    expect(denial.status()).toBe(404);
    const page = await second.newPage();
    await openSupport(page);
    await expect(page.getByText("Здесь пока нет переписки. Начните новый вопрос.")).toBeVisible();
    await page.getByRole("button", { name: "Новый вопрос" }).click();
    const memberMarker = `Частная переписка участника ${randomUUID()}`;
    await page.getByRole("textbox", { name: "Сообщение" }).fill(memberMarker);
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.getByText(memberMarker)).toBeVisible();
    await stack.command({ kind: "revokeMember", tenantId: a.tenantId, userId: b.userId });
    await expect(
      page.getByText("Доступ к переписке утрачен. Обновите организацию или войдите снова."),
    ).toBeVisible();
    await expect(page.getByText(memberMarker)).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Сообщение" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Доступ к кабинету пока не открыт")).toBeVisible();
    const revoked = await second.request.get("/api/support-chat/episodes");
    expect(revoked.status()).toBe(403);
    expect(b.tenantId).not.toBe(a.tenantId);
  } finally {
    await second.close();
    await first.close();
  }
});
