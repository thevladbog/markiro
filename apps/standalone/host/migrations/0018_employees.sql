-- Employees (owner feedback on the first beta: «связывать сотрудника с
-- оператором, как в вебе»). The site's register of people, as the cloud's
-- `employees`: office data for administrators, never in the station feed and
-- never a credential. An employee may be linked to one operator and an
-- operator to one employee (`operator_id`, UNIQUE; SQLite lets many rows
-- hold NULL): the link says which person an operator is, and the operator
-- keeps its own personnel number, PIN and badges. An archived employee is
-- linked to no operator, so archiving and unlinking are one change.
-- Numbered 0018: 0013 (plan ОЧ) and 0014 are allocated to other plans and
-- may land later (`tests/org_logo.rs`), 0015 and 0016 are СКЛ and А4, 0017
-- is the code search.
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  role TEXT CHECK (role IS NULL OR length(trim(role)) BETWEEN 1 AND 120),
  operator_id TEXT UNIQUE REFERENCES operators (id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL,
  CHECK (archived = 0 OR operator_id IS NULL)
);
