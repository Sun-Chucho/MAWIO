"use client";

import { useState, useEffect } from 'react';
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { BARISTA_INVENTORY_SEED, PREMIUM_BARISTA_INVENTORY_SEED, PREMIUM_BARISTA_PRICE_ALIASES } from "@/app/lib/seed-barista-data";
import { DEFAULT_KITCHEN_MENU, mergeKitchenMenuItems } from "@/app/lib/kitchen-menu";
import { InventoryItem, Role } from "@/app/lib/mock-data";
import { getLocalMawioTier } from "@/app/lib/login-profiles";
import { ExpenseRecord, STORAGE_EXPENSES } from "@/app/lib/expenses";
import { KitchenPurchaseHistoryEntry, STORAGE_KITCHEN_PURCHASE_HISTORY } from "@/app/lib/kitchen-session-storage";
import { MainStoreItem, STORAGE_MAIN_STORE_ITEMS, getStoreItemLabel, normalizeBaristaProductTarget, normalizeStockName } from "@/app/lib/inventory-transfer";
import { getTotLimit } from "@/app/lib/barista-stock";
import { normalizeRole } from "@/app/lib/auth";
import { hydrateStorageKeyFromFirebase, purgeSyncedKeysForCurrentTier, runOnceForTierAcrossDevices, setMawioTier } from "@/app/lib/firebase-sync";
import { readJson, readPosState, STORAGE_BARISTA_STATE, STORAGE_KITCHEN_STATE, writeJson, writePosState } from "@/app/lib/storage";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Home, Hotel, Search, User, Clock, Menu, WalletCards, ReceiptText, Package } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";
import { MANAGER_SESSION_VERSION, STORAGE_MANAGER_SESSION_VERSION, readActiveSessionUsername, readLocalLoginProfiles, renameProfileUser, saveLoginProfileToServer, writeActiveSessionUsername } from "@/app/lib/login-profiles";

const VALID_ROLES: Role[] = ['manager', 'director', 'inventory', 'cashier', 'kitchen', 'barista'];
const DIRECTOR_MOBILE_NAV = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Rooms", href: "/dashboard/rooms", icon: Hotel },
  { label: "Kitchen", href: "/dashboard/kitchen", icon: ReceiptText },
  { label: "Stock", href: "/dashboard/company-stock", icon: Package },
  { label: "Payments", href: "/dashboard/payments", icon: WalletCards },
  { label: "Expenses", href: "/dashboard/expenses", icon: ReceiptText },
] as const;
const KITCHEN_TRANSACTIONS_RESET_KEY = "orange-hotel-kitchen-transactions-reset-v3";
const KITCHEN_MENU_PRICE_FIX_KEY = "orange-hotel-kitchen-menu-price-fix-v2";
const DOMPO_STOCK_FIX_KEY = "orange-hotel-dompo-750ml-stock-fix-v1";
const BARISTA_STOCK_FIX_KEY = "orange-hotel-barista-stock-fix-v5";
const BARISTA_FINANCE_PRICE_FIX_KEY = "orange-hotel-barista-finance-price-fix-v3";
const BARISTA_SHARED_STATE_FIX_KEY = "orange-hotel-barista-shared-state-fix-v4";
const BARISTA_INVENTORY_CORRECTION_FIX_KEY = "orange-hotel-barista-inventory-correction-fix-v5";
const COMPANY_STOCK_SHEET_FIX_KEY = "orange-hotel-company-stock-sheet-fix-v1";
const BARISTA_MENU_REMOVAL_FIX_KEY = "orange-hotel-barista-menu-removal-fix-v1";
const JACK_DANIELS_TOTS_PRICE_FIX_KEY = "orange-hotel-jack-daniels-tots-price-fix-v1";
const STAFF_FOOD_DISHES_EXPENSE_REMOVAL_KEY = "orange-hotel-staff-food-dishes-expense-removal-v2";
const KITCHEN_MAY_SALES_YEAR_FIX_KEY = "orange-hotel-kitchen-may-sales-year-fix-v1";
const PREMIUM_BARISTA_PRICE_FIX_KEY = "orange-hotel-premium-barista-price-fix-v1";

// One-time clean slate for the premium (platinum) hotel: its backend node
// historically absorbed sales/bookings that belonged to the standard hotel, so
// the premium dashboards kept showing the other hotel's records. Runs once per
// tier across ALL devices (backend marker) and only touches the platinum node —
// standard hotel data is never read or written here. The premium kitchen menu
// is preserved across the purge; only tickets/sales/bookings/rooms are reset.
const PLATINUM_SALES_RESET_KEY = "orange-hotel-platinum-sales-reset-v1";

async function runOneTimePremiumSalesCleanSlate() {
  if (getLocalMawioTier() !== "platinum") return;

  await runOnceForTierAcrossDevices(PLATINUM_SALES_RESET_KEY, async () => {
    const kitchenSnapshot = readJson<{ menuItems?: unknown[] }>(STORAGE_KITCHEN_STATE);
    const preservedKitchenMenu = Array.isArray(kitchenSnapshot?.menuItems) ? kitchenSnapshot.menuItems : [];

    await purgeSyncedKeysForCurrentTier([
      "orange-hotel-cashier-state",
      "orange-hotel-cashier-transactions",
      "orange-hotel-cashier-seq",
      STORAGE_KITCHEN_STATE,
      "orange-hotel-kitchen-tickets",
      "orange-hotel-kitchen-seq",
      "orange-hotel-kitchen-payments",
      "orange-hotel-cancelled-tickets",
      "orange-hotel-rooms-state",
    ]);

    if (preservedKitchenMenu.length > 0) {
      writeJson(STORAGE_KITCHEN_STATE, { tickets: [], ticketSeq: 300, payments: [], menuItems: preservedKitchenMenu });
    }
  });
}

const MANAGEMENT_SYNC_KEYS = [
  "orange-hotel-settings",
  "orange-hotel-login-profiles",
  "orange-hotel-staff-members",
  "orange-hotel-cashier-state",
  "orange-hotel-rooms-state",
  "orange-hotel-kitchen-state",
  "orange-hotel-barista-state",
  "orange-hotel-main-store-items",
  "orange-hotel-inventory-items",
  "orange-hotel-store-movements",
  "orange-hotel-store-usage",
  "orange-hotel-kitchen-purchase-history",
  "orange-hotel-kitchen-daily-stock-history",
  "orange-hotel-barista-purchase-history",
  "orange-hotel-barista-daily-stock-history",
  "orange-hotel-expenses",
  "orange-hotel-laundry-records",
  "orange-hotel-company-stock",
  "orange-hotel-website-bookings",
] as const;

const STARTUP_SYNC_KEYS_BY_ROLE: Record<Role, string[]> = {
  manager: [...MANAGEMENT_SYNC_KEYS],
  director: [...MANAGEMENT_SYNC_KEYS],
  inventory: ["orange-hotel-settings", "orange-hotel-login-profiles", "orange-hotel-main-store-items", "orange-hotel-inventory-items"],
  cashier: ["orange-hotel-settings", "orange-hotel-login-profiles", "orange-hotel-cashier-state", "orange-hotel-rooms-state"],
  kitchen: ["orange-hotel-settings", "orange-hotel-login-profiles", "orange-hotel-kitchen-state", "orange-hotel-main-store-items", "orange-hotel-inventory-items", "orange-hotel-store-movements", "orange-hotel-store-usage"],
  barista: ["orange-hotel-settings", "orange-hotel-login-profiles", "orange-hotel-barista-state", "orange-hotel-main-store-items", "orange-hotel-inventory-items", "orange-hotel-store-movements", "orange-hotel-store-usage"],
  standard: ["orange-hotel-settings", "orange-hotel-login-profiles"],
  platinum: ["orange-hotel-settings", "orange-hotel-login-profiles"],
};

async function hydrateStartupStateForRole(role: Role) {
  const keys = STARTUP_SYNC_KEYS_BY_ROLE[role] ?? ["orange-hotel-settings", "orange-hotel-login-profiles"];
  await Promise.race([
    Promise.all(keys.map((key) => hydrateStorageKeyFromFirebase(key).catch(() => undefined))),
    new Promise((resolve) => window.setTimeout(resolve, 5000)),
  ]);
}
const KALUSE_KIANGI_BOOKING_FIX_KEY = "orange-hotel-kaluse-kiangi-booking-fix-v2";
const LOCAL_BUSINESS_CORRECTION_KEYS = [
  KALUSE_KIANGI_BOOKING_FIX_KEY,
  KITCHEN_TRANSACTIONS_RESET_KEY,
  KITCHEN_MENU_PRICE_FIX_KEY,
  DOMPO_STOCK_FIX_KEY,
  BARISTA_STOCK_FIX_KEY,
  BARISTA_FINANCE_PRICE_FIX_KEY,
  BARISTA_SHARED_STATE_FIX_KEY,
  BARISTA_INVENTORY_CORRECTION_FIX_KEY,
  COMPANY_STOCK_SHEET_FIX_KEY,
  BARISTA_MENU_REMOVAL_FIX_KEY,
  JACK_DANIELS_TOTS_PRICE_FIX_KEY,
  KITCHEN_MAY_SALES_YEAR_FIX_KEY,
] as const;

