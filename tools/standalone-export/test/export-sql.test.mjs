import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runPsql } from "../cli.mjs";
import { ExportError, buildExportFile } from "../transform.mjs";

/**
 * `export.sql` against a database with the cloud's migrations applied. It
 * seeds two tenants with fixed ids (`fixtures/seed-cloud.sql`), so it runs
 * only where that is allowed: CI's `verify-api-tests` sets the variable to its
 * throwaway Postgres; locally, point it at a disposable one, never at a
 * shared or production database.
 */
const URL_VARIABLE = "STANDALONE_EXPORT_TEST_DATABASE_URL";
const databaseUrl = process.env[URL_VARIABLE];
const psql = process.env.PSQL ?? "psql";

/** libpq's environment for `url`, so no password goes on a command line. */
function pgEnv(url) {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.slice(1),
  };
}

function psqlRun(env, args) {
  const result = spawnSync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const exportSql = fileURLToPath(new URL("../export.sql", import.meta.url));

/** One psql session fed `script` on stdin; its status, stdout and stderr, whatever happened. */
function psqlScript(env, script, variables = []) {
  const result = spawnSync(psql, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...variables], {
    env,
    input: script,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** export.sql's JSON for `imp-test-atoll` after `statements` ran in the same session. */
function exportAfter(env, statements) {
  const result = psqlScript(env, [...statements, includeExport].join("\n"), [
    "-v",
    "tenant_id=imp-test-atoll",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const STATION_1 = "0a0d0000-0000-4000-8000-000000000001";
const ACTIVE_OCT7 = [{ monthKey: "OCT26", seq: 7, createdFrom: "admin" }];
const STALE_STATION_1 = [{ id: STATION_1, name: "Станция 1" }];

/** The `\i` line that runs export.sql inside a session that shaped its own tables first. */
const includeExport = `\\i '${exportSql.replaceAll("'", "''")}'\n`;

test(
  "export.sql reads one tenant, at one snapshot, exactly as the raw fixture",
  { skip: databaseUrl ? false : `set ${URL_VARIABLE} to a disposable cloud database` },
  async () => {
    const env = pgEnv(databaseUrl);
    psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
    psqlRun(env, ["-f", fixture("seed-cloud.sql")]);
    try {
      const clean = JSON.parse(await runPsql({ psql, tenantId: "imp-test-atoll", env }));
      assert.deepEqual(clean, JSON.parse(readFileSync(fixture("raw-cloud.json"), "utf8")));
      // The seeded A4 sheet (migration 0183) comes out with its format and
      // its two defaults counted, and the file leaves all three out.
      const SHEET = "0d0d0000-0000-4000-8000-000000000007";
      assert.equal(clean.templates.find((each) => each.id === SHEET)?.format, "pallet_sheet_v2");
      assert.ok(
        clean.templates
          .filter((each) => each.id !== SHEET)
          .every((each) => each.format === "label_v1"),
      );
      assert.equal(clean.palletSheetDefaults, 2);
      const fromSql = buildExportFile(clean, { exportedAt: "2026-10-09T18:30:00.000Z" });
      assert.ok(!fromSql.payload.templates.some((each) => each.id === SHEET));
      assert.deepEqual(
        fromSql.notes.filter(
          (note) => note.id === SHEET || note.code === "pallet_sheet_defaults_lost",
        ),
        [
          { code: "template_dropped", id: SHEET, reason: "pallet_sheet" },
          { code: "pallet_sheet_defaults_lost", count: 2 },
        ],
      );
      // Each default counts on its own: the organization's alone is one.
      assert.equal(
        exportAfter(env, [
          "DELETE FROM org_pallet_sheet_template_defaults WHERE tenant_id = 'imp-test-atoll';",
        ]).palletSheetDefaults,
        1,
      );
      psqlRun(env, [
        "-c",
        "INSERT INTO org_pallet_sheet_template_defaults (tenant_id, chz_product_group_code, template_id) VALUES ('imp-test-atoll', 8, '0d0d0000-0000-4000-8000-000000000007')",
      ]);

      // What a product loses on the way: the two causes the fixture has no
      // row for are added here (a default counterparty, a photo).
      const withExtras = exportAfter(env, [
        "INSERT INTO media_assets (id, owner_tenant_id, object_key, content_type, byte_size, checksum) VALUES ('0aaa0000-0000-4000-8000-000000000001', 'imp-test-atoll', 'imp-test/photo.jpg', 'image/jpeg', 1, 'x');",
        "INSERT INTO product_images (tenant_id, product_id, asset_id) VALUES ('imp-test-atoll', '0e0e0000-0000-4000-8000-000000000004', '0aaa0000-0000-4000-8000-000000000001');",
        "UPDATE products SET default_counterparty_id = '0c0c0000-0000-4000-8000-000000000001' WHERE id = '0e0e0000-0000-4000-8000-000000000004';",
      ]);
      assert.deepEqual(
        withExtras.products.map((product) => product.lost),
        [["price"], ["externalRef"], ["egaisCode"], ["defaultCounterparty", "photo"]],
      );

      // The other tenant's active shift and stale station did not count;
      // the same rows of this tenant do.
      psqlRun(env, [
        "-c",
        "UPDATE shifts SET status = 'active' WHERE id = '05050000-0000-4000-8000-000000000002'",
        "-c",
        "UPDATE station_devices SET last_seen_at = NULL WHERE id = '0a0d0000-0000-4000-8000-000000000001'",
      ]);
      const dirty = JSON.parse(await runPsql({ psql, tenantId: "imp-test-atoll", env }));
      assert.deepEqual(dirty.activeShifts, [{ monthKey: "OCT26", seq: 7, createdFrom: "admin" }]);
      assert.deepEqual(dirty.staleDevices, [
        { id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" },
      ]);
      assert.equal(dirty.plannedShifts, 1);

      // A station is stale only while it has not been seen since the last
      // close (a station seen exactly then is not), is not revoked, and holds
      // a live block; and only when some shift has closed. The station with
      // no block never counts.
      const lastClose = "2026-10-09 17:00:00+00";
      const setSeen = (at) =>
        `UPDATE station_devices SET last_seen_at = ${at} WHERE id = '${STATION_1}';`;
      assert.deepEqual(
        exportAfter(env, [setSeen(`'${lastClose}'`)]).staleDevices,
        [],
        "a station seen exactly at the last close is in sync",
      );
      assert.deepEqual(
        exportAfter(env, [setSeen(`'${lastClose}'::timestamptz - interval '1 second'`)])
          .staleDevices,
        STALE_STATION_1,
      );
      assert.deepEqual(
        exportAfter(env, [
          setSeen("NULL"),
          `UPDATE sscc_blocks SET revoked_at = now() WHERE device_id = '${STATION_1}';`,
        ]).staleDevices,
        [],
        "a station whose blocks are all revoked holds nothing",
      );
      assert.deepEqual(
        exportAfter(env, [
          `UPDATE sscc_blocks SET revoked_at = NULL WHERE device_id = '${STATION_1}';`,
          `UPDATE station_devices SET revoked_at = now() WHERE id = '${STATION_1}';`,
        ]).staleDevices,
        [],
        "a revoked station is not waited for",
      );
      const neverClosed = exportAfter(env, [
        `UPDATE station_devices SET revoked_at = NULL WHERE id = '${STATION_1}';`,
        "UPDATE shifts SET closed_at = NULL WHERE tenant_id = 'imp-test-atoll';",
      ]);
      assert.deepEqual(neverClosed.staleDevices, [], "no shift ever closed, nothing is held back");
      assert.deepEqual(neverClosed.activeShifts, ACTIVE_OCT7);

      const missing = JSON.parse(await runPsql({ psql, tenantId: "imp-test-nobody", env }));
      assert.equal(missing.tenant, null);
      assert.equal(missing.orgProfile, null);
      assert.deepEqual(missing.products, []);
      assert.deepEqual(missing.shiftNumberMaxima, []);
      assert.deepEqual(missing.otherTenantsSscc, []);
      // What the SQL prints is what the transform reads: a missing tenant is
      // its own refusal, not a TypeError from a list that is not there.
      assert.throws(
        () => buildExportFile(missing, { exportedAt: "2026-10-09T18:30:00.000Z" }),
        (error) => error instanceof ExportError && error.code === "tenant_not_found",
      );

      // The transaction is what its first line says: read-only, one snapshot.
      const begin = readFileSync(exportSql, "utf8")
        .replace(/--[^\n]*/gu, "")
        .split(";")[0]
        .trim();
      const write = psqlScript(
        env,
        `${begin};\nINSERT INTO organization (id, name, slug, created_at) VALUES ('imp-test-write', 'x', 'imp-test-write', now());\n`,
      );
      assert.notEqual(write.status, 0, "a write ran inside export.sql's transaction");
      assert.match(write.stderr, /read-only transaction/u);
      const modes = psqlScript(
        env,
        `${begin};\nSHOW transaction_isolation;\nSHOW transaction_read_only;\n`,
      );
      assert.equal(modes.status, 0, modes.stderr);
      assert.equal(modes.stdout, "repeatable read\non\n");

      // A column or a table the export does not know is ignored (the session
      // shadows `products` with a copy that has one more column, and adds a
      // table of its own); a column it needs and the schema lacks stops psql.
      const tolerated = psqlScript(
        env,
        [
          "CREATE TEMP TABLE products (LIKE public.products INCLUDING DEFAULTS);",
          "ALTER TABLE pg_temp.products ADD COLUMN imp_test_extra text DEFAULT 'x';",
          "INSERT INTO pg_temp.products SELECT * FROM public.products;",
          "CREATE TEMP TABLE imp_test_new_table (id int);",
          includeExport,
        ].join("\n"),
        ["-v", "tenant_id=imp-test-atoll"],
      );
      assert.equal(tolerated.status, 0, tolerated.stderr);
      assert.deepEqual(
        JSON.parse(tolerated.stdout),
        JSON.parse(await runPsql({ psql, tenantId: "imp-test-atoll", env })),
      );
      const lacking = psqlScript(
        env,
        [
          "CREATE TEMP TABLE products AS SELECT id, tenant_id, gtin14, name FROM public.products WHERE false;",
          includeExport,
        ].join("\n"),
        ["-v", "tenant_id=imp-test-atoll"],
      );
      assert.notEqual(lacking.status, 0, "export.sql ran without a column it needs");
      assert.match(lacking.stderr, /print_name/u);
      assert.equal(lacking.stdout, "");

      // The organization's own GLN prefix is watched even when this tenant
      // never issued under it: here it has no counter, block or printed code
      // there (a legacy box printed before blocks is the only trace), and the
      // other tenant holds a counter under it. The legacy box still counts,
      // and the other tenant stops the export.
      const shared = exportAfter(env, [
        "DELETE FROM boxes WHERE tenant_id = 'imp-test-atoll' AND sscc LIKE '_460068200%';",
        "DELETE FROM pallets WHERE tenant_id = 'imp-test-atoll' AND sscc LIKE '_460068200%';",
        "DELETE FROM sscc_blocks WHERE tenant_id = 'imp-test-atoll' AND issuer_prefix = '460068200';",
        "DELETE FROM sscc_counters WHERE tenant_id = 'imp-test-atoll' AND issuer_prefix = '460068200';",
        "INSERT INTO boxes (id, tenant_id, shift_id, device_box_id, sscc) VALUES ('0b0c0000-0000-4000-8000-000000000007', 'imp-test-atoll', '05050000-0000-4000-8000-000000000001', 'box-7', '046006820000312344');",
        "INSERT INTO sscc_counters (tenant_id, issuer_prefix, extension_digit, next_serial) VALUES ('imp-test-other', '460068200', 1, 13);",
      ]);
      assert.deepEqual(
        shared.ssccCounters.map((each) => each.issuerPrefix),
        ["460123400"],
        "this tenant has no counter under its own prefix",
      );
      assert.deepEqual(
        shared.ssccPrinted.filter((each) => each.issuerPrefix === "460068200"),
        [{ issuerPrefix: "460068200", extension: 0, maxSerial: 31234 }],
      );
      assert.deepEqual(
        shared.otherTenantsSscc.filter((each) => each.issuerPrefix === "460068200"),
        [{ issuerPrefix: "460068200", extension: 1, maxSerial: 12 }],
      );
      assert.throws(
        // The earlier steps left this tenant's cloud dirty: a rehearsal reads past
        // that, and the shared prefix still stops it.
        () => buildExportFile(shared, { exportedAt: "2026-10-09T18:30:00.000Z", rehearsal: true }),
        (error) => error instanceof ExportError && error.code === "sscc_prefix_shared",
      );
      const sharedFile = buildExportFile(shared, {
        exportedAt: "2026-10-09T18:30:00.000Z",
        rehearsal: true,
        acceptSharedPrefix: true,
      });
      assert.deepEqual(
        sharedFile.cutover.ssccCounters
          .filter((each) => each.issuerPrefix === "460068200")
          .map((each) => [each.extension, each.issuedMax, each.standaloneStart]),
        [
          [0, 31234, 40000],
          [1, null, 0],
        ],
      );
      assert.deepEqual(
        sharedFile.notes.filter((note) => note.code === "sscc_prefix_shared"),
        [{ code: "sscc_prefix_shared", issuerPrefix: "460068200", extension: 1 }],
      );
    } finally {
      psqlRun(env, ["-f", fixture("cleanup-cloud.sql")]);
    }
  },
);
