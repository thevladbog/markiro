-- Additive global-office read paths. Include archived products and frozen imports;
-- text substring matches intentionally scan compact headers, never code/file bytes.
CREATE INDEX products_search_gtin ON products(gtin14,id);
CREATE INDEX shifts_search_product ON shifts(product_id,id);
CREATE INDEX cloud_history_shifts_search_gtin ON cloud_history_shifts(gtin14,id);
