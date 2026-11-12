-- A shift's historical act also finds set marks and device documents made
-- while assembling its sets from source boxes of other shifts.
CREATE INDEX disaggregation_lines_set
  ON disaggregation_document_lines (set_device_id, set_record_id)
  WHERE set_record_id IS NOT NULL;
CREATE INDEX disaggregation_documents_assembly_shift
  ON disaggregation_documents (json_extract(device_request_json, '$.shiftId'))
  WHERE status = 'applied' AND json_valid(device_request_json)
    AND json_extract(device_request_json, '$.kind') = 'set_assembly';
