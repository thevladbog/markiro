import { pathToFileURL } from "node:url";
import { createCatalogClient } from "./client.mjs";

export async function verifyStablePublisher(product, catalog = createCatalogClient()) {
  if (product !== "handheld" && product !== "standalone") {
    throw new Error("unknown stable publisher product");
  }
  const scope = { product, channel: "stable" };
  const snapshot = await catalog.getChannel(scope);
  // Without a channel pointer the catalog returns revision zero and readable: false.
  if (snapshot.revision === "0" && snapshot.publicationId === null) {
    return { scope, revision: snapshot.revision, status: "empty" };
  }
  if (!snapshot.readable || !snapshot.publicationId || snapshot.revision === "0") {
    throw new Error("stable publisher channel is not readable");
  }
  return { scope, revision: snapshot.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyStablePublisher(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
