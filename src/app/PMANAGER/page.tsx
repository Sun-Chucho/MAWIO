import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Manager",
  description: "Premium hotel manager login page for MAWIO.",
  manifest: "/api/pwa-manifest/manager?tier=platinum",
};

export default function PremiumManagerPage() {
  return <RoleLoginPage role="platinum" initialHotelRole="manager" />;
}