const BARISTA_STOCK_TARGETS = {
  "Serengeti Lager|330ml": 20,
  "Kilimanjaro Premium Lager|375ml": 13,
  "Safari Lager|330ml": 19,
  "Classic Dompo|750ml": 3,
} as const;

const REMOVED_BARISTA_ITEMS = [
  { name: "Serengeti Lemon", size: "300ml" },
] as const;

function resolveBarInventorySellingPrice(
  inventoryItems: InventoryItem[],
  storeItem: Pick<MainStoreItem, "name" | "size">,
) {
  const storeTargets = [
    normalizeBaristaProductTarget(storeItem.name),
    normalizeBaristaProductTarget(getStoreItemLabel(storeItem)),
  ];

  const inventoryMatch = inventoryItems.find((item) => {
    if (item.category !== "Bar") return false;
    const inventoryTargets = [
      normalizeBaristaProductTarget(item.name),
      normalizeBaristaProductTarget(item.size ? `${item.name} ${item.size}` : item.name),
    ];

    return storeTargets.some((target) => inventoryTargets.includes(target));
  });

  if (typeof inventoryMatch?.sellingPrice === "number" && inventoryMatch.sellingPrice > 0) {
    return inventoryMatch.sellingPrice;
  }

  if (typeof inventoryMatch?.price === "number" && inventoryMatch.price > 0) {
    return inventoryMatch.price;
  }

  return 0;
}

function normalizeBaristaMenuTarget(value: string) {
  return normalizeBaristaProductTarget(value);
}

function isJackDaniels700Target(name: string, size?: string) {
  const normalizedName = normalizeStockName(
    name
      .replace(/\s*\(?TOTS?\)?/gi, " ")
      .replace(/\b700\s*ml\b/gi, " ")
      .trim(),
  );
  return normalizedName === "jack daniels" && normalizeStockName(size ?? "700ml") === "700ml";
}

function isStaffFoodDishesExpenseDate(value: number | string) {
  const date = new Date(value);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === 2026 &&
    date.getMonth() === 4 &&
    date.getDate() === 18 &&
    date.getHours() === 15 &&
    date.getMinutes() === 22
  );
}

function isStaffFoodDishesText(value: string | undefined) {
  const normalized = normalizeStockName(value ?? "").replace(/&/g, "and");
  return normalized.includes("staff foo") && normalized.includes("dishes");
}

function isStaffFoodDishesExpense(expense: ExpenseRecord) {
  return (
    expense.department === "kitchen" &&
    expense.amount === 258000 &&
    isStaffFoodDishesExpenseDate(expense.createdAt) &&
    (isStaffFoodDishesText(expense.title) || isStaffFoodDishesText(expense.notes))
  );
}

function getPurchaseHistoryAmount(entry: KitchenPurchaseHistoryEntry) {
  return entry.lines.reduce((sum, line) => sum + (line.addedQty || 0) * (line.pricePerUnit || 0), 0);
}

function isStaffFoodDishesPurchaseHistory(entry: KitchenPurchaseHistoryEntry) {
  return (
    isStaffFoodDishesExpenseDate(entry.closedAt) &&
    getPurchaseHistoryAmount(entry) === 258000 &&
    entry.lines.some((line) => isStaffFoodDishesText(line.itemName) || isStaffFoodDishesText(line.category))
  );
}

function getBaristaInventoryLabel(item: Pick<InventoryItem, "name" | "size">) {
  const rawName = item.name.trim();
  const isTotItem = /\s*\(?TOTS?\)?$/i.test(rawName);
  const baseName = rawName.replace(/\s*\(?TOTS?\)?$/i, "").trim();
  const size = item.size?.trim() ?? "";

  if (!size) return isTotItem ? `${baseName} (TOTS)` : baseName;
  if (rawName.toLowerCase().includes(size.toLowerCase())) return rawName;
  return isTotItem ? `${baseName} ${size} (TOTS)`.trim() : `${baseName} ${size}`.trim();
}

function getPremiumBaristaTargets(label: string) {
  const target = normalizeBaristaMenuTarget(label);
  const aliasGroup = PREMIUM_BARISTA_PRICE_ALIASES.find((group) =>
    group.labels.some((alias) => normalizeBaristaMenuTarget(alias) === target),
  );

  if (!aliasGroup) return [target];
  return Array.from(new Set([target, ...aliasGroup.labels.map((alias) => normalizeBaristaMenuTarget(alias))]));
}

function getPremiumBaristaPrice(label: string) {
  const target = normalizeBaristaMenuTarget(label);

  for (const group of PREMIUM_BARISTA_PRICE_ALIASES) {
    if (group.labels.some((alias) => normalizeBaristaMenuTarget(alias) === target)) {
      return group.price;
    }
  }

  const seedMatch = PREMIUM_BARISTA_INVENTORY_SEED.find((item) => {
    if (!item.name) return false;
    return getPremiumBaristaTargets(getBaristaInventoryLabel({ name: item.name, size: item.size ?? "" })).includes(target);
  });

  return typeof seedMatch?.sellingPrice === "number" && seedMatch.sellingPrice > 0 ? seedMatch.sellingPrice : 0;
}

function getPremiumBaristaSeedLabel(item: Partial<InventoryItem>) {
  return getBaristaInventoryLabel({ name: item.name ?? "", size: item.size ?? "" });
}

function getPremiumBaristaSeedId(prefix: string, item: Partial<InventoryItem>, index: number) {
  return `${prefix}-${item.barcode || normalizeStockName(getPremiumBaristaSeedLabel(item)).replace(/\s+/g, "-") || index}`;
}

