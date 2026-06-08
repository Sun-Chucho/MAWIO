import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Reception Booking",
  description: "Reception booking login page for MAWIO.",
};

export default function ReceptionBookingEntryPage() {
  return <RoleLoginPage role="cashier" />;
}
