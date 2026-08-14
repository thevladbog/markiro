# Product Images End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one private primary product photograph from admin upload through tenant-safe API storage to persistent offline display on kiosks and stations.

**Architecture:** PostgreSQL stores one tenant-owned active media reference per product and S3/MinIO stores one normalized WebP object. JSON catalog and device payloads carry an optional nullable checksum descriptor; kiosk IndexedDB and station Cache Storage download immutable bytes separately and publish local pointers only after validation succeeds.

**Tech Stack:** Node 24, pnpm 11.10.0, TypeScript, NestJS, Drizzle/PostgreSQL, Sharp worker threads, S3/MinIO, React, TanStack Query, IndexedDB, Cache Storage, station SQLite, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-13-product-images-end-to-end-design.md`

## Global Constraints

- A product has zero or one image; no gallery, ordering, caption, CommerceML image import, print-template use, or device upload.
- Accept actual JPEG, PNG, or WebP content up to 5 MiB; reject animation, dimensions above 8192, and more than 25 million source pixels.
- Normalize to metadata-free, auto-oriented WebP, preserve aspect ratio, never upscale, and cap the longest edge at 1200 pixels.
- Never persist public or presigned URLs; never expose asset IDs, object keys, credentials, or client filenames.
- `image === undefined` means legacy/unknown and preserves a local pointer; `image === null` is the only deletion tombstone.
- Media failure never blocks catalog refresh, pairing, shift recovery, scanning, printing, pickup limits, or order queueing.
- Write normalized bytes before publishing server or device pointers; retain the previous image after a failed replacement.
- Every business query and write is tenant-scoped; kiosk downloads additionally require its product allowlist.
- Existing avatars and old station/kiosk payloads must remain compatible.
- Preserve fixed station viewport acceptance at 1280 by 800 with no scrolling.
- Build `@markiro/db` after DB source changes before running API consumer tests.
- Keep automated, MinIO, browser, Windows/Tauri, and physical-device acceptance as separate reported gates.

## File and responsibility map

- `packages/db/src/schema/media.ts`: generalized user/tenant media ownership and `productImages` aggregate.
- `packages/db/migrations/0036_product_images.sql` plus metadata: additive ownership/product-image migration.
- `apps/api/src/modules/media/`: reusable processing, lifecycle, descriptor lookup, cleanup, and media reconciliation.
- `apps/api/src/modules/products/`: product DTO enrichment, cabinet upload/delete/read, deletion cleanup, tenant audit.
- `apps/api/src/modules/pickup-orders/`: kiosk descriptor propagation and allowlist-protected image read.
- `apps/api/src/modules/shifts/`: station descriptor propagation and station-protected image read.
- `apps/admin/src/pages/catalog/`: staged create upload, edit preview/replace/delete, list thumbnail.
- `apps/kiosk/src/store/product-images.ts`: immutable IndexedDB blobs and published pointers.
- `apps/kiosk/src/sync/product-images.ts`: non-blocking descriptor reconciliation and downloads.
- `apps/kiosk/src/ui/ProductImage.tsx`: object-URL lifecycle and monogram fallback.
- `apps/station/src/lib/product-image-cache.ts`: Cache Storage bytes and SQLite pointer publication.
- `apps/station/src/ui/ProductImage.tsx`: station object-URL lifecycle and text-only fallback.

---

### Task 1: Tenant-Owned Media Schema and Migration

**Files:**

- Modify: `packages/db/src/schema/media.ts`
- Modify: `packages/db/test/mail-media-schema.test.ts`
- Create: generated `packages/db/migrations/0036_product_images.sql`
- Create: generated `packages/db/migrations/meta/0036_snapshot.json`
- Modify: generated `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/tenant-isolation.test.ts`

**Interfaces:**

- Produces: `schema.mediaAssets.ownerTenantId: string | null`.
- Produces: `schema.productImages` keyed by `(tenantId, productId)` with `assetId`.
- Preserves: `schema.userProfiles` composite avatar-owner foreign key and all existing avatar rows.

- [ ] **Step 1: restore the repository-declared package manager without changing policy files**

Run:

```bash
corepack enable
corepack prepare pnpm@11.10.0 --activate
pnpm --version
pnpm install --frozen-lockfile
```

Expected: version `11.10.0` and an unchanged `pnpm-lock.yaml`. If install reports the known
`packageManager dependency ... must use a registry package path` error, inspect `command -v pnpm`,
`corepack pnpm --version`, and `pnpm config list`; do not edit the lockfile or disable repository
dependency policy.

- [ ] **Step 2: write failing schema tests**

Add literal assertions:

```ts
expect(Object.keys(schema.mediaAssets)).toEqual(
  expect.arrayContaining(["ownerUserId", "ownerTenantId", "status", "checksum"]),
);
expect(getTableConfig(schema.mediaAssets).checks.map((one) => one.name)).toContain(
  "media_assets_owner_xor",
);
expect(getTableName(schema.productImages)).toBe("product_images");
expect(getTableConfig(schema.productImages).foreignKeys.map((one) => one.getName())).toEqual(
  expect.arrayContaining(["product_images_tenant_product_fk", "product_images_tenant_asset_fk"]),
);
```

Also assert the product reference uses both tenant and product columns and the asset reference uses
both tenant and asset columns.

- [ ] **Step 3: run the focused test and verify RED**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/mail-media-schema.test.ts test/tenant-isolation.test.ts
```