function applyPremiumBaristaPriceCorrections() {
  if (typeof window === "undefined" || getLocalMawioTier() !== "platinum") return;
  if (localStorage.getItem(PREMIUM_BARISTA_PRICE_FIX_KEY) === "1") return;

  const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
  const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
  const baristaSnapshot = readPosState<{ id: string }, { id: string }, { id: string; name: string; price: number; category: string; prepMinutes: number; barcode?: string }>(
    STORAGE_BARISTA_STATE,
    "orange-hotel-barista-orders",
    "orange-hotel-barista-seq",
    "orange-hotel-barista-payments",
    "orange-hotel-barista-menu",
    490,
  );

  const canonicalSeed = PREMIUM_BARISTA_INVENTORY_SEED.filter(
    (item) => item.name && item.status === "ACTIVE" && typeof item.sellingPrice === "number" && item.sellingPrice > 0,
  );

  const nextMenuItems = [...baristaSnapshot.menuItems];
  const existingMenuTargets = new Set(nextMenuItems.flatMap((item) => getPremiumBaristaTargets(item.name)));
  let menuChanged = false;

  for (let index = 0; index < nextMenuItems.length; index += 1) {
    const price = getPremiumBaristaPrice(nextMenuItems[index].name);
    if (price > 0 && nextMenuItems[index].price !== price) {
      nextMenuItems[index] = { ...nextMenuItems[index], price };
      menuChanged = true;
    }
  }

  canonicalSeed.forEach((item, index) => {
    const label = getPremiumBaristaSeedLabel(item);
    const targets = getPremiumBaristaTargets(label);
    if (targets.some((target) => existingMenuTargets.has(target))) return;

    nextMenuItems.push({
      id: getPremiumBaristaSeedId("premium-seed", item, index),
      name: label,
      price: item.sellingPrice ?? 0,
      category: item.category ?? "cold",
      prepMinutes: 2,
      barcode: item.barcode ?? "",
    });
    targets.forEach((target) => existingMenuTargets.add(target));
    menuChanged = true;
  });

  const nextInventoryItems = [...inventoryItems];
  let inventoryChanged = false;
  canonicalSeed.forEach((seedItem, index) => {
    const label = getPremiumBaristaSeedLabel(seedItem);
    const targets = getPremiumBaristaTargets(label);
    const inventoryIndex = nextInventoryItems.findIndex((item) => {
      const itemTargets = getPremiumBaristaTargets(getBaristaInventoryLabel(item));
      return itemTargets.some((target) => targets.includes(target));
    });

    if (inventoryIndex >= 0) {
      const current = nextInventoryItems[inventoryIndex];
      const price = getPremiumBaristaPrice(getBaristaInventoryLabel(current)) || seedItem.sellingPrice || current.sellingPrice;
      if (current.sellingPrice !== price || current.price !== price) {
        nextInventoryItems[inventoryIndex] = {
          ...current,
          sellingPrice: price,
          price,
        };
        inventoryChanged = true;
      }
      return;
    }

    nextInventoryItems.push({
      id: getPremiumBaristaSeedId("premium-inventory", seedItem, index),
      barcode: seedItem.barcode ?? "",
      name: seedItem.name ?? "",
      category: "Bar",
      subCategory: seedItem.category ?? "Bar",
      size: seedItem.size ?? "",
      stock: seedItem.stock ?? 0,
      buyingPrice: seedItem.buyingPrice ?? 0,
      sellingPrice: seedItem.sellingPrice ?? 0,
      price: seedItem.sellingPrice ?? 0,
      status: seedItem.status ?? "ACTIVE",
      minStock: seedItem.minStock ?? 0,
      unit: seedItem.unit ?? "Bottle",
      totSold: seedItem.totSold ?? 0,
      totPerBottle: seedItem.totPerBottle,
    });
    inventoryChanged = true;
  });

  const nextStoreItems = [...storeItems];
  let storeChanged = false;
  canonicalSeed.forEach((seedItem, index) => {
    const label = getPremiumBaristaSeedLabel(seedItem);
    const targets = getPremiumBaristaTargets(label);
    const storeIndex = nextStoreItems.findIndex((item) => {
      if (item.lane !== "barista") return false;
      const itemTargets = getPremiumBaristaTargets(getStoreItemLabel(item));
      return itemTargets.some((target) => targets.includes(target));
    });

    if (storeIndex >= 0) {
      const current = nextStoreItems[storeIndex];
      const price = getPremiumBaristaPrice(getStoreItemLabel(current)) || seedItem.sellingPrice || current.sellingPrice || 0;
      if (current.sellingPrice !== price) {
        nextStoreItems[storeIndex] = {
          ...current,
          sellingPrice: price,
        };
        storeChanged = true;
      }
      return;
    }

    nextStoreItems.push({
      id: getPremiumBaristaSeedId("premium-store", seedItem, index),
      name: seedItem.name ?? "",
      subCategory: seedItem.category ?? "Bar",
      size: seedItem.size ?? "",
      stock: seedItem.stock ?? 0,
      unit: seedItem.unit ?? "Bottle",
      minStock: seedItem.minStock ?? 0,
      lane: "barista",
      buyingPrice: seedItem.buyingPrice ?? 0,
      sellingPrice: seedItem.sellingPrice ?? 0,
      totLimit: seedItem.totPerBottle,
      totSold: seedItem.totSold ?? 0,
    });
    storeChanged = true;
  });

  if (menuChanged) {
    writePosState(STORAGE_BARISTA_STATE, baristaSnapshot.tickets, baristaSnapshot.ticketSeq, baristaSnapshot.payments, nextMenuItems);
  }

  if (inventoryChanged) {
    writeJson("orange-hotel-inventory-items", nextInventoryItems);
  }

  if (storeChanged) {
    writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
  }

  localStorage.setItem(PREMIUM_BARISTA_PRICE_FIX_KEY, "1");
}

function syncBaristaMenuItemsWithSharedData(
  menuItems: Array<{ id: string; name: string; price: number; category: string; prepMinutes: number; barcode?: string }>,
  inventoryItems: InventoryItem[],
  storeItems: MainStoreItem[],
) {
  const filteredMenuItems = menuItems.filter((item) => {
    const target = normalizeBaristaMenuTarget(item.name);
    return !REMOVED_BARISTA_ITEMS.some((removedItem) => {
      const directTarget = normalizeBaristaMenuTarget(`${removedItem.name} ${removedItem.size}`);
      const fallbackTarget = normalizeBaristaMenuTarget(removedItem.name);
      return target === directTarget || target === fallbackTarget;
    });
  });

  const inventoryMenuItems = inventoryItems
    .filter((item) => (item.category ?? "").toLowerCase() !== "kitchen")
    .map((item) => ({
      id: item.id,
      name: getBaristaInventoryLabel(item),
      price:
        typeof item.sellingPrice === "number" && item.sellingPrice > 0
          ? item.sellingPrice
          : typeof item.price === "number" && item.price > 0
            ? item.price
            : 0,
      category: item.category,
      prepMinutes: 2,
      barcode: item.barcode || "",
    }));

  const syncedItems = filteredMenuItems.map((item) => {
    const target = normalizeBaristaMenuTarget(item.name);
    const inventoryMatch = inventoryItems.find((entry) => {
      const entryTargets = [
        normalizeBaristaMenuTarget(entry.name),
        normalizeBaristaMenuTarget(getBaristaInventoryLabel(entry)),
      ];
      return entryTargets.includes(target);
    });
    const storeMatch = storeItems.find((entry) => normalizeBaristaMenuTarget(getStoreItemLabel(entry)) === target);

    if (!inventoryMatch && !storeMatch) {
      return item;
    }

    const nextName = storeMatch
      ? getTotLimit(storeMatch) > 0
        ? `${getStoreItemLabel(storeMatch)} (TOTS)`
        : getStoreItemLabel(storeMatch)
      : inventoryMatch
        ? getBaristaInventoryLabel(inventoryMatch)
        : item.name;
    const nextPrice =
      typeof inventoryMatch?.sellingPrice === "number" && inventoryMatch.sellingPrice > 0
        ? inventoryMatch.sellingPrice
        : typeof inventoryMatch?.price === "number" && inventoryMatch.price > 0
          ? inventoryMatch.price
          : item.price;
    const nextBarcode = inventoryMatch?.barcode || item.barcode;

    if (nextName === item.name && nextPrice === item.price && nextBarcode === item.barcode) {
      return item;
    }

    return {
      ...item,
      name: nextName,
      price: nextPrice,
      barcode: nextBarcode,
    };
  });

  const existingTargets = new Set(syncedItems.map((item) => normalizeBaristaMenuTarget(item.name)));
  const missingInventoryMenuItems = inventoryMenuItems.filter(
    (item) => !existingTargets.has(normalizeBaristaMenuTarget(item.name)),
  );

  return [...syncedItems, ...missingInventoryMenuItems];
}

type InventorySeedUpdate = {
  name: string;
  size: string;
  buyingPrice?: number;
  stock?: number;
  stockDelta?: number;
};

type StoredBookingRecord = {
  id: string;
  receiptNo?: string;
  guestName?: string;
  roomNumber?: string;
  checkInDate?: string;
  checkOutDate?: string;
  total?: number;
  ratePerNight?: number;
  paymentBreakdown?: Array<{ method: string; nights: number; amount: number }>;
};

function normalizeReceiptNumber(value: string | undefined) {
  const normalized = (value ?? "").trim();
  const match = normalized.match(/^#?0*(\d+)$/);
  return match ? `#${match[1]}` : normalized;
}

function isKaluseKiangiBookingTarget(booking: StoredBookingRecord) {
  const guestName = normalizeStockName(booking.guestName ?? "");
  const receiptNo = normalizeReceiptNumber(booking.receiptNo);
  const matchesGuest = guestName.includes("kaluse") && guestName.includes("kiangi");
  const matchesBookingDetails =
    booking.roomNumber === "4009" &&
    booking.checkInDate === "2026-05-15" &&
    booking.checkOutDate === "2026-05-16";

  return matchesBookingDetails && (receiptNo === "#405" || matchesGuest) && (booking.total === 100000 || booking.ratePerNight === 100000);
}

function correctKaluseKiangiBookings(bookings: StoredBookingRecord[]) {
  return bookings.map((booking) => {
    if (!isKaluseKiangiBookingTarget(booking)) return booking;

    return {
      ...booking,
      total: 70000,
      ratePerNight: booking.ratePerNight === 100000 ? 70000 : booking.ratePerNight,
      paymentBreakdown: booking.paymentBreakdown?.map((entry) => ({
        ...entry,
        amount: entry.amount === 100000 ? 70000 : entry.amount,
      })),
    };
  });
}

function correctMaySalesTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  if (date.getMonth() !== 4 || (date.getFullYear() !== 2025 && date.getFullYear() !== 2007)) return value;

  const correctedDate = new Date(value);
  correctedDate.setFullYear(2026);
  return correctedDate.getTime();
}

function correctKitchenMaySalesRecord<T extends { createdAt?: unknown }>(record: T): T {
  const correctedCreatedAt = correctMaySalesTimestamp(record.createdAt);
  if (correctedCreatedAt === record.createdAt) return record;
  return { ...record, createdAt: correctedCreatedAt };
}

function correctKitchenMaySalesRecords<T extends { createdAt?: unknown }>(records: T[]) {
  let changed = false;
  const nextRecords = records.map((record) => {
    const nextRecord = correctKitchenMaySalesRecord(record);
    if (nextRecord !== record) changed = true;
    return nextRecord;
  });

  return { records: nextRecords, changed };
}

