import { describe, expect, it } from "vitest";

import {
  renderPairingCardFragment,
  renderPairingCardHtml,
  type PairingCardData,
} from "../src/index.js";

const DATA: PairingCardData = {
  payload: "markiro-host:1?h=192.168.1.10&p=45710&f=ab12&c=0123456789",
  code: "0123456789",
  addresses: ["192.168.1.10:45710", "10.0.0.5:45710"],
  fingerprint: "AB12 CD34 EF56 7890 AB12 CD34 EF56 7890",
  validMinutes: 10,
  validUntil: "14:35",
  organizationName: "ООО «Атолл» <тест> & Ко",
};

describe("pairing card", () => {
  it("prints the code, addresses, fingerprint, lifetime and a DataMatrix", () => {
    const html = renderPairingCardHtml(DATA, "a4");
    expect(html).toContain("@page { size: A4 portrait; margin: 0 }");
    expect(html).toContain("01234 56789");
    expect(html).toContain("192.168.1.10:45710<br/>10.0.0.5:45710");
    expect(html).toContain("AB12 CD34 EF56 7890 AB12 CD34 EF56 7890");
    expect(html).toContain("10 мин, код одноразовый; действует до 14:35");
    expect(html).toMatch(/<div class="pc-matrix"><svg/);
    expect(html).toContain("ООО «Атолл» &lt;тест&gt; &amp; Ко");
  });

  it("lays out A5 on its own page and says so when there is no address", () => {
    const html = renderPairingCardHtml(
      { ...DATA, addresses: [], validUntil: null, organizationName: null },
      "a5",
    );
    expect(html).toContain("@page { size: A5 portrait; margin: 0 }");
    expect(html).toContain("нет адреса в локальной сети");
    expect(html).not.toContain("действует до");
    expect(html).not.toContain('class="pc-org"');
  });

  it("gives a fragment that is well-formed XML, for the SVG foreignObject of a PDF", () => {
    const { html, widthMm, heightMm } = renderPairingCardFragment(DATA, "a4");
    expect([widthMm, heightMm]).toEqual([210, 297]);
    expect(html).not.toMatch(/&nbsp;|<br>|<img[^/]*[^/]>/);
    // Every entity is one of the five XML predefined ones.
    for (const entity of html.match(/&[^;\s]*;/g) ?? []) {
      expect(["&amp;", "&lt;", "&gt;", "&quot;", "&#39;"]).toContain(entity);
    }
    expect(renderPairingCardFragment(DATA, "a5").heightMm).toBe(210);
  });
});
