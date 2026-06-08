import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Manager",
  description: "Hotel manager login page for MAWIO.",
};

export default function ManagerEntryPage() {
  return <RoleLoginPage role="manager" />;
}
