import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  sheetLogoFingerprint,
  type MonoRaster,
  nominalSheetGeometry,
  renderPalletSheet,
  sampleLabelData,
  type PalletTemplateChoice,
} from "@markiro/domain";
import { readDeviceRecovery } from "../../lib/device-recovery.js";
import {
  loadBundledMarkiroLogo,
  loadOrganizationBranding,
} from "../../lib/organization-branding.js";
import { rasterizeDriverText } from "../../lib/rasterizer.js";
import type { CredentialGeneration } from "../../lib/credential-recovery.js";
import type { SqlExecutor } from "../../lib/mirror.js";
import { MonoRasterPreview } from "../LabelRasterPreview.js";
import { LabelPreview } from "./LabelPreview.js";
type LogoOwner = { exec: SqlExecutor; generation: CredentialGeneration };
const scopedCache = new WeakMap<CredentialGeneration, Map<string, Promise<MonoRaster>>>();
export function PalletChoicePreview({
  choice,
  logoOwner,
}: {
  choice: PalletTemplateChoice;
  logoOwner?: LogoOwner;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ key: string; bytes: MonoRaster | null } | null>(null);
  const key = choice.snapshotDigest;
  const thermal = useMemo(
    () => (choice.kind === "thermal" ? { name: choice.name, spec: choice.snapshot } : null),
    [choice],
  );
  const exec = logoOwner?.exec,
    generation = logoOwner?.generation;
  useEffect(() => {
    if (choice.kind !== "a4") return;
    let active = true;
    const run = async () => {
      const recovery = exec ? await readDeviceRecovery(exec) : null;
      const branding =
        exec && generation && recovery?.owner
          ? await loadOrganizationBranding({
              exec,
              generation,
              tenantId: recovery.owner.tenantId,
              isCurrent: () => !generation.sealed,
            })
          : null;
      if (generation?.sealed) throw new Error("WAREHOUSE_OWNER_CHANGED");
      const cacheKey = JSON.stringify([key, branding?.digest ?? "bundled"]);
      const cache = generation
        ? (scopedCache.get(generation) ?? new Map<string, Promise<MonoRaster>>())
        : null;
      if (generation && cache) scopedCache.set(generation, cache);
      let promise = cache?.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const bundled = branding ? null : await loadBundledMarkiroLogo();
          const logo =
            branding?.logo ??
            (bundled
              ? { ...bundled, digest: sheetLogoFingerprint(bundled), source: "markiro" as const }
              : null);
          if (!logo) throw new Error("Logo unavailable");
          return renderPalletSheet(
            choice.snapshot.spec,
            {
              sscc: "146000000000001231",
              productPrintName: sampleLabelData()["product.printName"],
              gtin14: "04600682000013",
              egaisCode: "0300005753630000024",
              boxCount: 48,
              itemCount: 576,
              productionDate: "2026-10-13",
              shelfLifeDays: 365,
              shiftNumber: "OCT26-006/S",
              organizationName: branding?.organizationName ?? "Маркиро",
              organizationInn: branding?.organizationInn ?? null,
              logo,
            },
            nominalSheetGeometry(choice.snapshot.spec),
            rasterizeDriverText,
          );
        })();
        if (cache) {
          if (cache.size >= 6) {
            const oldest = cache.keys().next().value;
            if (oldest) cache.delete(oldest);
          }
          cache.set(cacheKey, promise);
          promise.catch(() => {
            if (cache.get(cacheKey) === promise) cache.delete(cacheKey);
          });
        }
      }
      return promise;
    };
    const timer = setTimeout(() => {
      void run()
        .then((bytes) => {
          if (active && !generation?.sealed) setLoaded({ key, bytes });
        })
        .catch(() => {
          if (active) setLoaded({ key, bytes: null });
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [choice, key, exec, generation]);
  if (thermal) return <LabelPreview template={thermal} {...(logoOwner ? { logoOwner } : {})} />;
  return (
    <figure className="warehouse-label-preview warehouse-sheet-choice-preview">
      {loaded?.key === key && loaded.bytes && !generation?.sealed ? (
        <MonoRasterPreview
          page={loaded.bytes}
          maxSide={800}
          label={t("warehouse.previewLabel", { name: choice.name })}
        />
      ) : (
        <p role="status">
          {t(loaded?.key === key ? "warehouse.previewUnavailable" : "warehouse.previewLoading")}
        </p>
      )}
      <figcaption>{t("warehouse.previewSample")} · А4</figcaption>
    </figure>
  );
}