function applyKitchenMaySalesYearCorrection() {
  if (localStorage.getItem(KITCHEN_MAY_SALES_YEAR_FIX_KEY)) return;

  const kitchenSnapshot = readPosState<{ createdAt?: unknown }, { createdAt?: unknown }, unknown>(
    STORAGE_KITCHEN_STATE,
    "orange-hotel-kitchen-tickets",
    "orange-hotel-kitchen-seq",
    "orange-hotel-kitchen-payments",
    "orange-hotel-kitchen-menu",
    300,
  );
  const nextTickets = correctKitchenMaySalesRecords(kitchenSnapshot.tickets);
  const nextPayments = correctKitchenMaySalesRecords(kitchenSnapshot.payments);

  if (nextTickets.changed || nextPayments.changed) {
    writePosState(
      STORAGE_KITCHEN_STATE,
      nextTickets.records,
      kitchenSnapshot.ticketSeq,
      nextPayments.records,
      kitchenSnapshot.menuItems,
    );
  }

  const legacyTickets = readJson<Array<{ createdAt?: unknown }>>("orange-hotel-kitchen-tickets") ?? [];
  const nextLegacyTickets = correctKitchenMaySalesRecords(legacyTickets);
  if (nextLegacyTickets.changed) {
    writeJson("orange-hotel-kitchen-tickets", nextLegacyTickets.records);
  }

  const legacyPayments = readJson<Array<{ createdAt?: unknown }>>("orange-hotel-kitchen-payments") ?? [];
  const nextLegacyPayments = correctKitchenMaySalesRecords(legacyPayments);
  if (nextLegacyPayments.changed) {
    writeJson("orange-hotel-kitchen-payments", nextLegacyPayments.records);
  }

  localStorage.setItem(KITCHEN_MAY_SALES_YEAR_FIX_KEY, "1");
}

const BARISTA_PRICE_UPDATES: InventorySeedUpdate[] = [
  { name: "Classic Dompo", size: "750ml", buyingPrice: 11000, stockDelta: 3 },
  { name: "Kilimanjaro Water", size: "1L", buyingPrice: 833 },
  { name: "Kilimanjaro Water", size: "500ml", buyingPrice: 375 },
  { name: "Serengeti Lager", size: "330ml", buyingPrice: 1600 },
  { name: "Castle Lite", size: "330ml", buyingPrice: 1650 },
  { name: "Safari Lager", size: "330ml", buyingPrice: 1650 },
  { name: "Kilimanjaro Premium Lager", size: "375ml", buyingPrice: 1650 },
  { name: "Konyagi", size: "750ml", buyingPrice: 10333, stock: 6 },
  { name: "Apothic Red", size: "750ml", stockDelta: 2 },
  { name: "J & B", size: "200ml", stockDelta: 1 },
  { name: "Brutal Fruit", size: "275ml", stock: 16 },
];

type AdditionalBaristaItem = Partial<InventoryItem> & {
  name: string;
  category: string;
  size: string;
  stock: number;
  buyingPrice: number;
  sellingPrice: number;
  minStock: number;
  unit: string;
};