Expected: FAIL because `ownerTenantId`, `productImages`, and the named constraints do not exist.

- [ ] **Step 4: implement the Drizzle schema**

Use nullable user/tenant ownership with an XOR check and composite references:

```ts
ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
ownerTenantId: text("owner_tenant_id").references(() => organization.id, {
  onDelete: "cascade",
}),
// check: num_nonnulls(owner_user_id, owner_tenant_id) = 1
```

Define `productImages` with `tenantId`, `productId`, `assetId`, timestamps, primary key
`(tenantId, productId)`, unique `assetId`, and the two named composite foreign keys. Avoid a schema
import cycle; if `media.ts` importing `products` creates one, define the aggregate beside `products`
in `platform.ts` and export it through the existing schema barrel.

- [ ] **Step 5: generate and inspect the migration**

Run:

```bash
pnpm --filter @markiro/db db:generate -- --name product_images
```

Inspect the generated SQL. It must add the tenant column before making user ownership nullable,
install the XOR check after both columns exist, preserve avatar constraints, create both composite
foreign keys, and contain no destructive rewrite of prior migrations.

- [ ] **Step 6: run DB gates**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/mail-media-schema.test.ts test/tenant-isolation.test.ts test/runtime-migrate.test.ts
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
```

Expected: PASS; database-backed migration coverage may skip only when `DATABASE_URL` is absent and
must be recorded separately.

- [ ] **Step 7: commit**

```bash
git add packages/db/src/schema/media.ts packages/db/src/schema/platform.ts packages/db/test/mail-media-schema.test.ts packages/db/test/tenant-isolation.test.ts packages/db/migrations
git commit -m "feat(db): add tenant-owned product images"
```

### Task 2: Bounded Product Processing and Aggregate-Aware Cleanup

**Files:**

- Create: `apps/api/src/modules/media/product-image-processor.ts`
- Create: `apps/api/src/modules/media/media-assets.service.ts`
- Create: `apps/api/src/modules/media/media-assets.reconciler.ts`
- Create: `apps/api/src/modules/media/media.module.ts`
- Modify: `apps/api/src/modules/profile/avatar-processor.ts`
- Modify: `apps/api/src/modules/profile/profile.service.ts`
- Modify: `apps/api/src/modules/profile/profile.module.ts`
- Delete: `apps/api/src/modules/profile/profile-assets.reconciler.ts`
- Test: `apps/api/test/product-image-processor.test.ts`
- Test: `apps/api/test/media-assets.reconciler.test.ts`
- Modify: `apps/api/test/avatar-processor.test.ts`
- Modify: `apps/api/test/profile-reconciliation.e2e.test.ts`

**Interfaces:**

- Produces: `processProductImage(input: Buffer): Promise<ProcessedProductImage>`.
- Produces: `MediaAssetsService.reconcile(now?: Date, limit?: number): Promise<number>`.
- `ProcessedProductImage` contains `buffer`, `contentType: "image/webp"`, `byteSize`, lowercase hex
  `checksum`, `width`, and `height`.

- [ ] **Step 1: write processor RED tests**

Create fixtures with Sharp in tests and assert:

```ts
const result = await processProductImage(
  await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: "#2463eb" },
  })
    .jpeg()
    .toBuffer(),
);
expect(result).toMatchObject({ contentType: "image/webp", width: 1200, height: 600 });
expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
```

Add separate cases for portrait ratio, no upscale, actual-content rejection, animation, 5 MiB,
8192-pixel, 25-million-pixel, and deterministic normalized bytes.

- [ ] **Step 2: run processor tests and verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/product-image-processor.test.ts test/avatar-processor.test.ts
```

