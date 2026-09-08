import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { ThemeProvider } from "@markiro/ui";
import { receivingDraftItemSchema, type ReceivingDraftItem } from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { emptyReceivingLine, ReceivingLineEditor } from "../src/us/receiving/line-editor.js";

afterEach(cleanup);

it.each(["en-US", "es-US"] as const)(
  "preserves 120 supplementary TLC points and retains the rejected 121st point in %s",
  async (locale) => {
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale,
      resources: { [locale]: { translation: masterDataCopy[locale] } },
      initAsync: false,
    });
    const client = createUsBrowserClient(async () =>
      Response.json({ items: [], limit: 50, offset: 0 }),
    );
    let latest: ReceivingDraftItem = { ...emptyReceivingLine };
    function Harness() {
      const [value, setValue] = useState<ReceivingDraftItem>(latest);
      return (
        <ReceivingLineEditor
          value={value}
          number={1}
          disabled={false}
          client={client}
          receivingLocationId={null}
          receivingLocationLabel=""
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
          onRemove={() => {}}
          onSessionLost={() => {}}
          onForbidden={async () => {}}
        />
      );
    }
    render(
      <StrictMode>
        <ThemeProvider>
          <I18nextProvider i18n={instance}>
            <Harness />
          </I18nextProvider>
        </ThemeProvider>
      </StrictMode>,
    );
    const user = userEvent.setup();
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: locale === "en-US" ? "Lot code (TLC)" : "Código de lote (TLC)",
    });
    const valid = "𐐀".repeat(120);
    await user.type(input, valid);
    expect(input.value).toBe(valid);
    expect(latest.tlc).toBe(valid);
    expect(receivingDraftItemSchema.parse(latest).tlc).toBe(valid);
    expect(input.maxLength).toBe(-1);
    await user.type(input, "𐐀");
    expect(input.value).toBe("𐐀".repeat(121));
    expect(latest.tlc).toBe("𐐀".repeat(121));
    const rejected = receivingDraftItemSchema.safeParse(latest);
    expect(rejected.success).toBe(false);
    if (!rejected.success)
      expect(rejected.error.issues.map((issue) => issue.path)).toContainEqual(["tlc"]);
  },
);
