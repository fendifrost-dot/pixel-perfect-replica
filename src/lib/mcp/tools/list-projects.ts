import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAnon } from "../supabase";

export default defineTool({
  name: "list_projects",
  title: "List shared projects",
  description: "List intentionally public cloud projects; does not access device-only projects or private audio.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(25).describe("Maximum projects to return."),
    offset: z.number().int().min(0).max(100000).default(0).describe("Number of projects to skip for pagination."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit, offset }) => {
    const { data, error } = await supabaseAnon().from("projects")
      .select("id,name,schema_version,created_at,updated_at")
      .order("created_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
    if (error) throw new ToolError("Shared projects could not be read.");
    return { content: [{ type: "text", text: JSON.stringify({ projects: data ?? [], nextOffset: (data?.length ?? 0) === limit ? offset + limit : null }) }] };
  },
});