Expected: FAIL because the product processor module is missing.

- [ ] **Step 3: implement the processor without changing avatar output**

Reuse the existing limiter/worker boundary. Product worker Sharp operations are:

```ts
.rotate()
.resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
.webp({ quality: 85, effort: 4 })
.toBuffer({ resolveWithObject: true })
```

Return dimensions from worker output info. Keep avatar at exact 512 by 512 cover. Share constants
and worker plumbing only where tests prove avatar messages, limits, and dimensions remain intact.

- [ ] **Step 4: write reconciler RED tests**

Test stale user-owned and tenant-owned staging/deleting assets, a referenced avatar, a referenced
product image, conditional claim loss, S3 delete failure, and successful metadata deletion. Assert
the service never deletes an active referenced asset and does not leak object keys in returned data.

- [ ] **Step 5: run reconciler tests and verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/media-assets.reconciler.test.ts test/profile-assets.reconciler.test.ts
```

Expected: FAIL because reconciliation is still profile-only.

- [ ] **Step 6: implement generalized reconciliation**

Move lifecycle cleanup into `MediaAssetsService`. Determine references by left joining both
`userProfiles` and `productImages`; conditionally transition stale staging assets to deleting; call
`ObjectStorageService.delete(objectKey)`; delete metadata only when status is deleting and neither
aggregate references it. Register one timer in `MediaAssetsReconciler` and remove the profile timer.

- [ ] **Step 7: verify API media/profile gates**

```bash
pnpm --filter @markiro/api exec vitest run test/product-image-processor.test.ts test/avatar-processor.test.ts test/media-assets.reconciler.test.ts test/profile-reconciliation.e2e.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

- [ ] **Step 8: commit**

```bash
git add apps/api/src/modules/media apps/api/src/modules/profile apps/api/test/product-image-processor.test.ts apps/api/test/media-assets.reconciler.test.ts apps/api/test/avatar-processor.test.ts apps/api/test/profile-reconciliation.e2e.test.ts
git commit -m "refactor(api): generalize private media lifecycle"
```

### Task 3: Product Image Cabinet API and Audit

**Files:**

- Modify: `apps/api/src/modules/products/dto.ts`
- Modify: `apps/api/src/modules/products/products.service.ts`
- Modify: `apps/api/src/modules/products/products.controller.ts`
- Modify: `apps/api/src/modules/products/products.module.ts`
- Modify: `apps/api/test/products.e2e.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `apps/api/test/openapi-docs.test.ts`

**Interfaces:**

- Produces: `ProductImageDescriptor` and `ProductDto.image`.
- Produces: `ProductsService.uploadImage(tenantId, actorUserId, productId, source)`.
- Produces: `ProductsService.deleteImage(tenantId, actorUserId, productId)`.
- Produces: `ProductsService.getCurrentImageRead(tenantId, productId, checksum)` returning the
  current safe object key for controller presigning/redirect.

- [ ] **Step 1: write API RED tests**

Add e2e cases that upload multipart `image`, inspect the normalized asset and product reference,
replace it, delete twice, and verify DTO shape:

```ts
expect(response.body.image).toMatchObject({
  contentType: "image/webp",
  checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
  width: expect.any(Number),
  height: expect.any(Number),
});
expect(response.body).not.toHaveProperty("assetId");
expect(response.body).not.toHaveProperty("objectKey");
```

Add invalid content, source size, foreign tenant, storage failure, switch failure, concurrent
replacement, product deletion cleanup, stale checksum 404, and exact tenant audit rows with actor,
action, outcome, target type/id, and safe image metadata.

- [ ] **Step 2: run product API test and verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts
```

