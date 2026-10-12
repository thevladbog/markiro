import { useMemo, useState } from "react";
import {
  buildPalletLabelTemplates,
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  PALLET_REPRINT_V2_PROTOCOL,
  type PalletTemplateChoice,
  buildWarehouseCodeOnlyLabelTemplate,
  productLabelValueDigest,
  warehouseBoxTemplate,
  WAREHOUSE_REPRINT_PROTOCOL,
  warehousePreparedEvent,
} from "@markiro/domain";
import { WarehouseReprintView } from "../pages/WarehouseReprint.js";
import type { WarehouseWorkState } from "../lib/warehouse-reprint/work.js";
import { createCredentialGeneration } from "../lib/credential-recovery.js";
import type { StationClient } from "../lib/api-client.js";
const exec = { run: async () => {}, all: () => Promise.resolve([]) };
const client: StationClient = {
  get: () => Promise.reject(new Error("synthetic fixture")),
  post: () => Promise.reject(new Error("synthetic fixture")),
  download: () => Promise.resolve(new Blob()),
  whoami: () => Promise.resolve({ ok: true }),
};
const source = { start: () => () => {} };
export function WarehouseReprintGallery({ variant }: { variant: string }) {
  const seed = useMemo(() => {
    const box = warehouseBoxTemplate();
    const { digest, ...value } = {
      ...box,
      id: "00000000-0000-4000-8000-000000000040",
      name: "Только код",
      purpose: "product_duplicate" as const,
      spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    };
    void digest;
    const unit = { ...value, digest: productLabelValueDigest(value) };
    const preset = buildPalletLabelTemplates()[0];
    if (!preset) throw new Error("Missing pallet preset");
    let pallet: PalletTemplateChoice = {
      kind: "thermal",
      id: "00000000-0000-4000-8000-000000000041",
      name: "Палета 75×120",
      snapshot: preset.spec,
      snapshotDigest: productLabelValueDigest(preset.spec),
    };
    if (variant === "ready-a4") {
      const preset = buildPalletSheetPresets()[0];
      if (!preset) throw new Error("Missing A4 preset");
      const snapshot = createPalletSheetSnapshot({
        id: "00000000-0000-4000-8000-000000000041",
        name: preset.name,
        revision: 1,
        spec: preset.spec,
      });
      pallet = {
        kind: "a4",
        id: "00000000-0000-4000-8000-000000000041",
        name: preset.name,
        snapshot,
        snapshotDigest: productLabelValueDigest(snapshot),
      };
    }
    const event = warehousePreparedEvent();
    const state: WarehouseWorkState = {
      initialized: true,
      busy: variant === "lookup",
      catalog: {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([unit, box]),
        templates: [
          unit,
          box,
          ...Array.from({ length: 18 }, (_, index) => {
            const { digest: oldDigest, ...copy } = {
              ...(index % 2 ? unit : box),
              id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
              name: `${index % 2 ? "Код" : "Короб"} ${index + 2}`,
            };
            void oldDigest;
            return { ...copy, digest: productLabelValueDigest(copy) };
          }),
        ],
      },
      palletCatalog: { protocol: PALLET_REPRINT_V2_PROTOCOL, templates: [pallet] },
      session: {
        owner: "synthetic",
        sessionId: event.sessionId,
        operatorId: event.operatorId,
        reason: "damaged",
        status: variant === "setup" ? "paused" : "active",
        unitTemplate: unit,
        boxTemplate: box,
        palletTemplate: pallet,
        sentCount: variant === "legacy-sent" ? 1 : 0,
      },
      job:
        variant === "unknown" || variant === "legacy-sent"
          ? {
              jobId: event.jobId,
              attemptId: event.attemptId,
              attemptNo: 1,
              state: variant === "unknown" ? "delivery_unknown" : "sent",
              kind: "box",
              identity: event.identity,
              productName: "Сироп «Клюква», 0,5 л",
              templateName: box.name,
              printerName: "TSC 210",
              repair: event.repair,
              updatedAt: event.occurredAt,
            }
          : null,
      duplicate: false,
      error: null,
      verification: false,
      defaultBoxId: box.id,
      historyIssue: variant === "history-warning" ? "template_mismatch" : null,
    };
    return state;
  }, [variant]);
  const [state, setState] = useState(seed);
  const work = {
    scan: async () => {},
    newSession: async () => {},
    configure: (reason, unitTemplate, boxTemplate, palletTemplate) => {
      setState((s) => ({
        ...s,
        session: s.session
          ? {
              ...s.session,
              reason,
              unitTemplate,
              boxTemplate,
              palletTemplate: palletTemplate ?? null,
            }
          : null,
      }));
      return Promise.resolve();
    },
    start: () => {
      setState((s) => ({ ...s, session: s.session ? { ...s.session, status: "active" } : null }));
      return Promise.resolve();
    },
    close: async () => {},
    finish: () => Promise.resolve(true),
    refreshCatalog: async () => {},
    requestVerification: () => setState((s) => ({ ...s, verification: true })),
    cancelVerification: () => setState((s) => ({ ...s, verification: false })),
    reprint: async () => {},
    sendPrepared: async () => {},
    resolveOriginal: async () => {},
    acknowledgeHistory: () => {
      setState((s) => ({ ...s, historyIssue: null }));
      return Promise.resolve();
    },
  } satisfies Parameters<typeof WarehouseReprintView>[0]["work"];
  const generation = useMemo(() => createCredentialGeneration("synthetic-gallery-key"), []);
  return (
    <WarehouseReprintView
      exec={exec}
      client={client}
      deviceId="00000000-0000-4000-8000-000000000030"
      operatorId="00000000-0000-4000-8000-000000000001"
      credentialGeneration={generation}
      source={source}
      hardwareConfig={{
        scanner: null,
        printer: null,
        printerLanguage: "tspl",
        printerDpi: 203,
        verifyPrintedLabel: false,
        ...(variant === "ready-a4"
          ? {
              printerRouting: {
                printers: [
                  {
                    id: "pallet",
                    name: "A4 Windows",
                    target: { kind: "usb" as const, printer: "A4" },
                    mode: "windows_driver" as const,
                    paper: "a4" as const,
                    dpi: 300 as const,
                    language: "zpl" as const,
                  },
                ],
                assignments: { box: null, duplicate: null, pallet: "pallet" },
              },
            }
          : {}),
      }}
      print={async () => {}}
      onExit={() => {}}
      state={state}
      work={work}
    />
  );
}
