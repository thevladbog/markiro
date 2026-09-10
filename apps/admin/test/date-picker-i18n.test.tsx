import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import i18n from "../src/i18n/index.js";
import { InventoryParametersForm } from "../src/pages/inventory/InventoryParametersForm.js";

const SRC_DIR = join(__dirname, "../src");

/**
 * `@markiro/ui`'s DatePicker defaults every user-visible string to Russian
 * (placeholder, clear action, calendar dialog, month navigation) and defaults
 * `locale` to `ru-RU`. A call site that omits them leaks Russian into the
 * English cabinet, so each one has to pass the shared dictionary entries.
 */
const REQUIRED_PROPS = [
  ["placeholder", "common.datePicker.placeholder"],
  ["clearLabel", "common.datePicker.clear"],
  ["calendarLabel", "common.datePicker.calendar"],
  ["previousMonthLabel", "common.datePicker.previousMonth"],
  ["nextMonthLabel", "common.datePicker.nextMonth"],
] as const;

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.isFile() && (path.endsWith(".tsx") || path.endsWith(".ts")) ? [path] : [];
  });
}

/** Slices out each `<DatePicker ... />`, ignoring `>` nested inside braces. */
function extractDatePickerElements(source: string): string[] {
  const elements: string[] = [];
  for (let start = source.indexOf("<DatePicker"); start !== -1;) {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) {
        elements.push(source.slice(start, index + 1));
        break;
      }
    }
    start = source.indexOf("<DatePicker", start + 1);
  }
  return elements;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function renderInventoryParameters() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ items: [] })),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ThemeProvider defaultTheme="light">
        <InventoryParametersForm
          initialValue={{
            productId: "22222222-2222-4222-8222-222222222222",
            lineId: "33333333-3333-4333-8333-333333333333",
            mode: "check",
            productionDateFrom: "2026-09-01",
            productionDateTo: "2026-09-30",
            boxLabelTemplateId: null,
          }}
          submitLabel="Continue"
          cancelLabel="Cancel"
          pending={false}
          requestError={null}
          onCancel={() => {}}
          onSubmit={() => {}}
        />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

describe("inventory parameters date pickers", () => {
  it("localizes both production-date pickers in the English cabinet", async () => {
    await i18n.changeLanguage("en");
    const user = renderInventoryParameters();

    const from = await screen.findByRole("button", { name: "Production date from" });
    const to = await screen.findByRole("button", { name: "Production date to" });
    expect(from.textContent).toContain("September 1, 2026");
    expect(to.textContent).toContain("September 30, 2026");
    expect(screen.getByRole("button", { name: "Clear date: Production date from" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear date: Production date to" })).toBeDefined();

    await user.click(from);

    const calendar = await screen.findByRole("dialog", { name: "Calendar" });
    expect(calendar).toBeDefined();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Next month" })).toBeDefined();
  });

  it("shows the English empty-value placeholder when no period is set yet", async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ items: [] })),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <ThemeProvider defaultTheme="light">
          <InventoryParametersForm
            submitLabel="Continue"
            cancelLabel="Cancel"
            pending={false}
            requestError={null}
            onCancel={() => {}}
            onSubmit={() => {}}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const from = await screen.findByRole("button", { name: "Production date from" });
    const to = await screen.findByRole("button", { name: "Production date to" });
    expect(from.textContent).toBe("Select a date");
    expect(to.textContent).toBe("Select a date");
  });
});

describe("admin DatePicker call sites", () => {
  it("passes the localized labels and the active locale everywhere", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_DIR)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("<DatePicker")) continue;

      for (const element of extractDatePickerElements(source)) {
        const missing: string[] = REQUIRED_PROPS.filter(([prop, key]) => {
          const match = new RegExp(`${prop}=\\{t\\((["'\`])${key}\\1`).exec(element);
          return match === null;
        }).map(([prop]) => prop);
        if (!/\blocale=\{/.test(element)) missing.push("locale");
        if (missing.length > 0) {
          const label = /label=\{t\((["'`])([^"'`]+)\1/.exec(element)?.[2] ?? "(unlabelled)";
          offenders.push(`${relative(SRC_DIR, file)} [${label}]: ${missing.join(", ")}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
