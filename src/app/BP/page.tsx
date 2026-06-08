import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Barista POS",
  description: "Barista POS login page for MAWIO.",
  manifest: "/api/pwa-manifest/barista",
};

export default function BaristaPosEntryPage() {
  return <RoleLoginPage role="barista" />;
}
