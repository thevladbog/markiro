import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import userEvent from "@testing-library/user-event";
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
  expect(screen.queryByText(/Публикация недоступна/)).toBeNull();
  expect(screen.getByRole("combobox", { name: /Правила действия лицензии/ }).textContent).toContain(
    "Без дополнительных правил",
  );
  expect(screen.getByText(/Укажите явно значения/)).toBeDefined();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("explains license rules and disables an empty approved-policy selector", () => {
  render(
    <ThemeProvider>
      <CatalogP1Fields
        values={null}
        policyId={null}
        policies={[]}
        onFeatureChange={vi.fn()}
        onPolicyChange={vi.fn()}
      />
    </ThemeProvider>,
  );
  const policy = screen.getByRole("combobox", { name: /Правила действия лицензии/ });
  expect(policy.hasAttribute("disabled")).toBe(true);
  const hint = document.getElementById(policy.getAttribute("aria-describedby") ?? "");
  expect(hint?.textContent).toContain("правила применения лицензии и ограничений");
  expect(screen.getByRole("alert").textContent).toContain(
    "Можно публиковать тарифы, дополнения и услуги",
  );
  expect(screen.getByRole("alert").textContent).toContain("Для подписок действуют текущие правила");
});

it("allows an approved policy to be chosen with the keyboard", async () => {
  const onPolicyChange = vi.fn();
  render(
    <ThemeProvider>
      <CatalogP1Fields
        values={null}
        policyId={null}
        policies={[{ id: "policy-approved", policyKey: "standard", version: 2 }]}
        onFeatureChange={vi.fn()}
        onPolicyChange={onPolicyChange}
      />
    </ThemeProvider>,
  );
  const user = userEvent.setup();
  const policy = screen.getByRole("combobox", { name: /Правила действия лицензии/ });
  expect(policy.hasAttribute("disabled")).toBe(false);
  policy.focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{End}{Enter}");
  expect(onPolicyChange).toHaveBeenCalledWith("policy-approved");
});

it("does not claim there are no approved rules before the server context arrives", () => {
  render(
    <ThemeProvider>
      <CatalogP1Fields
        values={null}
        policyId={null}
        policies={undefined}
        onFeatureChange={vi.fn()}
        onPolicyChange={vi.fn()}
      />
    </ThemeProvider>,
  );
  expect(
    screen.getByRole("combobox", { name: /Правила действия лицензии/ }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("lets an unavailable selected policy be cleared when no approved policies remain", async () => {
  const onPolicyChange = vi.fn();
  render(
    <ThemeProvider>
      <CatalogP1Fields
        values={null}
        policyId="policy-unavailable"
        policies={[]}
        onFeatureChange={vi.fn()}
        onPolicyChange={onPolicyChange}
      />
    </ThemeProvider>,
  );
  const policy = screen.getByRole("combobox", { name: /Правила действия лицензии/ });
  expect(policy.hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("alert").textContent).toContain("Выбранные правила недоступны");
  const user = userEvent.setup();
  policy.focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{Home}{Enter}");
  expect(onPolicyChange).toHaveBeenCalledWith(null);
});
