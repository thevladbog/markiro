import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

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
});
