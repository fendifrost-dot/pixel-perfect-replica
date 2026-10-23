CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Untitled project',
  schema_version integer NOT NULL DEFAULT 2,
  project jsonb NOT NULL DEFAULT '{}'::jsonb,
  audio_paths text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.projects TO anon, authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read shared projects" ON public.projects FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Anyone can add shared projects" ON public.projects FOR INSERT TO anon, authenticated WITH CHECK (true);
COMMENT ON TABLE public.projects IS 'Intentionally public shared cloud projects. Never automatically copy private device projects here. Anonymous updates and deletions are not permitted.';