import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import "../src/i18n/index.js";
import { CatalogP1Fields } from "../src/pages/catalog/CatalogP1Fields.js";
afterEach(cleanup);
it("preserves four unresolved choices and only offers server-approved named policies", () => {
  render(
    <ThemeProvider>
      <CatalogP1Fields
        values={{ chzIntegration: null, inventory: null, commerceMl: null, handheld: null }}
        policyId={null}
        policies={[]}
        onFeatureChange={vi.fn()}
        onPolicyChange={vi.fn()}
      />
    </ThemeProvider>,
  );
  expect(screen.getAllByRole("combobox")).toHaveLength(5);
  expect(screen.getByText(/Публикация недоступна/)).toBeDefined();
  expect(screen.getByText(/Укажите явно значения/)).toBeDefined();
  expect(screen.queryByRole("checkbox")).toBeNull();
});
