import { describe, expect, it } from "vitest";
import { getRequestCopy, requestCopy } from "../src/us/requests/copy.js";

describe("Requests EN/ES module copy", () => {
  it("selects Spanish only for es-US and falls back to English", () => {
    expect(getRequestCopy("es-US").title).toBe("Solicitudes");
    for (const language of ["en-US", "ru-RU", "es", "es-MX", ""])
      expect(getRequestCopy(language).title).toBe("Requests");
  });
  it("has matching translated keys with nonempty values", () => {
    expect(Object.keys(requestCopy["es-US"]).sort()).toEqual(
      Object.keys(requestCopy["en-US"]).sort(),
    );
    for (const copy of Object.values(requestCopy))
      for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0);
  });
  it("explains AND between selectors and OR within lists in both languages", () => {
    for (const copy of Object.values(requestCopy)) {
      expect(copy.scopeHelp).toContain("AND");
      expect(copy.scopeHelp).toContain("OR");
    }
  });
  it("makes no literal approval, submission or compliance claim", () => {
    for (const copy of Object.values(requestCopy))
      for (const value of Object.values(copy))
        expect(value).not.toMatch(
          /\b(approved|compliant|compliance guaranteed|send to FDA|aprobado|cumplimiento garantizado|enviar a FDA)\b/i,
        );
  });
});
