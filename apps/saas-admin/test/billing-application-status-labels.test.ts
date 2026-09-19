import { describe, expect, it } from "vitest";

import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

/**
 * Finding 5 (final review, mirrors задача 15's signer fix): a `failed`
 * invoice-line application event rendered with the `failed` phase (red `✕`,
 * "ошибка или отклонение системой" per the phase dictionary) but its label
 * read "Требует внимания" / "Needs attention" -- exactly the wording the
 * dictionary reserves for the `attention` phase. The word "внимание"
 * ("attention") must describe the `attention` phase alone; a `failed` label
 * must describe the failure itself.
 */
describe("billing.applicationStatuses.failed label", () => {
  it("does not borrow the attention phase's wording", () => {
    expect(ru.billing.applicationStatuses.failed).not.toMatch(/внимани/i);
    expect(en.billing.applicationStatuses.failed).not.toMatch(/attention/i);
  });

  it("describes the application failure in both languages", () => {
    expect(ru.billing.applicationStatuses.failed).toBe("Ошибка применения");
    expect(en.billing.applicationStatuses.failed).toBe("Application failed");
  });

  it("stays distinct from the sibling applied/skipped success labels", () => {
    expect(ru.billing.applicationStatuses.failed).not.toBe(ru.billing.applicationStatuses.applied);
    expect(ru.billing.applicationStatuses.failed).not.toBe(ru.billing.applicationStatuses.skipped);
    expect(en.billing.applicationStatuses.failed).not.toBe(en.billing.applicationStatuses.applied);
    expect(en.billing.applicationStatuses.failed).not.toBe(en.billing.applicationStatuses.skipped);
  });
});
