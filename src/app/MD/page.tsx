import type { Metadata, Viewport } from "next";
import { MdEntryPage } from "@/components/auth/md-entry-page";

export const metadata: Metadata = {
  title: "MAWIO MD Dashboard",
  description: "Managing director dashboard entry for MAWIO.",
  manifest: "/md-manifest.webmanifest",
  icons: {
    icon: [
      { url: "/logo.png", sizes: "192x192", type: "image/png" },
      { url: "/logo.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/logo.png", sizes: "any", type: "image/png" }],
    shortcut: "/logo.png",
  },
  appleWebApp: {
    capable: true,
    title: "MAWIO MD",
    statusBarStyle: "black-translucent",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-title": "MAWIO MD",
    "application-name": "MAWIO MD",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#065f46",
};

export default function ManagingDirectorEntryPage() {
  return <MdEntryPage />;
}
