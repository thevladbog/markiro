import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecentOperations } from "../src/ui/work/RecentOperations.js";

const statusLabels = {
  waiting: "Waiting for a scan",
  ok: "Accepted",
  duplicate: "Duplicate",
  invalid: "Invalid code",
  wrong_gtin: "Wrong product",
  unknown: "Rejected",
  gtin: "GTIN",
  serial: "Serial number",
  crypto: "Crypto tail",
};

describe("RecentOperations", () => {
  it("labels the GTIN and serial as semantic definition rows", () => {
    render(
      <RecentOperations
        operations={[
          {
            verdict: "ok",
            scannedAt: "2026-08-13T10:00:00.000Z",
            codeSuffix: "…L-42",
            identity: {
              gtin14: "04600000000015",
              serial: "SERIAL-42",
              crypto: [],
              normalized: "(01)04600000000015 (21)SERIAL-42",
            },
          },
        ]}
        labels={{ title: "Recent operations", empty: "No scans yet", invalidTime: "Time unknown" }}
        statusLabels={statusLabels}
        locale="en-US"
      />,
    );

    expect(screen.getByText("GTIN").tagName).toBe("DT");
    expect(screen.getByText("04600000000015").tagName).toBe("DD");
    expect(screen.getByText("Serial number").tagName).toBe("DT");
    expect(screen.getByText("SERIAL-42").tagName).toBe("DD");
  });
});
