import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RequestScopeEditor } from "../src/us/requests/scope-editor.js";
import { RequestLotPicker } from "../src/us/requests/lot-picker.js";
import { scopeToFields, parseRequestScope } from "../src/us/requests/scope.js";
import { renderPlanUi } from "./us-plans-fixtures.js";
import { requestLot, requestsFixture } from "./us-requests-fixtures.js";
import { UsClientError } from "../src/us/client.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps invalid selectors visible and treats URL as text without retrieval", async () => {
  const client = requestsFixture();
  function Form() {
    const [value, onChange] = useState(scopeToFields(null));
    return (
      <RequestScopeEditor
        client={client}
        value={value}
        onChange={onChange}
        disabled={false}
        onForbidden={async () => {}}
        onSessionLost={() => {}}
      />
    );
  }
  renderPlanUi(<Form />);
  fireEvent.change(screen.getByLabelText("TLC list"), { target: { value: "A\nA" } });
  fireEvent.change(screen.getByLabelText("Source reference URL"), {
    target: { value: "https://example.test/reference" },
  });
  expect((screen.getByLabelText("TLC list") as HTMLTextAreaElement).value).toBe("A\nA");
  expect(
    screen.getByText("Review the selectors, distinct list values and range order."),
  ).toBeTruthy();
  expect(parseRequestScope({ ...scopeToFields(null), tlcs: "A\nA" }).success).toBe(false);
});
it("uses bounded lot pages and retains selected lot through page changes", async () => {
  const client = requestsFixture();
  const lot = requestLot();
  vi.mocked(client.listLots)
    .mockResolvedValueOnce({
      items: Array.from({ length: 50 }, (_, i) =>
        requestLot({
          id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          tlc: `TLC-${i}`,
        }),
      ),
      limit: 50,
      offset: 0,
    })
    .mockResolvedValue({ items: [], limit: 50, offset: 50 });
  renderPlanUi(
    <RequestLotPicker
      client={client}
      value={lot.id}
      disabled={false}
      onChange={vi.fn()}
      onForbidden={async () => {}}
      onSessionLost={() => {}}
    />,
  );
  await waitFor(() =>
    expect(client.listLots).toHaveBeenCalledWith({ limit: 50, offset: 0, search: "" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(client.listLots).toHaveBeenLastCalledWith({ limit: 50, offset: 50, search: "" }),
  );
  expect((screen.getByLabelText("Lot ID") as HTMLSelectElement).value).toBe(lot.id);
});
it.each(["forbidden", "session_required"] as const)(
  "forwards lot lookup %s to the authority boundary",
  async (code) => {
    const client = requestsFixture();
    vi.mocked(client.listLots).mockRejectedValue(new UsClientError(code));
    const forbidden = vi.fn(async () => {});
    const lost = vi.fn();
    renderPlanUi(
      <RequestScopeEditor
        client={client}
        value={scopeToFields(null)}
        onChange={vi.fn()}
        disabled={false}
        onForbidden={forbidden}
        onSessionLost={lost}
      />,
    );
    await waitFor(() => expect(code === "forbidden" ? forbidden : lost).toHaveBeenCalledOnce());
  },
);
