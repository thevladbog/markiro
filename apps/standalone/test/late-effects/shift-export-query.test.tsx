import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { ExportDialog } from "../../src/office/exports/ExportDialog.js";
import { OfficeFilesProvider } from "../../src/office/exports/office-files-context.js";
import { createOfficeQueryClient } from "../../src/office/office-query.js";
import { OfficeSessionProvider } from "../../src/office/office-session.js";
import { fakeOfficeSession, ORG_PROFILE } from "../support/office.js";
import { fakeOfficeFiles } from "../support/office-files.js";
import { CLOSED } from "../support/shifts.js";

it("starts the export source query after the dialog commits under late passive effects", async () => {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.getShiftExportSource.mockReturnValue(new Promise(() => undefined));
  render(
    <ThemeProvider>
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={session}>
          <OfficeFilesProvider value={fakeOfficeFiles()}>
            <ExportDialog shift={CLOSED} onClose={vi.fn()} />
          </OfficeFilesProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  await screen.findByRole("dialog", { name: `Выгрузка смены ${CLOSED.number}` });
  await waitFor(() =>
    expect(session.api.getShiftExportSource).toHaveBeenCalledWith(
      "office-session-token",
      CLOSED.id,
    ),
  );
});
