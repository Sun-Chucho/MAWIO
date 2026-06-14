import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Inventory Manager",
  description: "Premium inventory manager login page for MAWIO.",
  manifest: "/api/pwa-manifest/inventory",
};

export default function PremiumInventoryManagerPage() {
  return <RoleLoginPage role="inventory" />;
}
