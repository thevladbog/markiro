/**
 * Why an admin currently cannot reseed this counter, or null when nothing
 * stands in the way.
 *
 * Reseeding revokes the serial blocks devices hold, and a device that is
 * still printing (or that has printed boxes it hasn't uploaded yet) would
 * emit serials from a range the server has already handed to someone else --
 * two physical boxes under one SSCC, surfacing only at ingest as a
 * `boxes_tenant_sscc_uq` violation that fails the whole batch. Both blockers
 * below are the cheap, checkable proxies for "no device is mid-print".
 */
export type SsccSeedBlocker =
  /** A shift is open, so a station may be printing right now. */
  | { kind: "active_shift"; shiftId: string; shiftNumber: string }
  /**
   * A device holding a live block has not checked in since the last shift
   * closed, so it may be sitting offline with closed boxes it hasn't sent.
   */
  | { kind: "device_out_of_sync"; deviceId: string; deviceName: string };

/** `GET /org/profile/sscc` and `GET /counterparties/:id/sscc` response. */
export interface SsccCounterStateDto {
  extensionDigit: number;
  /** The serial the next printed label will carry. */
  nextSerial: number;
  /** The lowest value `PUT` will accept right now (`seedFloor`). */
  minSerial: number;
  blockedBy: SsccSeedBlocker | null;
}
