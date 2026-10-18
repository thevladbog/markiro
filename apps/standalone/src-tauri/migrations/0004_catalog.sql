-- The station's copies of the catalog (stage 1 spec §5.3, plan 1e2): products,
-- label templates and the templates' category defaults, and the
-- organization's three default templates on `ref_org`. The webview's reference
-- sync writes the rows; `device_forget` empties every table
-- (`LocalDb::clear_copies`).
--
-- The copies keep the feed's flags and filter nothing: an archived product and
-- a disabled template stay, and the station chooses among them later (plan
-- 2a). A product never leaves; a deleted template and a cleared category
-- default leave as tombstones. No foreign key and no uniqueness besides the
-- key: within one revision a deleted template's tombstone comes before the
-- products whose preference its delete cleared, a template a copy names may
-- wait in the quarantine, and a copy that refused a row would abort its whole
-- page and stop the sync for good.
ALTER TABLE ref_org ADD COLUMN default_box_template_id TEXT;
ALTER TABLE ref_org ADD COLUMN default_pallet_template_id TEXT;
ALTER TABLE ref_org ADD COLUMN default_duplicate_template_id TEXT;

CREATE TABLE ref_products (
  id TEXT PRIMARY KEY,
  -- 14 digits, as the office saved it.
  gtin14 TEXT NOT NULL,
  name TEXT NOT NULL,
  print_name TEXT,
  chz_group_code INTEGER,
  box_capacity INTEGER,
  pallet_box_capacity INTEGER,
  shelf_life_days INTEGER,
  -- Preferences: the station uses one only while the template still fits.
  default_box_template_id TEXT,
  default_pallet_template_id TEXT,
  archived INTEGER NOT NULL,
  -- `active` or `draft`, as the host computed it.
  status TEXT NOT NULL,
  rev INTEGER NOT NULL
);

-- The station finds a scanned product by its GTIN (plan 2a).
CREATE INDEX ref_products_gtin14 ON ref_products (gtin14);

CREATE TABLE ref_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  -- A JSON array of product-group codes, or NULL for every category.
  category_codes TEXT,
  stock INTEGER NOT NULL,
  -- The layout as JSON text, as the webview wrote what the feed carried.
  spec TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_template_defaults (
  -- The feed's key: `<code>:<purpose>` (`8:box`).
  id TEXT PRIMARY KEY,
  chz_group_code INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  template_id TEXT NOT NULL,
  rev INTEGER NOT NULL
);
