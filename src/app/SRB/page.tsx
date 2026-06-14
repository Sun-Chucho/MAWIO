import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Standard Reception Booking",
  description: "Standard reception booking login page for MAWIO.",
  manifest: "/api/pwa-manifest/cashier?tier=standard",
};

export default function StandardReceptionBookingPage() {
  return <RoleLoginPage role="standard" initialHotelRole="cashier" />;
}
