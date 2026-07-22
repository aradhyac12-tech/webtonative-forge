ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS codemagic_build_id text,
  ADD COLUMN IF NOT EXISTS project_kind text,
  ADD COLUMN IF NOT EXISTS web_dir text,
  ADD COLUMN IF NOT EXISTS app_name text,
  ADD COLUMN IF NOT EXISTS bundle_id text;