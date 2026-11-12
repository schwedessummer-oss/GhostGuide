-- ============================================================================
-- Hike totals (Phase 1, additive)
--
-- catalog_trails.estimated_duration_min is ONE traversal measured from the
-- trailhead. Hikers usually walk linear routes out and back, and the way back
-- is not simply the same time again (descents are faster), so the realistic
-- total is computed at ingestion with the same Tobler model on the reversed
-- profile and stored here. Lists, filters and trail pages all use it.
--   loop / network / unknown: equals estimated_duration_min
--   linear:                   out-and-back estimate
-- ============================================================================
alter table public.catalog_trails
  add column if not exists hike_duration_min integer check (hike_duration_min > 0);
