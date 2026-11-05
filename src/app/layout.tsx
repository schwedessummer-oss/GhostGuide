import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { ServiceWorkerRegistrar } from "@/components/site/service-worker-registrar";

export const metadata: Metadata = {
  title: { default: "Ghost Guide — self-guided hikes with an audio companion", template: "%s · Ghost Guide" },
  description:
    "Discover a hike, get a personalized itinerary, download your trip, and hike with GPS-triggered audio narration and optional check-ins.",
  applicationName: "Ghost Guide",
  appleWebApp: { capable: true, title: "Ghost Guide", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#1f4630",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
