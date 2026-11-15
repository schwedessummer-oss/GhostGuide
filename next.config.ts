import type { NextConfig } from "next";

/**
 * Ghost Guide runs with the classic dynamic rendering model (cacheComponents off).
 * Many pages read per-user, RLS-scoped data at request time, so we opt in to
 * caching explicitly (e.g. hourly ISR) instead of opting out.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    // Geolocation is needed by "Near me" on our own origin only.
    value: "camera=(), microphone=(), geolocation=(self), payment=(self)",
  },
];

const nextConfig: NextConfig = {
  cacheComponents: false,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The kill-switch service worker (public/sw.js) must always be fetched fresh.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
