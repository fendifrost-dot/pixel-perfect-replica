-- Frost Sampler cloud becomes a private, key-protected sync store.
-- Only the app's server (service role) reads or writes; the browser and MCP reach it through
-- key-checked server routes (FROST_MCP_KEY). Safe to re-run.
DROP POLICY IF EXISTS "Anyone can read shared projects" ON public.projects;
DROP POLICY IF EXISTS "Anyone can add shared projects" ON public.projects;
REVOKE ALL ON public.projects FROM anon, authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS key text;
CREATE UNIQUE INDEX IF NOT EXISTS projects_key_idx ON public.projects (key);
COMMENT ON TABLE public.projects IS 'Frost Sampler projects synced from the owner''s devices and edited by MCP. Server-only (service role) behind FROST_MCP_KEY; no anon/authenticated access.';
