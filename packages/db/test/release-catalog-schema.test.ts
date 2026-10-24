import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
describe("release catalog schema", () => {
  it("exports durable publication, channel and recovery state", () => {
    for (const name of [
      "releaseCatalogEpochs",
      "releaseCatalogIntents",
      "releaseCatalogPublications",
      "releaseCatalogObjects",
      "releaseCatalogReservations",
      "releaseCatalogChannels",
      "releaseCatalogChannelEvents",
      "releaseCatalogReceipts",
      "releaseCatalogOidcBindings",
    ])
      expect(schema).toHaveProperty(name);
  });
  it("uniquely reserves a product/channel/version and binds pointer namespace", () => {
    const publication = getTableConfig(schema.releaseCatalogPublications);
    expect(
      publication.uniqueConstraints.some(
        (c) => c.columns.map((v) => v.name).join(",") === "product,channel,version",
      ),
    ).toBe(true);
    const channels = getTableConfig(schema.releaseCatalogChannels);
    expect(
      channels.foreignKeys.some(
        (c) =>
          c
            .reference()
            .columns.map((v) => v.name)
            .join(",") === "publication_id,product,channel",
      ),
    ).toBe(true);
  });
});
