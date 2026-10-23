import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/cloud")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleCloud } = await import("@/lib/cloud/api.server");
        return handleCloud(request);
      },
    },
  },
});
