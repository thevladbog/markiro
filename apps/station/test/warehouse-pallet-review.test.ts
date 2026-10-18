import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  makePalletLabelSource,
  buildPalletLabelTemplates,
  warehouseBoxSource,
  PALLET_REPRINT_PROTOCOL,
  PALLET_PRODUCTION_DELIVERY_PROTOCOL,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import {
  readProductionPalletFields,
  savePalletLabelSource,
  resolveWarehousePalletSource,
} from "../src/lib/warehouse-reprint/pallet-sources.js";
import { syncWarehousePallets } from "../src/lib/warehouse-reprint/pallet-sync.js";
import type { StationClient } from "../src/lib/api-client.js";
function source(sscc = "146000000000001231") {
  const template = buildPalletLabelTemplates()[0];
  if (!template) throw new Error("Missing template");
  return makePalletLabelSource({
    version: 1,
    sscc,
    shiftId: "00000000-0000-4000-8000-000000000001",
    closedAt: "2026-10-11T00:00:00.000Z",
    boxCount: 1,
    itemCount: 1,
    boxSsccs: ["046000000000001234"],
    compositionDigest: "a".repeat(64),
    rendering: {
      kind: "thermal",
      rendererVersion: "thermal-v1",
      template: template.spec,
      brandingJson: null,
      fields: { ...warehouseBoxSource().fields, sscc, qty: "1", "qty.boxes": "1" },
    },
  });
}
it("does not let one retryable source starve another source", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const first = source(),
      second = source("246000000000001238");
    await savePalletLabelSource(exec, "owner", first);
    await savePalletLabelSource(exec, "owner", second);
    const revisions: string[] = [];
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>(_path: string, body?: unknown) => {
        const parsed = body as { entries: Array<{ revision: string }> };
        const revision = parsed.entries[0]?.revision;
        revisions.push(revision ?? "");
        return {
          protocol: PALLET_REPRINT_PROTOCOL,
          results: [{ revision, status: revision === first.revision ? "retryable" : "accepted" }],
        } as T;
      },
    };
    await syncWarehousePallets(exec, client, "owner", () => true);
    await syncWarehousePallets(exec, client, "owner", () => true);
    expect(revisions).toEqual([first.revision, second.revision]);
  } finally {
    db.close();
  }
});
it("uses a positively cached lookup offline on a station without the production mirrors", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const saved = source(),
      raw = "010460068200001321abcDEF1234567\u001d93crypto";
    const client: StationClient = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>() => ({ status: "found", source: saved }) as T,
      download: async () => new Blob(),
      whoami: async () => ({ ok: true }),
    };
    for (const scan of [saved.sscc, saved.boxSsccs[0] ?? "", raw])
      await resolveWarehousePalletSource(
        client,
        exec,
        "owner",
        scan,
        "00000000-0000-4000-8000-000000000004",
      );
    const offline = {
      ...client,
      get: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    };
    for (const scan of [saved.sscc, saved.boxSsccs[0] ?? "", raw])
      expect(
        (
          await resolveWarehousePalletSource(
            offline,
            exec,
            "owner",
            scan,
            "00000000-0000-4000-8000-000000000004",
          )
        ).source.revision,
      ).toBe(saved.revision);
  } finally {
    db.close();
  }
});

