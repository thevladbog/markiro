import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

function expectNoTracking(output: { html: string; text: string }): void {
  expect(output.html).not.toMatch(/<img\b|<link\b|@font-face|url\(|\bsrc=["']/i);
  expect(output.html).not.toMatch(/tracking|pixel|unsubscribe|marketing|рассыл|реклам/i);
  expect(output.text).not.toContain("undefined");
}

describe("landing lead e-mails (spec 2026-10-20 §15)", () => {
  it("sends the download page, never the installer, with the SmartScreen steps", async () => {
    const output = await renderEmail({
      kind: "landing-download-link",
      locale: "ru",
      company: "ООО «Пивоварня» & Ко",
      downloadPageUrl: "https://markiro.app/skachat/",
      contactEmail: "hello@v-b.tech",
    });

    expect(output.subject).toBe("Ссылка на пробную версию Маркиро Автоном");
    expect(output.replyTo).toBe("hello@v-b.tech");
    expect(output.html).toContain('lang="ru"');
    expect(output.html).toContain('href="https://markiro.app/skachat/"');
    expect(output.html).not.toMatch(/\.exe|\.jws|releases\.markiro\.app/);
    expect(output.html).toContain("ООО «Пивоварня» &amp; Ко");
    expect(output.text).toContain("«Подробнее», затем «Выполнить в любом случае»");
    expect(output.text).toContain("Get-FileHash .\\<файл> -Algorithm SHA256");
    expect(output.text).toContain("14 дней с завершения мастера установки");
    expect(output.text).toContain("Созвон на 30 минут");
    expectNoTracking(output);
  });

  it("localizes the download e-mail", async () => {
    const output = await renderEmail({
      kind: "landing-download-link",
      locale: "en",
      company: "Factory",
      downloadPageUrl: "https://markiro.app/skachat/",
      contactEmail: "hello@v-b.tech",
    });
    expect(output.subject).toBe("Your link to the Markiro Standalone trial");
    expect(output.html).toContain('lang="en"');
    expect(output.text).toContain("“More info”, then “Run anyway”");
  });

  it("confirms an invoice request with the INN, plan and bridge demo file", async () => {
    const output = await renderEmail({
      kind: "landing-invoice-request-confirmation",
      locale: "ru",
      company: "ООО «Пивоварня»",
      inn: "7707083893",
      tariffCode: "line",
      email: "buyer@example.test",
      contactEmail: "hello@v-b.tech",
    });
    expect(output.subject).toBe("Мы получили запрос счёта — Маркиро");
    expect(output.replyTo).toBe("hello@v-b.tech");
    expect(output.text).toContain(
      "Компания: ООО «Пивоварня»\nИНН: 7707083893\nТариф: line\nПочта для счёта: buyer@example.test",
    );
    expect(output.text).toContain("демо-файл лицензии на 14 дней");
    expectNoTracking(output);
  });

  it("gives the owner the contacts, the attribution and the card link", async () => {
    const output = await renderEmail({
      kind: "landing-lead-notification",
      intent: "invoice",
      locale: "ru",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: new Date("2026-10-21T09:05:00Z"),
      sourcePath: "/stoimost/",
      consentVersion: "consent-v1",
      company: "ООО «Пивоварня»",
      email: "buyer@example.test",
      phone: "+79991234567",
      inn: "7707083893",
      tariffCode: "line",
      linesBucket: "2-3",
      utm: { source: "yandex", medium: "cpc" },
      firstContact: false,
      leadUrl: "https://admin.markiro.app/leads/22222222-2222-4222-8222-222222222222",
    });
    expect(output.subject).toBe("Запрос счёта · ООО «Пивоварня» — Маркиро");
    expect(output.replyTo).toBe("buyer@example.test");
    expect(output.text).toContain("Обращение от уже известного лида");
    expect(output.text).toContain("ИНН: 7707083893\nТариф: line\nEmail: buyer@example.test");
    expect(output.text).toContain("Телефон: +79991234567");
    expect(output.text).toContain("Линии: 2–3 линии");
    expect(output.text).toContain("UTM: yandex / cpc");
    expect(output.text).toContain("Получена: 21.10.2026, 09:05 UTC");
    expect(output.text).not.toContain("Имя:");
    expect(output.html).toContain(
      'href="https://admin.markiro.app/leads/22222222-2222-4222-8222-222222222222"',
    );
    expectNoTracking(output);
  });

  it("titles a first download as a new lead", async () => {
    const output = await renderEmail({
      kind: "landing-lead-notification",
      intent: "download",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: new Date("2026-10-21T09:05:00Z"),
      sourcePath: "/skachat/",
      consentVersion: "consent-v1",
      company: "Factory",
      email: "ada@example.test",
      firstContact: true,
      leadUrl: "https://admin.markiro.app/leads/22222222-2222-4222-8222-222222222222",
    });
    expect(output.subject).toBe("Скачивание · Factory — Маркиро");
    expect(output.text).toContain("С сайта пришёл новый лид.");
    expect(output.text).toContain("Язык посетителя: English (en)");
    expect(output.text).not.toContain("UTM:");
  });

  it("lists the digest sections with companies and links only", async () => {
    const output = await renderEmail({
      kind: "landing-lead-digest",
      digestDate: "2026-10-21",
      leadsUrl: "https://admin.markiro.app/leads",
      sections: [
        {
          section: "new_uncontacted",
          leads: [{ company: "Пивоварня", leadUrl: "https://admin.markiro.app/leads/a" }],
        },
        {
          section: "invoice_unpaid",
          leads: [
            { company: "Сидрерия", leadUrl: "https://admin.markiro.app/leads/b" },
            { company: "Квас", leadUrl: "https://admin.markiro.app/leads/c" },
          ],
        },
      ],
    });
    expect(output.subject).toBe("Кому пора написать · 21.10.2026 — Маркиро");
    expect(output.replyTo).toBeUndefined();
    expect(output.text).toContain("Новые без контакта (1)");
    expect(output.text).toContain("Счёт без оплаты больше 7 дней (2)");
    expect(output.text).not.toContain("3-й день");
    expect(output.html).toContain('href="https://admin.markiro.app/leads/b"');
    expect(output.text).not.toMatch(/@/);
    expectNoTracking(output);
  });
});
