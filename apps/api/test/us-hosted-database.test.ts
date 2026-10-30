import { expect, it, vi } from "vitest";
import * as database from "@markiro/db";
import { createUsHostedDatabase } from "../src/deployment/us-hosted-database";

it("refuses forged release/material before constructing any database connection", () => {
  const connect = vi.spyOn(database, "createDb");
  try {
    for (const release of [null, undefined, {}, Object.freeze({ service: "worker" })]) {
      expect(() => createUsHostedDatabase(release, {})).toThrow("us_hosted_database_invalid");
    }
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});