Expected: route 404 and missing `image` descriptor.

- [ ] **Step 3: implement descriptor lookup and lifecycle**

All list/detail/create/update `ProductDto` mappings must emit:

```ts
image: row.imageChecksum
  ? {
      checksum: row.imageChecksum,
      contentType: "image/webp",
      byteSize: row.imageByteSize,
      width: row.imageWidth,
      height: row.imageHeight,
    }
  : null,
```

Use one tenant-scoped left join/helper, not a query per product. Upload inserts staging metadata,
puts the object, then transactionally switches `productImages` and statuses. Product deletion marks
the referenced asset deleting before deleting the product. Record tenant audit inside the same
successful switch/delete transaction; record safe failure outcome through the established pattern.

- [ ] **Step 4: implement cabinet routes**

Add `FileInterceptor("image", { limits: { fileSize: 5 * 1024 * 1024 } })` and cabinet read/delete
routes. Pass `req.userId!` into mutations. For immutable reads authorize and verify current checksum
before returning a five-minute presigned redirect; never accept an object key from the request.

- [ ] **Step 5: update route/OpenAPI inventory and verify GREEN**

```bash
pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts test/subscription-route-inventory.test.ts test/object-storage.test.ts
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

- [ ] **Step 6: commit**

```bash
git add apps/api/src/modules/products apps/api/test/products.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts apps/api/test/openapi-docs.test.ts
git commit -m "feat(api): manage private product images"
```

### Task 4: Kiosk and Station Image Delivery Contracts

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.controller.ts`
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/test/kiosk-bootstrap-day-count.e2e.test.ts`
- Modify: `apps/api/test/products.e2e.test.ts`
- Test: `apps/api/test/product-image-device-access.e2e.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`

**Interfaces:**

- Produces: optional nullable `image` in `KioskBootstrapDto.products[]`, `ShiftDto`, and bundle
  `ProductDto`.
- Produces: allowlist-protected `GET /kiosk/products/:id/image/:checksum`.
- Produces: paired-station `GET /station/products/:id/image/:checksum`.

- [ ] **Step 1: write device access RED tests**

Create two tenants, two kiosks, two stations, allowed/unallowed products, and current/stale
checksums. Assert same-tenant allowed reads succeed; foreign tenant, archived/revoked device,
unallowed kiosk product, unknown product, and stale checksum all return 404/401 according to the
existing credential guard without leaking asset data.

- [ ] **Step 2: verify RED**

```bash
pnpm --filter @markiro/api exec vitest run test/product-image-device-access.e2e.test.ts test/kiosk-bootstrap-day-count.e2e.test.ts
```

- [ ] **Step 3: enrich bootstrap and shift queries without N+1 reads**

Join `productImages` and `mediaAssets` in the existing kiosk product and shift list/bundle queries.
Emit `image: null` for no reference. Keep optional TypeScript fields on device-facing reader types so
old stored payloads compile and decode.

- [ ] **Step 4: implement trust-domain-specific reads**

The kiosk service must require a matching row in `kioskProducts`. The station service must use the
existing paired station identity from the station guard and same tenant. Both verify the requested
checksum against the current active asset before presigning. Do not combine cabinet, kiosk, and
station identity in one permissive guard.

- [ ] **Step 5: verify API contracts**

```bash
pnpm --filter @markiro/api exec vitest run test/product-image-device-access.e2e.test.ts test/kiosk-bootstrap-day-count.e2e.test.ts test/products.e2e.test.ts test/subscription-route-inventory.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

