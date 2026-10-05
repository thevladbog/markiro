import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import LandingFooter from "../src/components/LandingFooter.astro";
import type { PublicPhone } from "../src/lib/site-config";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

const PHONE: PublicPhone = { display: "+7 960 495-46-10", href: "tel:+79604954610" };

async function render(locale: "ru" | "en", phone: PublicPhone | null): Promise<Document> {
  const html = await container.renderToString(LandingFooter, {
    props: { page: { locale }, phone },
  });
  return new JSDOM(html).window.document;
}

describe("landing footer contacts", () => {
  it("lists the phone, email, Telegram and operator requisites", async () => {
    const document = await render("ru", PHONE);
    const contacts = document.querySelector("[data-footer-contacts]");

    expect(contacts?.querySelector('a[href="tel:+79604954610"]')?.textContent).toBe(
      "+7 960 495-46-10",
    );
    expect(contacts?.querySelector('a[href="mailto:hello@markiro.app"]')?.textContent).toBe(
      "hello@markiro.app",
    );
    expect(contacts?.querySelector('a[href="https://t.me/thevladbog"]')?.textContent).toBe(
      "Telegram @thevladbog",
    );
    expect(document.querySelector("[data-footer-requisites]")?.textContent).toBe(
      "ИП Богатырев Владислав Сергеевич · ИНН 234106228141 · ОГРНИП 321237500100358",
    );
  });

  it("states the requisites in English on English pages", async () => {
    const document = await render("en", PHONE);

    expect(document.querySelector("[data-footer-requisites]")?.textContent).toBe(
      "Sole proprietor Vladislav Bogatyrev · INN 234106228141 · OGRNIP 321237500100358",
    );
  });

  it("omits the phone link when no public phone is configured", async () => {
    const document = await render("ru", null);
    const contacts = document.querySelector("[data-footer-contacts]");

    expect(contacts?.querySelector('a[href^="tel:"]')).toBeNull();
    expect(contacts?.querySelector('a[href="mailto:hello@markiro.app"]')).not.toBeNull();
  });
});
