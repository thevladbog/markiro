const REPORT_KEY =
  /^platform-reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attempt-[1-3]\/report\.zip$/;

export function isPlatformReportObjectKey(key: string): boolean {
  return REPORT_KEY.test(key);
}

export function platformReportObjectKey(id: string, attempt: number): string {
  const key = `platform-reports/${id}/attempt-${attempt}/report.zip`;
  if (!isPlatformReportObjectKey(key)) throw new Error("Unsafe object key");
  return key;
}
