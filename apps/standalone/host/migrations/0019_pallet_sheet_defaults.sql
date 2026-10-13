-- A4 sheets chosen by default on a par with the pallet labels (beta
-- feedback): a product's preferred sheet and each category's default sheet,
-- beside the organization's (`0016`). Numbered 0019: `0013` and `0014` belong
-- to other plans, `0017` to the code search and `0018` to the people's
-- changes of the same beta wave; sqlx applies a missing lower number late.
--
-- A shift with pallets that names no sheet takes the product's sheet while
-- it is enabled, else its category's, else the organization's
-- (`pallet_sheets::PRODUCT_SHEET_SQL`). Neither is in the station feed: a
-- station prints a sheet only from a shift's snapshot.

-- A preference, as `default_pallet_template_id`: the host checks that it
-- names a sheet; a sheet switched off later stays the preference and is
-- skipped. Deleting the sheet clears it (the route does, at the delete's
-- revision, so the product rides the feed).
ALTER TABLE products ADD COLUMN default_pallet_sheet_id TEXT
  REFERENCES pallet_sheet_templates (id);
CREATE INDEX products_default_pallet_sheet ON products (default_pallet_sheet_id)
  WHERE default_pallet_sheet_id IS NOT NULL;

-- A category's default sheet: an enabled sheet (the routes refuse to switch
-- it off or delete it while it is one). One per category; it takes no
-- revision of its own: a change moves the organization's record, whose
-- revision the templates' defaults document reads.
CREATE TABLE category_pallet_sheet_defaults (
  chz_group_code INTEGER PRIMARY KEY REFERENCES chz_product_groups (code),
  sheet_id TEXT NOT NULL REFERENCES pallet_sheet_templates (id)
);
CREATE INDEX category_pallet_sheet_defaults_sheet ON category_pallet_sheet_defaults (sheet_id);
