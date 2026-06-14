import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Barista POS",
  description: "Standard barista POS login page for MAWIO.",
  manifest: "/api/pwa-manifest/barista?tier=standard",
};

export default function StandardBaristaPosPage() {
  return <RoleLoginPage role="standard" initialHotelRole="barista" />;
}
