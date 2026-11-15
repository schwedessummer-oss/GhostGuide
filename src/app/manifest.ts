import type { MetadataRoute } from "next";

/** Web app manifest (installable PWA). Colours mirror the forest/canvas design tokens. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ghost Guide",
    short_name: "Ghost Guide",
    description: "A guide to the world's best hikes, being rebuilt. The catalog is coming soon.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf7f1",
    theme_color: "#1f4630",
    categories: ["travel", "sports"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