import { settleWarehousePalletJob } from "../src/lib/warehouse-reprint/pallet-printing.js";
it("publishes explicit resolution and native delivery resolution atomically", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const saved = source(),
      jobId = "00000000-0000-4000-8000-000000000010",
      attemptId = "00000000-0000-4000-8000-000000000011",
      operatorId = "00000000-0000-4000-8000-000000000004";
    const event = {
      eventId: crypto.randomUUID(),
      jobId,
      attemptId,
      operatorId,
      sscc: saved.sscc,
      sourceRevision: saved.revision,
      reason: "damaged",
      state: "delivery_unknown",
      occurredAt: "2026-10-11T00:00:00.000Z",
      printFormat: "mono-raster-v1",
      bytesDigest: "b".repeat(64),
    };
    await exec.run(
      "INSERT INTO warehouse_pallet_jobs(owner,job_id,sscc,source_revision,source_json,profile_json,bytes_base64,bytes_digest,state,event_json) VALUES('owner',?,?,?,'{}','{}','AQ==',?,'delivery_unknown',?)",
      [jobId, saved.sscc, saved.revision, event.bytesDigest, JSON.stringify(event)],
    );
    const scope = JSON.stringify(["warehouse-pallet", "owner", jobId]);
    await exec.run(
      "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES(?,'pallet',?,?,'delivery_unknown','{}',?,'AQ==','label','2026-10-11T00:00:00Z')",
      [scope, saved.sscc, attemptId, event.bytesDigest],
    );
    const interrupted = {
      all: exec.all.bind(exec),
      run: async (sql: string, params?: unknown[]) => {
        await exec.run(sql, params);
        if (sql.startsWith("UPDATE warehouse_pallet_jobs"))
          throw new Error("power loss after commit");
      },
    };
    await expect(
      settleWarehousePalletJob(interrupted, "owner", jobId, operatorId, "skipped"),
    ).rejects.toThrow("power loss");
    expect(
      (await exec.all<{ state: string }>("SELECT state FROM warehouse_pallet_jobs"))[0]?.state,
    ).toBe("skipped");
    expect(
      (
        await exec.all<{ resolved_at: string | null }>("SELECT resolved_at FROM printer_deliveries")
      )[0]?.resolved_at,
    ).not.toBeNull();
  } finally {
    db.close();
  }
});
it("recovers a newly closed skipped pallet from frozen closure facts without a successful initial render", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const saved = source();
    if (saved.rendering.kind !== "thermal") throw new Error("Expected thermal");
    const template = {
      ...saved.rendering.template,
      elements: saved.rendering.template.elements.filter((e) => e.kind !== "organization_logo"),
    };
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('product','04600682000013','Frozen','active',1)",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id,production_date,pallet_label_template_spec) VALUES(?,'active','aggregation','product','2026-10-11',?)",
      [saved.shiftId, JSON.stringify(template)],
    );
    await exec.run(
      "INSERT INTO pallets_mirror(pallet_id,shift_id,sscc,opened_at) VALUES('pallet',?,?,'2026-10-11T00:00:00Z')",
      [saved.shiftId, saved.sscc],
    );
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,pallet_id) VALUES('box',?,?,'2026-10-11T00:00:00Z','2026-10-11T00:00:01Z','pallet')",
      [saved.shiftId, saved.boxSsccs[0] ?? ""],
    );
    await exec.run(
      "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,?,'04600682000013','serial','2026-10-11T00:00:00Z','box')",
      ["a".repeat(64), saved.shiftId],
    );
    await exec.run(
      "UPDATE pallets_mirror SET closed_at='2026-10-11T00:00:01Z',print_state='skipped',print_skipped_at='2026-10-11T00:01:00Z'",
    );
    await exec.run(
      "UPDATE product_mirror SET name='Changed',shelf_life_days=365; UPDATE shift_mirror SET production_date='2026-10-12',pallet_label_template_spec=NULL",
    );
    const client: StationClient = {
      get: async () => {
        throw new TypeError("Failed to fetch");
      },
      post: async () => {
        throw new Error("Offline");
      },
      download: async () => new Blob(),
      whoami: async () => ({ ok: true }),
    };
    const found = await resolveWarehousePalletSource(
      client,
      exec,
      "owner",
      saved.sscc,
      "00000000-0000-4000-8000-000000000004",
    );
    expect(found.source.rendering).toMatchObject({
      kind: "thermal",
      fields: { "product.name": "Frozen", date: "11.10.2026", expiry: "11.10.2026" },
    });
  } finally {
    db.close();
  }
});

it("does not invent historical fields from an incomplete legacy closure", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    await exec.run(
      "INSERT INTO warehouse_pallet_closures(sscc,pallet_id,shift_id,closed_at,context_json) VALUES(?,?,?,?,?)",
      [
        "146000000000001231",
        "p",
        "s",
        "2026-10-11T00:00:00Z",
        JSON.stringify({
          productName: null,
          productPrintName: null,
          gtin14: null,
          egaisCode: null,
          shelfLifeDays: null,
          productionDate: null,
          shiftNumber: null,
          counterpartyName: null,
        }),
      ],
    );
    expect(
      await readProductionPalletFields(exec, "146000000000001231", { boxCount: 1, itemCount: 1 }),
    ).toBeNull();
    expect(await exec.all("SELECT 1 FROM warehouse_pallet_sources")).toEqual([]);
  } finally {
    db.close();
  }
});

