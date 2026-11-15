import type { MetadataRoute } from "next";

/** Web app manifest (installable PWA). Colours mirror the forest/canvas design tokens. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ghost Guide",
    short_name: "Ghost Guide",
    description: "Find real trails with honest distance, climb and time estimates, and plan your hike.",
    id: "/",
    start_url: "/trips",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf7f1",
    theme_color: "#1f4630",
    categories: ["travel", "sports", "navigation"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
