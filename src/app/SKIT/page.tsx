import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Kitchen POS",
  description: "Standard kitchen POS login page for MAWIO.",
  manifest: "/api/pwa-manifest/kitchen?tier=standard",
};

export default function StandardKitchenPosPage() {
  return <RoleLoginPage role="standard" initialHotelRole="kitchen" />;
}