it.each(["accepted", "retryable", "conflict"] as const)(
  "resends the saved production receipt on unresolved lookup (%s), without changing its facts",
  async (status) => {
    const db = new DatabaseSync(":memory:"),
      exec = makeRotatingExec([db, db]);
    await applyMigrations(exec);
    try {
      const saved = source(),
        owner = "owner";
      await savePalletLabelSource(exec, owner, saved);
      const evidence = {
        sourceRevision: saved.revision,
        sequence: 2,
        attemptId: "production-1",
        bytesDigest: "b".repeat(64),
        state: "sent",
        occurredAt: "2026-10-11T00:00:02.000Z",
      };
      await exec.run("UPDATE warehouse_pallet_sources SET production_delivery_json=?", [
        JSON.stringify(evidence),
      ]);
      let uploaded = false;
      const post = vi.fn(async (path: string, body?: unknown) => {
        if (path.endsWith("/pallet-sources")) {
          expect(body).toEqual({
            protocol: PALLET_REPRINT_PROTOCOL,
            entries: [saved],
            productionDelivery: evidence,
          });
          uploaded = status === "accepted";
          return {
            protocol: PALLET_REPRINT_PROTOCOL,
            results: [{ revision: saved.revision, status }],
          };
        }
        return uploaded
          ? { status: "found", source: saved }
          : { status: "unavailable", code: "delivery_unresolved" };
      });
      const client: StationClient = {
        get: async <T>() =>
          ({ protocols: [PALLET_REPRINT_PROTOCOL, PALLET_PRODUCTION_DELIVERY_PROTOCOL] }) as T,
        post: async <T>(path: string, body?: unknown) => (await post(path, body)) as T,
        download: async () => new Blob(),
        whoami: async () => ({ ok: true }),
      };
      const result = resolveWarehousePalletSource(
        client,
        exec,
        owner,
        saved.sscc,
        "00000000-0000-4000-8000-000000000004",
      );
      if (status === "accepted") expect((await result).source).toEqual(saved);
      else await expect(result).rejects.toThrow("WAREHOUSE_PALLET_DELIVERY_UNRESOLVED");
      expect(post.mock.calls.filter(([path]) => path.endsWith("/pallet-sources"))).toHaveLength(1);
      const rows = await exec.all<{ value_json: string; production_delivery_json: string }>(
        "SELECT value_json,production_delivery_json FROM warehouse_pallet_sources",
      );
      expect(JSON.parse(rows[0]?.value_json ?? "null")).toEqual(saved);
      expect(JSON.parse(rows[0]?.production_delivery_json ?? "null")).toEqual(evidence);
    } finally {
      db.close();
    }
  },
);

it.each(["delivery_unresolved", "composition_changed", "network"] as const)(
  "does not bypass the authoritative %s response after receipt resync",
  async (failure) => {
    const db = new DatabaseSync(":memory:"),
      exec = makeRotatingExec([db, db]);
    await applyMigrations(exec);
    try {
      const saved = source();
      await savePalletLabelSource(exec, "owner", saved);
      await exec.run("UPDATE warehouse_pallet_sources SET production_delivery_json=?", [
        JSON.stringify({
          sourceRevision: saved.revision,
          sequence: 2,
          attemptId: "production-1",
          bytesDigest: "b".repeat(64),
          state: "sent",
          occurredAt: "2026-10-11T00:00:02.000Z",
        }),
      ]);
      let uploaded = false;
      const client: StationClient = {
        get: async <T>() =>
          ({ protocols: [PALLET_REPRINT_PROTOCOL, PALLET_PRODUCTION_DELIVERY_PROTOCOL] }) as T,
        post: async <T>(path: string) => {
          if (path.endsWith("/pallet-sources")) {
            uploaded = true;
            return {
              protocol: PALLET_REPRINT_PROTOCOL,
              results: [{ revision: saved.revision, status: "accepted" }],
            } as T;
          }
          if (uploaded && failure === "network") throw new TypeError("Failed to fetch");
          return { status: "unavailable", code: uploaded ? failure : "delivery_unresolved" } as T;
        },
        download: async () => new Blob(),
        whoami: async () => ({ ok: true }),
      };
      await expect(
        resolveWarehousePalletSource(
          client,
          exec,
          "owner",
          saved.sscc,
          "00000000-0000-4000-8000-000000000004",
        ),
      ).rejects.toThrow(
        failure === "composition_changed"
          ? "WAREHOUSE_PALLET_COMPOSITION_CHANGED"
          : "WAREHOUSE_PALLET_DELIVERY_UNRESOLVED",
      );
    } finally {
      db.close();
    }
  },
);
