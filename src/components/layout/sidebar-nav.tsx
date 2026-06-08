
"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from 'react';
import { 
  LayoutDashboard, 
  Hotel, 
  Package, 
  ShoppingCart, 
  WalletCards,
  Utensils, 
  XCircle,
  Users, 
  BarChart3, 
  Settings,
  Building2,
  FileSpreadsheet,
  MessageCircle,
  MonitorSmartphone,
  LogOut,
  ReceiptText,
  HandCoins,
  Shirt,
  Calculator
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Role } from "@/app/lib/mock-data";
import { PlaceHolderImages } from "@/lib/placeholder-images";

interface NavItem {
  label: string;
  href: string;
  icon: any;
  roles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard, roles: ['manager', 'director'] },
  { label: 'Rooms', href: '/dashboard/rooms', icon: Hotel, roles: ['manager', 'director', 'cashier'] },
  { label: 'Kitchen Stock', href: '/dashboard/inventory/kitchen-stock', icon: Package, roles: ['manager', 'inventory'] },
  { label: 'Barista Stock', href: '/dashboard/inventory/barista-stock', icon: Package, roles: ['manager', 'inventory'] },
  { label: 'Inventory', href: '/dashboard/inventory', icon: Package, roles: ['inventory'] },
  { label: 'Menu Create', href: '/dashboard/menu-create', icon: FileSpreadsheet, roles: ['manager'] },
  { label: 'Company Stock', href: '/dashboard/company-stock', icon: Building2, roles: ['manager', 'director', 'inventory'] },
  { label: 'F&B Suite', href: '/dashboard/fnb-suite', icon: FileSpreadsheet, roles: [] },
  { label: 'F&B POS', href: '/dashboard/fnb-pos', icon: Utensils, roles: ['kitchen', 'barista'] },
  { label: 'Booking', href: '/dashboard/cashier', icon: ShoppingCart, roles: ['manager', 'director', 'cashier'] },
  { label: 'Cash Requests', href: '/dashboard/cash-requests', icon: HandCoins, roles: ['cashier'] },
  { label: 'Laundry', href: '/dashboard/laundry', icon: Shirt, roles: ['manager', 'director', 'cashier'] },
  { label: 'Website Booking', href: '/dashboard/website-bookings', icon: MonitorSmartphone, roles: ['cashier'] },
  { label: 'Live Chat', href: '/dashboard/live-chat', icon: MessageCircle, roles: ['cashier'] },
  { label: 'Payments', href: '/dashboard/payments', icon: WalletCards, roles: ['manager', 'director', 'cashier', 'kitchen', 'barista'] },
  { label: 'Expenses', href: '/dashboard/expenses', icon: ReceiptText, roles: ['manager', 'director'] },
  { label: 'Finances', href: '/dashboard/finances', icon: Calculator, roles: ['manager', 'director'] },
  { label: 'Kitchen Stock', href: '/dashboard/kitchen', icon: Utensils, roles: ['director'] },
  { label: 'Barista Stock', href: '/dashboard/barista', icon: Package, roles: ['director'] },
  { label: 'Cancelled', href: '/dashboard/cancelled', icon: XCircle, roles: ['kitchen', 'barista'] },
  { label: 'Staff', href: '/dashboard/staff', icon: Users, roles: ['manager', 'director'] },
  { label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3, roles: ['director'] },
  { label: 'Settings', href: '/dashboard/settings/password', icon: Settings, roles: ['manager', 'director', 'inventory', 'cashier', 'kitchen', 'barista'] },
];

const ROLE_NAV_PRIORITY: Partial<Record<Role, string[]>> = {
  cashier: ['/dashboard/cashier', '/dashboard/laundry', '/dashboard/cash-requests', '/dashboard/website-bookings', '/dashboard/live-chat'],
  kitchen: ['/dashboard/kitchen'],
  barista: ['/dashboard/barista'],
};

