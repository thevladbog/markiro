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
 * KNOWN LIMIT (not fixed here): a print batch may hold up to
 * `KM_PRINT_ISSUE_MAX_COUNT` codes, and this page mounts one canvas per code
 * at `PRINT_DPI`. A few hundred labels are comfortable; several thousand will
 * cost a browser far more memory than it should. Paginating or rasterizing
 * lazily is its own change.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";

import type { LabelField, LabelTemplateSpec, RasterizeTextFn } from "@markiro/domain";
import { Button, EmptyState, Spinner } from "@markiro/ui";

import { rasterizeText as realRasterizeText } from "../../labels/rasterizer.js";
import { useChzProductGroups } from "../catalog/api.js";
import { useLabelTemplate, useLabelTemplates } from "../labels/api.js";
import { PREVIEW_FONT_FAMILY } from "../labels/editor/PreviewPane.js";
import { compositeRasterText, type LabelRenderOptions } from "../labels/raster-composite.js";
import { draw } from "../labels/renderer.js";
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
 * The label's field values for one code. Deliberately a full literal rather
 * than an override of `sampleLabelData()`: a field this order cannot fill
 * prints EMPTY, never a sample. A template that happens to carry an operator
 * or a shift number would otherwise put «Смирнов А.» on real goods.
 *
 * The order DTO carries no separate print name, so the catalogue name fills
 * both -- the station applies the same "print name or name" fallback.
 */
export function kmLabelData(order: KmOrder, code: string): Record<LabelField, string> {
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

interface LabelCanvasProps {
  spec: LabelTemplateSpec;
  scale: number;
  data: Record<LabelField, string>;
  seq: number;
  /** Stable across renders: a fresh identity would repaint every label. */
  onReady: (seq: number) => void;
  rasterizeText?: RasterizeTextFn;
}

/**
 * One label, painted exactly as `editor/PreviewPane.tsx` paints its preview:
 * the schematic `draw()` followed by the shared raster compositing pass.
 *
 * `onReady` fires exactly once per mounted label, whatever later repaints do,
 * and fires even when the label could not be painted at all -- under jsdom
 * (and any browser without a 2D context) `getContext` answers `null`, which
 * degrades to a placeholder rather than throwing and must not leave the page
 * waiting forever for a canvas that will never report in.
 */
function LabelCanvas({
  spec,
  scale,
  data,
  seq,
  onReady,
  rasterizeText = realRasterizeText,
}: LabelCanvasProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readyRef = useRef(false);
  const [drawable, setDrawable] = useState(true);
  const [failed, setFailed] = useState(false);
  const widthPx = Math.round(spec.widthMm * scale);
  const heightPx = Math.round(spec.heightMm * scale);

  useEffect(() => {
    let cancelled = false;
    const markReady = () => {
      if (cancelled || readyRef.current) return;
      readyRef.current = true;
      onReady(seq);
    };

    const ctx = canvasRef.current?.getContext("2d") ?? null;
    if (!ctx) {
      setDrawable(false);
      markReady();
      return () => {
        cancelled = true;
      };
    }

    try {
      draw(spec, ctx, scale, data, KM_RENDER_OPTIONS);
    } catch {
      // Whatever went wrong, the reason may not be repeated back: the value
      // that would appear in it is a live marking code.
      setFailed(true);
      markReady();
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        await compositeRasterText(spec, ctx, scale, data, {
          fontFamily: PREVIEW_FONT_FAMILY,
          rasterizeText,
          renderOptions: KM_RENDER_OPTIONS,
          isCancelled: () => cancelled,
        });
      } finally {
        markReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [spec, scale, data, seq, onReady, rasterizeText]);

  if (!drawable || failed) {
    return (
      <>
        {/* Decorative: it stands in for a label, it is not one. */}
        <img className="mk-km-print__label" alt="" width={widthPx} height={heightPx} />
        {failed ? (
          <span className="mk-km-print__failed">
            {t("pages.kmOrders.print.renderFailed", { seq })}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="mk-km-print__label"
      role="img"
      aria-label={t("pages.kmOrders.print.labelAria", { seq })}
      width={widthPx}
      height={heightPx}
    />
  );
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
  // One record per code, memoised: `readySeqs` re-renders this component once
  // per label, and a fresh `data` object each time would repaint every canvas
  // on every one of those renders.
  const labels = useMemo(
    () => codes.map((code) => ({ seq: code.seq, data: kmLabelData(order, code.code) })),
    [codes, order],
  );
  const [readySeqs, setReadySeqs] = useState<ReadonlySet<number>>(() => new Set());
  const markReady = useCallback((seq: number) => {
    setReadySeqs((previous) => (previous.has(seq) ? previous : new Set(previous).add(seq)));
  }, []);

  const printedRef = useRef(false);
  const allReady = labels.length > 0 && readySeqs.size === labels.length;

  useEffect(() => {
    // Exactly once per page load. The ref, not the dependency list, is what
    // guarantees it: a refetch of the codes (zero cache lifetime, so a window
    // refocus is enough) re-runs this effect, and a second print dialog over
    // a job the office already sent to the printer is worse than none. The
    // «Открыть диалог печати» button below is the deliberate way back.
    if (!allReady || printedRef.current) return;
    printedRef.current = true;
    window.print();
  }, [allReady]);

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
    <div className="mk-km-print">
      {/* Emitted inline, not in `print.css`: the media size is the template's,
          and only this render knows it. */}
      <style>{`@page { size: ${spec.widthMm}mm ${spec.heightMm}mm; margin: 0 }`}</style>
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
        <div className="mk-km-print__actions">
          <Button type="button" onClick={() => window.print()}>
            {t("pages.kmOrders.print.printAction")}
          </Button>
          <Link to={`/km-orders/${order.id}`}>{t("pages.kmOrders.print.back")}</Link>
        </div>
      </header>
      {labels.map((label) => (
        <section
          key={label.seq}
          className="mk-km-print__page"
          data-ready={readySeqs.has(label.seq) ? "true" : "false"}
          style={{ width: `${spec.widthMm}mm`, height: `${spec.heightMm}mm` }}
        >
          <LabelCanvas
            spec={spec}
            scale={SCALE}
            data={label.data}
            seq={label.seq}
            onReady={markReady}
          />
        </section>
      ))}
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
