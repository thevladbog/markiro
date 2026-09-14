import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { validatePickupKm } from "@markiro/domain";
import { canonical, orderContent, sha256, verifyPickupScope } from "../src/grants/scope.js";
const rawKm = "010460068200001321KYC9X7MQ\u001d93Abcd";
const body = { deviceSeq: 3, badgeDigest: "digest", reason: "buy" as const, items: [{ rawKm }] };
const product = { id: "product", gtin14: "04600682000013" };
async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const km = validatePickupKm(rawKm);
  if (km.status === "not_km" || km.status === "incomplete") throw Error("km");
  const scope = {
    version: 1,
    deviceSeq: 3,
    payloadDigest: await sha256(orderContent(body)),
    reason: "buy",
    writeoffReasonId: null,
    badgeIdentityDigest: await sha256(canonical({ badgeDigest: "digest", badgeCode: null })),
    items: [{ rawKm, kmKey: km.key, productId: "product" }],
    boxes: [],
    unitCount: 1,
    containerCount: 0,
  };
  const text = canonical({ taskKind: "pickup", taskId: "task", scope });
  return { text, digest: await sha256(text) };
}
it("verifies original canonical bytes and all independently saved executed inputs", async () => {
  const f = await fixture();
  expect(await verifyPickupScope(f.text, f.digest, "task", body, [product], [])).toMatchObject({
    unitCount: 1,
    containerCount: 0,
  });
  await expect(
    verifyPickupScope(f.text, f.digest, "task", { ...body, reason: "writeoff" }, [product], []),
  ).rejects.toThrow("scope");
  await expect(
    verifyPickupScope(f.text, f.digest, "task", body, [{ ...product, id: "changed" }], []),
  ).rejects.toThrow("scope");
  await expect(
    verifyPickupScope(f.text + " ", f.digest, "task", body, [product], []),
  ).rejects.toThrow("digest");
});
it("preserves legacy order while sorting explicit vNext boxes payloads", () => {
  const items = [{ rawKm: "z" }, { rawKm: "a" }];
  expect(JSON.parse(orderContent({ ...body, items })).items).toEqual(items);
  expect(JSON.parse(orderContent({ ...body, items, boxes: [] })).items).toEqual(items.toReversed());
});
