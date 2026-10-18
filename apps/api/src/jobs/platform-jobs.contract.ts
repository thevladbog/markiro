/** Both server compositions satisfy these contracts under the existing DI token. */
export interface JobsReadiness {
  checkReady(): Promise<void>;
}
export interface PlatformReportQueue {
  wakePlatformReports(): Promise<void>;
}
