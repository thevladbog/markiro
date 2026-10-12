import { loadThermalLabelLogo } from "../../lib/organization-branding.js";
import type { SqlExecutor } from "../../lib/mirror.js";
import type { CredentialGeneration } from "../../lib/credential-recovery.js";
import { useEffect, useState, useRef } from "react";
import {
  createLabelRenderPlan,
  productLabelValueDigest,
  sheetLogoFingerprint,
  sampleLabelData,
  type LabelRenderPlan,
  type PrinterDpi,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { TextPreview } from "./TextPreview.js";
import { rasterizeText } from "../../lib/rasterizer.js";
import { useTranslation } from "react-i18next";
const ownerCaches = new WeakMap<CredentialGeneration, Map<string, Promise<LabelRenderPlan>>>();
type PreviewTemplate = { name: string; spec: LabelTemplateSpec };
export function LabelPreview({
  template,
  logoOwner,
  dpi = template.spec.dpi,
  language = template.spec.language,
}: {
  template: PreviewTemplate;
  logoOwner?: { exec: SqlExecutor; generation: CredentialGeneration };
  dpi?: PrinterDpi;
  language?: LabelTemplateSpec["language"];
}) {
  const { t } = useTranslation();
  const logoExec = logoOwner?.exec;
  const logoGeneration = logoOwner?.generation;
  const localCache = useRef(new Map<string, Promise<LabelRenderPlan>>());
  const renderKey = productLabelValueDigest([template.spec, dpi, language]);
  const [loaded, setLoaded] = useState<{
    key: string;
    dpi: PrinterDpi;
    language: LabelTemplateSpec["language"];
    plan: LabelRenderPlan | null;
    logoExec: SqlExecutor | undefined;
    logoGeneration: CredentialGeneration | undefined;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const run = async () => {
      const hasLogo = template.spec.elements.some((e) => e.kind === "organization_logo");
      const branding =
        hasLogo && logoExec && logoGeneration
          ? { logo: await loadThermalLabelLogo(logoExec, logoGeneration) }
          : {};
      const key = JSON.stringify([
        renderKey,
        "logo" in branding && branding.logo ? sheetLogoFingerprint(branding.logo) : null,
      ]);
      const cache = logoGeneration
        ? (ownerCaches.get(logoGeneration) ?? new Map<string, Promise<LabelRenderPlan>>())
        : localCache.current;
      if (logoGeneration) ownerCaches.set(logoGeneration, cache);
      let pending = cache.get(key);
      if (!pending) {
        pending = createLabelRenderPlan(
          template.spec,
          { ...sampleLabelData(), "km.code": `${sampleLabelData()["km.code"]}\u001d93DEMO` },
          { dpi, language, rasterizeText, ...branding },
        );
        if (cache.size >= 6) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(key, pending);
        pending.catch(() => {
          if (cache.get(key) === pending) cache.delete(key);
        });
      }
      return pending;
    };
    void run()
      .then((plan) => {
        if (active) setLoaded({ key: renderKey, dpi, language, plan, logoExec, logoGeneration });
      })
      .catch(() => {
        if (active)
          setLoaded({ key: renderKey, dpi, language, plan: null, logoExec, logoGeneration });
      });
    return () => {
      active = false;
    };
  }, [template, renderKey, dpi, language, logoExec, logoGeneration]);
  const current =
    loaded?.key === renderKey &&
    loaded.dpi === dpi &&
    loaded.language === language &&
    loaded.logoExec === logoExec &&
    loaded.logoGeneration === logoGeneration &&
    !logoGeneration?.sealed;
  const plan = current ? loaded.plan : null;
  const spec = template.spec;
  return (
    <figure className="warehouse-label-preview">
      {spec.gs1Constraint && <p role="note">{t("warehouse.gs1WidthConstraint")}</p>}
      {plan ? (
        <svg
          role="img"
          aria-label={t("warehouse.previewLabel", { name: template.name })}
          viewBox={`0 0 ${plan.widthDots} ${plan.heightDots}`}
          width={plan.widthDots}
          height={plan.heightDots}
          style={{
            width: `min(100%, calc(var(--label-preview-max-height) * ${plan.widthDots / plan.heightDots}))`,
            aspectRatio: `${plan.widthDots} / ${plan.heightDots}`,
          }}
          data-language={plan.language}
          data-dpi={plan.dpi}
        >
          <rect width={plan.widthDots} height={plan.heightDots} fill="white" />
          {plan.elements.map((e) =>
            e.kind === "raster" ? (
              <TextPreview key={e.id} element={e} dpi={plan.dpi} />
            ) : e.kind === "barcode" ? (
              <image
                key={e.id}
                data-barcode-element={e.id}
                x={e.xDots}
                y={e.yDots}
                width={e.widthDots}
                height={e.heightDots}
                href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(e.svg)}`}
                preserveAspectRatio="none"
              />
            ) : (
              <rect
                key={e.id}
                x={e.xDots + (e.filled ? 0 : e.thicknessDots / 2)}
                y={e.yDots + (e.filled ? 0 : e.thicknessDots / 2)}
                width={e.widthDots - (e.filled ? 0 : e.thicknessDots)}
                height={e.heightDots - (e.filled ? 0 : e.thicknessDots)}
                fill={e.filled ? "black" : "none"}
                stroke={e.filled ? "none" : "black"}
                strokeWidth={e.thicknessDots}
              />
            ),
          )}
        </svg>
      ) : (
        <p role="status">
          {t(current ? "warehouse.previewUnavailable" : "warehouse.previewLoading")}
        </p>
      )}
      <figcaption>
        {t("warehouse.previewSample")} · {spec.widthMm} × {spec.heightMm} {t("warehouse.mm")}
      </figcaption>
    </figure>
  );
}
