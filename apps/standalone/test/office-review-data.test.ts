import { describe, expect, it } from "vitest";

import { api, user } from "./harness/office-review/data.js";

describe("Office browser review users", () => {
  it("lists the signed-in administrator and a distinct technologist with their own identities", async () => {
    const users = await api.listUsers("office-preview-session");
    expect(users).toHaveLength(2);
    expect(new Set(users.map((record) => record.id)).size).toBe(2);
    expect(users.find((record) => record.id === user.id)).toMatchObject({
      id: user.id,
      login: user.login,
      name: user.name,
      role: "admin",
      active: true,
    });
    const technologist = users.find((record) => record.role === "technologist");
    expect(technologist).toMatchObject({ login: "tech", name: "Павел Орлов", active: true });
    expect(technologist?.id).not.toBe(user.id);
  });
});
