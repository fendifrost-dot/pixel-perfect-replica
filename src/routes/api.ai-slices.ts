import { createFileRoute } from "@tanstack/react-router";
import { handleAiSlices } from "@/lib/ai/slices.server";

export const Route = createFileRoute("/api/ai-slices")({
  server: { handlers: { POST: ({ request }) => handleAiSlices(request) } },
});