import { describe, expect, it } from "vitest";

import { directoryProblem } from "../src/office/backups/backup-dir.js";

describe("directoryProblem", () => {
  it.each([
    "E:\\Markiro",
    "E:/Markiro",
    "E:\\",
    "C:\\Program Files\\Markiro copies",
    "\\\\ADMIN-PC\\MarkiroCopies",
    "\\\\ПК-АДМИНИСТРАТОРА\\Копии\\Ежедневные",
    "//ADMIN-PC/MarkiroCopies",
    "E:\\a..b",
  ])("takes %s", (text) => {
    expect(directoryProblem(text)).toBeNull();
  });

  it.each([
    "\\\\?\\C:\\Markiro",
    "\\\\?\\UNC\\ADMIN-PC\\MarkiroCopies",
    "\\\\.\\E:\\",
    "//?/C:/Markiro",
    "//./E:/",
  ])("names %s a device path, however the share is written inside it", (text) => {
    expect(directoryProblem(text)).toBe("device");
  });

  it.each(["E:\\a\\..\\b", "E:\\..", "\\\\PC\\Share\\..\\x", "E:/a/../b"])(
    "refuses a .. part in %s",
    (text) => {
      expect(directoryProblem(text)).toBe("parent");
    },
  );

  it.each([
    "Markiro",
    "\\Markiro",
    "E:Markiro",
    "E:",
    ".\\copies",
    "/var/copies",
    "\\\\ADMIN-PC",
    "\\\\ADMIN-PC\\",
    "\\\\\\Share",
  ])("asks for a full path instead of %s", (text) => {
    expect(directoryProblem(text)).toBe("notAbsolute");
  });
});
