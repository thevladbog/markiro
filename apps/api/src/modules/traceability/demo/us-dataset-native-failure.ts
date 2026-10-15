const semanticMismatches = new Set([
  "us_dataset_reference_mismatch",
  "us_dataset_receiving_mismatch",
  "us_dataset_transformation_mismatch",
  "us_dataset_cases_mismatch",
  "us_dataset_shipping_mismatch",
  "us_dataset_special_mismatch",
  "us_dataset_corrected_transformation_mismatch",
]);

/** Only a proved domain error may change namespace; ambiguous causes pass through. */
export function nativeFailure(error: unknown): unknown {
  try {
    if (!(error instanceof Error) || Object.isFrozen(error)) return error;
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (
      !message ||
      !("value" in message) ||
      typeof message.value !== "string" ||
      !semanticMismatches.has(message.value)
    )
      return error;
    const annotations: PropertyDescriptorMap = {};
    for (const key of ["unitKey", "stage"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor) {
        if (!("value" in descriptor)) return error;
        annotations[key] = descriptor;
      } else if (key in error) return error;
    }
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null; depth++) {
      if (typeof current !== "object" || depth >= 32 || seen.has(current)) return error;
      seen.add(current);
      if ("code" in current) return error;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (!cause) {
        if ("cause" in current) return error;
        break;
      }
      if (!("value" in cause)) return error;
      current = cause.value;
    }
    return Object.defineProperties(
      new Error("us_dataset_native_drift", { cause: error }),
      annotations,
    );
  } catch {
    return error;
  }
}
