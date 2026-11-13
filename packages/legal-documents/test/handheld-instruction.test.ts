import { describe, expect, it } from "vitest";
import { findLegalDocument, findLegalRelease, requireLegalContent } from "../src/index.js";

describe("handheld warehouse instruction", () => {
  it("registers the new bilingual edition", () => {
    expect(findLegalRelease("MKR-INS-14").revision).toBe("2026.11/01");
  });

  it.each(["ru", "en"] as const)("documents the current warehouse workflow in %s", (locale) => {
    const content = requireLegalContent(findLegalDocument("MKR-INS-14"), locale);
    const section = (id: string) => JSON.stringify(content.sections.find((item) => item.id === id));

    expect(section("purpose")).toMatch(/1\.11\.0.*1\.7\.0/u);
    expect(section("pairing")).toContain("Линия");
    expect(section("sign-in")).toContain("Сменить оператора");
    expect(section("printer")).toContain("Открыть настройки приложения");
    expect(section("printer")).toContain("Коды маркировки");

    const disassembly = section("warehouse-disassembly");
    expect(disassembly).toContain("Сканируйте SSCC упаковки");
    expect(disassembly).toContain("Проверить результат");
    expect(disassembly).toMatch(/другом устройстве|another device/u);
    expect(disassembly).toMatch(/требует связи с хостом|requires a host connection/u);

    const reprint = section("site-reprint");
    expect(reprint).toContain("Найти и напечатать");
    expect(reprint).toContain("Проверить этикетку");
    expect(section("offline")).toContain("Открыть очередь хоста");
  });
});
