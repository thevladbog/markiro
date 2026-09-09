import { schema } from "@markiro/db";
import { sql, type SQL } from "drizzle-orm";

/** No locks on candidates: attachers lock candidate -> asset, collectors lock asset only. */
export function noCatalogImageReference(assetId: SQL, now = new Date()): SQL {
  return sql`not exists (
    select 1 from national_catalog_import_images i
    where i.staged_asset_id = ${assetId} and (
      (i.state <> 'released' and i.expires_at > ${now} and exists (
        select 1 from national_catalog_import_previews p
        join national_catalog_import_sessions s on s.tenant_id = p.tenant_id and s.id = p.session_id
        where p.tenant_id = i.tenant_id and p.session_id = i.session_id and p.id = i.preview_id
          and p.payload_purged_at is null and p.expires_at > ${now} and s.expires_at > ${now}
          and s.state not in ('cancelled', 'expired')
      )) or exists (
        select 1 from national_catalog_import_operation_items r
        where r.tenant_id = i.tenant_id and r.session_id = i.session_id
          and r.preview_id = i.preview_id and r.accepted_image_id = i.id and r.image_retry_eligible
      )
    )
  )`;
}
export function noMediaAssetReference(now = new Date()): SQL {
  return sql`${noCatalogImageReference(sql`${schema.mediaAssets.id}`, now)}
    and not exists (select 1 from national_catalog_import_images where staged_asset_id = ${schema.mediaAssets.id})
    and not exists (select 1 from product_images where asset_id = ${schema.mediaAssets.id})
    and not exists (select 1 from user_profiles where avatar_asset_id = ${schema.mediaAssets.id})`;
}
