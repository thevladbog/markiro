import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const capability = "working-device-assignments-v1";

/** Exercise the actual packaged implementation; an image label alone is insufficient. */
export function verifyWorkingDeviceImplementation(implementation) {
  const incompatible = () => {
    throw new Error("API image is incompatible with working device reservations");
  };
  for (const name of [
    "countWorkingDeviceUsage",
    "transitionWorkingAssignment",
    "assignmentConsistent",
    "assignmentOccupied",
    "assertReservationOpen",
  ]) {
    if (typeof implementation?.[name] !== "function") incompatible();
  }
  const device = { revokedAt: null, pairedAt: null, apiKeyId: null, lastSeenAt: null };
  const cancelled = { state: "released", releaseReason: "reservation_cancelled" };
  const reserved = { state: "reserved", releaseReason: null };
  const securityReleased = { state: "released", releaseReason: "security_revoked" };
  if (
    implementation.assignmentOccupied(device, undefined) !== true ||
    implementation.assignmentOccupied(device, reserved) !== true ||
    implementation.assignmentOccupied(device, cancelled) !== false ||
    implementation.assignmentOccupied({ ...device, apiKeyId: "fixture" }, cancelled) !== true ||
    implementation.assignmentOccupied(device, securityReleased) !== true ||
    implementation.assignmentOccupied({ ...device, revokedAt: new Date(0) }, securityReleased) !==
      false ||
    implementation.assignmentConsistent(device, undefined) !== false ||
    implementation.assignmentConsistent({ ...device, apiKeyId: "fixture" }, reserved) !== false
  )
    incompatible();
  let rejectsCancelled = false;
  try {
    implementation.assertReservationOpen(cancelled);
  } catch {
    rejectsCancelled = true;
  }
  if (!rejectsCancelled) incompatible();
  implementation.assertReservationOpen(reserved);
  implementation.assertReservationOpen(securityReleased);
  return capability;
}

export async function probeWorkingDeviceImage(applicationRoot = "/app") {
  const implementation = await import(
    pathToFileURL(resolve(applicationRoot, "dist/subscriptions/working-device-assignments.js")).href
  );
  return verifyWorkingDeviceImplementation(implementation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${await probeWorkingDeviceImage()}\n`);
  } catch {
    console.error("API image is incompatible with working device reservations");
    process.exitCode = 1;
  }
}
