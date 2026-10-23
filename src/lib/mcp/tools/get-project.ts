import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon } from "../supabase";

export default defineTool({
  name: "get_project",
  title: "Read shared project",
  description: "Read one intentionally public cloud project by ID; private audio files are not accessible.",
  inputSchema: { id: z.string().uuid().describe("Shared cloud project ID from list_projects.") },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ id }) => {
    const { data, error } = await supabaseAnon().from("projects")
      .select("id,name,schema_version,project,created_at,updated_at").eq("id", id).maybeSingle();
    if (error) throw new ToolError("Shared project could not be read.");
    if (!data) throw new ToolError("Shared project not found.");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
});