- [ ] **Step 6: commit**

```bash
git add apps/api/src/modules/pickup-orders apps/api/src/modules/shifts apps/api/test/product-image-device-access.e2e.test.ts apps/api/test/kiosk-bootstrap-day-count.e2e.test.ts apps/api/test/products.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): deliver product images to devices"
```

### Task 5: Admin Catalog Upload, Preview, Replace, and Delete

**Files:**

- Modify: `apps/admin/src/pages/catalog/api.ts`
- Create: `apps/admin/src/pages/catalog/ProductImageField.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/pages/catalog/catalog.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/catalog.test.tsx`
- Modify: `apps/admin/test/catalog-routing.test.tsx`

**Interfaces:**

- Consumes: `ProductDto.image?: ProductImageDescriptor | null` and cabinet media routes.
- Produces: `uploadProductImage(id, file)`, `deleteProductImage(id)`, and a staged `File | null`
  handoff from `ProductForm`.

- [ ] **Step 1: write admin RED tests**

Render the real catalog and assert: accepted file types/limit text, accessible file input, local
preview, create JSON request followed by multipart image request, replace, idempotent delete, and
current preview preservation on failed storage. For partial create assert exactly one product POST,
the panel remains open in edit mode, and retry sends only the image request.

```ts
expect((uploadInit.body as FormData).get("image")).toBe(file);
expect(uploadInit.headers).toBeUndefined(); // browser owns multipart boundary
```

