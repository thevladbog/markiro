import { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { hashSecret } from "../src/lib/crypto.js";
import { OperatorLogin } from "../src/pages/OperatorLogin.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

async function seedOperator(exec: SqlExecutor, pin: string): Promise<void> {
  await exec.run(
    `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active) VALUES (?,?,?,?,?,?)`,
    ["op1", "Ivan", "operator", await hashSecret(pin), null, 1],
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("OperatorLogin", () => {
  it("accepts a correct PIN against the seeded mirror and calls onAuthed", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await seedOperator(exec, "4321");

    const onAuthed = vi.fn();
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);
    for (const d of "4321") fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(onAuthed).toHaveBeenCalledWith(expect.objectContaining({ operatorId: "op1" })),
    );
  });

  it("shows a floor error on a wrong PIN and does not authenticate", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await seedOperator(exec, "4321");
    const onAuthed = vi.fn();
    render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);
    for (const d of "0000") fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(screen.getByText("Wrong PIN")).toBeDefined());
    expect(onAuthed).not.toHaveBeenCalled();
  });
});
