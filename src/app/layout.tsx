import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { TabBar } from "@/components/site/primary-nav";
import { ServiceWorkerRegistrar } from "@/components/site/service-worker-registrar";
import { getCurrentUser } from "@/server/auth";

export const metadata: Metadata = {
  title: { default: "Ghost Guide — find a hike, plan the day, get home safely", template: "%s · Ghost Guide" },
  description:
    "Find real trails anywhere with honest distance, climb and time estimates, check the forecast and daylight, and hike with optional check-ins.",
  applicationName: "Ghost Guide",
  appleWebApp: { capable: true, title: "Ghost Guide", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#1f4630",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/*
 * Layout notes
 * - Phones get a fixed bottom tab bar; the body reserves its height (plus the
 *   safe-area inset) so no content hides behind it.
 * - Full-height app pages (Explore) mark their root with data-app-fullscreen:
 *   the body then becomes exactly one viewport tall and <main> a flex column
 *   the page fills, so the map never scrolls with the page.
 */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] antialiased md:pb-0 has-[[data-app-fullscreen]]:h-dvh has-[[data-app-fullscreen]]:overflow-hidden print:pb-0">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1 has-[[data-app-fullscreen]]:flex has-[[data-app-fullscreen]]:min-h-0 has-[[data-app-fullscreen]]:flex-col">
          {children}
        </main>
        <SiteFooter />
        <TabBar signedIn={Boolean(user)} />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
