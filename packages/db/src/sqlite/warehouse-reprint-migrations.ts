/** Single-statement commands commit the job, attempt and outbox together on pooled SQLite. */
export const WAREHOUSE_REPRINT_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_sessions (
    owner TEXT NOT NULL, session_id TEXT NOT NULL, operator_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','paused')),
    session_json TEXT NOT NULL CHECK(json_valid(session_json)),
    sent_count INTEGER NOT NULL DEFAULT 0 CHECK(sent_count>=0),
    PRIMARY KEY(owner,session_id));`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_jobs (
    owner TEXT NOT NULL, job_id TEXT NOT NULL, session_id TEXT NOT NULL,
    identity TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('unit','box')),
    job_json TEXT NOT NULL CHECK(json_valid(job_json)), projection_json TEXT NOT NULL CHECK(json_valid(projection_json)),
    state TEXT NOT NULL CHECK(state IN ('prepared','sending','sent','verified','delivery_unknown','failed_before_send')),
    latest_sequence INTEGER NOT NULL CHECK(latest_sequence BETWEEN 1 AND 9007199254740991),
    attempt_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner,job_id), UNIQUE(owner,session_id,source_kind,identity),
    FOREIGN KEY(owner,session_id) REFERENCES warehouse_reprint_sessions(owner,session_id));`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_attempts (
    owner TEXT NOT NULL, job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
    state TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('not_printed','damaged','lost')),
    PRIMARY KEY(owner,job_id,attempt_id), UNIQUE(owner,job_id,attempt_no),
    FOREIGN KEY(owner,job_id) REFERENCES warehouse_reprint_jobs(owner,job_id));`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_events (
    owner TEXT NOT NULL, event_id TEXT NOT NULL, job_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL CHECK(json_valid(event_json)), digest TEXT NOT NULL,
    receive_status TEXT NOT NULL DEFAULT 'pending' CHECK(receive_status IN ('pending','accepted','quarantined')),
    rejection_code TEXT, PRIMARY KEY(owner,event_id), UNIQUE(owner,job_id,sequence),
    FOREIGN KEY(owner,job_id) REFERENCES warehouse_reprint_jobs(owner,job_id));`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_cache (
    owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('unit','box','templates')),
    identity TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
    PRIMARY KEY(owner,kind,identity));`,
  `CREATE TABLE IF NOT EXISTS warehouse_reprint_commands (
    owner TEXT NOT NULL, command_id TEXT NOT NULL, job_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('prepare','event')), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    PRIMARY KEY(owner,command_id));`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_reprint_prepare AFTER INSERT ON warehouse_reprint_commands
    WHEN NEW.kind='prepare' BEGIN
      SELECT RAISE(ABORT,'WAREHOUSE_DUPLICATE') WHERE EXISTS (
        SELECT 1 FROM warehouse_reprint_jobs WHERE owner=NEW.owner
        AND session_id=json_extract(NEW.payload_json,'$.input.sessionId')
        AND source_kind=json_extract(NEW.payload_json,'$.input.source.kind')
        AND identity=json_extract(NEW.payload_json,'$.input.source.identity'));
      SELECT RAISE(ABORT,'WAREHOUSE_BUSY') WHERE EXISTS (
        SELECT 1 FROM warehouse_reprint_jobs WHERE owner=NEW.owner AND state IN ('prepared','sending','delivery_unknown','failed_before_send'));
      SELECT RAISE(ABORT,'WAREHOUSE_SESSION_UNAVAILABLE') WHERE NOT EXISTS (
        SELECT 1 FROM warehouse_reprint_sessions WHERE owner=NEW.owner
        AND session_id=json_extract(NEW.payload_json,'$.input.sessionId') AND status='active'
        AND operator_id=json_extract(NEW.payload_json,'$.input.operatorId'));
      SELECT RAISE(ABORT,'WAREHOUSE_OPERATOR_DENIED') WHERE NOT EXISTS(SELECT 1 FROM operators_mirror WHERE operator_id=json_extract(NEW.payload_json,'$.input.operatorId') AND active=1);
      INSERT INTO warehouse_reprint_jobs(owner,job_id,session_id,identity,source_kind,job_json,projection_json,state,latest_sequence,attempt_id,updated_at)
        VALUES(NEW.owner,NEW.job_id,json_extract(NEW.payload_json,'$.input.sessionId'),
        json_extract(NEW.payload_json,'$.input.source.identity'),json_extract(NEW.payload_json,'$.input.source.kind'),
        json_extract(NEW.payload_json,'$.input'),json_extract(NEW.payload_json,'$.projection'),'prepared',1,
        json_extract(NEW.payload_json,'$.input.preparedEvent.attemptId'),json_extract(NEW.payload_json,'$.input.preparedEvent.occurredAt'));
      INSERT INTO warehouse_reprint_attempts(owner,job_id,attempt_id,attempt_no,state,reason)
        VALUES(NEW.owner,NEW.job_id,json_extract(NEW.payload_json,'$.input.preparedEvent.attemptId'),1,'prepared',json_extract(NEW.payload_json,'$.input.reason'));
      INSERT INTO warehouse_reprint_events(owner,event_id,job_id,sequence,event_json,digest)
        VALUES(NEW.owner,json_extract(NEW.payload_json,'$.input.preparedEvent.eventId'),NEW.job_id,1,
        json_extract(NEW.payload_json,'$.input.preparedEvent'),json_extract(NEW.payload_json,'$.eventDigest'));
      DELETE FROM warehouse_reprint_commands WHERE owner=NEW.owner AND command_id=NEW.command_id;
    END;`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_reprint_event AFTER INSERT ON warehouse_reprint_commands
    WHEN NEW.kind='event' BEGIN
      SELECT RAISE(ABORT,'WAREHOUSE_STALE_EVENT') WHERE NOT EXISTS (
        SELECT 1 FROM warehouse_reprint_jobs WHERE owner=NEW.owner AND job_id=NEW.job_id
        AND latest_sequence=json_extract(NEW.payload_json,'$.previousSequence')
        AND state=json_extract(NEW.payload_json,'$.previousState')
        AND session_id=json_extract(NEW.payload_json,'$.event.sessionId'));
      SELECT RAISE(ABORT,'WAREHOUSE_EVENT_REPLAY_MISMATCH') WHERE EXISTS (
        SELECT 1 FROM warehouse_reprint_events WHERE owner=NEW.owner AND event_id=NEW.command_id);
      INSERT INTO warehouse_reprint_events(owner,event_id,job_id,sequence,event_json,digest)
        VALUES(NEW.owner,NEW.command_id,NEW.job_id,json_extract(NEW.payload_json,'$.event.sequence'),
        json_extract(NEW.payload_json,'$.event'),json_extract(NEW.payload_json,'$.eventDigest'));
      INSERT INTO warehouse_reprint_attempts(owner,job_id,attempt_id,attempt_no,state,reason)
        SELECT NEW.owner,NEW.job_id,json_extract(NEW.payload_json,'$.event.attemptId'),
        json_extract(NEW.payload_json,'$.event.attemptNo'),'prepared',json_extract(NEW.payload_json,'$.event.reason')
        WHERE json_extract(NEW.payload_json,'$.event.kind')='reprint_prepared';
      UPDATE warehouse_reprint_attempts SET state=json_extract(NEW.payload_json,'$.projection.state')
        WHERE owner=NEW.owner AND job_id=NEW.job_id AND attempt_id=json_extract(NEW.payload_json,'$.event.attemptId');
      UPDATE warehouse_reprint_jobs SET projection_json=json_extract(NEW.payload_json,'$.projection'),
        state=json_extract(NEW.payload_json,'$.projection.state'),latest_sequence=json_extract(NEW.payload_json,'$.event.sequence'),
        attempt_id=json_extract(NEW.payload_json,'$.event.attemptId'),updated_at=json_extract(NEW.payload_json,'$.event.occurredAt')
        WHERE owner=NEW.owner AND job_id=NEW.job_id;
      UPDATE warehouse_reprint_sessions SET sent_count=sent_count+1 WHERE owner=NEW.owner
        AND session_id=json_extract(NEW.payload_json,'$.event.sessionId')
        AND (json_extract(NEW.payload_json,'$.event.kind')='sent' OR
        (json_extract(NEW.payload_json,'$.event.kind')='verified' AND json_extract(NEW.payload_json,'$.previousState')='delivery_unknown'));
      DELETE FROM warehouse_reprint_commands WHERE owner=NEW.owner AND command_id=NEW.command_id;
    END;`,
  `CREATE TRIGGER IF NOT EXISTS warehouse_reprint_safe_cleanup BEFORE DELETE ON warehouse_reprint_jobs BEGIN
    SELECT RAISE(ABORT,'WAREHOUSE_RETENTION_BLOCKED') WHERE OLD.state<>'verified' OR EXISTS(SELECT 1 FROM warehouse_reprint_events WHERE owner=OLD.owner AND job_id=OLD.job_id AND receive_status<>'accepted');
    DELETE FROM warehouse_reprint_events WHERE owner=OLD.owner AND job_id=OLD.job_id;
    DELETE FROM warehouse_reprint_attempts WHERE owner=OLD.owner AND job_id=OLD.job_id;
  END;`,
] as const;