const BARISTA_ADDITIONAL_ITEMS: AdditionalBaristaItem[] = [
  { barcode: "6200100630063", name: "Bacardi Superior White Rum (TOTS)", category: "Spirit", size: "750ml", stock: 1, totPerBottle: 30, buyingPrice: 45000, sellingPrice: 8000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
  { barcode: "6200100640064", name: "Camino Real Blanco (TOTS)", category: "Spirit", size: "750ml", stock: 1, totPerBottle: 30, buyingPrice: 42000, sellingPrice: 8000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
  { barcode: "6200100650065", name: "Captain Morgan Black Rum (TOTS)", category: "Spirit", size: "750ml", stock: 1, totPerBottle: 30, buyingPrice: 30000, sellingPrice: 5000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
  { barcode: "6200100660066", name: "Buttlers Blue Curacao (TOTS)", category: "Liqueur", size: "750ml", stock: 1, totPerBottle: 30, buyingPrice: 35000, sellingPrice: 5000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
  { barcode: "6200100670067", name: "Hennessy VSOP Box", category: "Cognac", size: "700ml", stock: 1, buyingPrice: 160000, sellingPrice: 250000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
  { barcode: "6200100680068", name: "Jack Daniels", category: "Whisky", size: "700ml", stock: 1, totPerBottle: 30, buyingPrice: 70000, sellingPrice: 10000, minStock: 1, unit: "Bottle", totSold: 0, status: "ACTIVE" },
] as const;

const SODA_MERGE_GROUPS = [
  {
    size: "350ml",
    names: ["Coca Cola Soda", "Fanta Soda"],
    barcode: "6200100540054",
    minStock: 5,
    buyingPrice: 604,
    sellingPrice: 2000,
    unit: "Bottle",
  },
  {
    size: "300ml",
    names: ["Krest Bitter Lemon", "Krest Tonic Water", "Krest Soda Water", "Stoney Soda", "Krest Ginger"],
    barcode: "6200100560056",
    minStock: 5,
    buyingPrice: 604,
    sellingPrice: 2000,
    unit: "Bottle",
  },
] as const;

function hasExistingSharedBusinessData() {
  const kitchenSnapshot = readPosState<unknown, unknown, unknown>(
    STORAGE_KITCHEN_STATE,
    "orange-hotel-kitchen-tickets",
    "orange-hotel-kitchen-seq",
    "orange-hotel-kitchen-payments",
    "orange-hotel-kitchen-menu",
    300,
  );
  const baristaSnapshot = readPosState<unknown, unknown, unknown>(
    STORAGE_BARISTA_STATE,
    "orange-hotel-barista-orders",
    "orange-hotel-barista-seq",
    "orange-hotel-barista-payments",
    "orange-hotel-barista-menu",
    490,
  );
  const cashierSnapshot = readJson<{ transactions?: unknown[] }>("orange-hotel-cashier-state");
  const inventoryItems = readJson<unknown[]>("orange-hotel-inventory-items") ?? [];
  const storeItems = readJson<unknown[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];

  return (
    (Array.isArray(cashierSnapshot?.transactions) && cashierSnapshot.transactions.length > 0) ||
    kitchenSnapshot.tickets.length > 0 ||
    kitchenSnapshot.payments.length > 0 ||
    baristaSnapshot.tickets.length > 0 ||
    baristaSnapshot.payments.length > 0 ||
    inventoryItems.length > 0 ||
    storeItems.length > 0
  );
}

function markLocalBusinessCorrectionsApplied() {
  LOCAL_BUSINESS_CORRECTION_KEYS.forEach((key) => localStorage.setItem(key, "1"));
}

function applyBusinessCorrections() {
  if (typeof window === "undefined") return;

  applyKitchenMaySalesYearCorrection();

  if (hasExistingSharedBusinessData()) {
    markLocalBusinessCorrectionsApplied();
    return;
  }

  if (!localStorage.getItem(KALUSE_KIANGI_BOOKING_FIX_KEY)) {
    const cashierSnapshot = readJson<{ transactions?: StoredBookingRecord[]; receiptSeq?: number }>("orange-hotel-cashier-state");
    if (cashierSnapshot && Array.isArray(cashierSnapshot.transactions)) {
      const nextTransactions = correctKaluseKiangiBookings(cashierSnapshot.transactions);

      if (JSON.stringify(nextTransactions) !== JSON.stringify(cashierSnapshot.transactions)) {
        writeJson("orange-hotel-cashier-state", {
          ...cashierSnapshot,
          transactions: nextTransactions,
        });
      }
    }

    const legacyTransactions = readJson<StoredBookingRecord[]>("orange-hotel-cashier-transactions") ?? [];
    const nextLegacyTransactions = correctKaluseKiangiBookings(legacyTransactions);
    if (JSON.stringify(nextLegacyTransactions) !== JSON.stringify(legacyTransactions)) {
      writeJson("orange-hotel-cashier-transactions", nextLegacyTransactions);
    }

    localStorage.setItem(KALUSE_KIANGI_BOOKING_FIX_KEY, "1");
  }

  if (!localStorage.getItem(KITCHEN_TRANSACTIONS_RESET_KEY)) {
    const kitchenSnapshot = readPosState<unknown, unknown, unknown>(
      STORAGE_KITCHEN_STATE,
      "orange-hotel-kitchen-tickets",
      "orange-hotel-kitchen-seq",
      "orange-hotel-kitchen-payments",
      "orange-hotel-kitchen-menu",
      300,
    );
    const cleanedKitchenMenu = mergeKitchenMenuItems(kitchenSnapshot.menuItems as Parameters<typeof mergeKitchenMenuItems>[0], {
      stripDefaultMenu: true,
    });
    writePosState(STORAGE_KITCHEN_STATE, [], kitchenSnapshot.ticketSeq, [], cleanedKitchenMenu);
    localStorage.setItem(KITCHEN_TRANSACTIONS_RESET_KEY, "1");
  }

  if (!localStorage.getItem(KITCHEN_MENU_PRICE_FIX_KEY)) {
    const kitchenSnapshot = readPosState<unknown, unknown, unknown>(
      STORAGE_KITCHEN_STATE,
      "orange-hotel-kitchen-tickets",
      "orange-hotel-kitchen-seq",
      "orange-hotel-kitchen-payments",
      "orange-hotel-kitchen-menu",
      300,
    );
    writePosState(
      STORAGE_KITCHEN_STATE,
      kitchenSnapshot.tickets,
      kitchenSnapshot.ticketSeq,
      kitchenSnapshot.payments,
      DEFAULT_KITCHEN_MENU,
    );
    localStorage.setItem(KITCHEN_MENU_PRICE_FIX_KEY, "1");
  }

  if (!localStorage.getItem(DOMPO_STOCK_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];

    if (inventoryItems.length > 0) {
      const dompoIndex = inventoryItems.findIndex(
        (item) => item.name === "Classic Dompo" && item.size === "750ml",
      );

      const nextInventoryItems = [...inventoryItems];
      if (dompoIndex >= 0) {
        nextInventoryItems[dompoIndex] = {
          ...nextInventoryItems[dompoIndex],
          stock: 3,
          minStock: Math.max(nextInventoryItems[dompoIndex].minStock ?? 0, 1),
          unit: nextInventoryItems[dompoIndex].unit || "Bottle",
        };
      }

      writeJson("orange-hotel-inventory-items", nextInventoryItems);
    }

    localStorage.setItem(DOMPO_STOCK_FIX_KEY, "1");
  }

  if (!localStorage.getItem(BARISTA_STOCK_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];

    if (inventoryItems.length > 0) {
      const seedTargets = BARISTA_INVENTORY_SEED.filter((item) => {
        const key = `${item.name}|${item.size ?? ""}`;
        return key in BARISTA_STOCK_TARGETS;
      });

      const nextInventoryItems = [...inventoryItems];
      seedTargets.forEach((seedItem) => {
        const key = `${seedItem.name}|${seedItem.size ?? ""}` as keyof typeof BARISTA_STOCK_TARGETS;
        const targetStock = BARISTA_STOCK_TARGETS[key];
        const existingIndex = nextInventoryItems.findIndex(
          (item) => normalizeStockName(item.name) === normalizeStockName(seedItem.name ?? "") &&
            normalizeStockName(item.size ?? "") === normalizeStockName(seedItem.size ?? ""),
        );

        if (existingIndex >= 0) {
          nextInventoryItems[existingIndex] = {
            ...nextInventoryItems[existingIndex],
            stock: targetStock,
            sellingPrice:
              typeof seedItem.sellingPrice === "number" && seedItem.sellingPrice > 0
                ? seedItem.sellingPrice
                : nextInventoryItems[existingIndex].sellingPrice,
            price:
              typeof seedItem.sellingPrice === "number" && seedItem.sellingPrice > 0
                ? seedItem.sellingPrice
                : nextInventoryItems[existingIndex].price,
          };
          return;
        }

      });

      writeJson("orange-hotel-inventory-items", nextInventoryItems);
    }

    if (storeItems.length > 0 || inventoryItems.length > 0) {
      const otherStoreItems = storeItems.filter((item) => item.lane !== "barista");
      const baristaStoreItems = storeItems.filter((item) => item.lane === "barista");
      const seedTargets = BARISTA_INVENTORY_SEED.filter((item) => {
        const key = `${item.name}|${item.size ?? ""}`;
        return key in BARISTA_STOCK_TARGETS;
      });

      const nextBaristaStoreItems = [...baristaStoreItems];
      seedTargets.forEach((seedItem) => {
        const key = `${seedItem.name}|${seedItem.size ?? ""}` as keyof typeof BARISTA_STOCK_TARGETS;
        const targetStock = BARISTA_STOCK_TARGETS[key];
        const existingIndex = nextBaristaStoreItems.findIndex(
          (item) =>
            normalizeStockName(item.name) === normalizeStockName(seedItem.name ?? "") &&
            normalizeStockName(item.size ?? "") === normalizeStockName(seedItem.size ?? ""),
        );

        const nextStoreRecord: MainStoreItem = {
          id: existingIndex >= 0 ? nextBaristaStoreItems[existingIndex].id : `s-fix-${seedItem.barcode || `${seedItem.name}-${seedItem.size}`}`,
          name: seedItem.name || "",
          subCategory: seedItem.category || "Bar",
          size: seedItem.size || "",
          stock: targetStock,
          unit: seedItem.unit || "Bottle",
          minStock: seedItem.minStock || 0,
          lane: "barista",
          buyingPrice: seedItem.buyingPrice || 0,
          sellingPrice: seedItem.sellingPrice || 0,
        };

        if (existingIndex >= 0) {
          nextBaristaStoreItems[existingIndex] = {
            ...nextBaristaStoreItems[existingIndex],
            ...nextStoreRecord,
          };
        }
      });

      writeJson(STORAGE_MAIN_STORE_ITEMS, [...otherStoreItems, ...nextBaristaStoreItems]);
    }

    localStorage.setItem(BARISTA_STOCK_FIX_KEY, "1");
  }

  if (!localStorage.getItem(BARISTA_INVENTORY_CORRECTION_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];

    let inventoryChanged = false;
    let storeChanged = false;

    const nextInventoryItems = [...inventoryItems];
    const nextStoreItems = [...storeItems];

    const removedTargets = REMOVED_BARISTA_ITEMS.map((item) => ({
      name: normalizeStockName(item.name),
      size: normalizeStockName(item.size),
    }));

    const filteredInventoryItems = nextInventoryItems.filter((item) => {
      const normalizedName = normalizeStockName(item.name);
      const normalizedSize = normalizeStockName(item.size ?? "");
      return !removedTargets.some((target) => target.name === normalizedName && target.size === normalizedSize);
    });
    if (filteredInventoryItems.length !== nextInventoryItems.length) {
      nextInventoryItems.splice(0, nextInventoryItems.length, ...filteredInventoryItems);
      inventoryChanged = true;
    }

    const filteredStoreItems = nextStoreItems.filter((item) => {
      const normalizedName = normalizeStockName(item.name);
      const normalizedSize = normalizeStockName(item.size ?? "");
      return !removedTargets.some((target) => target.name === normalizedName && target.size === normalizedSize);
    });
    if (filteredStoreItems.length !== nextStoreItems.length) {
      nextStoreItems.splice(0, nextStoreItems.length, ...filteredStoreItems);
      storeChanged = true;
    }

    for (const update of BARISTA_PRICE_UPDATES) {
      const inventoryIndex = nextInventoryItems.findIndex(
        (item) =>
          normalizeStockName(item.name) === normalizeStockName(update.name) &&
          normalizeStockName(item.size ?? "") === normalizeStockName(update.size),
      );
      if (inventoryIndex >= 0) {
        const current = nextInventoryItems[inventoryIndex];
        nextInventoryItems[inventoryIndex] = {
          ...current,
          buyingPrice: typeof update.buyingPrice === "number" ? update.buyingPrice : current.buyingPrice,
          stock:
            typeof update.stock === "number"
              ? update.stock
              : typeof update.stockDelta === "number"
                ? current.stock + update.stockDelta
                : current.stock,
        };
        inventoryChanged = true;
      }

      const storeIndex = nextStoreItems.findIndex(
        (item) =>
          item.lane === "barista" &&
          normalizeStockName(item.name) === normalizeStockName(update.name) &&
          normalizeStockName(item.size ?? "") === normalizeStockName(update.size),
      );
      if (storeIndex >= 0) {
        const current = nextStoreItems[storeIndex];
        nextStoreItems[storeIndex] = {
          ...current,
          buyingPrice: typeof update.buyingPrice === "number" ? update.buyingPrice : current.buyingPrice,
          stock:
            typeof update.stock === "number"
              ? update.stock
              : typeof update.stockDelta === "number"
                ? current.stock + update.stockDelta
                : current.stock,
        };
        storeChanged = true;
      }
    }

    for (const item of BARISTA_ADDITIONAL_ITEMS) {
      const inventoryIndex = nextInventoryItems.findIndex(
        (entry) =>
          normalizeStockName(entry.name) === normalizeStockName(item.name) &&
          normalizeStockName(entry.size ?? "") === normalizeStockName(item.size ?? ""),
      );

      if (inventoryIndex >= 0) {
        const current = nextInventoryItems[inventoryIndex];
        nextInventoryItems[inventoryIndex] = {
          ...current,
          barcode: item.barcode ?? current.barcode,
          category: item.category,
          subCategory: item.category,
          stock: item.stock,
          buyingPrice: item.buyingPrice,
          sellingPrice: item.sellingPrice,
          price: item.sellingPrice,
          totPerBottle: item.totPerBottle,
          totSold: item.totSold ?? current.totSold ?? 0,
          minStock: item.minStock,
          unit: item.unit,
          status: item.status ?? current.status,
        };
        inventoryChanged = true;
      }

      const storeIndex = nextStoreItems.findIndex(
        (entry) =>
          entry.lane === "barista" &&
          normalizeStockName(entry.name) === normalizeStockName(item.name) &&
          normalizeStockName(entry.size ?? "") === normalizeStockName(item.size ?? ""),
      );

      if (storeIndex >= 0) {
        nextStoreItems[storeIndex] = {
          ...nextStoreItems[storeIndex],
          name: item.name,
          subCategory: item.category,
          size: item.size,
          stock: item.stock,
          buyingPrice: item.buyingPrice,
          sellingPrice: item.sellingPrice,
          minStock: item.minStock,
          unit: item.unit,
          lane: "barista",
          totLimit: item.totPerBottle,
          totSold: item.totSold ?? nextStoreItems[storeIndex].totSold ?? 0,
        };
        storeChanged = true;
      }
    }

    SODA_MERGE_GROUPS.forEach((group) => {
      const inventoryMatches = nextInventoryItems.filter(
        (item) =>
          normalizeStockName(item.size ?? "") === normalizeStockName(group.size) &&
          (group.names.some((name) => normalizeStockName(item.name) === normalizeStockName(name)) ||
            normalizeStockName(item.name) === "soda"),
      );
      if (inventoryMatches.length > 0) {
        const baseItem = inventoryMatches[0];
        const removeIds = new Set(inventoryMatches.map((item) => item.id));
        const mergedStock = inventoryMatches.reduce((sum, item) => sum + (item.stock || 0), 0);
        const mergedMinStock = Math.max(group.minStock, ...inventoryMatches.map((item) => item.minStock || 0));
        const mergedInventoryItem: InventoryItem = {
          ...baseItem,
          barcode: group.barcode,
          name: "Soda",
          category: "Bar",
          subCategory: "Soda",
          size: group.size,
          stock: mergedStock,
          buyingPrice: group.buyingPrice,
          sellingPrice: group.sellingPrice,
          price: group.sellingPrice,
          minStock: mergedMinStock,
          unit: group.unit,
        };
        const filteredInventoryItems = nextInventoryItems.filter((item) => !removeIds.has(item.id));
        filteredInventoryItems.push(mergedInventoryItem);
        nextInventoryItems.splice(0, nextInventoryItems.length, ...filteredInventoryItems);
        inventoryChanged = true;
      }

      const storeMatches = nextStoreItems.filter(
        (item) =>
          item.lane === "barista" &&
          normalizeStockName(item.size ?? "") === normalizeStockName(group.size) &&
          (group.names.some((name) => normalizeStockName(item.name) === normalizeStockName(name)) ||
            normalizeStockName(item.name) === "soda"),
      );
      if (storeMatches.length > 0) {
        const baseItem = storeMatches[0];
        const removeIds = new Set(storeMatches.map((item) => item.id));
        const mergedStock = storeMatches.reduce((sum, item) => sum + (item.stock || 0), 0);
        const mergedMinStock = Math.max(group.minStock, ...storeMatches.map((item) => item.minStock || 0));
        const mergedStoreItem: MainStoreItem = {
          ...baseItem,
          name: "Soda",
          subCategory: "Soda",
          size: group.size,
          stock: mergedStock,
          buyingPrice: group.buyingPrice,
          sellingPrice: group.sellingPrice,
          minStock: mergedMinStock,
          unit: group.unit,
          lane: "barista",
        };
        const filteredStoreItems = nextStoreItems.filter((item) => !removeIds.has(item.id));
        filteredStoreItems.push(mergedStoreItem);
        nextStoreItems.splice(0, nextStoreItems.length, ...filteredStoreItems);
        storeChanged = true;
      }
    });

    if (inventoryChanged) {
      writeJson("orange-hotel-inventory-items", nextInventoryItems);
    }

    if (storeChanged) {
      writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
    }

    localStorage.setItem(BARISTA_INVENTORY_CORRECTION_FIX_KEY, "1");
  }

  if (!localStorage.getItem(BARISTA_FINANCE_PRICE_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];

    if (inventoryItems.length > 0 && storeItems.length > 0) {
      let hasChanges = false;
      const nextStoreItems = storeItems.map((item) => {
        if (item.lane !== "barista" || (typeof item.sellingPrice === "number" && item.sellingPrice > 0)) {
          return item;
        }

        const sellingPrice = resolveBarInventorySellingPrice(inventoryItems, item);
        if (sellingPrice <= 0) {
          return item;
        }

        hasChanges = true;
        return {
          ...item,
          sellingPrice,
        };
      });

      if (hasChanges) {
        writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
      }
    }

    localStorage.setItem(BARISTA_FINANCE_PRICE_FIX_KEY, "1");
  }

  if (!localStorage.getItem(BARISTA_SHARED_STATE_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
    const storeItems = (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []).filter((item) => item.lane === "barista");
    const baristaSnapshot = readPosState<{ id: string }, { id: string }, { id: string; name: string; price: number; category: string; prepMinutes: number; barcode?: string }>(
      STORAGE_BARISTA_STATE,
      "orange-hotel-barista-orders",
      "orange-hotel-barista-seq",
      "orange-hotel-barista-payments",
      "orange-hotel-barista-menu",
      490,
    );

    if (inventoryItems.length > 0 && storeItems.length > 0 && baristaSnapshot.menuItems.length > 0) {
      const nextMenuItems = syncBaristaMenuItemsWithSharedData(baristaSnapshot.menuItems, inventoryItems, storeItems);

      if (JSON.stringify(nextMenuItems) !== JSON.stringify(baristaSnapshot.menuItems)) {
        writePosState(STORAGE_BARISTA_STATE, baristaSnapshot.tickets, baristaSnapshot.ticketSeq, baristaSnapshot.payments, nextMenuItems);
      }
    }

    localStorage.setItem(BARISTA_SHARED_STATE_FIX_KEY, "1");
  }

  if (!localStorage.getItem(BARISTA_MENU_REMOVAL_FIX_KEY)) {
    const baristaSnapshot = readPosState<{ id: string }, { id: string }, { id: string; name: string; price: number; category: string; prepMinutes: number; barcode?: string }>(
      STORAGE_BARISTA_STATE,
      "orange-hotel-barista-orders",
      "orange-hotel-barista-seq",
      "orange-hotel-barista-payments",
      "orange-hotel-barista-menu",
      490,
    );

    const nextMenuItems = syncBaristaMenuItemsWithSharedData(
      baristaSnapshot.menuItems,
      readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [],
      (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []).filter((item) => item.lane === "barista"),
    );

    if (JSON.stringify(nextMenuItems) !== JSON.stringify(baristaSnapshot.menuItems)) {
      writePosState(
        STORAGE_BARISTA_STATE,
        baristaSnapshot.tickets,
        baristaSnapshot.ticketSeq,
        baristaSnapshot.payments,
        nextMenuItems,
      );
    }

    localStorage.setItem(BARISTA_MENU_REMOVAL_FIX_KEY, "1");
  }

  if (!localStorage.getItem(JACK_DANIELS_TOTS_PRICE_FIX_KEY)) {
    const inventoryItems = readJson<InventoryItem[]>("orange-hotel-inventory-items") ?? [];
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const baristaSnapshot = readPosState<{ id: string }, { id: string }, { id: string; name: string; price: number; category: string; prepMinutes: number; barcode?: string }>(
      STORAGE_BARISTA_STATE,
      "orange-hotel-barista-orders",
      "orange-hotel-barista-seq",
      "orange-hotel-barista-payments",
      "orange-hotel-barista-menu",
      490,
    );

    const nextInventoryItems = inventoryItems.map((item) => {
      if (!isJackDaniels700Target(item.name, item.size)) return item;
      return {
        ...item,
        name: "Jack Daniels TOTS",
        category: "Bar",
        subCategory: "Whisky",
        size: "700ml",
        buyingPrice: 70000,
        sellingPrice: 10000,
        price: 10000,
        totPerBottle: 30,
        totSold: item.totSold ?? 0,
        unit: item.unit || "Bottle",
        minStock: item.minStock ?? 1,
        status: item.status ?? "ACTIVE",
      };
    });

    const nextStoreItems = storeItems.map((item) => {
      if (item.lane !== "barista" || !isJackDaniels700Target(item.name, item.size)) return item;
      return {
        ...item,
        name: "Jack Daniels",
        subCategory: "Whisky",
        size: "700ml",
        buyingPrice: 70000,
        sellingPrice: 10000,
        totLimit: 30,
        totSold: item.totSold ?? 0,
        unit: item.unit || "Bottle",
        minStock: item.minStock ?? 1,
      };
    });

    const nextMenuItems = baristaSnapshot.menuItems.map((item) => {
      if (!isJackDaniels700Target(item.name, "700ml")) return item;
      return {
        ...item,
        name: "Jack Daniels 700ml (TOTS)",
        price: 10000,
        category: item.category || "Whisky",
        barcode: item.barcode || "6200100270027",
      };
    });

    if (JSON.stringify(nextInventoryItems) !== JSON.stringify(inventoryItems)) {
      writeJson("orange-hotel-inventory-items", nextInventoryItems);
    }

    if (JSON.stringify(nextStoreItems) !== JSON.stringify(storeItems)) {
      writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
    }

    if (JSON.stringify(nextMenuItems) !== JSON.stringify(baristaSnapshot.menuItems)) {
      writePosState(
        STORAGE_BARISTA_STATE,
        baristaSnapshot.tickets,
        baristaSnapshot.ticketSeq,
        baristaSnapshot.payments,
        nextMenuItems,
      );
    }

    localStorage.setItem(JACK_DANIELS_TOTS_PRICE_FIX_KEY, "1");
  }

  if (!localStorage.getItem(STAFF_FOOD_DISHES_EXPENSE_REMOVAL_KEY)) {
    const expenses = readJson<ExpenseRecord[]>(STORAGE_EXPENSES) ?? [];
    const kitchenPurchaseHistory = readJson<KitchenPurchaseHistoryEntry[]>(STORAGE_KITCHEN_PURCHASE_HISTORY) ?? [];
    const nextExpenses = expenses.filter((expense) => !isStaffFoodDishesExpense(expense));
    const nextKitchenPurchaseHistory = kitchenPurchaseHistory.filter((entry) => !isStaffFoodDishesPurchaseHistory(entry));

    if (nextExpenses.length !== expenses.length) {
      writeJson(STORAGE_EXPENSES, nextExpenses);
    }

    if (nextKitchenPurchaseHistory.length !== kitchenPurchaseHistory.length) {
      writeJson(STORAGE_KITCHEN_PURCHASE_HISTORY, nextKitchenPurchaseHistory);
    }

    localStorage.setItem(STAFF_FOOD_DISHES_EXPENSE_REMOVAL_KEY, "1");
  }

  localStorage.setItem(COMPANY_STOCK_SHEET_FIX_KEY, "1");
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [role, setRole] = useState<Role>('manager');
  const [shift, setShift] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeUsername, setActiveUsername] = useState("");
  const [usernameDialogOpen, setUsernameDialogOpen] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameFeedback, setUsernameFeedback] = useState<string | null>(null);
  const [currentHotelView, setCurrentHotelView] = useState<"standard" | "platinum">("standard");

  const allowedByRole: Record<Role, string[]> = {
    manager: ['/dashboard', '/dashboard/rooms', '/dashboard/inventory', '/dashboard/inventory/kitchen-stock', '/dashboard/inventory/barista-stock', '/dashboard/menu-create', '/dashboard/company-stock', '/dashboard/cashier', '/dashboard/laundry', '/dashboard/expenses', '/dashboard/finances', '/dashboard/payments', '/dashboard/kitchen', '/dashboard/cancelled', '/dashboard/barista', '/dashboard/staff', '/dashboard/settings', '/dashboard/settings/sync', '/dashboard/settings/password'],
    director: ['/dashboard', '/dashboard/rooms', '/dashboard/company-stock', '/dashboard/cashier', '/dashboard/laundry', '/dashboard/expenses', '/dashboard/finances', '/dashboard/payments', '/dashboard/kitchen', '/dashboard/barista', '/dashboard/staff', '/dashboard/analytics', '/dashboard/settings', '/dashboard/settings/sync', '/dashboard/settings/password'],
    inventory: ['/dashboard/inventory', '/dashboard/inventory/kitchen-stock', '/dashboard/company-stock', '/dashboard/settings/password'],
    cashier: ['/dashboard/cashier', '/dashboard/laundry', '/dashboard/cash-requests', '/dashboard/website-bookings', '/dashboard/live-chat', '/dashboard/payments', '/dashboard/rooms', '/dashboard/settings/password'],
    kitchen: ['/dashboard/fnb-pos', '/dashboard/kitchen', '/dashboard/cancelled', '/dashboard/payments', '/dashboard/settings/password'],
    barista: ['/dashboard/fnb-pos', '/dashboard/barista', '/dashboard/payments', '/dashboard/cancelled', '/dashboard/settings/password'],
    standard: [],
    platinum: [],
  };

  const defaultByRole: Record<Role, string> = {
    manager: '/dashboard',
    director: '/dashboard',
    inventory: '/dashboard/inventory',
    cashier: '/dashboard/cashier',
    kitchen: '/dashboard/kitchen',
    barista: '/dashboard/barista',
    standard: '/standard',
    platinum: '/platinum',
  };

  useEffect(() => {
    let cancelled = false;

    async function initializeDashboard() {
      const savedRole = normalizeRole(localStorage.getItem('orange-hotel-role'));
      const savedShift = localStorage.getItem('orange-hotel-shift');
      const activeHotelScope = getLocalMawioTier();

      if (!savedRole || !VALID_ROLES.includes(savedRole)) {
        localStorage.removeItem('orange-hotel-role');
        localStorage.removeItem('orange-hotel-shift');
        localStorage.removeItem(STORAGE_MANAGER_SESSION_VERSION);
        localStorage.removeItem('orange-hotel-active-login-scope');
        localStorage.removeItem('mawio-tier');
        router.replace('/');
        return;
      }

      if (savedRole === "manager" && localStorage.getItem(STORAGE_MANAGER_SESSION_VERSION) !== MANAGER_SESSION_VERSION) {
        localStorage.removeItem("orange-hotel-role");
        localStorage.removeItem("orange-hotel-shift");
        localStorage.removeItem("orange-hotel-username");
        localStorage.removeItem(STORAGE_MANAGER_SESSION_VERSION);
        localStorage.removeItem('orange-hotel-active-login-scope');
        localStorage.removeItem('mawio-tier');
        router.replace("/MANAGER");
        return;
      }

      localStorage.setItem("orange-hotel-role", savedRole);
      localStorage.setItem("orange-hotel-active-login-scope", activeHotelScope);
      localStorage.setItem("mawio-tier", activeHotelScope === "platinum" ? "platinum" : "standard");
      setCurrentHotelView(activeHotelScope === "platinum" ? "platinum" : "standard");
      setActiveUsername(readActiveSessionUsername(savedRole, activeHotelScope === "platinum" ? "platinum" : "standard"));
      setRole(savedRole);
      if (savedShift) setShift(savedShift);

      if (typeof window !== "undefined") {
        setSidebarOpen(window.innerWidth >= 768);
      }
      setMounted(true);

      try {
        await hydrateStartupStateForRole(savedRole);
        if (cancelled) return;
        if (activeHotelScope === "platinum") {
          // The premium hotel gets its own clean slate; the correction pass
          // below patches STANDARD-hotel history and must never run against
          // the platinum node.
          await runOneTimePremiumSalesCleanSlate();
          applyPremiumBaristaPriceCorrections();
        } else {
          applyBusinessCorrections();
        }
      } catch (error) {
        console.error("Dashboard hydration failed", error);
      }
    }

    void initializeDashboard();

    return () => {
      cancelled = true;
    };
  }, [router]);

  // Keep the resolved hotel tier pinned in the URL of EVERY dashboard route.
  // Sidebar links are static and drop the `?tier=` param on client navigation,
  // so without this a reload/shared link could fall back to the browser-wide
  // login scope (which the other hotel can overwrite) and render the wrong
  // hotel's data. Re-pinning here — in the layout that wraps all dashboards —
  // fixes every dashboard from one place. getLocalMawioTier() reads the per-tab
  // sessionStorage pin, so the value is always this tab's hotel.
  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    const tier = getLocalMawioTier();
    const params = new URLSearchParams(window.location.search);
    if (params.get("tier") === tier) return;
    params.set("tier", tier);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, [mounted, pathname]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 768) {
        setSidebarOpen(true);
      } else {
        setSidebarOpen(false);
      }
    };

    const onSidebarClose = () => setSidebarOpen(false);

    window.addEventListener("resize", onResize);
    window.addEventListener("orange-hotel-sidebar-close", onSidebarClose as EventListener);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orange-hotel-sidebar-close", onSidebarClose as EventListener);
    };
  }, []);

  const saveUsername = async () => {
    const nextUsername = usernameDraft.trim();
    const previousUsername = activeUsername.trim();
    if (!nextUsername || !previousUsername) return;

    setUsernameSaving(true);
    setUsernameFeedback(null);
    try {
      const profiles = readLocalLoginProfiles() ?? {};
      const currentProfile = profiles[role] ?? {
        username: previousUsername,
        updatedAt: Date.now(),
        users: [],
      };
      const nextProfile = renameProfileUser(currentProfile, previousUsername, nextUsername);
      const saved = await saveLoginProfileToServer(role, nextProfile);
      if (!saved) {
        setUsernameFeedback("Username was not saved to the backend. No local change was applied.");
        return;
      }

      writeActiveSessionUsername(nextUsername);
      setActiveUsername(nextUsername);
      setUsernameDialogOpen(false);
    } finally {
      setUsernameSaving(false);
    }
  };

  useEffect(() => {
    if (!mounted) return;

    const allowedRoutes = allowedByRole[role];
    if (!allowedRoutes.includes(pathname)) {
      router.replace(defaultByRole[role]);
    }
  }, [mounted, pathname, role, router]);

  const isDirector = role === "director";

  useEffect(() => {
    if (typeof window === "undefined" || !isDirector) return;

    const handleHotelViewChanged = (event: CustomEvent) => {
      const hotel = event.detail?.hotel;
      if (hotel === "standard" || hotel === "platinum") {
        window.location.reload();
      }
    };

    window.addEventListener("hotel-view-changed", handleHotelViewChanged as EventListener);
    return () => window.removeEventListener("hotel-view-changed", handleHotelViewChanged as EventListener);
  }, [isDirector]);
  const directorCurrentLabel =
    DIRECTOR_MOBILE_NAV.find((item) => item.href === pathname)?.label ??
    (pathname.includes("/inventory") ? "Stock" : pathname.includes("/settings") ? "Settings" : "Dashboard");

  if (!mounted) return null;

  return (
    <div className={cn("flex h-[100dvh] w-full overflow-hidden bg-background", currentHotelView === "platinum" ? "tier-platinum" : "tier-standard", isDirector && "bg-[#f4f7f2] md:bg-background")}>
      <aside
        className={cn(
          "fixed left-0 top-0 z-50 h-[100dvh] w-64 transition-transform duration-300",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarNav role={role} />
      </aside>
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
        />
      )}
      
      <div className={cn("flex h-[100dvh] min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-300", sidebarOpen ? "md:ml-64" : "md:ml-0")}>
        <header
          className={cn(
            "h-16 shrink-0 bg-white border-b sticky top-0 z-30 flex items-center justify-between px-8 shadow-sm",
            isDirector && "h-auto min-h-[calc(68px+env(safe-area-inset-top))] border-0 bg-[#0f1712] px-4 pt-[env(safe-area-inset-top)] text-white shadow-lg shadow-black/10 md:h-16 md:min-h-[4rem] md:border-b md:bg-white md:px-8 md:pt-0 md:text-foreground md:shadow-sm",
          )}
        >
          <div className={cn("flex items-center gap-4 w-full md:w-1/3", isDirector && "w-auto min-w-0")}>
            <button
              type="button"
              onClick={() => setSidebarOpen((current) => !current)}
              aria-label="Toggle sidebar"
              className={cn(
                "h-9 w-9 rounded-md border border-input flex items-center justify-center hover:bg-muted transition-colors",
                isDirector && "shrink-0 border-white/15 bg-white/10 hover:bg-white/15 md:border-input md:bg-transparent md:hover:bg-muted",
              )}
            >
              <Menu className="w-4 h-4" />
            </button>
            {isDirector && (
              <div className="min-w-0 text-left md:hidden">
                <p className="truncate text-[10px] font-black uppercase tracking-[0.22em] text-emerald-200/80">Orange MD</p>
                <p className="truncate text-sm font-black uppercase tracking-tight">{directorCurrentLabel}</p>
              </div>
            )}
            <div className={cn("relative w-full max-w-sm", isDirector && "hidden md:block")}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search resources..." 
                className="pl-10 h-9 bg-muted/50 border-none focus-visible:ring-primary text-sm" 
              />
            </div>
          </div>

          <div className={cn("flex items-center gap-6", isDirector && "gap-2 md:gap-6")}>
            {shift && (
              <Badge variant="outline" className="text-[10px] font-black uppercase tracking-widest border-primary text-primary px-2">
                <Clock className="w-3 h-3 mr-1" /> {shift}
              </Badge>
            )}
            {isDirector ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextHotel: "standard" | "platinum" = currentHotelView === "standard" ? "platinum" : "standard";
                    if (typeof window !== "undefined") {
                      // Rebind the per-tab tier lock, then reload so every page
                      // effect/subscription re-initializes against the new hotel.
                      setMawioTier(nextHotel);
                      window.location.reload();
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg font-black uppercase text-[10px] tracking-widest transition-all border-2",
                    currentHotelView === "standard"
                      ? "border-blue-500 bg-blue-50 text-blue-600 hover:bg-blue-100"
                      : "border-amber-500 bg-amber-50 text-amber-600 hover:bg-amber-100"
                  )}
                >
                  <span>Switch to {currentHotelView === "standard" ? "Premium" : "Standard"}</span>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 17h12M14 12H2" />
                  </svg>
                </button>
                <Badge variant="outline" className={cn("text-[10px] font-black uppercase tracking-widest px-2",
                  currentHotelView === "platinum"
                    ? "border-amber-500 text-amber-600 bg-amber-50"
                    : "border-blue-500 text-blue-600 bg-blue-50"
                )}>
                  {currentHotelView === "platinum" ? "Premium Hotel" : "Standard Hotel"}
                </Badge>
              </div>
            ) : (
              <Badge variant="outline" className={cn("text-[10px] font-black uppercase tracking-widest px-2",
                typeof window !== 'undefined' && getLocalMawioTier() === "platinum"
                  ? "border-amber-500 text-amber-600 bg-amber-50"
                  : "border-blue-500 text-blue-600 bg-blue-50"
              )}>
                {typeof window !== 'undefined' && getLocalMawioTier() === "platinum" ? "Premium Hotel" : "Standard Hotel"}
              </Badge>
            )}
            
            <div className={cn("flex items-center gap-4 text-muted-foreground", isDirector && "hidden md:flex")}>
              <SyncStatusIndicator />
              <button className="relative p-2 hover:bg-muted rounded-full transition-colors">
                <Bell className="w-5 h-5" />
                <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full border-2 border-white" />
              </button>
            </div>
            
            <div className={cn("flex items-center gap-3 border-l pl-6", isDirector && "border-l-0 pl-0 md:border-l md:pl-6")}>
              <div className="text-right hidden sm:block">
                <p className="text-xs font-bold leading-none">{activeUsername || role}</p>
                <p className="text-[10px] text-muted-foreground mt-1 font-bold uppercase tracking-widest">Username</p>
              </div>
              <div className="text-right hidden sm:block">
                <p className="text-sm font-black leading-none uppercase tracking-tight">{role}</p>
                <p className="text-[10px] text-muted-foreground mt-1 font-bold uppercase tracking-widest">Active Session</p>
              </div>
              <div className={cn("w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-white shadow-lg", isDirector && "rounded-lg bg-white/10 ring-1 ring-white/15 md:bg-secondary md:ring-0")}>
                <User className="w-5 h-5" />
              </div>
              <Button
                type="button"
                variant="outline"
                className={cn("h-9 text-[10px] font-black uppercase tracking-widest", isDirector && "hidden md:inline-flex")}
                onClick={() => {
                  setUsernameDraft(activeUsername || role);
                  setUsernameDialogOpen(true);
                }}
              >
                Change Username
              </Button>
            </div>
          </div>
        </header>

        <main className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto p-8 [-webkit-overflow-scrolling:touch]", isDirector && "px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-3 sm:px-4 sm:pt-4 md:p-8")}>
          {children}
        </main>
      </div>

      {isDirector && (
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0f1712]/95 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 text-white shadow-[0_-12px_30px_rgba(0,0,0,0.18)] backdrop-blur md:hidden">
          <div className="grid grid-cols-6 gap-1">
            {DIRECTOR_MOBILE_NAV.map((item) => {
              const active = item.href === "/dashboard" ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => router.push(item.href)}
                  className={cn(
                    "flex h-14 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-black uppercase tracking-tight text-white/55 transition-colors",
                    active && "bg-white text-[#0f1712]",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      <Dialog open={usernameDialogOpen} onOpenChange={setUsernameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-black uppercase tracking-tight">Change Username</DialogTitle>
            <DialogDescription>Update the username for the current logged-in account.</DialogDescription>
          </DialogHeader>
          <Input
            value={usernameDraft}
            onChange={(event) => setUsernameDraft(event.target.value)}
            placeholder="Enter new username"
            className="h-11"
          />
          {usernameFeedback && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-700">
              {usernameFeedback}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUsernameDialogOpen(false)} disabled={usernameSaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveUsername()} disabled={!usernameDraft.trim() || usernameSaving}>
              {usernameSaving ? "Saving..." : "Update Username"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
