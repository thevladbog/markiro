import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { expect, it } from "vitest";

import fixture from "../proto/fixtures/export-file.json";
import { exportFileSchema, type ExportFileList } from "../src/host/export-files.js";
import { CardFiles } from "../src/office/exports/CardFiles.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { fakeOfficeSession } from "./support/office.js";

it("focuses a searched document's saved-file section after its asynchronous read", async () => {
  const session = fakeOfficeSession();
  let resolve: (value: ExportFileList) => void = () => undefined;
  session.api.listExportFiles.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(
    <MemoryRouter initialEntries={["/codes/pallet/owner#stored-files"]}>
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <Link to="/codes/pallet/owner#stored-files">Найти документ ещё раз</Link>
          <CardFiles
            targetType="pallet"
            targetId="owner"
            label="Палет"
            at={(value) => value}
            timeZone="Europe/Moscow"
          />
        </OfficeSessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(session.api.listExportFiles).toHaveBeenCalledOnce());
  await act(async () => resolve({ items: [exportFileSchema.parse(fixture)] }));
  const section = (await screen.findByRole("heading", { name: "Сохранённые файлы" })).closest(
    "section",
  );
  await waitFor(() => expect(document.activeElement).toBe(section));
  const again = screen.getByRole("link", { name: "Найти документ ещё раз" });
  again.focus();
  fireEvent.click(again);
  await waitFor(() => expect(document.activeElement).toBe(section));
});
