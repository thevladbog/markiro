/**
 * What the office actually prints: one issued marking code per physical
 * label, one label per page, the page sized from the label template so a
 * plain Ctrl-P lands on the media in the printer without anyone choosing a
 * paper size.
 *
 * Opened in its own tab by `IssueKmCodesDialog` (with `?template=<id>`) and
 * by the order card's «Печать ещё раз» (without one -- an issue record stores
 * no template id, so this page re-derives it from the same rule the dialog
 * picks its default with; see `km-template.ts`). The route lives outside the
 * application shell and inside the auth/access gate (`pages/Shell.tsx`'s
 * `PrintShellPage`): a printed sidebar would be absurd, but the codes on this
 * page are live and must stay behind the cabinet's own gate.
 *
 * THE CODES ARE SECRETS. They arrive from a `no-store` endpoint through
 * `useKmIssueCodes`, whose cache is given a zero lifetime on purpose. Nothing
 * here may put one in a URL, a log, an analytics call or an error message:
 * a code that leaks is a code someone else can apply to their own goods.
 *
 * ONE CANVAS FOR THE WHOLE BATCH. A batch holds up to
 * `KM_PRINT_ISSUE_MAX_COUNT` (5 000) codes and a 58x40 mm label at
 * `PRINT_DPI` is a 685x472 px backing store, so a canvas per label would ask
 * the browser for ~6 GiB -- and a browser past its canvas budget does not
 * refuse: it evicts backing stores, every readiness callback still fires, and
 * the dialog opens over a sheet whose earliest labels have silently gone
 * blank, with the codes already spent. So each label is drawn into a SINGLE
 * reusable canvas, exported to a PNG blob, and shown as an `<img>`: peak
 * canvas memory is one label, the retained cost is a few kilobytes per label,
 * and a blob is re-decodable, so the print preview cannot lose pixels either.
 * The loop yields between chunks so the tab stays responsive and the header
 * can count progress.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";

import type { LabelField, LabelTemplateSpec } from "@markiro/domain";
import { Alert, Button, cn, EmptyState, Spinner } from "@markiro/ui";

import { rasterizeText } from "../../labels/rasterizer.js";
import { useChzProductGroups } from "../catalog/api.js";
import { useLabelTemplate, useLabelTemplates } from "../labels/api.js";
import { compositeRasterText, PREVIEW_FONT_FAMILY } from "../labels/raster-composite.js";
import { draw, type LabelRenderOptions } from "../labels/renderer.js";
import { useKmIssueCodes, useKmOrder } from "./api.js";
import { eligibleKmTemplates, kmOrderGroupCode, preferredKmTemplate } from "./km-template.js";
import type { KmIssueCode, KmOrder } from "./schemas.js";
import "./print.css";

/**
 * The resolution the label canvases are painted at. It is NOT the printer's
 * resolution and does not have to match `spec.dpi`: each page box is sized in
 * millimetres, so the browser scales this bitmap down onto the physical
 * label. 300 dpi keeps a Data Matrix crisp on both 203 and 300 dpi hardware.
 */
const PRINT_DPI = 300;

/**
 * A marking code is rasterized through the shared GS1 encoder rather than
 * drawn as a schematic barcode -- the same option the KM preview uses
 * (`labels/preview-data.ts`), so a proofread preview and this page agree.
 */
const KM_RENDER_OPTIONS: LabelRenderOptions = { kmDataMatrix: "raster" };

/** Canvas pixels per millimetre. */
const SCALE = PRINT_DPI / 25.4;

/**
 * How many labels are rasterized between two yields to the event loop. Small
 * enough that the tab keeps answering clicks and repainting the progress line
 * on a five-thousand-label batch, large enough that the yields themselves do
 * not dominate a short one.
 */
const RASTER_CHUNK = 20;

/**
 * How long the print dialog waits for the last chunk's images to finish
 * loading. Bounded on purpose: a dialog that opens a moment late is a
 * non-event, a dialog that never opens strands a batch whose codes are spent.
 */
const IMAGE_SETTLE_TIMEOUT_MS = 2_000;

/**
 * The label's field values for one code. Deliberately a full literal rather
 * than an override of `sampleLabelData()`: a field this order cannot fill
 * prints EMPTY, never a sample. A template that happens to carry an operator
 * or a shift number would otherwise put «Смирнов А.» on real goods.
 *
 * The order DTO carries no separate print name, so the catalogue name fills
 * both -- the station applies the same "print name or name" fallback.
 */
