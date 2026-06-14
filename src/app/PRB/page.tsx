import type { Metadata } from "next";
import { RoleLoginPage } from "@/components/auth/role-login-page";

export const metadata: Metadata = {
  title: "MAWIO Premium Reception Booking",
  description: "Premium reception booking login page for MAWIO.",
  manifest: "/api/pwa-manifest/cashier?tier=platinum",
};

export default function PremiumReceptionBookingPage() {
  return <RoleLoginPage role="platinum" initialHotelRole="cashier" />;
}