- [ ] **Step 2: run admin tests and verify RED**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx
```

- [ ] **Step 3: implement API hooks and focused field component**

Use `fetch("/api/products/${id}/image", { method: "POST", body: form })` without JSON content type.
Create/revoke local object URLs in effects. Fetch the current immutable cabinet image path using the
descriptor checksum. Render product-name alt text, keyboard-operable replace/delete buttons, busy
state, and an associated `Alert` on failure.

- [ ] **Step 4: implement two-phase create recovery**

Change the create route owner so the created `ProductDto.id` is retained before image upload. On
upload failure, navigate/transition the same open panel to edit state, keep the chosen file, and
expose retry. Do not rerun create. Text submit and image mutation must have independent pending and
error state.

- [ ] **Step 5: add list thumbnail and translations**

Use the current product name as alt text and a neutral placeholder on missing/decode failure. Keep
the catalog table density and avoid layout shift with fixed dimensions.

- [ ] **Step 6: verify admin gates**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

- [ ] **Step 7: commit**

```bash
git add apps/admin/src/pages/catalog apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/catalog.test.tsx apps/admin/test/catalog-routing.test.tsx
git commit -m "feat(admin): manage product photographs"
```

### Task 6: Kiosk Immutable Image Store and Sync

**Files:**

- Modify: `apps/kiosk/src/api/types.ts`
- Modify: `apps/kiosk/src/api/client.ts`
- Modify: `apps/kiosk/src/store/db.ts`
- Create: `apps/kiosk/src/store/product-images.ts`
- Create: `apps/kiosk/src/sync/product-images.ts`
- Modify: `apps/kiosk/src/sync/worker.ts`
- Test: `apps/kiosk/test/product-images.test.ts`
- Modify: `apps/kiosk/test/api-client.test.ts`
- Modify: `apps/kiosk/test/store.test.ts`

**Interfaces:**

- Produces: `KioskApiClient.downloadProductImage(productId, checksum): Promise<Blob>`.
- Produces: `syncProductImages(client, products): Promise<ProductImageSyncResult>` that never
  rejects for an individual media failure.
- Produces: `readPublishedProductImage(productId): Promise<Blob | null>`.
- Produces: `clearProductImages(): Promise<void>`.

- [ ] **Step 1: write IndexedDB RED tests**

Bump the DB version and assert new stores `product-image-blobs` and `product-image-pointers`. Test
blob-first/pointer-second publication, checksum reuse across products, undefined retention, null
deletion, allowlist removal, failed fetch/write retention, checksum mismatch rejection, and orphan
cleanup.

- [ ] **Step 2: verify RED**

```bash
pnpm --filter @markiro/kiosk exec vitest run test/product-images.test.ts test/store.test.ts test/api-client.test.ts
```

- [ ] **Step 3: implement raw download and cryptographic validation**

Add a fetch path that preserves kiosk authorization headers, timeout, and credential rejection but
returns `Blob`. Validate `image/webp`, expected byte size, and:

```ts
const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
if (actual !== descriptor.checksum) throw new Error("product image checksum mismatch");
```

- [ ] **Step 4: implement independent image sync**

Publish operational bootstrap first. Then run media sync with bounded concurrency; catch/log its
aggregate result without changing reachability. Store immutable blob, then pointer. Treat absent
descriptor as no-op and explicit null as deletion.

- [ ] **Step 5: verify kiosk storage/sync gates**

```bash
pnpm --filter @markiro/kiosk exec vitest run test/product-images.test.ts test/store.test.ts test/api-client.test.ts test/sync.test.ts
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
```

- [ ] **Step 6: commit**

```bash
git add apps/kiosk/src/api apps/kiosk/src/store apps/kiosk/src/sync apps/kiosk/test/product-images.test.ts apps/kiosk/test/api-client.test.ts apps/kiosk/test/store.test.ts apps/kiosk/test/sync.test.ts
git commit -m "feat(kiosk): cache product images offline"
```

### Task 7: Kiosk Display, Restart, and Pairing-Boundary Scrub

**Files:**

- Create: `apps/kiosk/src/ui/ProductImage.tsx`
- Modify: `apps/kiosk/src/screens/Cart.tsx`
- Modify: `apps/kiosk/src/ui/KioskShell.tsx`
- Modify: `apps/kiosk/src/store/scrub.ts`
- Modify: `apps/kiosk/src/screens/product-monogram.ts` if fallback extraction is needed
- Modify: `apps/kiosk/test/cart-screen.test.tsx`
- Modify: `apps/kiosk/test/app.test.tsx`
- Modify: `apps/kiosk/test/scrub.test.ts`

**Interfaces:**

- Consumes: `readPublishedProductImage`, `syncProductImages`, and `clearProductImages` from Task 6.
- Produces: `<ProductImage productId name fallback />` with managed object URL.

- [ ] **Step 1: write UI and boundary RED tests**

Assert cached Blob renders after simulated restart/offline, image alt equals product name, object URL
is revoked on replacement/unmount, missing/corrupt Blob renders the existing monogram, and cart
remove/price/scan behavior is unchanged. Assert unpair, 401 revocation, and tenant-changing repair
clear both image stores before the new snapshot is displayed.

- [ ] **Step 2: verify RED**

```bash
pnpm --filter @markiro/kiosk exec vitest run test/cart-screen.test.tsx test/app.test.tsx test/scrub.test.ts
```

- [ ] **Step 3: implement ProductImage and cart integration**

Load the published Blob asynchronously, create an object URL, revoke the prior URL in cleanup, and
fall back on load error. Keep the existing 56-pixel row slot and `object-fit: cover`; do not change
cart reducer data or persist URLs.

- [ ] **Step 4: wire lifecycle scrub**

Call `clearProductImages` in every credential/pairing boundary that clears or replaces kiosk
identity. A failed scrub logs a bounded diagnostic and follows the existing fail-safe identity
behavior; it must not silently show the new tenant with old pointers.

- [ ] **Step 5: verify full kiosk gates**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/kiosk typecheck
pnpm --filter @markiro/kiosk lint
pnpm --filter @markiro/kiosk build
```

- [ ] **Step 6: commit**

```bash
git add apps/kiosk/src/ui/ProductImage.tsx apps/kiosk/src/screens/Cart.tsx apps/kiosk/src/ui/KioskShell.tsx apps/kiosk/src/store/scrub.ts apps/kiosk/src/screens/product-monogram.ts apps/kiosk/test/cart-screen.test.tsx apps/kiosk/test/app.test.tsx apps/kiosk/test/scrub.test.ts
git commit -m "feat(kiosk): display cached product images"
```

