import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Manager",
  description: "Standard hotel manager login page for MAWIO.",
  manifest: "/api/pwa-manifest/manager?tier=standard",
};

export default function StandardManagerPage() {
  return <RoleLoginPage role="standard" initialHotelRole="manager" />;
}
