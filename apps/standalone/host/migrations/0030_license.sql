-- Plan ЛЦ-2 (spec 2026-10-13 §4.4, §8.1): the site's license files and the
-- license clock. Times are milliseconds since the Unix epoch, UTC, as the
-- signed file counts them.

-- Every file the office loaded, verified before it was written; append-only.
-- The file in force is the highest `sequence` whose `valid_from` came.
-- `loaded_by` names an office user without a foreign key: a restore carries
-- a row into a copy that may lack that user.
CREATE TABLE licenses (
    license_id TEXT PRIMARY KEY NOT NULL CHECK (length(license_id) = 36),
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
    compact TEXT NOT NULL CHECK (length(compact) BETWEEN 1 AND 16384),
    kid TEXT NOT NULL CHECK (length(kid) BETWEEN 1 AND 200),
    host_id TEXT NOT NULL CHECK (length(host_id) = 36),
    issued_at INTEGER NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER NOT NULL CHECK (valid_until > valid_from),
    grace_days INTEGER NOT NULL CHECK (grace_days BETWEEN 0 AND 60),
    plan TEXT NOT NULL CHECK (plan IN ('demo', 'subscription')),
    plan_version_id TEXT NOT NULL CHECK (length(plan_version_id) BETWEEN 1 AND 64),
    customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 500),
    customer_inn TEXT NOT NULL CHECK (length(customer_inn) BETWEEN 1 AND 32),
    quotas TEXT NOT NULL CHECK (json_valid(quotas)),
    features TEXT NOT NULL CHECK (json_valid(features)),
    loaded_at TEXT NOT NULL,
    loaded_by TEXT
);

-- One row: the last time the host knew (§7), the trial's start and the INN
-- the wizard took (§3.4), the emergency extension (§3.5), when a file of
-- another host was first seen in force (§4.6) and the last state a
-- `license.state` row named.
CREATE TABLE license_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_seen_at INTEGER,
    trial_started_at INTEGER,
    trial_inn TEXT,
    emergency_used_for TEXT,
    emergency_until INTEGER,
    wrong_host_since INTEGER,
    last_state TEXT,
    last_state_at INTEGER
);

INSERT INTO license_clock (id) VALUES (1);
