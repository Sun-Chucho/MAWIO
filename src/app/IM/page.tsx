import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Inventory Manager",
  description: "Inventory manager login page for MAWIO.",
};

export default function InventoryManagerEntryPage() {
  return <RoleLoginPage role="inventory" />;
}
