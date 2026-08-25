export interface ShiftEntryLease {
  isCurrent(): boolean;
  release(): void;
}

export type AcquireShiftEntry = () => Promise<ShiftEntryLease>;
