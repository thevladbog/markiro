import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FileDropZone } from "@markiro/ui";

import type { ProductPhotoState } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  encodePhoto,
  PHOTO_FILE_TYPES,
  PhotoTooLargeError,
  type EncodedPhoto,
  type PhotoEncoder,
} from "./photo-encode.js";

export interface ProductPhotoFieldProps {
  /** The saved product's id; `null` for a product not saved yet, which has no photo. */
  productId: string | null;
  /** Names the photo for a screen reader. */
  productName: string;
  /** Tests pass a fake; `encodePhoto` by default. */
  encode?: PhotoEncoder;
}

/** What the picker offers: the types `encodePhoto` reads. */
const PHOTO_ACCEPT = PHOTO_FILE_TYPES.join(",");

/**
 * A product's photo (plan ТОВ), printed on «Бланк смены». It is written at once
 * by its own buttons, not by the product form's «Сохранить», as the
 * organization's logo is: the picked picture is turned into a JPEG of at most
 * 640 × 640 and 300 000 bytes here, and only that JPEG is sent and shown. A
 * product not saved yet has no photo. The list's `photoChecksum` changes with
 * it, so the products are read again.
 */
export function ProductPhotoField({
  productId,
  productName,
  encode = encodePhoto,
}: ProductPhotoFieldProps) {
  const { t } = useTranslation();
  if (productId === null) {
    return (
      <PhotoSection>
        <p className="product-photo-field__hint">{t("office.products.photo.saveFirst")}</p>
      </PhotoSection>
    );
  }
  return <SavedProductPhoto productId={productId} productName={productName} encode={encode} />;
}

/** The section «Фото», named by its heading. */
function PhotoSection({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section className="product-photo-field" aria-labelledby={titleId}>
      <h3 id={titleId} className="product-photo-field__title">
        {t("office.products.photo.title")}
      </h3>
      {children}
    </section>
  );
}

type Problem = { kind: "picture"; message: string } | { kind: "write"; failure: AlertFailure };

function SavedProductPhoto({
  productId,
  productName,
  encode,
}: {
  productId: string;
  productName: string;
  encode: PhotoEncoder;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const state = useOfficeQuery(officeKeys.productPhoto(productId), (api, token) =>
    api.getProductPhoto(token, productId),
  );
  const put = useOfficeMutation((api, token, photo: EncodedPhoto) =>
    api.putProductPhoto(token, productId, photo),
  );
  const clear = useOfficeMutation((api, token, _: null) =>
    api.deleteProductPhoto(token, productId),
  );
  const [problem, setProblem] = useState<Problem | null>(null);
  // The latest picked file wins: a slow encode of an earlier one is dropped.
  const pick = useRef(0);
  const busy = put.isPending || clear.isPending;
  const photo = state.data?.photo ?? null;

  const stored = (next: ProductPhotoState) => {
    queryClient.setQueryData(officeKeys.productPhoto(productId), next);
    void queryClient.invalidateQueries({ queryKey: officeKeys.products, exact: true });
  };

  const choose = async (file: File) => {
    const mine = ++pick.current;
    setProblem(null);
    let encoded: EncodedPhoto;
    try {
      encoded = await encode(file);
    } catch (error) {
      if (mine !== pick.current) return;
      const key =
        error instanceof PhotoTooLargeError
          ? "office.products.photo.tooLarge"
          : "office.products.photo.unreadable";
      setProblem({ kind: "picture", message: t(key) });
      return;
    }
    if (mine !== pick.current) return;
    try {
      stored(await put.mutateAsync(encoded));
    } catch (error) {
      setProblem({ kind: "write", failure: alertFailure(error) });
    }
  };

  const remove = async () => {
    if (busy) return;
    pick.current += 1;
    setProblem(null);
    try {
      stored(await clear.mutateAsync(null));
    } catch (error) {
      setProblem({ kind: "write", failure: alertFailure(error) });
    }
  };

  return (
    <PhotoSection>
      {problem?.kind === "picture" && <Alert tone="error">{problem.message}</Alert>}
      <WriteFailureAlert failure={problem?.kind === "write" ? problem.failure : null} />
      {photo !== null && (
        <img
          className="product-photo-field__preview"
          src={`data:image/jpeg;base64,${photo.dataBase64}`}
          alt={t("office.products.photo.alt", { name: productName })}
          width={photo.width}
          height={photo.height}
        />
      )}
      {state.isSuccess && (
        <>
          <FileDropZone
            compact
            label={t(
              photo === null ? "office.products.photo.choose" : "office.products.photo.replace",
            )}
            accept={PHOTO_ACCEPT}
            busy={busy}
            onFile={(file) => void choose(file)}
            onRejected={() => {
              pick.current += 1;
              setProblem({ kind: "picture", message: t("office.products.photo.unreadable") });
            }}
          />
          <p className="product-photo-field__hint">{t("office.products.photo.hint")}</p>
          {photo !== null && (
            <div className="standalone-form__actions">
              <Button variant="destructive-outline" disabled={busy} onClick={() => void remove()}>
                {t("office.products.photo.remove")}
              </Button>
            </div>
          )}
        </>
      )}
      {state.isError && <p className="office-note">{t("office.products.photo.unavailable")}</p>}
    </PhotoSection>
  );
}
