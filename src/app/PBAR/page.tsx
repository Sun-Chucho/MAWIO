import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Barista POS",
  description: "Premium barista POS login page for MAWIO.",
  manifest: "/api/pwa-manifest/barista",
};

export default function PremiumBaristaPosPage() {
  return <RoleLoginPage role="barista" />;
}
