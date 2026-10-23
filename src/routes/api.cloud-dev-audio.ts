import { createFileRoute } from "@tanstack/react-router";

// Local development only: stands in for signed storage URLs when FROST_DEV_MEMORY_STORE=1.
// In production (service role present) it always answers 404.
export const Route = createFileRoute("/api/cloud-dev-audio")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (
          process.env["FROST_DEV_MEMORY_STORE"] !== "1" ||
          process.env["SUPABASE_SERVICE_ROLE_KEY"]
        )
          return new Response("Not found", { status: 404 });
        const { cloudStore } = await import("@/lib/cloud/store.server");
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (request.method === "PUT") {
          await cloudStore().putAudio(
            id,
            new Uint8Array(await request.arrayBuffer()),
            request.headers.get("content-type") ?? "",
          );
          return new Response("ok");
        }
        const bytes = await cloudStore().getAudio(id);
        return bytes
          ? new Response(bytes as Uint8Array<ArrayBuffer>, {
              headers: { "content-type": "application/octet-stream" },
            })
          : new Response("Not found", { status: 404 });
      },
    },
  },
});
