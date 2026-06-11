import { notFound } from "next/navigation";
import { RoleLoginPage } from "@/components/auth/role-login-page";

const STAFF_ROLES = {
  manager: "manager",
  receptionist: "cashier",
  inventory: "inventory",
  kitchen: "kitchen",
  barista: "barista",
} as const;

export default async function PlatinumStaffLoginPage({
  params,
}: {
  params: Promise<{ staffRole: string }>;
}) {
  const { staffRole } = await params;
  const role = STAFF_ROLES[staffRole as keyof typeof STAFF_ROLES];

  if (!role) notFound();

  return <RoleLoginPage role="platinum" initialHotelRole={role} />;
}
