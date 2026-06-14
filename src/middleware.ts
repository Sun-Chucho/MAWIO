import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const DIRECT_ROLE_ROUTES: Record<string, string> = {
  "/manager": "/MANAGER",
  "/md": "/MD",
  "/im": "/IM",
  "/rb": "/RB",
  "/kp": "/KP",
  "/bp": "/BP",
  "/smanager": "/SMANAGER",
  "/pmanager": "/PMANAGER",
  "/sbar": "/SBAR",
  "/srb": "/SRB",
  "/skit": "/SKIT",
  "/sim": "/SIM",
  "/pbar": "/PBAR",
  "/prb": "/PRB",
  "/pkit": "/PKIT",
  "/pim": "/PIM",
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const normalizedPath = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const directRoute = DIRECT_ROLE_ROUTES[normalizedPath];

  if (directRoute && pathname !== directRoute) {
    const url = request.nextUrl.clone();
    url.pathname = directRoute;
    return NextResponse.redirect(url);
  }

  if (normalizedPath === "/staff") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
