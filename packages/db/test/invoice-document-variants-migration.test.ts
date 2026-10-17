import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("invoice document variant migration", () => {
  it("preserves old files, allows a second variant, and rejects duplicates", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE invoice_documents (
        invoice_id uuid NOT NULL, revision integer NOT NULL, format text NOT NULL,
        print_variant text NOT NULL DEFAULT 'clean', object_key text,
        CONSTRAINT invoice_documents_invoice_revision_format_uq
          UNIQUE(invoice_id, revision, format)
      )`);
      const invoiceId = "11111111-1111-4111-8111-111111111111";
      await client.query(
        `INSERT INTO invoice_documents VALUES ($1, 1, 'pdf', 'clean', 'legacy/r1.pdf')`,
        [invoiceId],
      );
      const migration = await readFile(
        new URL("../migrations/0196_invoice_document_variants.sql", import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO invoice_documents VALUES ($1, 1, 'pdf', 'signed', 'r1-signed.pdf')`,
        [invoiceId],
      );
      expect(
        (
          await client.query(
            `SELECT print_variant, object_key FROM invoice_documents ORDER BY print_variant`,
          )
        ).rows,
      ).toEqual([
        { print_variant: "clean", object_key: "legacy/r1.pdf" },
        { print_variant: "signed", object_key: "r1-signed.pdf" },
      ]);
      await expect(
        client.query(
          `INSERT INTO invoice_documents VALUES ($1, 1, 'pdf', 'signed', 'duplicate.pdf')`,
          [invoiceId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.end();
    }
  });
});
