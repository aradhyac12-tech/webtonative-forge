ALTER TABLE public.builds
ADD COLUMN IF NOT EXISTS diagnostic_token text;

CREATE INDEX IF NOT EXISTS builds_diagnostic_token_idx
ON public.builds (diagnostic_token)
WHERE diagnostic_token IS NOT NULL;