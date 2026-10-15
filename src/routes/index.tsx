import { createFileRoute } from "@tanstack/react-router";
import { FrostProvider } from "@/lib/frost/store";
import { Workspace } from "@/components/frost/Workspace";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Frost Sampler — pocket sampler workspace" },
      { name: "description", content: "Import a song, chop it onto pads, sequence beats and arrange patterns on your phone." },
      { property: "og:title", content: "Frost Sampler" },
      { property: "og:description", content: "A pocket MPC-style sampler: chop, perform, sequence, arrange." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <FrostProvider>
      <Workspace />
    </FrostProvider>
  );
}
