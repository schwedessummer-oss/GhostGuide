import type { Metadata } from "next";
import { ExploreApp } from "@/components/explore/explore-app";
import { parseExploreParams, serializeExploreParams } from "@/components/explore/url-state";
import { getUnitsPreference } from "@/components/site/units-server";
import { parsePlaceQuery } from "@/server/geo/geocode";
import { loadExplore } from "./load";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: PageProps<"/explore">): Promise<Metadata> {
  const { q, bbox } = parseExploreParams(await searchParams);
  const place = q ? parsePlaceQuery(q).placeQuery : "";
  return {
    title: place ? `Trails near ${place}` : "Explore trails",
    description: "Find real hiking trails on the map, with honest distance, climb and time estimates from OpenStreetMap data.",
    // Searches are endless variations of one page: only the bare page is indexed.
    robots: q || bbox ? { index: false, follow: true } : undefined,
  };
}

export default async function ExplorePage({ searchParams }: PageProps<"/explore">) {
  const state = parseExploreParams(await searchParams);
  const initial = await loadExplore(state, await getUnitsPreference());
  // A new server render (a link to another search) starts the client state afresh.
  return <ExploreApp key={serializeExploreParams(initial.state)} initial={initial} />;
}
