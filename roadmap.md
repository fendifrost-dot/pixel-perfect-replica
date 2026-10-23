# Cloud and MCP (v2: private + key)
- [x] Lock `projects` to server-only access; key check (FROST_MCP_KEY) on /mcp and /api/cloud.
- [x] Full read/write MCP tools (projects, recordings, chops, pads, patterns, song, export settings, kits).
- [x] Phone ↔ cloud sync with conflict handling; audio via signed URLs.
- [ ] Owner adds the FROST_MCP_KEY secret in Lovable Cloud and pastes the key into the app + connectors (MCP_SETUP.md).

# Cloud and MCP setup (v1, superseded)
- [x] Enable Lovable Cloud.
- [x] Create public shared projects table and private audio bucket.
- [ ] Enable open audio access — blocked by workspace public-bucket policy; requires an admin in Settings → Privacy & Security.
- [x] Prepare read-only public MCP tools without uploading device-only projects.
- [x] Verify policies, real MCP reads, tests and security scan.
- [x] Request publishing in this turn; deployment completion must be confirmed separately.

# AI-assisted slicing
- [x] Add imported-sample AI analysis with explicit audio-send consent and cancellation.
- [x] Review, audition and apply slice/pad suggestions without replacing occupied pads.
- [x] Validate model output and test the real imported-audio flow; successful Gateway response, assignment and saved-project reopen verified.