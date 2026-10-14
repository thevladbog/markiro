-- The shift's own date (beta 3 feedback): the working day the shift takes
-- place, apart from `production_date`, the date printed on the product (the
-- cloud's `planned_date` beside its `production_date`; the office labels it
-- «Дата смены»). A civil date, `YYYY-MM-DD`. The shift's NUMBER keeps coming
-- from `production_date` (`number_month_key`), as before.
--
-- `0009`'s table cannot take a NOT NULL column without a constant default,
-- and a constant would be the wrong date for any row written without naming
-- one, so the column is nullable, the rows already there take their
-- production date (what the office and the stations showed as the shift's
-- one date until now), and a trigger gives the same to an insert that names
-- none (a shift written by a build that does not know the column, a test's
-- raw INSERT). The host's own writes always name it.
ALTER TABLE shifts ADD COLUMN planned_date TEXT
  CHECK (planned_date IS NULL
    OR planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

UPDATE shifts SET planned_date = production_date;

CREATE TRIGGER shifts_planned_date_default AFTER INSERT ON shifts
WHEN NEW.planned_date IS NULL
BEGIN
  UPDATE shifts SET planned_date = NEW.production_date WHERE id = NEW.id;
END;

-- The office's list by the shift's date, and the usage statistics' months.
CREATE INDEX shifts_planned_date ON shifts (planned_date);
