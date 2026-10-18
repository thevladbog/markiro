import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { warehousePreparedEvent } from "@markiro/domain";
import { WarehouseReprintView, type WarehouseReprintProps } from "../src/pages/WarehouseReprint.js";
import type { WarehouseWorkState } from "../src/lib/warehouse-reprint/work.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
vi.mock("../src/ui/WindowsDeliveryStatus.js", () => ({
  WindowsDeliveryStatus: ({ jobId }: { jobId: string }) => (
    <output data-testid="delivery-key">{jobId}</output>
  ),
}));
it.each(["pallet", "box", "unit"] as const)(
  "uses the persisted Windows delivery key for %s",
  (kind) => {
    const event = warehousePreparedEvent();
    const state: WarehouseWorkState = {
      initialized: true,
      busy: false,
      session: null,
      catalog: null,
      defaultBoxId: null,
      duplicate: false,
      error: null,
      verification: false,
      historyIssue: null,
      job: {
        jobId: event.jobId,
        attemptId: event.attemptId,
        attemptNo: 1,
        state: "delivery_unknown",
        kind,
        identity: event.identity,
        productName: "Historical",
        templateName: "Chosen",
        printerName: "Windows",
        repair: null,
        updatedAt: event.occurredAt,
        printScope: "exact-attempt-scope",
      },
    };
    const props: WarehouseReprintProps = {
      exec: { run: async () => {}, all: async () => [] },
      client: {
        get: async () => {
          throw new Error("unused");
        },
        post: async () => {
          throw new Error("unused");
        },
        download: async () => new Blob(),
        whoami: async () => ({ ok: true }),
      },
      deviceId: "00000000-0000-4000-8000-000000000030",
      operatorId: event.operatorId,
      credentialGeneration: createCredentialGeneration("synthetic"),
      source: { start: () => () => {} },
      hardwareConfig: {
        scanner: null,
        printer: null,
        printerLanguage: "tspl",
        printerDpi: 203,
        verifyPrintedLabel: false,
      },
      print: async () => {},
      onExit: () => {},
    };
    const work = {
      scan: async () => {},
      configure: async () => {},
      newSession: async () => {},
      start: async () => {},
      close: async () => {},
      finish: async () => true,
      refreshCatalog: async () => {},
      requestVerification: () => {},
      cancelVerification: () => {},
      reprint: async () => {},
      sendPrepared: async () => {},
      acknowledgeHistory: async () => {},
      resolveOriginal: async () => {},
    };
    render(<WarehouseReprintView {...props} state={state} work={work} />);
    expect(screen.getByTestId("delivery-key").textContent).toBe(
      kind === "pallet" ? event.identity : event.jobId,
    );
  },
);
