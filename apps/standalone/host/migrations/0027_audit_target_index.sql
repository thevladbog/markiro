-- A shift's history of exports (`GET /v1/office/shifts/{id}/exports`) reads the
-- audit trail by the shift it names, newest first; the trail had an index by
-- time only, so each read walked the whole of it.
CREATE INDEX audit_log_target ON audit_log (target_id, action, at);
