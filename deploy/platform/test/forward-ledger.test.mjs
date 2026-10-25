import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  buildProductMigrationProof,
  validateProductMigrationLedger,
  observeForwardMigrationLedger,
  forwardMigrationQuery,
} from "../host/forward-ledger.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
import { productFiles, proofInput } from "./forward-product-fixture.mjs";
const rows = () =>
  productFiles()
    .slice(1)
    .map((f, i) => ({ hash: hash(f.bytes), createdAt: String(1784674164506 + i) }));
test("exact complete ordered ledger is frozen and bound to original SQL and product image", () => {
  const proof = buildProductMigrationProof(proofInput());
  assert.equal(proof.productSha, "a".repeat(40));
  assert.equal(proof.entries[0].hash, rows()[0].hash);
  assert.deepEqual(validateProductMigrationLedger(rows(), proof), rows());
  assert.ok(Object.isFrozen(proof.entries));
  assert.ok(Object.isFrozen(validateProductMigrationLedger(rows(), proof)[0]));
  assert.throws(() =>
    validateProductMigrationLedger(rows(), { ...proof, imageId: `sha256:${"f".repeat(64)}` }),
  );
});
for (const kind of [
  "missing",
  "extra",
  "duplicate",
  "reordered",
  "hash",
  "timestamp",
  "extra-field",
])
  test(`complete ledger rejects ${kind} without count shortcuts`, () => {
    const proof = buildProductMigrationProof(proofInput()),
      actual = rows();
    if (kind === "missing") actual.pop();
    if (kind === "extra") actual.push(actual[0]);
    if (kind === "duplicate") actual[1] = actual[0];
    if (kind === "reordered") actual.reverse();
    if (kind === "hash") actual[0].hash = "f".repeat(64);
    if (kind === "timestamp") actual[0].createdAt = "1784674164507";
    if (kind === "extra-field") actual[0].raw = "PRIVATE-SENTINEL";
    assert.throws(() => validateProductMigrationLedger(actual, proof));
  });
for (const kind of [
  "source",
  "image",
  "reference",
  "missing-sql",
  "extra-sql",
  "duplicate-path",
  "unsafe-path",
  "link",
  "oversize",
  "journal-order",
])
  test(`product proof rejects ${kind}`, () => {
    const input = proofInput();
    if (kind === "source") input.productSha = "main";
    if (kind === "image") input.imageId = "latest";
    if (kind === "reference") input.imageReference = "ghcr.io/thevladbog/markiro-api:latest";
    if (kind === "missing-sql") input.files.pop();
    if (kind === "extra-sql")
      input.files.push({ path: "9999_unknown.sql", bytes: Buffer.from("SELECT 9;") });
    if (kind === "duplicate-path") input.files.push(input.files[1]);
    if (kind === "unsafe-path") input.files[1].path = "../escape.sql";
    if (kind === "link") input.files[1].type = "symlink";
    if (kind === "oversize") input.files[1].bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    if (kind === "journal-order") {
      const j = JSON.parse(input.files[0].bytes);
      j.entries.reverse();
      input.files[0].bytes = Buffer.from(JSON.stringify(j));
    }
    assert.throws(() => buildProductMigrationProof(input));
  });
test("ledger observation uses one read-only snapshot for full ledger, system ID and catalog digest", async () => {
  const proof = buildProductMigrationProof(proofInput());
  let called = 0;
  const result = await observeForwardMigrationLedger({
    postgresId: "c".repeat(64),
    proof,
    root: "/private/fixture",
    runProcess: async (request) => {
      called++;
      assert.equal(request.args.at(-1), forwardMigrationQuery);
      assert.ok(
        request.args.includes(
          "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
        ),
      );
      return {
        stdout: Buffer.from(
          JSON.stringify({
            schema: {
              systemId: "123",
              schemaSha256: "e".repeat(64),
              migrationSha256: "f".repeat(64),
              migrationCount: "2",
            },
            rows: rows(),
          }),
        ),
      };
    },
  });
  assert.equal(called, 1);
  assert.equal(result.schema.systemId, "123");
  assert.equal(result.productProofSha256, proof.proofSha256);
});
