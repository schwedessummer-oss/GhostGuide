import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";

export const metadata: Metadata = {
  title: { default: "Ghost Guide — the world's best hikes", template: "%s · Ghost Guide" },
  description: "Ghost Guide is being rebuilt as a guide to the world's best hikes. The catalog is coming soon.",
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
 * Layout note: nothing here reads cookies, headers or the session (directly
 * or in the header/footer). One request-time read would make EVERY route
 * dynamic and disable static rendering and CDN caching of public pages. The
 * signed-in chrome is applied in the browser (see
 * components/site/session.ts). tests/unit/site/static-shell.test.ts
 * enforces this.
 */
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
      </body>
    </html>
  );
}
