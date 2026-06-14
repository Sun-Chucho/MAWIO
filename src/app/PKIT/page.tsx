import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Kitchen POS",
  description: "Premium kitchen POS login page for MAWIO.",
  manifest: "/api/pwa-manifest/kitchen",
};

export default function PremiumKitchenPosPage() {
  return <RoleLoginPage role="kitchen" />;
}
