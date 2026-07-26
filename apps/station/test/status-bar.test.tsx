import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { StatusBar } from "../src/ui/StatusBar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBar", () => {
  it("reports a connected scanner", () => {
    render(<StatusBar online scannerConnected printerConfigured={false} />);
    expect(screen.getByText("Connected")).toBeDefined();
  });

  it("reports hardware that is not set up yet", () => {
    render(<StatusBar online={false} scannerConnected={false} printerConfigured={false} />);
    expect(screen.getAllByText("Not configured")).toHaveLength(3);
  });
});
