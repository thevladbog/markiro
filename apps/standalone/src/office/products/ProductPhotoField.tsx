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
  /** The saved product's id; `null` for a product not saved yet, whose photo is only staged. */
  productId: string | null;
  /** Names the photo for a screen reader. */
  productName: string;
  /** Catalog sets share the photo API and have their own label. */
  set?: boolean;
  /** Tests pass a fake; `encodePhoto` by default. */
  encode?: PhotoEncoder;
  /**
   * For a product not saved yet: the picture picked so far, kept by the
   * drawer and written once the product exists. Ignored for a saved product,
   * whose photo is written at once.
   */
  staged?: EncodedPhoto | null;
  onStage?: (photo: EncodedPhoto | null) => void;
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
  set = false,
  encode = encodePhoto,
  staged = null,
  onStage,
}: ProductPhotoFieldProps) {
  const { t } = useTranslation();
  const title = t(set ? "office.products.photo.setTitle" : "office.products.photo.title");
  const alt = t(set ? "office.products.photo.setAlt" : "office.products.photo.alt", {
    name: productName,
  });
  if (productId === null) {
    return (
      <StagedProductPhoto
        title={title}
        alt={alt}
        note={t(set ? "office.products.photo.setStagedNote" : "office.products.photo.stagedNote")}
        encode={encode}
        staged={staged}
        {...(onStage === undefined ? {} : { onStage })}
      />
    );
  }
  return (
    <SavedProductPhoto
      productId={productId}
      title={title}
      alt={alt}
      note={t(set ? "office.products.photo.setSavedNote" : "office.products.photo.savedNote")}
      encode={encode}
    />
  );
}

/** The section «Фото товара», named by its heading. */
function PhotoSection({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="product-photo-field" aria-labelledby={titleId}>
      <h3 id={titleId} className="product-photo-field__title">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The photo's card at the top of the drawer: the picture (or an empty frame
 * that says there is none), what a photo may be, and the buttons
 * «Загрузить фото» / «Заменить фото» and «Удалить фото».
 */
function PhotoCard({
  photo,
  alt,
  busy,
  note,
  onFile,
  onRejected,
  onRemove,
}: {
  photo: EncodedPhoto | null;
  alt: string;
  busy: boolean;
  /** What the photo's write does, under the limits. */
  note: string;
  onFile: (file: File) => void;
  onRejected: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="product-photo-field__card">
      <div className="product-photo-field__frame">
        {photo === null ? (
          <span className="product-photo-field__empty">{t("office.products.photo.none")}</span>
        ) : (
          <img
            className="product-photo-field__preview"
            src={`data:${photo.mediaType};base64,${photo.dataBase64}`}
            alt={alt}
            width={photo.width}
            height={photo.height}
          />
        )}
      </div>
      <div className="product-photo-field__actions">
        <FileDropZone
          compact
          label={t(
            photo === null ? "office.products.photo.choose" : "office.products.photo.replace",
          )}
          accept={PHOTO_ACCEPT}
          busy={busy}
          onFile={onFile}
          onRejected={onRejected}
        />
        {photo !== null && (
          <Button variant="destructive-outline" disabled={busy} onClick={onRemove}>
            {t("office.products.photo.remove")}
          </Button>
        )}
        <p className="product-photo-field__hint">{t("office.products.photo.limits")}</p>
        <p className="product-photo-field__hint">{note}</p>
      </div>
    </div>
  );
}

type Problem = { kind: "picture"; message: string } | { kind: "write"; failure: AlertFailure };

/** Turns a picked file into the photo, or says why it cannot be one (`undefined` after a newer pick). */
function useEncoder(encode: PhotoEncoder) {
  const { t } = useTranslation();
  // The latest picked file wins: a slow encode of an earlier one is dropped.
  const pick = useRef(0);
  const [picture, setPicture] = useState<string | null>(null);
  return {
    picture,
    supersede: () => {
      pick.current += 1;
      setPicture(null);
    },
    reject: () => {
      pick.current += 1;
      setPicture(t("office.products.photo.unreadable"));
    },
    run: async (file: File): Promise<EncodedPhoto | null> => {
      const mine = ++pick.current;
      setPicture(null);
      try {
        const encoded = await encode(file);
        return mine === pick.current ? encoded : null;
      } catch (error) {
        if (mine !== pick.current) return null;
        setPicture(
          t(
            error instanceof PhotoTooLargeError
              ? "office.products.photo.tooLarge"
              : "office.products.photo.unreadable",
          ),
        );
        return null;
      }
    },
  };
}

/** A new product: the picture is encoded here and kept by the drawer until the product is saved. */
function StagedProductPhoto({
  title,
  alt,
  note,
  encode,
  staged,
  onStage,
}: {
  title: string;
  alt: string;
  note: string;
  encode: PhotoEncoder;
  staged: EncodedPhoto | null;
  onStage?: (photo: EncodedPhoto | null) => void;
}) {
  const encoder = useEncoder(encode);
  return (
    <PhotoSection title={title}>
      {encoder.picture !== null && <Alert tone="error">{encoder.picture}</Alert>}
      <PhotoCard
        photo={staged}
        alt={alt}
        busy={false}
        note={note}
        onFile={(file) =>
          void encoder.run(file).then((encoded) => {
            if (encoded !== null) onStage?.(encoded);
          })
        }
        onRejected={encoder.reject}
        onRemove={() => {
          encoder.supersede();
          onStage?.(null);
        }}
      />
    </PhotoSection>
  );
}

function SavedProductPhoto({
  productId,
  title,
  alt,
  note,
  encode,
}: {
  productId: string;
  title: string;
  alt: string;
  note: string;
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
  const encoder = useEncoder(encode);
  const busy = put.isPending || clear.isPending;
  const photo = state.data?.photo ?? null;

  const stored = (next: ProductPhotoState) => {
    queryClient.setQueryData(officeKeys.productPhoto(productId), next);
    void queryClient.invalidateQueries({ queryKey: officeKeys.products, exact: true });
  };

  const choose = async (file: File) => {
    setProblem(null);
    const encoded = await encoder.run(file);
    if (encoded === null) return;
    try {
      stored(await put.mutateAsync(encoded));
    } catch (error) {
      setProblem({ kind: "write", failure: alertFailure(error) });
    }
  };

  const remove = async () => {
    if (busy) return;
    encoder.supersede();
    setProblem(null);
    try {
      stored(await clear.mutateAsync(null));
    } catch (error) {
      setProblem({ kind: "write", failure: alertFailure(error) });
    }
  };

  return (
    <PhotoSection title={title}>
      {encoder.picture !== null && <Alert tone="error">{encoder.picture}</Alert>}
      <WriteFailureAlert failure={problem?.kind === "write" ? problem.failure : null} />
      {state.isSuccess && (
        <PhotoCard
          photo={photo}
          alt={alt}
          busy={busy}
          note={note}
          onFile={(file) => void choose(file)}
          onRejected={encoder.reject}
          onRemove={() => void remove()}
        />
      )}
      {state.isError && <p className="office-note">{t("office.products.photo.unavailable")}</p>}
    </PhotoSection>
  );
}