export function kmLabelData(
  order: Pick<KmOrder, "productName" | "gtin14">,
  code: string,
): Record<LabelField, string> {
  return {
    "product.name": order.productName,
    "product.printName": order.productName,
    "product.gtin": order.gtin14,
    "product.egais": "",
    "km.code": code,
    sscc: "",
    "shift.no": "",
    date: "",
    expiry: "",
    qty: "",
    "qty.boxes": "",
    operator: "",
    "counterparty.name": "",
  };
}

/**
 * The `@page` rule the browser sizes the media from. It is stylesheet TEXT,
 * not a React-sanitised style object, and `useLabelTemplate` hands back a
 * response it never parsed -- so the two numbers are checked here rather than
 * trusted, and a template that cannot say how big its label is falls back to
 * the browser's own paper rather than to whatever the field contained.
 */
export function printMediaRule(spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">): string {
  const { widthMm, heightMm } = spec;
  const sized =
    Number.isFinite(widthMm) && Number.isFinite(heightMm) && widthMm > 0 && heightMm > 0;
  return sized ? `@page { size: ${widthMm}mm ${heightMm}mm; margin: 0 }` : "@page { margin: 0 }";
}

/** One label's terminal state: a PNG to show, or a page that stays blank. */
type LabelRaster = { readonly kind: "ready"; readonly url: string } | { readonly kind: "degraded" };

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob);
    }, "image/png");
  });
}

