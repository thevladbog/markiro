import { z } from "zod";

// Status pairs come from Request Store/Validation/Prepare, HTTP commands/reads,
// worker lifecycle, deadline policy and publication-read. Never render their text.
const inputCodes = z.enum([
  "us_request_invalid_instant",
  "us_request_deadline_out_of_range",
  "us_request_deadline_order",
  "us_request_alternate_reason_required",
]);
const notFoundCodes = z.enum([
  "us_request_not_found",
  "us_request_run_not_found",
  "us_request_artifact_not_found",
]);
const conflictCodes = z.enum([
  "us_request_revision_conflict",
  "us_request_number_conflict",
  "us_request_closed",
  "us_request_scope_required",
  "us_request_validation_stale",
  "us_request_warnings_required",
  "us_request_validation_required",
  "us_request_idempotency_conflict",
  "us_request_selection_limit",
  "us_request_snapshot_limit",
  "us_request_not_export_ready",
  "us_request_workbook_unrepresentable",
  "us_request_warning_ack_required",
  "us_request_worker_retry_conflict",
  "us_request_worker_lease_lost",
  "us_request_worker_deadline_exceeded",
  "us_request_worker_checkpoint_mismatch",
  "us_request_package_refreeze_required",
  "us_request_run_not_ready",
]);
// HTTP download can emit any sanitized worker failure at 503. These technical
// failures share safe unavailable copy, including persisted corruption/provider failures.
const unavailableCodes = z.enum([
  "traceability_profile_invalid",
  "us_database_unavailable",
  "us_request_stored_invalid",
  "us_request_validation_stored_invalid",
  "us_request_snapshot_invalid",
  "us_request_prepare_unavailable",
  "us_request_provenance_invalid",
  "us_request_tenant_origin_invalid",
  "us_request_build_unavailable",
  "us_request_package_storage_unavailable",
  "us_request_download_unavailable",
  "us_request_publication_invalid",
  "us_request_worker_evidence_invalid",
  "insufficient_permission",
  "traceability_profile_required",
  "us_request_profile_unsupported",
  "us_request_run_stored_invalid",
  "us_request_package_refreeze_required",
  "us_request_payload_evidence_mismatch",
  "us_request_payload_size_limit",
  "us_request_payload_workbook_unavailable",
  "us_request_payload_render_failed",
  "us_request_plan_read_failed",
  "us_request_package_inputs_invalid",
  "us_request_package_context_invalid",
  "us_request_package_model_invalid",
  "us_request_package_size_limit",
  "us_request_package_manifest_invalid",
  "us_request_package_archive_invalid",
  "us_request_report_render_failed",
  "us_request_worker_lease_lost",
  "us_request_worker_deadline_exceeded",
  "us_request_worker_retry_limit",
  "us_request_worker_checkpoint_mismatch",
  "us_request_worker_execution_invalid",
  "us_request_worker_stored_invalid",
  "us_request_worker_retry_conflict",
  "us_request_worker_unknown_failure",
  "us_request_worker_database_unavailable",
  "us_request_worker_database_retryable",
  "us_request_package_storage_configuration_invalid",
  "us_request_package_storage_operational_verification_required",
  "us_request_package_storage_transport_failed",
  "us_request_package_storage_timeout",
  "us_request_package_storage_evidence_invalid",
  "us_request_package_storage_scope_invalid",
  "us_request_package_storage_collision",
  "us_request_package_storage_checksum_mismatch",
  "us_request_package_storage_read_failed",
  "us_request_package_storage_delete_failed",
]);

export type UsRequestsClientErrorCode =
  | z.infer<typeof inputCodes>
  | z.infer<typeof notFoundCodes>
  | z.infer<typeof conflictCodes>
  | "invalid_input"
  | "invalid_response"
  | "session_required"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "request_rejected";

export function usRequestsResponseErrorCode(
  status: number,
  value: unknown,
): UsRequestsClientErrorCode {
  if (status === 401) return "session_required";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  const envelope = z.object({ code: z.string() }).strict().safeParse(value);
  if (envelope.success) {
    const code = envelope.data.code;
    if (status === 400) {
      const input = inputCodes.safeParse(code);
      if (input.success) return input.data;
      if (code === "us_request_worker_retry_conflict") return code;
      if (
        [
          "us_invalid_query",
          "us_invalid_body",
          "invalid_us_request_scope",
          "us_request_range_unsupported",
        ].includes(code)
      )
        return "invalid_input";
    }
    if (status === 404) {
      const missing = notFoundCodes.safeParse(code);
      if (missing.success) return missing.data;
    }
    if (status === 409) {
      const conflict = conflictCodes.safeParse(code);
      if (conflict.success) return conflict.data;
    }
    if (status === 413 && code === "us_body_too_large") return "invalid_input";
    if (status === 415 && ["us_json_required", "us_invalid_body"].includes(code))
      return "invalid_input";
    if (status === 503 && unavailableCodes.safeParse(code).success) return "unavailable";
  }
  // The shared parser includes field issues. Discard them rather than treating
  // arbitrary message arrays as safe feedback.
  if (
    status === 400 &&
    z
      .object({
        code: z.literal("invalid_master_data"),
        issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
      })
      .strict()
      .safeParse(value).success
  )
    return "invalid_input";
  if (status === 409) return "conflict";
  if (status >= 500) return "unavailable";
  return "request_rejected";
}
