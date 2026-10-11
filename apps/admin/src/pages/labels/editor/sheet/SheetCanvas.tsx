import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DomainError,
  type PalletSheetSpecV2,
  type RasterizeTextFn,
  type SheetElementRegion,
} from "@markiro/domain";
import type { SheetPreviewBranding } from "./sheet-branding.js";
import { Alert, Button, Checkbox } from "@markiro/ui";
import {
  loadSheetPreviewLogo,
  paintSheetRaster,
  previewSheetContext,
  renderSheetPreview,
  type SheetSampleOptions,
} from "./sheet-preview.js";
export function SheetCanvas({
  spec,
  rasterizeText,
  selectedId,
  onSelect,
  onMove,
  loadBranding,
}: {
  spec: PalletSheetSpecV2;
  rasterizeText: RasterizeTextFn;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onMove?: (id: string, dxMm: number, dyMm: number) => void;
  loadBranding?: () => Promise<SheetPreviewBranding>;
}) {
  const { t } = useTranslation();
  const key = (name: string) => t(`pages.labels.sheet.editor.${name}`);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; x: number; y: number } | null>(null);
  const [regions, setRegions] = useState<SheetElementRegion[]>([]);
  const [options, setOptions] = useState<SheetSampleOptions>({
    date: true,
    egais: true,
    longName: false,
    maximumCounts: false,
  });
  const [wideLogo, setWideLogo] = useState(false),
    [error, setError] = useState<string | null>(null),
    [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const target = canvas.current;
    if (!target?.getContext("2d")) return;
    setReady(false);
    setRegions([]);
    setError(null);
    const loading = loadBranding
      ? loadBranding()
      : loadSheetPreviewLogo(wideLogo).then((logo) => ({ organizationName: null, logo }));
    void loading
      .then((branding) =>
        renderSheetPreview(
          spec,
          {
            ...previewSheetContext(options, branding.logo),
            ...(branding.organizationName === null
              ? {}
              : { organizationName: branding.organizationName }),
          },
          rasterizeText,
          (measured) => {
            if (!cancelled) setRegions(measured);
          },
        ),
      )
      .then((raster) => {
        if (cancelled) return;
        paintSheetRaster(target, raster);
        setReady(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          target.width = 1;
          target.height = 1;
          setError(
            caught instanceof DomainError && caught.code === "LABEL_SHEET_BRANDING"
              ? t("pages.labels.sheet.editor.brandingError")
              : caught instanceof Error
                ? caught.message
                : String(caught),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spec, options, wideLogo, rasterizeText, loadBranding, t]);
  const width = spec.page.orientation === "portrait" ? 210 : 297,
    height = spec.page.orientation === "portrait" ? 297 : 210;
  return (
    <section className="sheet-preview" aria-label={key("preview")}>
      <fieldset>
        <legend>{key("sample")}</legend>
        {(["date", "egais", "longName", "maximumCounts"] as const).map((name) => (
          <Checkbox
            key={name}
            label={key(name)}
            checked={options[name]}
            onCheckedChange={(checked) => setOptions({ ...options, [name]: checked })}
          />
        ))}
        {!loadBranding ? (
          <Checkbox label={key("wideLogo")} checked={wideLogo} onCheckedChange={setWideLogo} />
        ) : null}
      </fieldset>
      <p>
        {width} × {height} мм · 300 dpi · {key("previewHint")}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: `${width * 2}px`,
          aspectRatio: `${width}/${height}`,
        }}
      >
        <canvas
          ref={canvas}
          aria-label={key("preview")}
          data-sheet-ready={ready}
          style={{
            width: "100%",
            height: "100%",
            background: "white",
            border: "1px solid var(--line-strong)",
          }}
        />
        {ready && onSelect
          ? regions.map((region) => (
              <Button
                type="button"
                key={`${region.id}-${region.copy}`}
                variant="secondary"
                aria-label={`${key("properties")} ${region.id} ${region.copy + 1}`}
                aria-pressed={selectedId === region.id}
                style={{
                  position: "absolute",
                  left: `${(region.leftMm / width) * 100}%`,
                  top: `${(region.topMm / height) * 100}%`,
                  width: `${(region.widthMm / width) * 100}%`,
                  height: `${(region.heightMm / height) * 100}%`,
                  minHeight: 0,
                  padding: 0,
                  border:
                    selectedId === region.id ? "2px solid var(--fg-1)" : "1px dashed transparent",
                  background: "transparent",
                }}
                onClick={() => onSelect(region.id)}
                onPointerDown={(event) => {
                  onSelect(region.id);
                  drag.current = { id: region.id, x: event.clientX, y: event.clientY };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => {
                  const start = drag.current;
                  drag.current = null;
                  if (!start || !canvas.current) return;
                  const box = canvas.current.getBoundingClientRect();
                  if (box.width && box.height)
                    onMove?.(
                      start.id,
                      ((event.clientX - start.x) * width) / box.width,
                      ((event.clientY - start.y) * height) / box.height,
                    );
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(event) => {
                  const amount = event.shiftKey ? 5 : 1;
                  const delta = (
                    {
                      ArrowLeft: [-amount, 0],
                      ArrowRight: [amount, 0],
                      ArrowUp: [0, -amount],
                      ArrowDown: [0, amount],
                    } as Record<string, number[]>
                  )[event.key];
                  if (delta) {
                    event.preventDefault();
                    onMove?.(region.id, delta[0] ?? 0, delta[1] ?? 0);
                  }
                }}
              />
            ))
          : null}
      </div>
    </section>
  );
}
