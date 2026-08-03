import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

describe("renderEmail", () => {
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
    expect(output.html).toContain("&lt;Admin&gt;");
    expect(output.html).toContain("Вас пригласили в Завод");
    expect(output.text).toContain("Ирина приглашает вас присоединиться к Завод");
    expect(output.text).toContain("https://cabinet.example/invitations/inv_1");
    expect(output.text).toContain("10 августа 2026");
  });

  it("renders a password reset without leaking markup into the subject", async () => {
    const output = await renderEmail({
      kind: "password-reset",
      recipientName: "Алексей",
      actionUrl: "https://cabinet.example/reset/token-1",
      expiresInMinutes: 30,
    });

    expect(output.subject).toBe("Восстановление пароля — Маркиро");
    expect(output.html).toContain("Сбросить пароль");
    expect(output.text).toContain("https://cabinet.example/reset/token-1");
    expect(output.text).toContain("30 минут");
  });

  it("renders email verification with useful preview and plain text", async () => {
    const output = await renderEmail({
      kind: "email-verification",
      recipientName: "Мария",
      actionUrl: "https://cabinet.example/verify/token-2",
      expiresInMinutes: 60,
    });

    expect(output.subject).toBe("Подтвердите email — Маркиро");
    expect(output.html).toContain("Подтвердите адрес электронной почты");
    expect(output.text).toContain("https://cabinet.example/verify/token-2");
    expect(output.text).toContain("60 минут");
  });
});