### Task 8: Station Descriptor Mirror and Cache Publication

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/src/sqlite/migrations.ts`
- Modify: `packages/db/test/sqlite-schema.test.ts`
- Modify: `apps/station/src/lib/api-client.ts`
- Modify: `apps/station/src/lib/mirror.ts`
- Create: `apps/station/src/lib/product-image-cache.ts`
- Modify: `apps/station/src/lib/shift-bundle.ts`
- Modify: `apps/station/test/api-client.test.tsx`
- Modify: `apps/station/test/mirror.test.ts`
- Create: `apps/station/test/product-image-cache.test.ts`
- Modify: `apps/station/test/shift-bundle.test.ts`

**Interfaces:**

- Produces: optional descriptor columns and a published local checksum pointer per product.
- Produces: `StationClient.download(path): Promise<Blob>`.
- Produces: `syncStationProductImage(exec, client, product): Promise<void>` that logs/returns media
  failure without rejecting operational bundle mirroring.
- Produces: `readStationProductImage(productId): Promise<Blob | null>` and
  `clearStationProductImages(exec): Promise<void>`.

- [ ] **Step 1: write SQLite/cache RED tests**

Add idempotent runtime DDL for descriptor/pointer columns. Round-trip old rows and new descriptors.
Test WebP/checksum validation, bytes-before-SQLite-pointer order, failed replacement retention,
explicit null removal, undefined no-op, corrupt cache fallback, and orphan cleanup.

- [ ] **Step 2: verify RED**

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/product-image-cache.test.ts test/shift-bundle.test.ts test/api-client.test.tsx
```

- [ ] **Step 3: implement station raw download and Cache Storage**

Use a private cache namespace such as `markiro-station-product-images-v1`; synthetic keys include
product ID and checksum, never API credentials or signed URLs. Validate content type, byte size, and
SHA-256 before `cache.put`. Publish the SQLite checksum only after cache success.

- [ ] **Step 4: integrate bundle and shift-list media sync**

Keep `addRange` before operational bundle publication. Mirror shift/product/roster regardless of
media availability, then schedule/catch image sync so a dead object store cannot block opening the
shift. Add the same descriptor-driven prefetch to shift-list refresh for unopened cards.

- [ ] **Step 5: verify station cache gates**

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
pnpm --filter @markiro/db build
pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/product-image-cache.test.ts test/shift-bundle.test.ts test/api-client.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

- [ ] **Step 6: commit**

```bash
git add packages/db/src/sqlite packages/db/test/sqlite-schema.test.ts apps/station/src/lib apps/station/test/api-client.test.tsx apps/station/test/mirror.test.ts apps/station/test/product-image-cache.test.ts apps/station/test/shift-bundle.test.ts
git commit -m "feat(station): cache product images offline"
```

### Task 9: Station Display and Credential-Recovery Scrub

**Files:**

