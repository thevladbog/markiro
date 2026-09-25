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
  undone: "Undone",
  gtin: "GTIN",
  serial: "Serial number",
  crypto: "Crypto tail",
};

describe("RecentOperations", () => {
  it("shows the serial, and the GTIN only on a wrong-GTIN row", () => {
    render(
      <RecentOperations
        operations={[
          {
            verdict: "wrong_gtin",
            scannedAt: "2026-08-13T10:00:01.000Z",
            codeSuffix: "…L-43",
            identity: {
              gtin14: "04600000000022",
              serial: "SERIAL-43",
              crypto: [],
              normalized: "(01)04600000000022 (21)SERIAL-43",
            },
          },
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
        counts={{ errors: 1, duplicates: 0 }}
        labels={{
          title: "Shift journal",
          empty: "No scans yet",
          invalidTime: "Time unknown",
          errors: "Errors",
          duplicates: "Duplicates",
        }}
        statusLabels={statusLabels}
        locale="en-US"
      />,
    );

    expect(screen.getByText("SERIAL-42").tagName).toBe("CODE");
    expect(screen.getByText("SERIAL-43").tagName).toBe("CODE");
    expect(screen.getByText("GTIN 04600000000022")).toBeDefined();
    expect(screen.queryByText(/04600000000015/)).toBeNull();
    expect(screen.getByTestId("journal-duplicates").getAttribute("data-tone")).toBeNull();
  });

  it("labels an undone row as a correction, not an error", () => {
    render(
      <RecentOperations
        operations={[
          {
            verdict: "undone",
            scannedAt: "2026-08-13T10:00:02.000Z",
            codeSuffix: null,
            identity: null,
          },
        ]}
        counts={{ errors: 0, duplicates: 0 }}
        labels={{
          title: "Shift journal",
          empty: "No scans yet",
          invalidTime: "Time unknown",
          errors: "Errors",
          duplicates: "Duplicates",
        }}
        statusLabels={statusLabels}
        locale="en-US"
      />,
    );

    expect(screen.getByText("Undone")).toBeDefined();
    expect(screen.getByRole("listitem").getAttribute("data-tone")).toBe("neutral");
    expect(screen.getByTestId("journal-errors").textContent).toBe("0");
  });
});
