import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RequestEditor } from "../src/us/requests/editor.js";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import { renderPlanUi } from "./us-plans-fixtures.js";
import { deferred, requestDetail } from "./us-requests-fixtures.js";

afterEach(() => cleanup());
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const props = () => ({
  detail: null,
  timeZone: "America/Los_Angeles",
  disabled: false,
  onSave: vi.fn(async () => {}),
  onDirtyChange: vi.fn(),
});

it("submits a null-scope shell with exact tenant wall milliseconds and default elapsed deadline", async () => {
  const p = props();
  renderPlanUi(<RequestEditor {...p} />);
  change("Request number", "SYNTHETIC-001");
  change("Requester name", "Synthetic requester");
  change("Received at", "2026-10-05T05:00");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(p.onSave).toHaveBeenCalledWith({
    requestNumber: "SYNTHETIC-001",
    requesterName: "Synthetic requester",
    requesterOrganization: null,
    requesterContact: null,
    receivedAt: "2026-10-05T12:00:00.000Z",
    dueAt: "2026-10-06T12:00:00.000Z",
    alternateDeadlineReason: null,
    scope: null,
  });
});
it("retains field errors and requires an explicit offset for a repeated local time", async () => {
  const p = props();
  renderPlanUi(<RequestEditor {...p} />);
  change("Request number", "REQ");
  change("Requester name", "Synthetic requester");
  change("Received at", "2026-11-01T01:30");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(screen.getByText("Choose one of the available UTC offsets for this time.")).toBeTruthy();
  expect(p.onSave).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText("Receipt UTC offset"), "-28800");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(p.onSave).toHaveBeenCalledWith(
    expect.objectContaining({ receivedAt: "2026-11-01T09:30:00.000Z" }),
  );
});
it("guards double submission and keeps captured revision/raw values after save failure and incoming revision drift", async () => {
  const pending = deferred<void>();
  const p = { ...props(), detail: requestDetail(), onSave: vi.fn(() => pending.promise) };
  const ui = renderPlanUi(<RequestEditor {...p} />);
  change("Requester contact (optional)", "private@example.test");
  const save = screen.getByRole("button", { name: "Save request" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(p.onSave).toHaveBeenCalledTimes(1);
  expect(p.onSave).toHaveBeenCalledWith({
    expectedRevision: 1,
    requesterContact: "private@example.test",
  });
  await act(async () => pending.reject(new Error("synthetic")));
  ui.rerender(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={ui.instance}>
        <RequestEditor {...p} detail={requestDetail({ revision: 2 })} disabled />
      </I18nextProvider>
    </ThemeProvider>,
  );
  expect((screen.getByLabelText("Requester contact (optional)") as HTMLInputElement).value).toBe(
    "private@example.test",
  );
});
it("preserves exact milliseconds and raw values when locale changes", async () => {
  const p = {
    ...props(),
    detail: requestDetail({
      receivedAt: "2026-10-05T12:00:00.123Z",
      dueAt: "2026-10-06T12:00:00.123Z",
    }),
  };
  const ui = renderPlanUi(<RequestEditor {...p} />);
  change("Requester contact (optional)", "private@example.test");
  await act(() => ui.instance.changeLanguage("es-US"));
  expect((screen.getByLabelText("Recibida a las") as HTMLInputElement).value).toBe(
    "2026-10-05T05:00:00.123",
  );
  await userEvent.click(screen.getByRole("button", { name: "Guardar solicitud" }));
  expect(p.onSave).toHaveBeenCalledWith({
    expectedRevision: 1,
    requesterContact: "private@example.test",
  });
});
it("rejects a DST gap and invalid alternative deadline without losing the text", async () => {
  const p = props();
  renderPlanUi(<RequestEditor {...p} />);
  change("Request number", "REQ");
  change("Requester name", "Synthetic requester");
  change("Received at", "2026-03-08T02:30");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(
    screen.getByText(
      "This local time does not exist in the tenant time zone. Choose another time.",
    ),
  ).toBeTruthy();
  change("Received at", "2026-10-05T05:00");
  await userEvent.selectOptions(screen.getByLabelText("Deadline policy"), "alternative");
  change("Due at", "2026-10-05T04:00");
  change("Reason for the agreed alternative deadline", "Agreed");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(screen.getByText("The deadline must follow receipt.")).toBeTruthy();
  expect(p.onSave).not.toHaveBeenCalled();
});
it("clears an old alternative reason when explicitly choosing the default elapsed deadline", async () => {
  const p = {
    ...props(),
    detail: requestDetail({
      dueAt: "2026-10-07T00:00:00.000Z",
      alternateDeadlineReason: "Agreed extension",
    }),
  };
  renderPlanUi(<RequestEditor {...p} />);
  await userEvent.selectOptions(screen.getByLabelText("Deadline policy"), "default");
  await userEvent.click(screen.getByRole("button", { name: "Save request" }));
  expect(p.onSave).toHaveBeenCalledWith({
    expectedRevision: 1,
    dueAt: "2026-10-06T00:00:00.000Z",
    alternateDeadlineReason: null,
  });
});
