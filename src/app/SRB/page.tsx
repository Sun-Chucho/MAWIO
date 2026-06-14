import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Reception Booking",
  description: "Standard reception booking login page for MAWIO.",
};

export default function StandardReceptionBookingPage() {
  return <RoleLoginPage role="cashier" />;
}
