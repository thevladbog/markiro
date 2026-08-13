import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { OfferTermsEditor } from "../src/pages/offers/OfferTermsEditor.js";

vi.mock("@mdxeditor/editor", () => ({
  MDXEditor: ({ markdown, onChange }: { markdown: string; onChange: (value: string) => void }) => (
    <button type="button" aria-label="editor" onClick={() => onChange("# Условия\n\n**Оплата**")}>
      {markdown}
    </button>
  ),
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  linkPlugin: () => ({}),
  tablePlugin: () => ({}),
  toolbarPlugin: () => ({}),
  UndoRedo: () => null,
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  CreateLink: () => null,
  InsertTable: () => null,
}));

afterEach(cleanup);

describe("OfferTermsEditor", () => {
  it("keeps offer terms keyboard-labelled and returns markdown", async () => {
    const onChange = vi.fn();
    const user = (await import("@testing-library/user-event")).default.setup();
    render(
      <ThemeProvider>
        <OfferTermsEditor
          value={null}
          onChange={onChange}
          label="Условия сотрудничества"
          error="Проверьте текст"
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("Условия сотрудничества")).toBeDefined();
    expect(screen.getByText("Проверьте текст")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "editor" }));
    expect(onChange).toHaveBeenCalledWith("# Условия\n\n**Оплата**");
  });
});
