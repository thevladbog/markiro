import { useTranslation } from "react-i18next";

import type { OfficeProduct } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

/** How long a thumbnail is trusted: its key holds the photo's checksum, which says when it changes. */
const THUMB_STALE_MS = 5 * 60_000;

/**
 * The product's photo in a list row: a small frame with the picture, or an
 * empty frame for a product without one. The list carries only the photo's
 * checksum, so the picture is read per row, only for a product that has one,
 * and kept while its checksum stays.
 */
export function ProductThumb({
  product,
}: {
  product: Pick<OfficeProduct, "id" | "name" | "photoChecksum">;
}) {
  const { t } = useTranslation();
  const checksum = product.photoChecksum;
  const state = useOfficeQuery(
    officeKeys.productThumb(product.id, checksum ?? ""),
    (api, token) => api.getProductPhoto(token, product.id),
    { enabled: checksum !== null, staleTime: THUMB_STALE_MS },
  );
  const photo = checksum === null ? null : (state.data?.photo ?? null);
  return (
    <span className="product-thumb">
      {photo === null ? null : (
        <img
          className="product-thumb__image"
          src={`data:image/jpeg;base64,${photo.dataBase64}`}
          alt={t("office.products.photo.alt", { name: product.name })}
        />
      )}
    </span>
  );
}
