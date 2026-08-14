import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

function expectTransactionalEmailOnly(output: { html: string; text: string }): void {
  expect(output.html).not.toMatch(/<img\b|<link\b|@font-face|url\(|\b(?:src|href)=["']/i);
  expect(output.html).not.toMatch(
    /tracking|pixel|unsubscribe|subscription|marketing|рассыл|реклам/i,
  );
  expect(output.text).not.toMatch(/unsubscribe|subscription|marketing|рассыл|реклам/i);
}

describe("renderEmail", () => {
  it("renders the exact image-free Markiro shell for every template", async () => {
    const outputs = await Promise.all([
      renderEmail({
        kind: "tenant-owner-activation",
        recipientName: "Владелец",
        organizationName: "Первый завод",
        actionUrl: "https://cabinet.example/activate-owner#token=setup-token",
        expiresInMinutes: 60,
      }),
      renderEmail({
        kind: "password-reset",
        recipientName: "Алексей",
        actionUrl: "https://cabinet.example/reset/token-1",
        expiresInMinutes: 30,
      }),
      renderEmail({
        kind: "organization-invitation",
        recipientName: "Администратор",
        organizationName: "Завод",
        inviterName: "Ирина",
        actionUrl: "https://cabinet.example/invitations/inv_1",
        expiresAt: new Date("2026-08-14T15:30:00Z"),
      }),
      renderEmail({
        kind: "email-verification",
        recipientName: "Мария",
        actionUrl: "https://cabinet.example/verify/token-2",
        expiresInMinutes: 60,
      }),
    ]);

    for (const output of outputs) {
      expect(output.html).toContain('aria-label="Маркиро"');
      expect(output.html.match(/data-markiro-module="true"/g)).toHaveLength(8);
      expect(output.html).toContain("маркиро");
      expect(output.html).toContain("#17161a");
      expect(output.html).toContain("#0faf56");
      expect(output.html).toContain("#3ddc7a");
      expect(output.html).toContain("@media (max-width: 480px)");
      expect(output.html).toContain("mk-email-content");
      expect(output.html).not.toMatch(/<img\b/i);
    }
  });

  it("renders an escaped organization invitation with a raw fallback URL", async () => {
    const output = await renderEmail({
      kind: "organization-invitation",
      recipientName: "<Admin>",
      organizationName: "Завод",
      inviterName: "Ирина",
      actionUrl: "https://cabinet.example/invitations/inv_1",
      expiresAt: new Date("2026-08-10T00:00:00Z"),
    });

    expect(output.subject).toBe("Приглашение в Завод — Маркиро");
    expect(output.html).toContain("Приглашение в команду");
    expect(output.html).toContain("Принять приглашение");
    expect(output.html).toContain('aria-label="Срок действия ссылки"');
    expect(output.html).toContain("&lt;Admin&gt;");
    expect(output.html).toContain("Вас пригласили в Завод");
    expect(output.text).toContain("Ирина приглашает вас присоединиться к Завод");
    expect(output.text).toContain("https://cabinet.example/invitations/inv_1");
    expect(output.text).toContain("10 августа 2026");
    expect(output.text).toContain("00:00");
    expect(output.text).toContain("UTC");
    expect(output.text).not.toContain("включительно");
  });

  it.each([
    { minutes: 1, expected: "1 минуту" },
    { minutes: 2, expected: "2 минуты" },
    { minutes: 5, expected: "5 минут" },
  ])("renders password-reset duration as $expected", async ({ minutes, expected }) => {
    const output = await renderEmail({
      kind: "password-reset",
      recipientName: "Алексей",
      actionUrl: "https://cabinet.example/reset/token",
      expiresInMinutes: minutes,
    });
    expect(output.text).toContain(expected);
  });

  it("renders a password reset without leaking markup into the subject", async () => {
    const output = await renderEmail({
      kind: "password-reset",
      recipientName: "Алексей",
      actionUrl: "https://cabinet.example/reset/token-1",
      expiresInMinutes: 30,
    });

    expect(output.subject).toBe("Восстановление пароля — Маркиро");
    expect(output.html).toContain("Восстановление пароля");
    expect(output.html).toContain("Если вы не запрашивали смену пароля, ничего делать не нужно.");
    expect(output.html).toContain("Сбросить пароль");
    expect(output.text).toContain("https://cabinet.example/reset/token-1");
    expect(output.text).toContain("30 минут");
  });

  it("renders first-owner activation copy instead of claiming a reset was requested", async () => {
    const output = await renderEmail({
      kind: "tenant-owner-activation",
      recipientName: "Владелец",
      organizationName: "Первый завод",
      actionUrl: "https://cabinet.example/activate-owner#token=setup-token",
      expiresInMinutes: 60,
    });

    expect(output.subject).toBe("Доступ к Первый завод — Маркиро");
    expect(output.html).toContain("Добро пожаловать в Маркиро");
    expect(output.html).toContain("Первый завод");
    expect(output.html).toContain("Активировать доступ");
    expect(output.text).toContain("пароль останется без изменений");
    expect(output.text).toContain("Для вас создан кабинет организации Первый завод");
    expect(output.text).toContain("https://cabinet.example/activate-owner#token=setup-token");
    expect(output.text).not.toContain("получили запрос на смену пароля");
  });

  it("renders email verification with useful preview and plain text", async () => {
    const output = await renderEmail({
      kind: "email-verification",
      recipientName: "Мария",
      actionUrl: "https://cabinet.example/verify/token-2",
      expiresInMinutes: 60,
    });

    expect(output.subject).toBe("Подтвердите email — Маркиро");
    expect(output.html).toContain("Подтвердите email");
    expect(output.html).toContain(
      "Подтвердите адрес электронной почты, чтобы завершить настройку учётной записи.",
    );
    expect(output.html).toContain("Подтвердите адрес электронной почты");
    expect(output.text).toContain("https://cabinet.example/verify/token-2");
    expect(output.text).toContain("60 минут");
  });

  it.each([
    { minutes: 1, expected: "1 минуту" },
    { minutes: 2, expected: "2 минуты" },
    { minutes: 5, expected: "5 минут" },
  ])("renders verification duration as $expected", async ({ minutes, expected }) => {
    const output = await renderEmail({
      kind: "email-verification",
      recipientName: "Мария",
      actionUrl: "https://cabinet.example/verify/token",
      expiresInMinutes: minutes,
    });
    expect(output.text).toContain(expected);
  });

  it("renders an image-free internal landing notification with fixed headers and escaped text", async () => {
    const output = await renderEmail({
      kind: "landing-demo-notification",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: new Date("2026-08-14T12:00:00Z"),
      sourcePath: "/en/",
      recipientName: "<Ada>",
      company: "Factory & Co",
      email: "ada@example.test",
      phone: "+12025550114",
    });

    expect(output.subject).toBe("Новая заявка с markiro.app — Маркиро");
    expect(output.replyTo).toBe("ada@example.test");
    expect(output.html).toContain('lang="ru"');
    expect(output.html).toContain('aria-label="Маркиро"');
    expect(output.html.match(/data-markiro-module="true"/g)).toHaveLength(8);
    expect(output.html).toContain("маркиро");
    expect(output.html).toContain("&lt;Ada&gt;");
    expect(output.html).toContain("Factory &amp; Co");
    expect(output.html).not.toMatch(/href=["'][^"']*(?:Ada|Factory|ada%40)/i);
    expect(output.text).toContain(
      [
        "ID заявки: 11111111-1111-4111-8111-111111111111",
        "Получена: 14.08.2026, 12:00 UTC",
        "Страница: /en/",
      ].join("\n"),
    );
    expect(output.text).toContain("Язык посетителя: English (en)");
    expect(output.text).toContain("Имя: <Ada>");
    expect(output.text).toContain("Компания: Factory & Co");
    expect(output.text).toContain("Email: ada@example.test");
    expect(output.text).toContain("Телефон: +12025550114");
    expectTransactionalEmailOnly(output);
  });

  it("renders a Russian landing confirmation and omits the absent phone row", async () => {
    const output = await renderEmail({
      kind: "landing-demo-confirmation",
      locale: "ru",
      requestId: "11111111-1111-4111-8111-111111111111",
      recipientName: "Анна",
      company: "Завод & Ко",
      email: "anna@example.test",
      contactEmail: "hello@v-b.tech",
    });

    expect(output.subject).toBe("Мы получили вашу заявку — Маркиро");
    expect(output.replyTo).toBe("hello@v-b.tech");
    expect(output.html).toContain('lang="ru"');
    expect(output.html).toContain('aria-label="Маркиро"');
    expect(output.html.match(/data-markiro-module="true"/g)).toHaveLength(8);
    expect(output.html).toContain("маркиро");
    expect(output.text).toContain("Здравствуйте, Анна.");
    expect(output.text).toContain("Мы получили вашу заявку на демонстрацию Маркиро.");
    expect(output.text).toContain("Компания: Завод & Ко\nEmail: anna@example.test");
    expect(output.text).not.toContain("Телефон:");
    expect(output.text).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(output.text).not.toContain("undefined");
    expectTransactionalEmailOnly(output);
  });

  it("renders an English landing confirmation with the localized Markiro brand", async () => {
    const output = await renderEmail({
      kind: "landing-demo-confirmation",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      recipientName: "Ada",
      company: "Factory",
      email: "ada@example.test",
      phone: "+12025550114",
      contactEmail: "hello@v-b.tech",
    });

    expect(output.subject).toBe("We received your request — Markiro");
    expect(output.replyTo).toBe("hello@v-b.tech");
    expect(output.html).toContain('lang="en"');
    expect(output.html).toContain('aria-label="Markiro"');
    expect(output.html.match(/data-markiro-module="true"/g)).toHaveLength(8);
    expect(output.html).toContain("MARKIRO");
    expect(output.text).toContain("Hello, Ada.");
    expect(output.text).toContain("We received your request for a Markiro demo.");
    expect(output.text).toContain("Company: Factory\nEmail: ada@example.test\nPhone: +12025550114");
    expect(output.text).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(output.text).not.toContain("undefined");
    expectTransactionalEmailOnly(output);
  });
});
