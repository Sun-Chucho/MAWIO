import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Inventory Manager",
  description: "Standard inventory manager login page for MAWIO.",
  manifest: "/api/pwa-manifest/inventory?tier=standard",
};

export default function StandardInventoryManagerPage() {
  return <RoleLoginPage role="standard" initialHotelRole="inventory" />;
}
