import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadShiftExportArtifact,
  shiftExportsQueryKey,
  useCreateShiftExport,
  useRetryShiftExport,
  useShiftExportFormats,
  useShiftExports,
} from "../src/pages/shifts/shift-exports-api.js";

const SHIFT_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";

const FORMAT = {
  id: "shift_txt_flat",
  version: 1,
  label: "[TXT][Без коробов] Отчет смены",
  extension: "txt",
  mimeType: "text/plain; charset=utf-8",
  boxMode: "flat",
} as const;

const ARTIFACT = {
  id: ARTIFACT_ID,
  partNumber: 1,
  physicalLineCount: 2,
  codeCount: 2,
  boxCount: 0,
  filename: "Отчет.txt",
  mimeType: "text/plain; charset=utf-8",
  byteSize: 12,
  sha256: "a".repeat(64),
};

const QUEUED_EXPORT = {
  id: EXPORT_ID,
  shiftId: SHIFT_ID,
  formatId: FORMAT.id,
  formatVersion: 1,
  maxLines: null,
  status: "queued",
  errorCode: null,
  productNameSnapshot: null,
  shiftDateSnapshot: null,
  totalCodeCount: null,
  totalBoxCount: null,
  createdByUserId: "user-1",
  createdByName: "Иванов Иван",
  sourceSnapshotStartedAt: null,
  completedAt: null,
  attemptCount: 0,
  createdAt: "2026-08-13T12:00:00.000Z",
  stale: false,
  artifacts: [ARTIFACT],
} as const;

function successfulJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shift export queries", () => {
  it("loads formats and the active shift history from their exact cabinet paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulJsonResponse([FORMAT]))
      .mockResolvedValueOnce(successfulJsonResponse([QUEUED_EXPORT]));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createWrapper();

    const formats = renderHook(() => useShiftExportFormats(), { wrapper });
    const exports = renderHook(() => useShiftExports(SHIFT_ID, true), { wrapper });

    await waitFor(() => expect(formats.result.current.data).toEqual([FORMAT]));
    await waitFor(() => expect(exports.result.current.data).toEqual([QUEUED_EXPORT]));

    expect(fetchMock).toHaveBeenCalledWith("/api/shift-exports/formats", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(`/api/shifts/${SHIFT_ID}/exports`, expect.any(Object));
  });

  it("does not request closed dialog history and polls only queued or processing exports", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse([QUEUED_EXPORT]));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createWrapper();

    try {
      renderHook(() => useShiftExports(SHIFT_ID, false), { wrapper });
      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      expect(fetchMock).not.toHaveBeenCalled();

      renderHook(() => useShiftExports(SHIFT_ID, true), { wrapper });
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1_999));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);

      queryClient.setQueryData(shiftExportsQueryKey(SHIFT_ID), [
        { ...QUEUED_EXPORT, status: "ready", completedAt: "2026-08-13T12:01:00.000Z" },
      ]);
      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("shift export mutations", () => {
  it("creates with the caller-provided UUID idempotency key and invalidates only that shift history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(QUEUED_EXPORT));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createWrapper();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateShiftExport(), { wrapper });
    const input = {
      formatId: FORMAT.id,
      formatVersion: 1 as const,
      maxLines: null,
      idempotencyKey: IDEMPOTENCY_KEY,
    };

    await act(() => result.current.mutateAsync({ shiftId: SHIFT_ID, input }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/shifts/${SHIFT_ID}/exports`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: shiftExportsQueryKey(SHIFT_ID) });
  });

  it("retries the selected export and invalidates only its shift history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(QUEUED_EXPORT));
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createWrapper();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRetryShiftExport(), { wrapper });

    await act(() => result.current.mutateAsync({ shiftId: SHIFT_ID, exportId: EXPORT_ID }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/shift-exports/${EXPORT_ID}/retry`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: shiftExportsQueryKey(SHIFT_ID) });
  });

  it("returns the server-issued artifact download URL without deriving a filename", async () => {
    const download = {
      url: "https://storage.example.test/object?signature=redacted",
      filename: ARTIFACT.filename,
      expiresInSeconds: 300,
    };
    const fetchMock = vi.fn().mockResolvedValue(successfulJsonResponse(download));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadShiftExportArtifact(EXPORT_ID, ARTIFACT_ID)).resolves.toEqual(download);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/shift-exports/${EXPORT_ID}/artifacts/${ARTIFACT_ID}/download`,
      expect.any(Object),
    );
  });
});
