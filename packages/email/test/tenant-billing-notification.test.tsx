import { describe, expect, it } from "vitest";
import { renderEmail } from "../src/index.js";

describe("tenant billing notification email", () => {
  it.each([
    {
      locale: "ru" as const,
      subject: "Требуется уточнение: Заявка №42 — Маркиро",
      greeting: "Здравствуйте, Елена.",
      event: "Маркиро запросил уточнение по заявке Заявка №42 организации Завод & Ко.",
      action: "Открыть заявку",
    },
    {
      locale: "en" as const,
      subject: "Clarification required: Request #42 — Markiro",
      greeting: "Hello, Elena.",
      event: "Markiro requested clarification for Request #42 at Factory & Co.",
      action: "Open request",
    },
  ])("renders a localized $locale clarification without leaking markup", async (fixture) => {
    const output = await renderEmail({
      kind: "tenant-billing-notification",
      locale: fixture.locale,
      recipientName: fixture.locale === "ru" ? "Елена" : "Elena",
      organizationName: fixture.locale === "ru" ? "Завод & Ко" : "Factory & Co",
      eventKind: "clarification_required",
      subjectName: fixture.locale === "ru" ? "Заявка №42" : "Request #42",
      actionUrl: "https://cabinet.markiro.test/billing/requests/request-id",
    });

    expect(output.subject).toBe(fixture.subject);
    expect(output.text).toContain(fixture.greeting);
    expect(output.text).toContain(fixture.event);
    expect(output.text).toContain(fixture.action);
    expect(output.html).toContain(fixture.locale === "ru" ? "Завод &amp; Ко" : "Factory &amp; Co");
    expect(output.html.match(/<a\b/g)).toHaveLength(1);
    expect(output.html).toContain(
      'href="https://cabinet.markiro.test/billing/requests/request-id"',
    );
  });

  it.each([
    ["offer_published", "Новое предложение: КП-42 — Маркиро", "Открыть предложение"],
    ["invoice_due_soon", "Счёт к оплате: Счёт №42 — Маркиро", "Открыть счёт"],
    ["act_ready", "Доступен акт: Акт №42 — Маркиро", "Открыть документы"],
  ] as const)("renders the Russian %s event", async (eventKind, subject, action) => {
    const output = await renderEmail({
      kind: "tenant-billing-notification",
      locale: "ru",
      recipientName: "Елена",
      organizationName: "Завод",
      eventKind,
      subjectName:
        eventKind === "offer_published"
          ? "КП-42"
          : eventKind === "act_ready"
            ? "Акт №42"
            : "Счёт №42",
      actionUrl: "https://cabinet.markiro.test/billing",
    });

    expect(output.subject).toBe(subject);
    expect(output.text).toContain(action);
  });

  it("escapes and bounds the only free-form billing subject", async () => {
    const output = await renderEmail({
      kind: "tenant-billing-notification",
      locale: "en",
      recipientName: "Ada",
      organizationName: "Factory",
      eventKind: "offer_published",
      subjectName: `<script>${"x".repeat(300)}</script>`,
      actionUrl: "https://cabinet.markiro.test/billing/offers/offer-id",
    });

    expect(output.subject).not.toContain("<script>");
    expect(output.subject.length).toBeLessThanOrEqual(200);
    expect(output.html).not.toContain("<script>");
    expect(output.html).not.toMatch(/bank|account|payload|attachment|storage|comment/i);
  });
});
