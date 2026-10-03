-- The catalog (spec §4.3). ЧЗ product groups are the cloud's static lookup,
-- copied row for row from packages/db/migrations/0099_chz_product_groups.sql
-- (`tests/product_groups.rs` compares the two); they are not in the station
-- feed. Products, label templates and the templates' category defaults ride
-- the feed; the organization's three default templates ride its record.
CREATE TABLE chz_product_groups (
  code INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
INSERT INTO chz_product_groups (code, alias, name) VALUES
  (1, 'lp', 'Лёгкая промышленность'),
  (2, 'shoes', 'Обувные товары'),
  (3, 'tobacco', 'Табачная продукция'),
  (4, 'perfumery', 'Духи и туалетная вода'),
  (5, 'tires', 'Шины и покрышки пневматические резиновые новые'),
  (6, 'electronics', 'Фотокамеры (кроме кинокамер), фотовспышки и лампы-вспышки'),
  (7, 'pharma', 'Лекарственные препараты для медицинского применения'),
  (8, 'milk', 'Молочная продукция'),
  (9, 'bicycle', 'Велосипеды и велосипедные рамы'),
  (10, 'wheelchairs', 'Медицинские изделия'),
  (11, 'alcohol', 'Алкоголь'),
  (12, 'otp', 'Альтернативная табачная продукция'),
  (13, 'water', 'Упакованная вода'),
  (14, 'furs', 'Товары из натурального меха'),
  (15, 'beer', 'Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки'),
  (16, 'ncp', 'Никотиносодержащая продукция'),
  (17, 'bio', 'Специализированная пищевая продукция и БАД к пище'),
  (19, 'antiseptic', 'Антисептики и дезинфицирующие средства'),
  (20, 'petfood', 'Корма для животных'),
  (21, 'seafood', 'Морепродукты'),
  (22, 'nabeer', 'Безалкогольное пиво'),
  (23, 'softdrinks', 'Соковая продукция и безалкогольные напитки'),
  (25, 'meat', 'Мясные изделия'),
  (26, 'vetpharma', 'Ветеринарные препараты'),
  (27, 'toys', 'Игры и игрушки для детей'),
  (28, 'radio', 'Радиоэлектронная продукция'),
  (31, 'titan', 'Титановая металлопродукция'),
  (32, 'conserve', 'Консервированная продукция'),
  (33, 'vegetableoil', 'Растительные масла'),
  (34, 'opticfiber', 'Оптоволокно и оптоволоконная продукция'),
  (35, 'chemistry', 'Косметика, бытовая химия и товары личной гигиены'),
  (36, 'books', 'Печатная продукция'),
  (37, 'grocery', 'Бакалейная продукция'),
  (38, 'pharmaraw', 'Фармацевтическое сырьё, лекарственные средства'),
  (39, 'construction', 'Строительные материалы'),
  (40, 'fire', 'Пожарная безопасность'),
  (41, 'heater', 'Отопительные приборы'),
  (42, 'cableraw', 'Кабельно-проводниковая продукция'),
  (43, 'autofluids', 'Моторные масла'),
  (44, 'polymer', 'Полимерные трубы'),
  (45, 'sweets', 'Сладости и кондитерские изделия'),
  (48, 'carparts', 'Автозапчасти и комплектующие транспортных средств'),
  (49, 'furslp', 'Натуральный мех'),
  (50, 'nicotindev', 'Радиоэлектронная продукция. Электронные системы доставки никотина'),
  (51, 'gadgets', 'Радиоэлектронная продукция. Ноутбуки и смартфоны'),
  (52, 'frozen', 'Полуфабрикаты и замороженные продукты'),
  (53, 'fertilizers', 'Удобрения в потребительской упаковке'),
  (54, 'homeware', 'Товары для дома и интерьера'),
  (55, 'vetbio', 'Кормовые добавки'),
  (57, 'industrial', 'Промышленное оборудование'),
  (59, 'pyrotechnics', 'Пиротехнические изделия');

-- A label template. `spec` is the printable layout as compact JSON: the UI
-- checks it with `labelTemplateSpecSchema`, the host only keeps it an object
-- of at most 256 KB. `category_codes` is NULL for every category or a
-- non-empty JSON array of group codes. A stock template came from the wizard:
-- its name, purpose and spec never change, and it is never deleted.
CREATE TABLE label_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet', 'product_duplicate')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  category_codes TEXT CHECK (category_codes IS NULL OR (json_valid(category_codes)
    AND json_type(category_codes) = 'array' AND json_array_length(category_codes) > 0)),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'
    AND length(CAST(spec AS BLOB)) <= 262144),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE INDEX label_templates_rev ON label_templates (rev);

-- A product. `gtin14` is unique among the products in use, as
-- `products_tenant_gtin_unarchived_uq` in the cloud: an archived product keeps
-- its GTIN for history but no longer reserves it. The GS1 check digit is the
-- UI's rule. `status` is computed, as the cloud's `computeStatus`. A product
-- is archived, never deleted. Its default templates are preferences the
-- station checks before it uses them; deleting a template clears them here,
-- with a new revision for each product (`ON DELETE SET NULL` is the last line).
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  print_name TEXT CHECK (print_name IS NULL OR length(trim(print_name)) BETWEEN 1 AND 200),
  chz_group_code INTEGER REFERENCES chz_product_groups (code),
  box_capacity INTEGER CHECK (box_capacity IS NULL OR box_capacity > 0),
  pallet_box_capacity INTEGER CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0),
  shelf_life_days INTEGER CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  default_box_template_id TEXT REFERENCES label_templates (id) ON DELETE SET NULL,
  default_pallet_template_id TEXT REFERENCES label_templates (id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  status TEXT GENERATED ALWAYS AS (CASE WHEN chz_group_code IS NOT NULL
    AND box_capacity IS NOT NULL AND pallet_box_capacity IS NOT NULL
    THEN 'active' ELSE 'draft' END) VIRTUAL,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX products_active_gtin14 ON products (gtin14) WHERE archived = 0;
CREATE INDEX products_default_box_template ON products (default_box_template_id);
CREATE INDEX products_default_pallet_template ON products (default_pallet_template_id);
CREATE INDEX products_rev ON products (rev);

-- A category's default template of one purpose. The station resolves a
-- product's template as its category's default, then the organization's,
-- then none. Only an enabled template of the slot's purpose that covers the
-- category stands here (the host checks it on every write). Its feed id is
-- `<code>:<purpose>`; clearing one writes a tombstone.
CREATE TABLE category_template_defaults (
  chz_group_code INTEGER NOT NULL REFERENCES chz_product_groups (code),
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet', 'product_duplicate')),
  template_id TEXT NOT NULL REFERENCES label_templates (id),
  rev INTEGER NOT NULL,
  PRIMARY KEY (chz_group_code, purpose)
);
CREATE INDEX category_template_defaults_template ON category_template_defaults (template_id);
CREATE INDEX category_template_defaults_rev ON category_template_defaults (rev);

-- The organization's default template of each purpose: an enabled template
-- of that purpose for every category, or none.
ALTER TABLE org_profile ADD COLUMN default_box_template_id TEXT REFERENCES label_templates (id);
ALTER TABLE org_profile ADD COLUMN default_pallet_template_id TEXT REFERENCES label_templates (id);
ALTER TABLE org_profile ADD COLUMN default_duplicate_template_id TEXT REFERENCES label_templates (id);
