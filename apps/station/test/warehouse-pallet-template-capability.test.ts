import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { PALLET_REPRINT_V2_PROTOCOL, UNIFIED_REPRINT_PROTOCOL } from "@markiro/domain";
import { thermalChoice } from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { createStationClient } from "../src/lib/api-client.js";
import { loadPalletTemplates } from "../src/lib/warehouse-reprint/pallet-templates.js";
it("requires V3 admission for offline V3 choices and preserves the legacy catalog", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const catalog = { protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [thermalChoice()] };
  await exec.run(
    "INSERT INTO warehouse_reprint_cache(owner,kind,identity,value_json) VALUES('owner','templates','pallet-v2',?)",
    [JSON.stringify(catalog)],
  );
  const client = createStationClient({
    apiKey: "synthetic-capability",
    serverUrl: "https://station.test",
  });
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    expect(await loadPalletTemplates(client, exec, "owner", UNIFIED_REPRINT_PROTOCOL)).toBeNull();
    expect(await loadPalletTemplates(client, exec, "owner")).toEqual(catalog);
    fetcher.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ protocols: [PALLET_REPRINT_V2_PROTOCOL, UNIFIED_REPRINT_PROTOCOL] }),
          { status: 200 },
        ),
    );
    fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify(catalog), { status: 200 }),
    );
    expect(await loadPalletTemplates(client, exec, "owner", UNIFIED_REPRINT_PROTOCOL)).toEqual(
      catalog,
    );
    expect(await loadPalletTemplates(client, exec, "owner", UNIFIED_REPRINT_PROTOCOL)).toEqual(
      catalog,
    );
  } finally {
    vi.unstubAllGlobals();
    db.close();
  }
});