/** Hands the main thread back between chunks. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function PrintSheet({
  order,
  codes,
  spec,
}: {
  order: KmOrder;
  codes: KmIssueCode[];
  spec: LabelTemplateSpec;
}) {
  const { t, i18n } = useTranslation();
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  // Only the two order fields a label paints. The order card polls and the
  // codes cache has a zero lifetime, so binding the batch to the whole order
  // object would re-rasterize every label whenever a counter moves.
  const product = useMemo(
    () => ({ productName: order.productName, gtin14: order.gtin14 }),
    [order.productName, order.gtin14],
  );
  const labels = useMemo(
    () => codes.map((code) => ({ seq: code.seq, data: kmLabelData(product, code.code) })),
    [codes, product],
  );

  const widthPx = Math.round(spec.widthMm * SCALE);
  const heightPx = Math.round(spec.heightMm * SCALE);
  const [rasters, setRasters] = useState<ReadonlyMap<number, LabelRaster>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    // THE one canvas (see this module's doc comment). Created here rather
    // than per label, and never resized: every label in a batch shares a
    // template, so the same bitmap is reused from the first code to the last.
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d");
    const painted = new Map<number, LabelRaster>();

    async function rasterizeLabel(data: Record<LabelField, string>): Promise<Blob | null> {
      // No 2D context at all: jsdom, an enterprise policy, or a
      // canvas-fingerprinting blocker. Every label degrades, and the header
      // says so rather than letting blank stock run through the printer
      // unannounced.
      if (ctx === null) return null;
      try {
        // `draw` clears the label area at its own unrounded size, which can
        // fall up to a pixel short of the rounded canvas -- and on a canvas
        // reused from label to label that uncleared strip would carry label N
        // into label N+1. Clear the real bitmap first.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        draw(spec, ctx, SCALE, data, KM_RENDER_OPTIONS);
        await compositeRasterText(spec, ctx, SCALE, data, {
          fontFamily: PREVIEW_FONT_FAMILY,
          rasterizeText,
          renderOptions: KM_RENDER_OPTIONS,
          isCancelled: () => cancelled,
        });
        return await canvasToBlob(canvas);
      } catch {
        // Whatever went wrong, the reason may not be repeated back: the value
        // that would appear in it is a live marking code.
        return null;
      }
    }

    setRasters(new Map());
    void (async () => {
      for (const [index, label] of labels.entries()) {
        const blob = await rasterizeLabel(label.data);
        // Checked BEFORE the object URL exists, so the cleanup below cannot
        // miss one: after cancellation no further URL is created.
        if (cancelled) return;
        if (blob === null) {
          painted.set(label.seq, { kind: "degraded" });
        } else {
          const url = URL.createObjectURL(blob);
          urls.push(url);
          painted.set(label.seq, { kind: "ready", url });
        }

        const done = index + 1;
        if (done % RASTER_CHUNK === 0 && done < labels.length) {
          setRasters(new Map(painted));
          await yieldToEventLoop();
          if (cancelled) return;
        }
      }
      if (!cancelled) setRasters(new Map(painted));
    })();

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [labels, spec, widthPx, heightPx]);

  const degradedCount = useMemo(() => {
    let count = 0;
    for (const raster of rasters.values()) {
      if (raster.kind === "degraded") count += 1;
    }
    return count;
  }, [rasters]);

  const sheetRef = useRef<HTMLDivElement>(null);
  const printedRef = useRef(false);
  const allReady = labels.length > 0 && rasters.size === labels.length;

  useEffect(() => {
    // Exactly once per page load. The ref, not the dependency list, is what
    // guarantees it: a refetch of the codes (zero cache lifetime, so a window
    // refocus is enough) re-runs this effect, and a second print dialog over
    // a job the office already sent to the printer is worse than none. The
    // «Открыть диалог печати» button below is the deliberate way back.
    if (!allReady || printedRef.current) return undefined;
    printedRef.current = true;

    // The last chunk's images were handed their blob URLs in the commit this
    // effect follows, and an image decodes asynchronously even from a local
    // blob. Opening the dialog over one that has not loaded yet is the same
    // blank label the single canvas exists to prevent, so wait for them --
    // bounded, because a late dialog is recoverable and a missing one is not.
    let done = false;
    let timer = 0;
    const open = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.print();
    };

    const pending = Array.from(sheetRef.current?.querySelectorAll("img") ?? []).filter(
      (image) => image.getAttribute("src") !== null && !image.complete,
    );
    if (pending.length === 0) {
      open();
      return undefined;
    }

    let settled = 0;
    const onSettled = () => {
      settled += 1;
      if (settled === pending.length) open();
    };
    for (const image of pending) {
      image.addEventListener("load", onSettled, { once: true });
      image.addEventListener("error", onSettled, { once: true });
    }
    timer = window.setTimeout(open, IMAGE_SETTLE_TIMEOUT_MS);

    return () => {
      done = true;
      window.clearTimeout(timer);
    };
  }, [allReady]);

  // The first run on a label printer is a calibration: the media, the offset,
  // whether the Data Matrix scans. Spending the whole batch to learn that the
  // offset is wrong is not recoverable -- these codes are already issued --
  // so one label can be sent on its own. It is a PRINT SCOPE, not a different
  // page: nothing is re-fetched, nothing server-side is touched, the sheet on
  // screen is untouched, and the full batch stays one click away.
  const [firstOnly, setFirstOnly] = useState(false);
  useEffect(() => {
    if (!firstOnly) return;
    // After the commit that put the scope class on the sheet, so the print
    // stylesheet is already hiding every page but the first.
    window.print();
    setFirstOnly(false);
  }, [firstOnly]);

  const first = labels[0];
  const last = labels[labels.length - 1];
  const range =
    first === undefined || last === undefined
      ? ""
      : t("pages.kmOrders.range", {
          from: number.format(first.seq),
          to: number.format(last.seq),
        });

  return (
    <div className={cn("mk-km-print", firstOnly && "mk-km-print--first-only")} ref={sheetRef}>
      {/* Emitted inline, not in `print.css`: the media size is the template's,
          and only this render knows it. */}
      <style>{printMediaRule(spec)}</style>
      <header className="mk-km-print__screen-only">
        <h1 className="mk-km-print__title">
          {t("pages.kmOrders.print.heading", {
            range,
            labels: t("pages.kmOrders.print.labels", {
              count: labels.length,
              formatted: number.format(labels.length),
            }),
          })}
        </h1>
        <p className="mk-km-print__product">
          {t("pages.kmOrders.print.product", {
            product: order.productName,
            gtin: order.gtin14,
          })}
        </p>
        <p className="mk-km-print__note">
          {t("pages.kmOrders.print.note", { width: spec.widthMm, height: spec.heightMm })}
        </p>
        {allReady ? null : (
          <p className="mk-km-print__note" role="status">
            {t("pages.kmOrders.print.progress", {
              done: number.format(rasters.size),
              total: number.format(labels.length),
            })}
          </p>
        )}
        {degradedCount > 0 ? (
          <Alert
            className="mk-km-print__degraded"
            tone="warn"
            title={t("pages.kmOrders.print.degraded", {
              count: degradedCount,
              formatted: number.format(degradedCount),
              total: number.format(labels.length),
            })}
          >
            {t("pages.kmOrders.print.degradedHint")}
          </Alert>
        ) : null}
        <div className="mk-km-print__actions">
          <Button type="button" onClick={() => window.print()}>
            {t("pages.kmOrders.print.printAction")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            // Disabled until the batch is painted: clicking mid-rasterization
            // would print label one straight away and then let the automatic
            // dialog reopen minutes later over the full sheet, which is the
            // opposite of what a calibration run wants.
            disabled={!allReady}
            onClick={() => {
              setFirstOnly(true);
            }}
          >
            {t("pages.kmOrders.print.printFirst")}
          </Button>
          <Link to={`/km-orders/${order.id}`}>{t("pages.kmOrders.print.back")}</Link>
        </div>
        <p className="mk-km-print__note">{t("pages.kmOrders.print.printFirstHint")}</p>
      </header>
      {labels.map((label) => {
        const raster = rasters.get(label.seq);
        return (
          <section
            key={label.seq}
            className="mk-km-print__page"
            data-ready={raster === undefined ? "false" : "true"}
            style={{ width: `${spec.widthMm}mm`, height: `${spec.heightMm}mm` }}
          >
            {raster !== undefined && raster.kind === "ready" ? (
              <img
                className="mk-km-print__label"
                src={raster.url}
                alt={t("pages.kmOrders.print.labelAria", { seq: label.seq })}
                width={widthPx}
                height={heightPx}
              />
            ) : (
              <>
                {/* Decorative: it stands in for a label, it is not one. */}
                <img className="mk-km-print__label" alt="" width={widthPx} height={heightPx} />
                {raster === undefined ? null : (
                  // Printed, not screen-only: a page that came out of the
                  // printer blank has to say which sequence number it was.
                  <span className="mk-km-print__failed">
                    {t("pages.kmOrders.print.renderFailed", { seq: label.seq })}
                  </span>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PrintMessage({
  title,
  hint,
  orderId,
  action,
}: {
  title: string;
  hint: string;
  orderId: string;
  action?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="mk-km-print">
      <div className="mk-km-print__screen-only">
        <EmptyState title={title} hint={hint} {...(action !== undefined ? { action } : {})} />
        <Link to={`/km-orders/${orderId}`}>{t("pages.kmOrders.print.back")}</Link>
      </div>
    </div>
  );
}

export function KmOrderPrintPage() {
  const { t } = useTranslation();
  const { orderId = "", issueId = "" } = useParams();
  const [search] = useSearchParams();
  const order = useKmOrder(orderId);
  const codes = useKmIssueCodes(orderId, issueId);

  // The dialog names the template it printed with. «Печать ещё раз» cannot:
  // an issue record does not store one, so the page re-derives it. This only
  // reproduces the original template when the tenant has a single eligible
  // marking-code template -- persisting it on the issue is the real fix and
  // needs a schema change.
  const requested = search.get("template")?.trim() ?? "";
  const derive = requested === "";
  const groups = useChzProductGroups({ enabled: derive });
  const templates = useLabelTemplates({ enabled: "true" }, { enabled: derive });
  const derived = useMemo(() => {
    if (!derive || templates.data === undefined || order.data === undefined) return null;
    const groupCode = kmOrderGroupCode(groups.data, order.data.productGroupAlias);
    return preferredKmTemplate(eligibleKmTemplates(templates.data, groupCode))?.id ?? null;
  }, [derive, groups.data, order.data, templates.data]);

  const templateId = derive ? derived : requested;
  const template = useLabelTemplate(templateId);

  // This page normally owns its own tab, where the cabinet's generic title
  // says nothing about which batch is on screen. The previous title is put
  // back on the way out, for the case where it does not: «Вернуться к заказу»
  // is a same-tab navigation.
  useEffect(() => {
    if (order.data === undefined) return undefined;
    const previous = document.title;
    document.title = t("pages.kmOrders.print.documentTitle", { product: order.data.productName });
    return () => {
      document.title = previous;
    };
  }, [order.data, t]);

  if (order.isError || codes.isError) {
    return (
      <PrintMessage
        orderId={orderId}
        title={t("pages.kmOrders.print.loadError")}
        hint={t("pages.kmOrders.print.loadErrorHint")}
        action={
          <Button
            type="button"
            onClick={() => {
              void order.refetch();
              void codes.refetch();
            }}
          >
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  // A reference this page cannot read would silently drop every group-scoped
  // template and hand the office the universal one in its place, or claim it
  // has none at all. Same rule as the issue dialog: say so instead.
  const referenceError = derive && (templates.isError || groups.isError);
  const referencePending = derive && (templates.isPending || groups.isPending);

  if (order.isPending || codes.isPending || (referencePending && !referenceError)) {
    return (
      <div className="mk-km-print">
        <Spinner label={t("pages.kmOrders.print.loading")} />
      </div>
    );
  }

  if (referenceError || templateId === null || template.isError) {
    return (
      <PrintMessage
        orderId={orderId}
        title={t("pages.kmOrders.print.templateMissing")}
        hint={t("pages.kmOrders.print.templateMissingHint")}
      />
    );
  }

  if (codes.data.length === 0) {
    return (
      <PrintMessage
        orderId={orderId}
        title={t("pages.kmOrders.print.empty")}
        hint={t("pages.kmOrders.print.emptyHint")}
      />
    );
  }

  if (template.isPending || template.data === undefined) {
    return (
      <div className="mk-km-print">
        <Spinner label={t("pages.kmOrders.print.loading")} />
      </div>
    );
  }

  return <PrintSheet order={order.data} codes={codes.data} spec={template.data.spec} />;
}
