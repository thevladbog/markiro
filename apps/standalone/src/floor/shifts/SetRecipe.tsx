import { useTranslation } from "react-i18next";

import type { SetItem } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import { PhotoSquare } from "../kit/PhotoSquare.js";
import { ProductPhotoImage, useStoredProductPhoto } from "./ProductPhoto.js";
import { usePhotoBacking } from "./photo-backing.js";
import { productMonogram } from "./product-accent.js";
import { formatQuantity } from "./shift-text.js";
import "./set-recipe.css";

function RecipePhoto({ local, item }: { local: LocalExecutor; item: SetItem }) {
  const photo = useStoredProductPhoto(local, item.gtin14, "gtin");
  const backing = usePhotoBacking(photo);
  return (
    <PhotoSquare size={40} backing={backing}>
      <ProductPhotoImage
        photo={photo}
        fallback={<span aria-hidden="true">{productMonogram(item.productName)}</span>}
      />
    </PhotoSquare>
  );
}

export function SetRecipe({
  local,
  items,
  counts,
  lastGtin,
}: {
  local: LocalExecutor;
  items: readonly SetItem[];
  counts?: ReadonlyMap<string, number>;
  lastGtin?: string;
}) {
  const { t } = useTranslation();
  const title = t("floor.setAssembly.composition");
  return (
    <section className="set-recipe" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item.gtin14} data-last-scan={item.gtin14 === lastGtin || undefined}>
            <RecipePhoto local={local} item={item} />
            <span className="set-recipe__product">
              {item.productName}
              <small>{item.gtin14}</small>
            </span>
            <strong>
              {counts === undefined ? null : `${formatQuantity(counts.get(item.gtin14) ?? 0)} / `}
              {formatQuantity(item.quantity)}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