export function SidebarNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const router = useRouter();
  const logoutPath = role === "director" ? "/MD" : "/";
  
  const handleNavigate = () => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      const evt = new CustomEvent("mawio-sidebar-close");
      window.dispatchEvent(evt);
    }
  };
  
  const filteredNav = useMemo(() => {
    const visible = NAV_ITEMS
      .filter(item => item.roles.includes(role))
      .filter((item) => !(role === "inventory" && item.href === "/dashboard/inventory/barista-stock"))
      .filter((item) => !(role === "barista" && item.href === "/dashboard/live-chat"))
      .map((item) => {
        if (item.href !== "/dashboard/fnb-pos") return item;
        if (role === "kitchen") return { ...item, label: "Kitchen POS", href: "/dashboard/kitchen" };
        if (role === "barista") return { ...item, label: "Barista POS", href: "/dashboard/barista" };
        return item;
      })
      .map((item) => {
        if (role !== "manager") return item;
        if (item.href === "/dashboard/inventory/kitchen-stock") return { ...item, label: "Kitchen" };
        if (item.href === "/dashboard/inventory/barista-stock") return { ...item, label: "Barista" };
        return item;
      })
      .map((item) => {
        if (role !== "director") return item;
        if (item.href === "/dashboard/laundry") return { ...item, label: "Laundry Sales" };
        return item;
      })
      .map((item) => {
        if (item.href !== "/dashboard/settings/password") return item;
        if (role === "manager" || role === "director") return { ...item, href: "/dashboard/settings" };
        return item;
      });
    const priority = ROLE_NAV_PRIORITY[role];
    if (!priority || priority.length === 0) return visible;

    return [...visible].sort((a, b) => {
      const aIndex = priority.indexOf(a.href);
      const bIndex = priority.indexOf(b.href);
      const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
      return aRank - bRank;
    });
  }, [role]);

  const logo = useMemo(() => 
    PlaceHolderImages.find(img => img.id === 'app-logo'), 
  []);

  return (
    <div className="flex h-full min-h-0 w-64 flex-col bg-black text-white border-r border-sidebar-border">
      <div className="p-8 flex justify-center">
        <Link href="/dashboard" className="group">
          <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center p-2 group-hover:scale-105 transition-transform overflow-hidden shadow-2xl relative">
            {logo && (
              <Image 
                src={logo.imageUrl} 
                alt="MAWIO Logo" 
                width={80} 
                height={80} 
                priority
                className="object-contain"
                data-ai-hint={logo.imageHint}
              />
            )}
          </div>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4 [-webkit-overflow-scrolling:touch]">
        <div className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] px-3 py-4 opacity-50">
          Management
        </div>
        {filteredNav.map((item) => {
          const isFnBPosRoute = pathname === "/dashboard/fnb-pos" || pathname === "/dashboard/kitchen" || pathname === "/dashboard/barista";
          const isRolePosRoute =
            (item.href === "/dashboard/kitchen" && pathname === "/dashboard/kitchen") ||
            (item.href === "/dashboard/barista" && pathname === "/dashboard/barista");
          const isSettingsRoute = item.href.startsWith("/dashboard/settings") && pathname.startsWith("/dashboard/settings");
          const isActive = item.href === "/dashboard/fnb-pos" ? isFnBPosRoute : isRolePosRoute || isSettingsRoute || pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={(event) => {
                event.preventDefault();
                handleNavigate();
                router.push(item.href);
              }}
              className={cn(
                "flex items-center gap-3 px-3 py-3 rounded-xl transition-all group mb-1",
                isActive 
                  ? "bg-primary text-white shadow-lg shadow-primary/20" 
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-primary"
              )}
            >
              <item.icon className={cn(
                "w-5 h-5 transition-colors",
                isActive ? "text-white" : "text-muted-foreground group-hover:text-primary"
              )} />
              <span className="font-bold text-sm tracking-tight">{item.label}</span>
              {isActive && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 p-4 border-t border-sidebar-border mt-auto">
        <div className="flex items-center gap-3 p-3 rounded-xl bg-sidebar-accent mb-4 border border-white/5">
          <div className="w-9 h-9 rounded-lg bg-muted overflow-hidden relative border border-white/20">
            <Image 
              src="/logo.jpeg" 
              alt="User Avatar" 
              fill 
              className="object-cover"
            />
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-xs font-black truncate uppercase tracking-tight">{role}</span>
            <span className="text-[10px] text-green-500 font-bold uppercase tracking-widest flex items-center gap-1">
              <div className="w-1 h-1 rounded-full bg-green-500" /> Active
            </span>
          </div>
        </div>
        <button 
          onClick={() => {
            localStorage.clear();
            window.location.href = logoutPath;
          }}
          className="flex items-center gap-3 px-3 py-2 w-full rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors font-bold text-xs uppercase tracking-widest"
        >
          <LogOut className="w-4 h-4" />
          <span>Exit Session</span>
        </button>
      </div>
    </div>
  );
}
