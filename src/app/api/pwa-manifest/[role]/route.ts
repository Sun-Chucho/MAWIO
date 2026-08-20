import { NextRequest, NextResponse } from "next/server";

const ROLE_MANIFESTS = {
  manager: {
    name: "MAWIO Manager",
    short_name: "OH Manager",
    start_url: "/MANAGER",
    id: "/MANAGER",
    description: "MAWIO manager login and dashboard entry point.",
    theme_color: "#d97706",
    background_color: "#fff7ed",
  },
  director: {
    name: "MAWIO MD Dashboard",
    short_name: "Orange MD",
    start_url: "/MD?source=pwa",
    scope: "/",
    id: "/mawio-md-dashboard",
    description: "MAWIO managing director mobile dashboard.",
    theme_color: "#065f46",
    background_color: "#f4f7f2",
  },
  inventory: {
    name: "MAWIO Inventory",
    short_name: "OH Inventory",
    start_url: "/IM",
    id: "/IM",
    description: "MAWIO inventory login and stock control entry point.",
    theme_color: "#111827",
    background_color: "#f9fafb",
  },
  cashier: {
    name: "MAWIO Reception",
    short_name: "OH Reception",
    start_url: "/RB",
    id: "/RB",
    description: "MAWIO reception booking login and dashboard entry point.",
    theme_color: "#ea580c",
    background_color: "#fff7ed",
  },
  kitchen: {
    name: "MAWIO Kitchen POS",
    short_name: "OH Kitchen",
    start_url: "/KP",
    id: "/KP",
    description: "MAWIO kitchen POS login and dashboard entry point.",
    theme_color: "#c2410c",
    background_color: "#fff7ed",
  },
  barista: {
    name: "MAWIO Barista POS",
    short_name: "OH Barista",
    start_url: "/BP",
    id: "/BP",
    description: "MAWIO barista POS login and dashboard entry point.",
    theme_color: "#fb923c",
    background_color: "#fff7ed",
  },
} as const;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ role: string }> },
) {
  void _request;
  const { role } = await context.params;
  const manifest = ROLE_MANIFESTS[role as keyof typeof ROLE_MANIFESTS];

  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  let startUrl: string = manifest.start_url;
  let name: string = manifest.name;
  let shortName: string = manifest.short_name;

  if (role === "barista") {
      startUrl = "/SBAR";
      name = "MAWIO Standard Barista POS";
      shortName = "Std Barista";
  } else if (role === "kitchen") {
      startUrl = "/SKIT";
      name = "MAWIO Standard Kitchen POS";
      shortName = "Std Kitchen";
  } else if (role === "manager") {
      startUrl = "/smanager";
      name = "MAWIO Standard Manager";
      shortName = "Std Manager";
  } else if (role === "inventory") {
      startUrl = "/SIM";
      name = "MAWIO Standard Inventory";
      shortName = "Std Inventory";
  } else if (role === "cashier") {
      startUrl = "/SRB";
      name = "MAWIO Standard Reception";
      shortName = "Std Reception";
  }

  return new NextResponse(
    JSON.stringify({
      ...manifest,
      name,
      short_name: shortName,
      display: "standalone",
      display_override: ["standalone", "minimal-ui"],
      start_url: startUrl,
      scope: startUrl,
      id: startUrl,
      background_color: manifest.background_color,
      theme_color: manifest.theme_color,
      categories: ["business", "productivity"],
      prefer_related_applications: false,
      orientation: "portrait-primary",
      icons: [
        {
          src: "/logo.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: "/logo.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
