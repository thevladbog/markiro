import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

describe("platform user activation email", () => {
  it("invites a platform user to choose a password without claiming a reset was requested", async () => {
    const output = await renderEmail({
      kind: "platform-user-activation",
      recipientName: "Администратор",
      actionUrl: "https://saas.example/activate#token=single-use-token",
      expiresInMinutes: 60,
    });

    expect(output.subject).toBe("Доступ к платформе Маркиро");
    expect(output.html).toContain("Активировать доступ");
    expect(output.text).toContain("создан доступ к платформе управления Маркиро");
    expect(output.text).toContain("https://saas.example/activate#token=single-use-token");
    expect(output.text).toContain("60 минут");
    expect(output.text).toContain("двухфакторную аутентификацию");
    expect(output.text).not.toContain("получили запрос на смену пароля");
  });
});