- Create: `apps/station/src/ui/ProductImage.tsx`
- Modify: `apps/station/src/ui/work/ScanResultInstrument.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/pages/ShiftSelection.tsx`
- Modify: `apps/station/src/lib/credential-recovery.ts`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/test/work-screen.test.tsx`
- Modify: `apps/station/test/shift-selection.test.tsx`
- Modify: `apps/station/test/credential-recovery.test.ts`
- Modify: `apps/station/test/screen-gallery-bootstrap.test.tsx`

**Interfaces:**

- Consumes: station cache read/clear functions and mirrored descriptor/pointer fields from Task 8.
- Produces: fixed-size thumbnail on shift cards and larger image in the scan-result instrument.

- [ ] **Step 1: write station UI/recovery RED tests**

Assert cached/offline image rendering, product-name alt, text-only fallback, object URL revocation,
no lost scan/counter controls, and cache cleanup after credential sealing/re-pairing. Render the real
1280 by 800 screen and assert document width equals client width and the main screen has no vertical
overflow in the test harness.

- [ ] **Step 2: verify RED**

```bash
pnpm --filter @markiro/station exec vitest run test/work-screen.test.tsx test/shift-selection.test.tsx test/credential-recovery.test.ts test/screen-gallery-bootstrap.test.tsx
```

- [ ] **Step 3: implement station ProductImage and layouts**

Load the cached Blob asynchronously, create one object URL, revoke the previous URL before replacing
it and again on unmount, and render the text-only fallback on read/decode failure. Use fixed
thumbnail/image slots, `object-fit: cover`, and product-name alt. Do not add scroll, shrink floor
controls, or move the current scan status out of the primary visual hierarchy.

- [ ] **Step 4: coordinate credential scrub with in-flight writes**

Extend the existing credential generation sealing/wait sequence so all active bundle/media writes
finish or observe `sealed` before deleting SQLite image pointers and the cache namespace. Preserve
the operational journal and existing recovery ordering.

- [ ] **Step 5: verify full station gates**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Cargo is a host gate only; do not report it as Windows WebView persistence or hardware acceptance.

- [ ] **Step 6: commit**

```bash
git add apps/station/src/ui/ProductImage.tsx apps/station/src/ui/work/ScanResultInstrument.tsx apps/station/src/pages/WorkScreen.tsx apps/station/src/pages/ShiftSelection.tsx apps/station/src/lib/credential-recovery.ts apps/station/src/station.css apps/station/test/work-screen.test.tsx apps/station/test/shift-selection.test.tsx apps/station/test/credential-recovery.test.ts apps/station/test/screen-gallery-bootstrap.test.tsx
git commit -m "feat(station): display cached product images"
```

### Task 10: Cross-Package Compatibility and Final Verification

**Files:**

- Modify: `docs/architecture.md`
- Modify: API/OpenAPI generated or checked contract files already tracked by the repository
- Modify: focused tests discovered by route/schema changes

**Interfaces:**

- Consumes every task deliverable.
- Produces a merge-ready branch with explicit automated and external acceptance evidence.

- [ ] **Step 1: add rolling-compatibility tests**

Use literal old payloads with no `image` field in kiosk and station tests. Seed old SQLite rows and
old IndexedDB snapshots. Assert they boot, preserve an existing pointer on absent descriptor, clear
only on explicit null, and perform every original business action.

- [ ] **Step 2: run focused cross-package gates sequentially**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
pnpm --filter @markiro/kiosk test
pnpm --filter @markiro/station test
```

- [ ] **Step 3: run package quality gates**

```bash
pnpm --filter @markiro/db typecheck lint build
pnpm --filter @markiro/api typecheck lint build
pnpm --filter @markiro/admin typecheck lint build
pnpm --filter @markiro/kiosk typecheck lint build
pnpm --filter @markiro/station typecheck lint build
pnpm format:check
git diff --check
```

- [ ] **Step 4: run broad repository gates when infrastructure is available**

Load only the development environment, never production credentials, then run:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm test:production-bundle:contract
```

Record database skips, infrastructure omissions, and any unrelated pre-existing failures exactly.

- [ ] **Step 5: perform browser/local object-storage acceptance**

With development Postgres, Mailpit, and MinIO only: create a product with a photo; replace it while
simulating object upload failure; delete it; verify another tenant cannot read it; restart kiosk
browser storage offline; reload station browser mode at 1280 by 800. Capture console errors and
confirm there is no scrolling or business-flow blockage.

- [ ] **Step 6: leave external gates explicit**

Do not mark these automated: Windows Tauri restart/offline Cache Storage persistence, physical kiosk
tablet restart/quota behavior, real S3 behavior, physical scanner/printer coexistence, and actual
device re-pair cache scrub. Provide manual steps and results separately.

- [ ] **Step 7: review final scope and commit remaining contract/docs changes**

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
git add docs/architecture.md apps/api/test/product-image-device-access.e2e.test.ts apps/kiosk/test/product-images.test.ts apps/station/test/product-image-cache.test.ts
git commit -m "test: verify product images end to end"
```

Omit the final commit when Task 10 produces no tracked changes. Never use broad staging.
