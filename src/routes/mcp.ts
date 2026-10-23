// Hand-owned (the mcp-js Vite plugin is not used, so nothing regenerates this): every MCP request
// must carry FROST_MCP_KEY before it reaches a tool.
// route: /mcp

import { createFileRoute } from "@tanstack/react-router";

import { createTanStackMcpHandler } from "@lovable.dev/mcp-js/stacks/tanstack";

import mcp from "../lib/mcp/index";
import { checkKey } from "../lib/cloud/key.server";

const handler = createTanStackMcpHandler(mcp, {
  resourcePath: "/mcp",
  trustForwardedHost: true,
  trustForwardedProto: true,
});

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      ANY: async (ctx) => {
        const auth = checkKey(ctx.request);
        return auth.ok ? handler(ctx) : auth.response;
      },
    },
  },
});
