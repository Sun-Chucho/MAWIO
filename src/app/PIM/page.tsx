import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Inventory Manager",
  description: "Premium inventory manager login page for MAWIO.",
  manifest: "/api/pwa-manifest/inventory?tier=platinum",
};

export default function PremiumInventoryManagerPage() {
  return <RoleLoginPage role="platinum" initialHotelRole="inventory" />;
}
