"use client";

import { useEffect, useMemo, useState } from "react";
import { readStoredRole } from "@/app/lib/auth";
import { InventoryItem, ROOMS, Role } from "@/app/lib/mock-data";
import {
  adjustInventoryQuantity,
  MainStoreItem,
  getStoreItemLabel,
  normalizeBaristaProductTarget,
  normalizeStockName,
  STORAGE_MAIN_STORE_ITEMS,
  STORAGE_INVENTORY_ITEMS,
  STORAGE_STORE_MOVEMENTS,
  STORAGE_STORE_USAGE,
  StoreMovementLog,
  StoreUsageLog,
} from "@/app/lib/inventory-transfer";
import { findStoreItemForMenuName, formatTotStatus, getMenuStockStatus, getRemainingTots, getTotLimit, isTotTrackedMenuItem, normalizeBaristaMenuItems } from "@/app/lib/barista-stock";
import { printDepartmentReceipt } from "@/app/lib/receipt-print";
import { getActiveBaristaStateKey, readJson, readPosState, writeJson, writePosState } from "@/app/lib/storage";
import { BARISTA_INVENTORY_SEED, PREMIUM_BARISTA_INVENTORY_SEED } from "@/app/lib/seed-barista-data";
import { getLocalMawioTier } from "@/app/lib/login-profiles";
import { useIsDirector } from "@/hooks/use-is-director";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";
import { KitchenSessionManager } from "@/components/dashboard/kitchen-session-manager";
import { CheckCircle2, Coffee, Lock, Minus, Pencil, Plus, Receipt, Search, Trash2, User, XCircle } from "lucide-react";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { hydrateStorageKeyFromFirebase, purgeSyncedKeysForCurrentTier, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { DEFAULT_LOGIN_PASSWORD, getProfilePassword, readActiveSessionUsername, readLocalLoginProfiles, saveLoginProfileToServer, STORAGE_LOGIN_PROFILES, subscribeToSessionIdentity, upsertProfileUser } from "@/app/lib/login-profiles";

type BaristaCategory = "all" | "espresso" | "coffee" | "tea" | "cold" | "snacks";
type ServiceMode = "restaurant" | "room-service" | "take-away";
type BaristaPaymentMethod = "cash" | "card" | "mobile" | "credit";
type BaristaPaymentStatus = "completed" | "credit";
type BaristaOrderLine = { name: string; qty: number };
type SalesDateFilter = "day" | "week" | "month" | "all";

interface BaristaMenuItem {
  id: string;
  name: string;
  price: number;
  category: Exclude<BaristaCategory, "all">;
  prepMinutes: number;
  barcode?: string;
  // Supplier cost, used only for manager costing — never shown in POS.
  buyingPrice?: number;
}

interface BaristaWasteLog {
  id: string;
  name: string;
  qty: number;
  createdAt: number;
}

interface CartLine {
  item: BaristaMenuItem;
  qty: number;
}

interface BaristaTicket {
  id: string;
  code: string;
  createdAt: number;
  mode: ServiceMode;
  destination: string;
  lines: BaristaOrderLine[];
  total: number;
  status?: "active" | "delivered";
  deliveredAt?: number;
}

interface BaristaPaymentRecord {
  id: string;
  ticketId: string;
  code: string;
  createdAt: number;
  mode: ServiceMode;
  destination: string;
  total: number;
  status: BaristaPaymentStatus;
  method: BaristaPaymentMethod;
  lines?: BaristaOrderLine[];
}

interface CancelledBaristaTicket extends BaristaTicket {
  source?: "kitchen" | "barista";
  cancelledAt: number;
}

interface PendingOrder {
  mode: ServiceMode;
  destination: string;
  lines: BaristaOrderLine[];
  total: number;
}

const BARISTA_MENU: BaristaMenuItem[] = [];

const STORAGE_TICKETS = "orange-hotel-barista-orders";
const STORAGE_SEQ = "orange-hotel-barista-seq";
const STORAGE_MENU = "orange-hotel-barista-menu";
const STORAGE_PAYMENTS = "orange-hotel-barista-payments";
const STORAGE_CANCELLED = "orange-hotel-cancelled-tickets";
const STORAGE_WASTE = "orange-hotel-barista-waste";

function matchesSalesDateFilter(createdAt: number | undefined, filter: SalesDateFilter) {
  if (filter === "all") return true;
  if (!createdAt) return false;

  const saleDate = new Date(createdAt);
  if (!Number.isFinite(saleDate.getTime())) return false;

  const now = new Date();
  const saleDay = new Date(saleDate.getFullYear(), saleDate.getMonth(), saleDate.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (filter === "day") return saleDay === today;

  if (filter === "week") {
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    return saleDate >= startOfWeek && saleDate < endOfWeek;
  }

  return saleDate.getFullYear() === now.getFullYear() && saleDate.getMonth() === now.getMonth();
}

function formatPaymentDate(createdAt: number | undefined) {
  if (!createdAt) return "-";
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "-";
}

const normalizeCategory = (value: string, itemName = ""): Exclude<BaristaCategory, "all"> => {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedName = itemName.trim().toLowerCase();

  if (normalizedValue === "espresso" || normalizedValue === "coffee" || normalizedValue === "tea" || normalizedValue === "cold" || normalizedValue === "snacks") {
    return normalizedValue;
  }

  if (normalizedValue === "soft drink" || normalizedValue === "soda" || normalizedValue === "energy drink" || normalizedValue === "water" || normalizedValue === "beer" || normalizedValue === "wine" || normalizedValue === "cider" || normalizedValue === "spirit" || normalizedValue === "sparkling" || normalizedValue === "whisky" || normalizedValue === "gin" || normalizedValue === "liqueur" || normalizedValue === "cognac" || normalizedValue === "aperitif" || normalizedValue === "malt" || normalizedValue === "bar") {
    return "cold";
  }

  if (normalizedName.includes("espresso") || normalizedName.includes("macchiato")) return "espresso";
  if (normalizedName.includes("tea")) return "tea";
  if (normalizedName.includes("ice cream") || normalizedName.includes("snack")) return "snacks";
  if (normalizedName.includes("iced") || normalizedName.includes("soda") || normalizedName.includes("water") || normalizedName.includes("juice") || normalizedName.includes("beer") || normalizedName.includes("wine")) return "cold";
  return "coffee";
};

function normalizeBaristaMenuItemsFromInventory(inventory: InventoryItem[]): BaristaMenuItem[] {
  const deduped = new Map<string, BaristaMenuItem>();

  inventory
    .filter((item) => {
      const status = item.status?.toUpperCase() ?? "ACTIVE";
      const category = item.category?.trim().toLowerCase() ?? "";
      return status === "ACTIVE" && category !== "kitchen";
    })
    .forEach((item) => {
      const name = getBaristaInventoryLabel(item);
      const key = `${normalizeBaristaTarget(name)}|${(item.category ?? "").toLowerCase()}|${isTotInventoryItem(item) ? "tot" : "full"}`;
      const nextMenuItem: BaristaMenuItem = {
        id: item.id,
        name,
        price:
          typeof item.sellingPrice === "number" && item.sellingPrice > 0
            ? item.sellingPrice
            : typeof item.price === "number" && item.price > 0
              ? item.price
              : 0,
        category: normalizeCategory(item.category, name),
        prepMinutes: 2,
        barcode: item.barcode || "",
      };
      const existingItem = deduped.get(key);
      if (!existingItem || nextMenuItem.price > existingItem.price || (!!nextMenuItem.barcode && !existingItem.barcode)) {
        deduped.set(key, nextMenuItem);
      }
    });

  return Array.from(deduped.values());
}

function syncBaristaMenuItemsWithSharedInventory(
  menuItems: BaristaMenuItem[],
  inventory: InventoryItem[],
  _storeItems: MainStoreItem[],
) {
  // The POS menu is authoritative per hotel tier: the seeded drink list plus any
  // manual edits made in the manager Drinks / Inventory tabs. We deliberately do
  // NOT merge items in from the shared inventory/store here. That shared data was
  // historically co-mingled between the standard and premium hotels, so merging
  // it back would leak one hotel's drinks into the other (the "merging" bug).
  // Stock levels are resolved separately at render time via getMenuStockStatus.
  if (menuItems.length === 0) {
    return normalizeBaristaMenuItemsFromInventory(inventory);
  }
  return menuItems;
}

function normalizeBaristaTarget(name: string) {
  return normalizeBaristaProductTarget(name);
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

function isTotInventoryItem(item: Pick<InventoryItem, "name" | "totPerBottle">) {
  return (typeof item.totPerBottle === "number" && item.totPerBottle > 0) || /\s*\(?TOTS?\)?$/i.test(item.name);
}

function buildPremiumSeedMenuItems(): BaristaMenuItem[] {
  return PREMIUM_BARISTA_INVENTORY_SEED
    .filter((item) => item.name && item.status === "ACTIVE")
    .map((item, idx) => ({
      id: `premium-seed-${idx}`,
      name: getBaristaInventoryLabel({ name: item.name ?? "", size: item.size ?? "" }),
      // Premium seed prices are the supplier cost. They become the buying price;
      // the manager sets the actual POS selling price in the manager Inventory tab.
      price: item.sellingPrice ?? 0,
      buyingPrice: item.buyingPrice ?? 0,
      category: normalizeCategory(item.category ?? "cold", item.name ?? ""),
      prepMinutes: 2,
      barcode: item.barcode ?? "",
    }));
}

function buildStandardSeedMenuItems(): BaristaMenuItem[] {
  return BARISTA_INVENTORY_SEED
    .filter((item) => item.name && item.status === "ACTIVE")
    .map((item, idx) => ({
      id: `standard-seed-${idx}`,
      name: getBaristaInventoryLabel({ name: item.name ?? "", size: item.size ?? "" }),
      // Customer-facing POS price is always the selling price; buying price is
      // reserved for manager costing only (synced from premium where the same
      // product shares a supplier).
      price: item.sellingPrice ?? 0,
      buyingPrice: item.buyingPrice ?? 0,
      category: normalizeCategory(item.category ?? "cold", item.name ?? ""),
      prepMinutes: 2,
      barcode: item.barcode ?? "",
    }));
}

// Bumping this version forces the standard barista menu to be re-seeded from
// BARISTA_INVENTORY_SEED once per browser, so uploaded drink-list changes show
// up even when a stale menu was already persisted.
const STANDARD_BARISTA_SEED_VERSION_KEY = "orange-hotel-standard-barista-seed-v2";

// One-time, per-tier barista clean-slate marker. The suffix `-{scope}` is added
// at runtime so the standard and premium hotels each purge their own historically
// co-mingled barista data exactly once. Bump the version to force another purge.
const BARISTA_TIER_RESET_KEY = "orange-hotel-barista-tier-reset-v2";

export default function BaristaPage() {
  const isDirector = useIsDirector();
  const { confirm, dialog } = useConfirmDialog();
  const [role, setRole] = useState<Role | null>(null);
  const isManager = role === "manager";
  const [managerTab, setManagerTab] = useState<"inventory" | "finance" | "sales" | "drinks">("finance");
  const [drinkEditId, setDrinkEditId] = useState<string | null>(null);
  const [drinkName, setDrinkName] = useState("");
  const [drinkPrice, setDrinkPrice] = useState("");
  const [drinkCategory, setDrinkCategory] = useState<Exclude<BaristaCategory, "all">>("coffee");
  const [drinkPrepMinutes, setDrinkPrepMinutes] = useState("5");
  const [directorTab, setDirectorTab] = useState<"inventory" | "finance" | "purchases" | "sales">("finance");
  const [directorSalesDateFilter, setDirectorSalesDateFilter] = useState<SalesDateFilter>("day");
  const [category, setCategory] = useState<BaristaCategory>("all");
  const [serviceMode, setServiceMode] = useState<ServiceMode>("restaurant");
  const [searchTerm, setSearchTerm] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [roomNumber, setRoomNumber] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [tickets, setTickets] = useState<BaristaTicket[]>([]);
  const [ticketSeq, setTicketSeq] = useState(1);
  const [storedMenuItems, setStoredMenuItems] = useState<BaristaMenuItem[]>(BARISTA_MENU);
  const [baristaPayments, setBaristaPayments] = useState<BaristaPaymentRecord[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [posHydrated, setPosHydrated] = useState(false);
  const [queueTab, setQueueTab] = useState<"queue" | "from-store">("queue");
  const [baristaStoreItems, setBaristaStoreItems] = useState<MainStoreItem[]>([]);
  const [fromStoreEntries, setFromStoreEntries] = useState<StoreMovementLog[]>([]);
  const [usageLogs, setUsageLogs] = useState<StoreUsageLog[]>([]);
  const [useEntryId, setUseEntryId] = useState("");
  const [useQty, setUseQty] = useState("1");

  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [showSettlementPopup, setShowSettlementPopup] = useState(false);
  const [showPayNowPopup, setShowPayNowPopup] = useState(false);
  const [accountTab, setAccountTab] = useState<"session" | "password">("session");
  const [activeUsername, setActiveUsername] = useState("");
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [deliveringTicketId, setDeliveringTicketId] = useState<string | null>(null);

  const roomSuggestions = useMemo(() => ROOMS.map((room) => room.number), []);
  const tableSuggestions = useMemo(
    () => Array.from({ length: 30 }, (_, index) => String(index + 1)),
    [],
  );

  useEffect(() => {
    const savedRole = readStoredRole();
    setRole(savedRole);
    if (typeof window !== "undefined") {
      setActiveUsername(readActiveSessionUsername(""));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const applySessionIdentity = () => {
      setActiveUsername(readActiveSessionUsername(""));
    };

    const handleProfilesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (detail?.key !== STORAGE_LOGIN_PROFILES) return;
      applySessionIdentity();
    };

    const unsubscribeSession = subscribeToSessionIdentity(applySessionIdentity);
    window.addEventListener("orange-hotel-storage-updated", handleProfilesUpdated as EventListener);

    return () => {
      unsubscribeSession();
      window.removeEventListener("orange-hotel-storage-updated", handleProfilesUpdated as EventListener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const activeBaristaKey = getActiveBaristaStateKey();
    const scope = getLocalMawioTier();

    const applyBaristaSnapshot = () => {
      if (cancelled) return;
      const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
        activeBaristaKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        490,
      );
      setTickets(snapshot.tickets);
      setTicketSeq(snapshot.ticketSeq);
      setBaristaPayments(snapshot.payments);

      const inventory = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
      setInventoryItems(inventory);

      let menuItems = snapshot.menuItems;
      if (scope === "platinum") {
        if (menuItems.length === 0) {
          menuItems = buildPremiumSeedMenuItems();
          writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, menuItems);
        }
      } else {
        // Standard hotel: seed when empty, and force a one-time re-seed so an
        // updated uploaded drink list replaces a previously persisted menu.
        const needsForcedSeed =
          typeof window !== "undefined" && !window.localStorage.getItem(STANDARD_BARISTA_SEED_VERSION_KEY);
        if (menuItems.length === 0 || needsForcedSeed) {
          menuItems = buildStandardSeedMenuItems();
          writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, menuItems);
        }
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STANDARD_BARISTA_SEED_VERSION_KEY, "1");
        }
      }

      setStoredMenuItems(syncBaristaMenuItemsWithSharedInventory(menuItems, inventory, readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []));
      setPosHydrated(true);
    };

    const bootstrapBarista = async () => {
      // One-time, per-hotel clean slate: abandon the barista data that was
      // historically co-mingled between the two hotels during the original
      // shared-database bug. Each tier purges only its own data (local + its own
      // Firebase node) exactly once, then reseeds below. This is what makes each
      // dashboard truly own its sales/menu with no cross-hotel conflict.
      const resetMarker = `${BARISTA_TIER_RESET_KEY}-${scope}`;
      if (typeof window !== "undefined" && !window.localStorage.getItem(resetMarker)) {
        await purgeSyncedKeysForCurrentTier([
          activeBaristaKey,
          STORAGE_TICKETS,
          STORAGE_SEQ,
          STORAGE_PAYMENTS,
          STORAGE_MENU,
          STORAGE_WASTE,
        ]).catch(() => undefined);
        window.localStorage.setItem(resetMarker, "1");
      }

      await Promise.all([
        hydrateStorageKeyFromFirebase(activeBaristaKey).catch(() => undefined),
        hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS).catch(() => undefined),
        hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS).catch(() => undefined),
      ]);
    };

    void bootstrapBarista().finally(applyBaristaSnapshot);
    const unsubscribeBarista = subscribeToSyncedStorageKey(activeBaristaKey, applyBaristaSnapshot);
    const unsubscribeInventory = subscribeToSyncedStorageKey(STORAGE_INVENTORY_ITEMS, applyBaristaSnapshot);

    return () => {
      cancelled = true;
      unsubscribeBarista();
      unsubscribeInventory();
    };
  }, []);

  const loadFromStoreData = () => {
    const savedStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS);
    const savedMovements = readJson<StoreMovementLog[]>(STORAGE_STORE_MOVEMENTS);
    const savedUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE);
    setBaristaStoreItems(Array.isArray(savedStoreItems) ? savedStoreItems.filter((entry) => entry.lane === "barista") : []);
    setFromStoreEntries(Array.isArray(savedMovements) ? savedMovements.filter((entry) => entry.destination === "barista") : []);
    setUsageLogs(Array.isArray(savedUsage) ? savedUsage.filter((entry) => entry.destination === "barista") : []);
  };

  useEffect(() => {
    loadFromStoreData();
    const unsubscribeStoreItems = subscribeToSyncedStorageKey(STORAGE_MAIN_STORE_ITEMS, loadFromStoreData);
    const unsubscribeMovements = subscribeToSyncedStorageKey(STORAGE_STORE_MOVEMENTS, loadFromStoreData);
    const unsubscribeUsage = subscribeToSyncedStorageKey(STORAGE_STORE_USAGE, loadFromStoreData);

    return () => {
      unsubscribeStoreItems();
      unsubscribeMovements();
      unsubscribeUsage();
    };
  }, []);

  useEffect(() => {
    if (queueTab === "from-store") loadFromStoreData();
  }, [queueTab]);

  useEffect(() => {
    const activeBaristaKey = getActiveBaristaStateKey();
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey,
      STORAGE_TICKETS,
      STORAGE_SEQ,
      STORAGE_PAYMENTS,
      STORAGE_MENU,
      490,
    );
    const syncedMenuItems = syncBaristaMenuItemsWithSharedInventory(snapshot.menuItems, inventoryItems, baristaStoreItems);

    if (JSON.stringify(syncedMenuItems) !== JSON.stringify(snapshot.menuItems)) {
      writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, syncedMenuItems);
    }

    if (JSON.stringify(syncedMenuItems) !== JSON.stringify(storedMenuItems)) {
      setStoredMenuItems(syncedMenuItems);
    }
  }, [inventoryItems, baristaStoreItems]);

  useEffect(() => {
    if (serviceMode === "restaurant") {
      setRoomNumber("");
      return;
    }
    if (serviceMode === "room-service") {
      setTableNumber("");
      return;
    }
    setRoomNumber("");
    setTableNumber("");
  }, [serviceMode]);

  const getUsedQty = (movementId: string) =>
    usageLogs.filter((entry) => entry.movementId === movementId).reduce((sum, entry) => sum + entry.quantityUsed, 0);

  const updateBaristaStoreStock = (
    lines: BaristaOrderLine[],
    direction: "consume" | "restore",
  ) => {
    const allStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const otherStoreItems = allStoreItems.filter((entry) => entry.lane !== "barista");
    const currentBaristaItems = allStoreItems
      .filter((entry) => entry.lane === "barista")
      .map((entry) => ({ ...entry, lane: "barista" as const }));
    const nextBaristaItems = [...currentBaristaItems];
    let nextInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];

    for (const line of lines) {
      const matchedItem = findStoreItemForMenuName(nextBaristaItems, line.name);
      if (!matchedItem) {
        const inventoryMatch = nextInventoryItems.find((item) => {
          const itemName = item.size ? `${item.name} ${item.size}` : item.name;
          return normalizeBaristaTarget(itemName) === normalizeBaristaTarget(line.name) || normalizeBaristaTarget(item.name) === normalizeBaristaTarget(line.name);
        });

        if (!inventoryMatch) continue;
        const availableUnits = typeof inventoryMatch.stock === "number" ? inventoryMatch.stock : 0;
        const availableTots = typeof inventoryMatch.totPerBottle === "number" && inventoryMatch.totPerBottle > 0
          ? availableUnits * inventoryMatch.totPerBottle - (typeof inventoryMatch.totSold === "number" ? inventoryMatch.totSold : 0)
          : availableUnits;

        if (direction === "consume" && line.qty > availableTots) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }

        nextInventoryItems = adjustInventoryQuantity(nextInventoryItems, inventoryMatch.category, line.name, direction === "consume" ? -line.qty : line.qty);
        continue;
      }

      const itemIndex = nextBaristaItems.findIndex((entry) => entry.id === matchedItem.id);
      if (itemIndex < 0) continue;

      const currentItem = nextBaristaItems[itemIndex];
      const inventoryLabel = getStoreItemLabel(currentItem);
      if (isTotTrackedMenuItem(line.name)) {
        const totLimit = getTotLimit(currentItem);
        if (totLimit <= 0) {
          return { ok: false as const, error: `Missing tot limit for ${line.name}.` };
        }

        const currentTotSold = typeof currentItem.totSold === "number" && currentItem.totSold > 0 ? currentItem.totSold : 0;
        if (direction === "consume") {
          const remainingTots = getRemainingTots(currentItem);
          if (line.qty > remainingTots) {
            return { ok: false as const, error: `Not enough tots remaining for ${line.name}.` };
          }

          const totalTotSold = currentTotSold + line.qty;
          const bottlesConsumed = Math.floor(totalTotSold / totLimit);
          nextBaristaItems[itemIndex] = {
            ...currentItem,
            stock: currentItem.stock - bottlesConsumed,
            totLimit,
            totSold: totalTotSold % totLimit,
          };
          nextInventoryItems = adjustInventoryQuantity(nextInventoryItems, "Bar", inventoryLabel, -bottlesConsumed);
          continue;
        }

        const totalTotSold = currentTotSold - line.qty;
        if (totalTotSold >= 0) {
          nextBaristaItems[itemIndex] = {
            ...currentItem,
            totLimit,
            totSold: totalTotSold,
          };
          continue;
        }

        const bottlesRestored = Math.ceil(Math.abs(totalTotSold) / totLimit);
        nextBaristaItems[itemIndex] = {
          ...currentItem,
          stock: currentItem.stock + bottlesRestored,
          totLimit,
          totSold: totalTotSold + bottlesRestored * totLimit,
        };
        nextInventoryItems = adjustInventoryQuantity(nextInventoryItems, "Bar", inventoryLabel, bottlesRestored);
        continue;
      }

      if (direction === "consume") {
        if (line.qty > currentItem.stock) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }
        nextBaristaItems[itemIndex] = { ...currentItem, stock: currentItem.stock - line.qty };
        nextInventoryItems = adjustInventoryQuantity(nextInventoryItems, "Bar", inventoryLabel, -line.qty);
        continue;
      }

      nextBaristaItems[itemIndex] = { ...currentItem, stock: currentItem.stock + line.qty };
      nextInventoryItems = adjustInventoryQuantity(nextInventoryItems, "Bar", inventoryLabel, line.qty);
    }

    const nextStoreItems = [...otherStoreItems, ...nextBaristaItems];
    setBaristaStoreItems(nextBaristaItems);
    writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
    writeJson(STORAGE_INVENTORY_ITEMS, nextInventoryItems);
    return { ok: true as const };
  };

  const addUsage = async () => {
    const qty = Number(useQty);
    const entry = fromStoreEntries.find((item) => item.id === useEntryId);
    if (!entry || Number.isNaN(qty) || qty <= 0) return;
    const remaining = entry.convertedQty - getUsedQty(entry.id);
    if (qty > remaining) return;
    const approved = await confirm({
      title: "Record Barista Usage",
      description: `Are you sure you want to record ${qty} units used for ${entry.itemName}?`,
      actionLabel: "Record Usage",
    });
    if (!approved) return;
    const log: StoreUsageLog = {
      id: `su-${Date.now()}`,
      movementId: entry.id,
      destination: "barista",
      quantityUsed: qty,
      usedAt: Date.now(),
    };
    const next = [log, ...usageLogs];
    setUsageLogs(next);
    const existingUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE) ?? [];
    const existingInventory = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const nextInventory = adjustInventoryQuantity(existingInventory, "Bar", entry.itemName, -qty);
    writeJson(
      STORAGE_STORE_USAGE,
      [...next, ...existingUsage.filter((i) => i.destination !== "barista")],
    );
    writeJson(STORAGE_INVENTORY_ITEMS, nextInventory);
    setUseQty("1");
  };

  const menuItems = useMemo(
    () => normalizeBaristaMenuItems(storedMenuItems, baristaStoreItems),
    [baristaStoreItems, storedMenuItems],
  );

  const filteredMenu = useMemo(
    () => {
      const normalizedSearch = searchTerm.trim().toLowerCase();
      const compactSearch = normalizedSearch.replace(/\s+/g, "");
      const searchTokens = normalizedSearch.split(/\s+/).filter(Boolean);
      return menuItems.filter((item) => {
        const inCategory = normalizedSearch.length > 0 || category === "all" || item.category === category;
        const searchHaystack = [
          item.name,
          item.category,
          item.barcode ?? "",
        ]
          .join(" ")
          .toLowerCase();
        const compactHaystack = searchHaystack.replace(/\s+/g, "");
        const inSearch =
          searchTokens.length === 0 ||
          searchTokens.every((token) => searchHaystack.includes(token)) ||
          compactHaystack.includes(compactSearch);
        return inCategory && inSearch;
      });
    },
    [category, menuItems, searchTerm],
  );

  const subtotal = useMemo(() => cart.reduce((sum, line) => sum + line.item.price * line.qty, 0), [cart]);
  const completedSalesTotal = useMemo(
    () => baristaPayments.filter((payment) => payment.status !== "credit").reduce((sum, payment) => sum + payment.total, 0),
    [baristaPayments],
  );
  const creditSalesTotal = useMemo(
    () => baristaPayments.filter((payment) => payment.status === "credit").reduce((sum, payment) => sum + payment.total, 0),
    [baristaPayments],
  );
  const recentSales = useMemo(
    () => [...baristaPayments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8),
    [baristaPayments],
  );
  const activeTickets = useMemo(() => tickets.filter((ticket) => ticket.status !== "delivered"), [tickets]);
  const orderedTickets = useMemo(
    () =>
      [...tickets].sort((a, b) => {
        const aDelivered = a.status === "delivered";
        const bDelivered = b.status === "delivered";

        if (aDelivered !== bDelivered) return aDelivered ? 1 : -1;
        return b.createdAt - a.createdAt;
      }),
    [tickets],
  );
  const resolveBaristaInventoryItem = (item: MainStoreItem) =>
    inventoryItems.find((entry) => {
      if ((entry.category ?? "").toLowerCase() === "kitchen") return false;

      const itemNames = [
        item.name,
        getStoreItemLabel(item),
      ].map((value) => normalizeStockName(value));
      const entryNames = [
        entry.name,
        entry.size ? `${entry.name} ${entry.size}` : entry.name,
      ].map((value) => normalizeStockName(value));

      return itemNames.some((value) => entryNames.includes(value));
    });

  const baristaSalesByItem = useMemo(() => {
    const salesMap = new Map<string, number>();

    baristaPayments.forEach((payment) => {
      if (!Array.isArray(payment.lines)) return;

      payment.lines.forEach((line) => {
        const key = normalizeBaristaTarget(line.name);
        salesMap.set(key, (salesMap.get(key) ?? 0) + line.qty);
      });
    });

    return salesMap;
  }, [baristaPayments]);

  const baristaMenuPriceByItem = useMemo(() => {
    const priceMap = new Map<string, number>();

    menuItems.forEach((item) => {
      const key = normalizeBaristaTarget(item.name);
      if (typeof item.price === "number" && item.price > 0) {
        priceMap.set(key, item.price);
      }
    });

    return priceMap;
  }, [menuItems]);

  const baristaMenuBuyingPriceByItem = useMemo(() => {
    const priceMap = new Map<string, number>();

    menuItems.forEach((item) => {
      const key = normalizeBaristaTarget(item.name);
      if (typeof item.buyingPrice === "number" && item.buyingPrice > 0) {
        priceMap.set(key, item.buyingPrice);
      }
    });

    return priceMap;
  }, [menuItems]);

  const baristaInventoryRows = useMemo(
    () =>
      baristaStoreItems.map((item) => {
        const inventoryMatch = resolveBaristaInventoryItem(item);
        const menuBuyingPrice = baristaMenuBuyingPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item)));
        const buyingPrice =
          typeof menuBuyingPrice === "number" && menuBuyingPrice > 0
            ? menuBuyingPrice
            : typeof item.buyingPrice === "number" && item.buyingPrice > 0
            ? item.buyingPrice
            : typeof inventoryMatch?.buyingPrice === "number" && inventoryMatch.buyingPrice > 0
              ? inventoryMatch.buyingPrice
              : 0;
        const sellingPrice =
          typeof baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) === "number" &&
          (baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) ?? 0) > 0
            ? (baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) ?? 0)
            : typeof item.sellingPrice === "number" && item.sellingPrice > 0
            ? item.sellingPrice
            : typeof inventoryMatch?.sellingPrice === "number" && inventoryMatch.sellingPrice > 0
              ? inventoryMatch.sellingPrice
              : typeof baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) === "number" &&
                (baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) ?? 0) > 0
                ? (baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) ?? 0)
              : typeof inventoryMatch?.price === "number" && inventoryMatch.price > 0
                ? inventoryMatch.price
                : 0;
        const quantitySold = baristaSalesByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) ?? 0;
        const capital = item.stock * buyingPrice;
        const revenue = quantitySold * sellingPrice;
        const profitLoss = revenue - capital;

        return {
          ...item,
          displayName: getStoreItemLabel(item),
          buyingPrice,
          sellingPrice,
          quantitySold,
          capital,
          revenue,
          profitLoss,
        };
      }),
    [baristaMenuBuyingPriceByItem, baristaMenuPriceByItem, baristaSalesByItem, baristaStoreItems, inventoryItems],
  );

  // Editable per-item pricing rows for the manager Inventory tab. Driven by the
  // POS menu so every drink (including premium menu-only items with no store
  // stock) gets a Buying Price and Selling Price the manager can set manually.
  const baristaManagerPricingRows = useMemo(
    () =>
      menuItems.map((menuItem) => {
        const target = normalizeBaristaTarget(menuItem.name);
        const storeMatch = baristaStoreItems.find(
          (entry) => normalizeBaristaTarget(getStoreItemLabel(entry)) === target,
        );
        const inventoryMatch = inventoryItems.find((entry) => {
          const entryNames = [
            entry.name,
            entry.size ? `${entry.name} ${entry.size}` : entry.name,
          ].map((value) => normalizeBaristaTarget(value));
          return entryNames.includes(target);
        });
        const buyingPrice =
          typeof menuItem.buyingPrice === "number" && menuItem.buyingPrice > 0
            ? menuItem.buyingPrice
            : typeof storeMatch?.buyingPrice === "number" && storeMatch.buyingPrice > 0
            ? storeMatch.buyingPrice
            : typeof inventoryMatch?.buyingPrice === "number" && inventoryMatch.buyingPrice > 0
            ? inventoryMatch.buyingPrice
            : 0;
        const sellingPrice = typeof menuItem.price === "number" && menuItem.price > 0 ? menuItem.price : 0;
        const stock = typeof storeMatch?.stock === "number" ? storeMatch.stock : 0;
        const unit = storeMatch?.unit ?? "";
        const quantitySold = baristaSalesByItem.get(target) ?? 0;
        return {
          id: menuItem.id,
          name: menuItem.name,
          category: menuItem.category,
          buyingPrice,
          sellingPrice,
          stock,
          unit,
          quantitySold,
        };
      }),
    [baristaSalesByItem, baristaStoreItems, inventoryItems, menuItems],
  );

  // Persist a manual buying/selling price change from the manager Inventory tab
  // onto the POS menu item (matched by name). Selling price drives the POS;
  // buying price is kept for costing only.
  const updateBaristaItemPricing = (menuName: string, patch: { price?: number; buyingPrice?: number }) => {
    const activeBaristaKey = getActiveBaristaStateKey();
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const target = normalizeBaristaTarget(menuName);
    let matched = false;
    const next = snapshot.menuItems.map((item) => {
      if (normalizeBaristaTarget(item.name) === target) {
        matched = true;
        return { ...item, ...patch };
      }
      return item;
    });
    if (!matched) {
      const menuRef = menuItems.find((entry) => normalizeBaristaTarget(entry.name) === target);
      if (menuRef) next.push({ ...menuRef, ...patch });
    }
    writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, next);
    setStoredMenuItems(next);
  };

  // Set the available barista stock quantity for a menu item from the manager
  // Inventory tab. Quantity lives on the barista-lane store item (created on
  // demand for menu-only items such as the premium seed) so POS stock checks and
  // sale deductions keep working.
  const updateBaristaItemStock = (
    menuItem: { name: string; category: string; buyingPrice?: number; sellingPrice?: number },
    qty: number,
  ) => {
    const allStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const target = normalizeBaristaTarget(menuItem.name);
    const index = allStoreItems.findIndex(
      (entry) => entry.lane === "barista" && normalizeBaristaTarget(getStoreItemLabel(entry)) === target,
    );

    let nextStoreItems: Array<MainStoreItem & { lane?: "kitchen" | "barista" }>;
    if (index >= 0) {
      nextStoreItems = allStoreItems.map((entry, idx) => (idx === index ? { ...entry, stock: qty } : entry));
    } else {
      const seedRef = [...BARISTA_INVENTORY_SEED, ...PREMIUM_BARISTA_INVENTORY_SEED].find(
        (seed) =>
          normalizeBaristaTarget(getBaristaInventoryLabel({ name: seed.name ?? "", size: seed.size ?? "" })) === target,
      );
      const newStoreItem: MainStoreItem & { lane: "barista" } = {
        id: `bs-${Date.now()}`,
        name: seedRef?.name ?? menuItem.name,
        subCategory: seedRef?.category ?? menuItem.category ?? "Bar",
        size: seedRef?.size ?? "",
        stock: qty,
        unit: seedRef?.unit ?? "Bottle",
        minStock: seedRef?.minStock ?? 0,
        lane: "barista",
        buyingPrice: typeof menuItem.buyingPrice === "number" ? menuItem.buyingPrice : seedRef?.buyingPrice ?? 0,
        sellingPrice: typeof menuItem.sellingPrice === "number" ? menuItem.sellingPrice : seedRef?.sellingPrice ?? 0,
      };
      nextStoreItems = [...allStoreItems, newStoreItem];
    }

    setBaristaStoreItems(nextStoreItems.filter((entry) => entry.lane === "barista"));
    writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
  };

  const recordWaste = async (item: BaristaMenuItem) => {
    if (isDirector) return;
    const approved = await confirm({
      title: "Record Waste",
      description: `Record 1 x ${item.name} as waste? This removes it from barista stock.`,
      actionLabel: "Record Waste",
    });
    if (!approved) return;

    const stockResult = updateBaristaStoreStock([{ name: item.name, qty: 1 }], "consume");
    if (!stockResult.ok) {
      window.alert(stockResult.error);
      return;
    }

    const wasteLog: BaristaWasteLog = {
      id: `bw-${Date.now()}`,
      name: item.name,
      qty: 1,
      createdAt: Date.now(),
    };
    const existing = readJson<BaristaWasteLog[]>(STORAGE_WASTE) ?? [];
    writeJson(STORAGE_WASTE, [wasteLog, ...existing]);
    window.alert(`Recorded waste: 1 x ${item.name}`);
  };

  const baristaCapitalTotal = useMemo(
    () => baristaInventoryRows.reduce((sum, item) => sum + item.capital, 0),
    [baristaInventoryRows],
  );
  const totalBaristaRevenue = useMemo(
    () => {
      const itemizedRevenue = baristaInventoryRows.reduce((sum, item) => sum + item.revenue, 0);
      const fallbackRevenue = baristaPayments
        .filter((payment) => !Array.isArray(payment.lines) || payment.lines.length === 0)
        .reduce((sum, payment) => sum + (payment.total || 0), 0);

      return itemizedRevenue + fallbackRevenue;
    },
    [baristaInventoryRows, baristaPayments],
  );
  const baristaProfitLoss = useMemo(
    () => totalBaristaRevenue - baristaCapitalTotal,
    [baristaCapitalTotal, totalBaristaRevenue],
  );
  const filteredDirectorSalesPayments = useMemo(
    () =>
      [...baristaPayments]
        .filter((payment) => matchesSalesDateFilter(payment.createdAt, directorSalesDateFilter))
        .sort((a, b) => b.createdAt - a.createdAt),
    [baristaPayments, directorSalesDateFilter],
  );
  const directorSalesRows = useMemo(
    () =>
      filteredDirectorSalesPayments.flatMap((payment) => {
        if (!Array.isArray(payment.lines) || payment.lines.length === 0) {
          return [
            {
              id: payment.id,
              code: payment.code,
              createdAt: payment.createdAt,
              itemName: "Unitemized sale",
              quantity: 1,
              destination: payment.destination,
              method: payment.method,
              status: payment.status,
              amount: payment.total,
            },
          ];
        }

        return payment.lines.map((line, index) => {
          const price = baristaMenuPriceByItem.get(normalizeBaristaTarget(line.name)) ?? 0;
          const amount = price > 0
            ? line.qty * price
            : payment.lines?.length === 1
              ? payment.total
              : 0;

          return {
            id: `${payment.id}-${index}`,
            code: payment.code,
            createdAt: payment.createdAt,
            itemName: line.name,
            quantity: line.qty,
            destination: payment.destination,
            method: payment.method,
            status: payment.status,
            amount,
          };
        });
      }),
    [baristaMenuPriceByItem, filteredDirectorSalesPayments],
  );
  const directorSalesQuantityTotal = useMemo(
    () => directorSalesRows.reduce((sum, row) => sum + row.quantity, 0),
    [directorSalesRows],
  );
  const directorSalesAmountTotal = useMemo(
    () => filteredDirectorSalesPayments.reduce((sum, payment) => sum + payment.total, 0),
    [filteredDirectorSalesPayments],
  );

  const renderFinanceTable = () => (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Finance</CardTitle>
        <CardDescription>
          Capital = quantity in stock x buying price. Revenue = quantity sold x selling price. Profit/Loss = revenue - capital.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Stock Qty</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Qty Sold</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Buying Price</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Capital</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Selling Price</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Revenue</TableHead>
              <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Profit/Loss</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {baristaInventoryRows.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-bold">{item.displayName}</TableCell>
                <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                <TableCell className="font-bold">{item.quantitySold}</TableCell>
                <TableCell className="font-bold">
                  {item.buyingPrice > 0 ? `TSh ${item.buyingPrice.toLocaleString()}` : "-"}
                </TableCell>
                <TableCell className="font-bold">TSh {item.capital.toLocaleString()}</TableCell>
                <TableCell className="font-bold">
                  {item.sellingPrice > 0 ? `TSh ${item.sellingPrice.toLocaleString()}` : "-"}
                </TableCell>
                <TableCell className="font-bold">TSh {item.revenue.toLocaleString()}</TableCell>
                <TableCell className={`font-bold ${item.profitLoss >= 0 ? "text-green-600" : "text-red-600"}`}>
                  TSh {item.profitLoss.toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {baristaInventoryRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                  No barista finance records
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  const renderDirectorSalesTable = () => (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-black uppercase tracking-tight">Barista Sales</h2>
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Itemized sales captured from barista POS settlements.
          </p>
        </div>
        <Tabs value={directorSalesDateFilter} onValueChange={(value) => setDirectorSalesDateFilter(value as SalesDateFilter)}>
          <TabsList className="h-10">
            <TabsTrigger value="day" className="font-black uppercase text-[10px] tracking-widest">Day</TabsTrigger>
            <TabsTrigger value="week" className="font-black uppercase text-[10px] tracking-widest">Week</TabsTrigger>
            <TabsTrigger value="month" className="font-black uppercase text-[10px] tracking-widest">Month</TabsTrigger>
            <TabsTrigger value="all" className="font-black uppercase text-[10px] tracking-widest">All Time</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Sales Records</p>
            <p className="mt-2 text-2xl font-black">{filteredDirectorSalesPayments.length}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Items Sold</p>
            <p className="mt-2 text-2xl font-black">{directorSalesQuantityTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Sales Total</p>
            <p className="mt-2 text-2xl font-black">TSh {directorSalesAmountTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">Sold Items</CardTitle>
          <CardDescription>Filter by day, week, month, or all time.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Date</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Code</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item Sold</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Qty</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Destination</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Method</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {directorSalesRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-bold text-sm">{formatPaymentDate(row.createdAt)}</TableCell>
                  <TableCell className="font-black">{row.code}</TableCell>
                  <TableCell className="font-bold">{row.itemName}</TableCell>
                  <TableCell className="font-bold">{row.quantity}</TableCell>
                  <TableCell className="font-bold">{row.destination}</TableCell>
                  <TableCell className="font-black uppercase text-[10px] tracking-widest">{row.method}</TableCell>
                  <TableCell className="font-black uppercase text-[10px] tracking-widest">{row.status}</TableCell>
                  <TableCell className="font-bold">TSh {row.amount.toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {directorSalesRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                    No sales found for this filter
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );

  const activeBaristaProfile = useMemo(() => readLocalLoginProfiles()?.barista ?? null, [activeUsername, role]);

  if (!posHydrated) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <p className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">Syncing Barista POS</p>
          <h1 className="mt-3 text-2xl font-black uppercase tracking-tight">Loading live menu...</h1>
        </div>
      </div>
    );
  }

  const updateBaristaPassword = async () => {
    if (role !== "barista") {
      setPasswordFeedback({ type: "error", message: "Only logged-in barista users can change barista passwords." });
      return;
    }

    const normalizedUsername = activeUsername.trim();
    if (!normalizedUsername) {
      setPasswordFeedback({ type: "error", message: "No active barista user found in this session." });
      return;
    }

    const expectedPassword = getProfilePassword(activeBaristaProfile, normalizedUsername, DEFAULT_LOGIN_PASSWORD);
    if (currentPasswordInput !== expectedPassword) {
      setPasswordFeedback({ type: "error", message: "Current password is incorrect." });
      return;
    }

    const nextPassword = newPasswordInput.trim();
    if (nextPassword.length < 4) {
      setPasswordFeedback({ type: "error", message: "New password must be at least 4 characters." });
      return;
    }

    if (nextPassword !== confirmPasswordInput.trim()) {
      setPasswordFeedback({ type: "error", message: "New password and confirmation do not match." });
      return;
    }

    const profiles = readLocalLoginProfiles() ?? {};
    const nextEntry = upsertProfileUser(profiles.barista, normalizedUsername, {
      password: nextPassword,
      updatedAt: Date.now(),
    });
    const saved = await saveLoginProfileToServer("barista", nextEntry);
    if (!saved) {
      setPasswordFeedback({ type: "error", message: "Password was not saved to the backend. No local change was applied." });
      return;
    }

    setCurrentPasswordInput("");
    setNewPasswordInput("");
    setConfirmPasswordInput("");
    setPasswordFeedback({
      type: "success",
      message: `Password updated for ${normalizedUsername}.`,
    });
  };

  const addToCart = (item: BaristaMenuItem) => {
    if (isDirector) return;
    setCart((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      if (existing) {
        return current.map((line) => (line.item.id === item.id ? { ...line, qty: line.qty + 1 } : line));
      }
      return [...current, { item, qty: 1 }];
    });
  };

  const increaseQty = (itemId: string) => {
    if (isDirector) return;
    setCart((current) => current.map((line) => (line.item.id === itemId ? { ...line, qty: line.qty + 1 } : line)));
  };

  const decreaseQty = (itemId: string) => {
    if (isDirector) return;
    setCart((current) =>
      current
        .map((line) => (line.item.id === itemId ? { ...line, qty: Math.max(0, line.qty - 1) } : line))
        .filter((line) => line.qty > 0),
    );
  };

  const removeLine = (itemId: string) => {
    if (isDirector) return;
    setCart((current) => current.filter((line) => line.item.id !== itemId));
  };

  const clearCart = async () => {
    if (isDirector) return;
    const approved = await confirm({
      title: "Clear Barista Ticket",
      description: "Are you sure you want to clear the current ticket?",
      actionLabel: "Clear Ticket",
    });
    if (!approved) return;
    setCart([]);
  };

  const placeTicket = () => {
    if (isDirector) return;
    if (cart.length === 0) return;

    const destination =
      serviceMode === "room-service"
        ? `Room ${roomNumber.trim()}`
        : serviceMode === "restaurant"
        ? `Table ${tableNumber.trim()}`
        : "Take Away";

    if (serviceMode === "room-service" && !roomNumber.trim()) {
      window.alert("Enter the room number for room service.");
      return;
    }

    if (serviceMode === "restaurant" && !tableNumber.trim()) {
      window.alert("Enter the table number for restaurant service.");
      return;
    }

      setPendingOrder({
        mode: serviceMode,
        destination,
        lines: cart.map((line) => ({ name: line.item.name, qty: line.qty })),
        total: subtotal,
      });
      setShowPayNowPopup(false);
      setShowSettlementPopup(true);
    };

  const finalizeOrder = async (status: BaristaPaymentStatus, method: BaristaPaymentMethod) => {
    if (isDirector) return;
    if (!pendingOrder) return;

    const stockResult = updateBaristaStoreStock(pendingOrder.lines, "consume");
    if (!stockResult.ok) {
      window.alert(stockResult.error);
      return;
    }

    const nextSeq = ticketSeq + 1;
    const createdAt = Date.now();
    setTicketSeq(nextSeq);

    const orderId = `bt-${createdAt}`;
    const code = `B-${nextSeq}`;

    const ticket: BaristaTicket = {
      id: orderId,
      code,
      createdAt,
      mode: pendingOrder.mode,
      destination: pendingOrder.destination,
      lines: pendingOrder.lines,
      total: pendingOrder.total,
    };

    const paymentRecord: BaristaPaymentRecord = {
      id: `bp-${createdAt}`,
      ticketId: orderId,
      code,
      createdAt,
      mode: pendingOrder.mode,
      destination: pendingOrder.destination,
      total: pendingOrder.total,
      status,
      method,
      lines: pendingOrder.lines,
    };

    const nextTickets = [ticket, ...tickets];
    const nextPayments = [paymentRecord, ...baristaPayments];
    setTickets(nextTickets);
    setBaristaPayments(nextPayments);
    writePosState(getActiveBaristaStateKey(), nextTickets, nextSeq, nextPayments, storedMenuItems);

    setCart([]);
    setPendingOrder(null);
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);

    const printResult = await printDepartmentReceipt({
      department: "barista",
      code,
      destination: pendingOrder.destination,
      mode: pendingOrder.mode,
      method,
      status,
      total: pendingOrder.total,
      createdAt,
      lines: pendingOrder.lines,
    });

    if (!printResult.ok && printResult.reason) {
      window.alert(`Barista receipt was not printed: ${printResult.reason}`);
    }
  };

  const deliverTicket = async (id: string) => {
    if (isDirector || deliveringTicketId) return;
    const approved = await confirm({
      title: "Deliver Barista Order",
      description: "Are you sure you want to mark this barista order as delivered?",
      actionLabel: "Deliver",
    });
    if (!approved) return;
    setDeliveringTicketId(id);
    try {
      const activeBaristaKey = getActiveBaristaStateKey();
      const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
        activeBaristaKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        490,
      );
      const sourceTickets = snapshot.tickets.length > 0 ? snapshot.tickets : tickets;
      const sourcePayments = snapshot.payments.length > 0 ? snapshot.payments : baristaPayments;
      const sourceMenuItems = snapshot.menuItems.length > 0 ? snapshot.menuItems : storedMenuItems;
      const deliveredAt = Date.now();
      const nextTickets = sourceTickets.map((ticket) =>
        ticket.id === id ? { ...ticket, status: "delivered" as const, deliveredAt } : ticket,
      );

      setTickets(nextTickets);
      setTicketSeq(snapshot.ticketSeq);
      setBaristaPayments(sourcePayments);
      setStoredMenuItems(sourceMenuItems);
      writePosState(activeBaristaKey, nextTickets, snapshot.ticketSeq, sourcePayments, sourceMenuItems);
    } finally {
      setDeliveringTicketId(null);
    }
  };

  const cancelTicket = async (id: string) => {
    if (isDirector) return;
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    if (ticket.status === "delivered") return;
    const approved = await confirm({
      title: "Cancel Barista Order",
      description: "Are you sure you want to cancel this barista order?",
      actionLabel: "Cancel Order",
    });
    if (!approved) return;

    const stockResult = updateBaristaStoreStock(ticket.lines, "restore");
    if (!stockResult.ok) {
      window.alert(stockResult.error);
      return;
    }

    const cancelled: CancelledBaristaTicket = {
      ...ticket,
      source: "barista",
      cancelledAt: Date.now(),
    };

    const existing = readJson<CancelledBaristaTicket[]>(STORAGE_CANCELLED) ?? [];
    writeJson(STORAGE_CANCELLED, [cancelled, ...existing]);

    const nextTickets = tickets.filter((ticket) => ticket.id !== id);
    setTickets(nextTickets);
    writePosState(getActiveBaristaStateKey(), nextTickets, ticketSeq, baristaPayments, storedMenuItems);
  };

  const saveDrink = () => {
    const name = drinkName.trim();
    const price = parseFloat(drinkPrice);
    if (!name || isNaN(price) || price < 0) return;
    const prep = Math.max(0, parseInt(drinkPrepMinutes, 10) || 5);

    const activeBaristaKey = getActiveBaristaStateKey();
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    let next: BaristaMenuItem[];
    if (drinkEditId) {
      next = snapshot.menuItems.map((item) =>
        item.id === drinkEditId ? { ...item, name, price, category: drinkCategory, prepMinutes: prep } : item,
      );
    } else {
      const newDrink: BaristaMenuItem = {
        id: `d-${Date.now()}`,
        name,
        price,
        category: drinkCategory,
        prepMinutes: prep,
      };
      next = [...snapshot.menuItems, newDrink];
    }
    writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, next);
    setStoredMenuItems(next);
    setDrinkEditId(null);
    setDrinkName("");
    setDrinkPrice("");
    setDrinkPrepMinutes("5");
    setDrinkCategory("coffee");
  };

  const startEditDrink = (item: BaristaMenuItem) => {
    setDrinkEditId(item.id);
    setDrinkName(item.name);
    setDrinkPrice(String(item.price));
    setDrinkCategory(item.category);
    setDrinkPrepMinutes(String(item.prepMinutes));
  };

  const deleteDrink = async (id: string) => {
    const approved = await confirm({
      title: "Delete Drink",
      description: "Are you sure you want to remove this drink from the menu?",
      actionLabel: "Delete",
    });
    if (!approved) return;
    const activeBaristaKey = getActiveBaristaStateKey();
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const next = snapshot.menuItems.filter((item) => item.id !== id);
    writePosState(activeBaristaKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, next);
    setStoredMenuItems(next);
    if (drinkEditId === id) {
      setDrinkEditId(null);
      setDrinkName("");
      setDrinkPrice("");
    }
  };

  const DRINK_CATEGORIES: Array<Exclude<BaristaCategory, "all">> = [
    "espresso", "coffee", "tea", "cold", "snacks",
  ];

  const renderDrinksManager = () => (
    <div className="space-y-6">
      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">
            {drinkEditId ? "Edit Drink" : "Add New Drink"}
          </CardTitle>
          <CardDescription>
            {drinkEditId ? "Update the drink details below, then save." : "Enter drink name, price, category and prep time, then save."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Drink Name</p>
            <Input
              value={drinkName}
              onChange={(e) => setDrinkName(e.target.value)}
              placeholder="e.g. Cappuccino"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Price (TSh)</p>
            <Input
              type="number"
              min="0"
              value={drinkPrice}
              onChange={(e) => setDrinkPrice(e.target.value)}
              placeholder="e.g. 3500"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Category</p>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-medium"
              value={drinkCategory}
              onChange={(e) => setDrinkCategory(e.target.value as Exclude<BaristaCategory, "all">)}
            >
              {DRINK_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Prep Time (min)</p>
            <Input
              type="number"
              min="0"
              value={drinkPrepMinutes}
              onChange={(e) => setDrinkPrepMinutes(e.target.value)}
              placeholder="e.g. 5"
            />
          </div>
          <div className="md:col-span-2 lg:col-span-4 flex gap-2">
            <Button onClick={saveDrink} className="gap-2">
              <Plus className="h-4 w-4" />
              {drinkEditId ? "Save Changes" : "Add Drink"}
            </Button>
            {drinkEditId && (
              <Button variant="outline" onClick={() => { setDrinkEditId(null); setDrinkName(""); setDrinkPrice(""); setDrinkPrepMinutes("5"); setDrinkCategory("coffee"); }}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">Drinks Menu</CardTitle>
          <CardDescription>{storedMenuItems.length} drink{storedMenuItems.length !== 1 ? "s" : ""} on menu</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Name</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Category</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Price (TSh)</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Prep (min)</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {storedMenuItems.map((item) => (
                <TableRow key={item.id} className={drinkEditId === item.id ? "bg-primary/5" : ""}>
                  <TableCell className="font-bold">{item.name}</TableCell>
                  <TableCell className="font-bold capitalize">{item.category}</TableCell>
                  <TableCell className="font-bold">TSh {item.price.toLocaleString()}</TableCell>
                  <TableCell className="font-bold">{item.prepMinutes} min</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => startEditDrink(item)}>
                        <Pencil className="h-3 w-3 mr-1" /> Edit
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 px-2 text-red-600 hover:text-red-700 hover:border-red-300" onClick={() => deleteDrink(item.id)}>
                        <Trash2 className="h-3 w-3 mr-1" /> Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {storedMenuItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                    No drinks on menu yet. Add one above.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );

  if (isManager) {
  return (
    <div className="space-y-6">
      {dialog}
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <Coffee className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight">Barista Setup</h1>
              <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
                Inventory visibility for barista operations
              </p>
            </div>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Barista Orange Capital</p>
              <p className="mt-2 text-2xl font-black">TSh {baristaCapitalTotal.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Barista Orange Revenue</p>
              <p className="mt-2 text-2xl font-black">TSh {totalBaristaRevenue.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Profit And Loss</p>
              <p className={`mt-2 text-2xl font-black ${baristaProfitLoss >= 0 ? "text-green-600" : "text-red-600"}`}>
                TSh {baristaProfitLoss.toLocaleString()}
              </p>
            </CardContent>
          </Card>
        </div>
        <Tabs value={managerTab} onValueChange={(value) => setManagerTab(value as "inventory" | "finance" | "sales" | "drinks")}>
          <TabsList className="h-10">
            <TabsTrigger value="finance" className="font-black uppercase text-[10px] tracking-widest">Finance</TabsTrigger>
            <TabsTrigger value="inventory" className="font-black uppercase text-[10px] tracking-widest">Inventory</TabsTrigger>
            <TabsTrigger value="sales" className="font-black uppercase text-[10px] tracking-widest">Sales</TabsTrigger>
            <TabsTrigger value="drinks" className="font-black uppercase text-[10px] tracking-widest">Drinks</TabsTrigger>
          </TabsList>
        </Tabs>
        {managerTab === "drinks" ? renderDrinksManager() : managerTab === "finance" ? renderFinanceTable() : managerTab === "sales" ? renderDirectorSalesTable() : (
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Inventory & Pricing</CardTitle>
              <CardDescription>
                Buying price is the supplier cost (used only for costing). Selling price is what the POS charges. Edit either field and click away to save.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/10">
                  <TableRow>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Quantity</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Qty Sold</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Buying Price (Cost)</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Selling Price (POS)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {baristaManagerPricingRows.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-bold">{item.name}</TableCell>
                      <TableCell className="font-bold">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min="0"
                            defaultValue={item.stock}
                            className="h-9 w-20"
                            onBlur={(event) => {
                              const value = parseInt(event.target.value, 10);
                              if (!Number.isFinite(value) || value < 0) return;
                              if (value === item.stock) return;
                              updateBaristaItemStock(
                                { name: item.name, category: item.category, buyingPrice: item.buyingPrice, sellingPrice: item.sellingPrice },
                                value,
                              );
                            }}
                          />
                          {item.unit ? (
                            <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{item.unit}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="font-bold">{item.quantitySold}</TableCell>
                      <TableCell className="font-bold">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">TSh</span>
                          <Input
                            type="number"
                            min="0"
                            defaultValue={item.buyingPrice > 0 ? item.buyingPrice : ""}
                            placeholder="0"
                            className="h-9 w-28"
                            onBlur={(event) => {
                              const value = parseFloat(event.target.value);
                              if (!Number.isFinite(value) || value < 0) return;
                              if (value === item.buyingPrice) return;
                              updateBaristaItemPricing(item.name, { buyingPrice: value });
                            }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="font-bold">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">TSh</span>
                          <Input
                            type="number"
                            min="0"
                            defaultValue={item.sellingPrice > 0 ? item.sellingPrice : ""}
                            placeholder="0"
                            className="h-9 w-28"
                            onBlur={(event) => {
                              const value = parseFloat(event.target.value);
                              if (!Number.isFinite(value) || value < 0) return;
                              if (value === item.sellingPrice) return;
                              updateBaristaItemPricing(item.name, { price: value });
                            }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {baristaManagerPricingRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                        No barista menu items yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  if (isDirector) {
    return (
      <div className="space-y-6">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <Coffee className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight">Barista Analytics</h1>
              <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
                Managing Director read-only controls
              </p>
            </div>
          </div>
          <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
            {baristaPayments.length} Sales Records
          </Badge>
        </header>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Barista Orange Capital</p>
              <p className="mt-2 text-2xl font-black">TSh {baristaCapitalTotal.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Barista Orange Revenue</p>
              <p className="mt-2 text-2xl font-black">TSh {totalBaristaRevenue.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card className="border-none shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Profit And Loss</p>
              <p className={`mt-2 text-2xl font-black ${baristaProfitLoss >= 0 ? "text-green-600" : "text-red-600"}`}>
                TSh {baristaProfitLoss.toLocaleString()}
              </p>
            </CardContent>
          </Card>
        </div>

        <Tabs value={directorTab} onValueChange={(value) => setDirectorTab(value as "inventory" | "finance" | "purchases" | "sales")}>
          <TabsList className="h-10">
            <TabsTrigger value="inventory" className="font-black uppercase text-[10px] tracking-widest">Stock / Inventory</TabsTrigger>
            <TabsTrigger value="finance" className="font-black uppercase text-[10px] tracking-widest">Finances</TabsTrigger>
            <TabsTrigger value="sales" className="font-black uppercase text-[10px] tracking-widest">Sales</TabsTrigger>
            <TabsTrigger value="purchases" className="font-black uppercase text-[10px] tracking-widest">Purchases</TabsTrigger>
          </TabsList>
        </Tabs>

        {directorTab === "inventory" ? (
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Inventory from Store</CardTitle>
              <CardDescription>Store additions plus received, used, and remaining quantities</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/10">
                  <TableRow>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Store Qty</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Qty Sold</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Selling Price</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Revenue</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Profit/Loss</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Tot Status</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Received</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Used</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {baristaInventoryRows.map((item) => {
                    const itemEntries = fromStoreEntries.filter((entry) => entry.itemName === item.name);
                    const received = itemEntries.reduce((sum, entry) => sum + entry.convertedQty, 0);
                    const used = itemEntries.reduce((sum, entry) => sum + getUsedQty(entry.id), 0);
                    const remaining = Math.max(0, received - used);
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-bold">{item.displayName}</TableCell>
                        <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                        <TableCell className="font-bold">{item.quantitySold}</TableCell>
                        <TableCell className="font-bold">
                          {item.sellingPrice > 0 ? `TSh ${item.sellingPrice.toLocaleString()}` : "-"}
                        </TableCell>
                        <TableCell className="font-bold">TSh {item.revenue.toLocaleString()}</TableCell>
                        <TableCell className={`font-bold ${item.profitLoss >= 0 ? "text-green-600" : "text-red-600"}`}>
                          TSh {item.profitLoss.toLocaleString()}
                        </TableCell>
                        <TableCell className="font-bold">{formatTotStatus(item)}</TableCell>
                        <TableCell className="font-bold">{received} units</TableCell>
                        <TableCell className="font-bold">{used} units</TableCell>
                        <TableCell className="font-bold">{remaining} units</TableCell>
                      </TableRow>
                    );
                  })}
                  {baristaStoreItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                        No inventory records
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : directorTab === "finance" ? (
          <div className="space-y-6">
            {renderFinanceTable()}
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl font-black uppercase tracking-tight">Payment Records</CardTitle>
                <CardDescription>Completed and credit sales records from barista settlements</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="bg-muted/10">
                    <TableRow>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Code</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Destination</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Method</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Amount</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {baristaPayments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell className="font-black">{payment.code}</TableCell>
                        <TableCell className="font-bold">{payment.destination}</TableCell>
                        <TableCell className="font-black uppercase text-[10px] tracking-widest">{payment.status}</TableCell>
                        <TableCell className="font-black uppercase text-[10px] tracking-widest">{payment.method}</TableCell>
                        <TableCell className="font-bold">TSh {payment.total.toLocaleString()}</TableCell>
                        <TableCell className="font-bold text-sm">{new Date(payment.createdAt).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    {baristaPayments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                          No sales records
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        ) : directorTab === "sales" ? (
          renderDirectorSalesTable()
        ) : (
          <KitchenSessionManager isDirector department="barista" visibleTabs={["purchase"]} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {dialog}
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
            <Coffee className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight">Barista POS</h1>
            <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
              Order intake and delivery control
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SyncStatusIndicator />
          <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
            {activeTickets.length} Active Orders
          </Badge>
        </div>
      </header>
      {isDirector && (
        <Card className="border-emerald-200 bg-emerald-50/60 shadow-none">
          <CardContent className="p-3 text-xs font-black uppercase tracking-widest text-emerald-700">
            Managing Director View: Barista operations analytics and stock visibility only
          </CardContent>
        </Card>
      )}

      {role === "barista" && !isDirector && (
        <Card className="border-none shadow-sm">
          <CardHeader>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Account</CardTitle>
                <CardDescription>Manage the active barista session and account password.</CardDescription>
              </div>
              <Tabs value={accountTab} onValueChange={(value) => setAccountTab(value as "session" | "password")}>
                <TabsList className="grid w-full grid-cols-2 md:w-[260px] h-10">
                  <TabsTrigger value="session" className="font-black uppercase text-[10px] tracking-widest">Session</TabsTrigger>
                  <TabsTrigger value="password" className="font-black uppercase text-[10px] tracking-widest">Change Password</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent>
            {accountTab === "session" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border bg-muted/20 p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">Logged In User</p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-100 text-orange-700">
                      <User className="h-4 w-4" />
                    </div>
                    <p className="text-xl font-black">{activeUsername || "BARISTA"}</p>
                  </div>
                </div>
                <div className="rounded-2xl border bg-muted/20 p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">Password Control</p>
                  <p className="mt-3 text-sm font-bold text-muted-foreground">
                    Use the change-password tab to update only this user&apos;s login password.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Current Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input type="password" value={currentPasswordInput} onChange={(event) => setCurrentPasswordInput(event.target.value)} className="pl-10 h-11" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input type="password" value={newPasswordInput} onChange={(event) => setNewPasswordInput(event.target.value)} className="pl-10 h-11" />
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Confirm New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input type="password" value={confirmPasswordInput} onChange={(event) => setConfirmPasswordInput(event.target.value)} className="pl-10 h-11" />
                  </div>
                </div>
                {passwordFeedback && (
                  <div className={`rounded-xl border px-4 py-3 text-xs font-black uppercase tracking-widest md:col-span-2 ${passwordFeedback.type === "success" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
                    {passwordFeedback.message}
                  </div>
                )}
                <div className="md:col-span-2 flex justify-end">
                  <Button
                    onClick={() => void updateBaristaPassword()}
                    className="h-11 font-black uppercase text-[10px] tracking-widest"
                    disabled={!currentPasswordInput || !newPasswordInput || !confirmPasswordInput}
                  >
                    Update Password
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Completed Sales</p>
            <p className="mt-2 text-2xl font-black">TSh {completedSalesTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Credit Sales</p>
            <p className="mt-2 text-2xl font-black">TSh {creditSalesTotal.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Sales Records</p>
            <p className="mt-2 text-2xl font-black">{baristaPayments.length}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <div className="xl:col-span-2 space-y-6">
          <Card className="border-none shadow-sm">
            <CardHeader className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => {
                    const val = event.target.value;
                    setSearchTerm(val);
                    // Barcode Search Logic
                    const match = menuItems.find(i => i.barcode === val.trim());
                    if (match) {
                      addToCart(match);
                      setSearchTerm(""); // Clear for next scan
                    }
                  }}
                  placeholder="Search drinks or scan barcode..."
                  className="pl-10 h-12"
                  autoFocus
                />
              </div>

              <Tabs value={category} onValueChange={(value) => setCategory(value as BaristaCategory)}>
                <TabsList className="w-full grid grid-cols-3 md:grid-cols-6 h-auto gap-1 bg-muted/30 p-1.5 rounded-xl">
                  <TabsTrigger value="all" className="font-black uppercase text-[10px] tracking-widest rounded-lg">All</TabsTrigger>
                  <TabsTrigger value="espresso" className="font-black uppercase text-[10px] tracking-widest rounded-lg">Espresso</TabsTrigger>
                  <TabsTrigger value="coffee" className="font-black uppercase text-[10px] tracking-widest rounded-lg">Coffee</TabsTrigger>
                  <TabsTrigger value="tea" className="font-black uppercase text-[10px] tracking-widest rounded-lg">Tea</TabsTrigger>
                  <TabsTrigger value="cold" className="font-black uppercase text-[10px] tracking-widest rounded-lg">Cold</TabsTrigger>
                  <TabsTrigger value="snacks" className="font-black uppercase text-[10px] tracking-widest rounded-lg">Snacks</TabsTrigger>
                </TabsList>
              </Tabs>

              <Tabs value={serviceMode} onValueChange={(value) => setServiceMode(value as ServiceMode)}>
                <TabsList className="w-full grid grid-cols-3 h-11 bg-muted/30 rounded-xl">
                  <TabsTrigger value="restaurant" className="font-black uppercase text-[10px] tracking-widest">Restaurant</TabsTrigger>
                  <TabsTrigger value="room-service" className="font-black uppercase text-[10px] tracking-widest">Room Service</TabsTrigger>
                  <TabsTrigger value="take-away" className="font-black uppercase text-[10px] tracking-widest">Take Away</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredMenu.map((item) => {
                  const stockStatus = getMenuStockStatus(baristaStoreItems, item.name);
                  return (
                  <div
                    key={item.id}
                    className={`flex flex-col text-left bg-white border rounded-2xl p-5 transition-all hover:border-primary/50 hover:shadow-md ${!stockStatus.available ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <Badge variant="outline" className="uppercase text-[9px] font-black tracking-widest">
                          {item.category}
                      </Badge>
                        <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest text-right">
                          <span className="block">{stockStatus.label}</span>
                          {item.prepMinutes} min
                        </span>
                      </div>
                      <h3 className="font-black text-lg leading-tight">{item.name}</h3>
                      <span className="mt-4 font-black">TSh {(item.price || 0).toLocaleString()}</span>
                      <div className="mt-4 flex items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => addToCart(item)}
                          disabled={!stockStatus.available || isDirector}
                          className="h-9 flex-1 gap-1 font-black uppercase text-[10px] tracking-widest"
                        >
                          <Plus className="w-4 h-4" /> Add
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void recordWaste(item)}
                          disabled={isDirector}
                          className="h-9 gap-1 font-black uppercase text-[10px] tracking-widest text-red-600 hover:text-red-700 hover:border-red-300"
                        >
                          <Trash2 className="w-4 h-4" /> Waste
                        </Button>
                      </div>
                  </div>
                )})}

                {filteredMenu.length === 0 && (
                  <div className="col-span-full text-center py-10 opacity-50">
                    <p className="font-black uppercase tracking-widest text-xs">No drinks found</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Operations</CardTitle>
              <CardDescription>Queue, delivered records, and stock received from Main Store</CardDescription>
              <Tabs value={queueTab} onValueChange={(value) => setQueueTab(value as "queue" | "from-store")}>
                <TabsList className="w-full md:w-[280px] grid grid-cols-2 h-10 bg-muted/30 rounded-xl">
                  <TabsTrigger value="queue" className="font-black uppercase text-[10px] tracking-widest">Queue</TabsTrigger>
                  <TabsTrigger value="from-store" className="font-black uppercase text-[10px] tracking-widest">From Store</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent className="p-0">
              {queueTab === "queue" ? (
                <Table>
                  <TableHeader className="bg-muted/10">
                    <TableRow>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Ticket</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Details</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Total</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12 text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderedTickets.map((ticket) => {
                      const isDelivered = ticket.status === "delivered";

                      return (
                        <TableRow key={ticket.id} className={isDelivered ? "bg-green-50/50" : undefined}>
                          <TableCell className="font-black">
                            <p>{ticket.code}</p>
                            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mt-1">
                              {ticket.mode} | {ticket.destination}
                            </p>
                            {isDelivered && (
                              <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-green-700">
                                Delivered {ticket.deliveredAt ? new Date(ticket.deliveredAt).toLocaleString() : ""}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="font-bold text-sm">
                            {ticket.lines.map((line) => `${line.name} x${line.qty}`).join(" | ")}
                          </TableCell>
                          <TableCell className="font-black">TSh {ticket.total.toLocaleString()}</TableCell>
                          <TableCell className="text-right">
                            {isDelivered ? (
                              <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                                <CheckCircle2 className="w-4 h-4 mr-1" /> Delivered
                              </Badge>
                            ) : (
                              <div className="flex justify-end gap-2">
                                <Button onClick={() => deliverTicket(ticket.id)} disabled={isDirector || deliveringTicketId === ticket.id} className="h-9 font-black uppercase text-[10px] tracking-widest bg-green-600 hover:bg-green-600/90">
                                  <CheckCircle2 className="w-4 h-4 mr-1" /> {deliveringTicketId === ticket.id ? "Saving" : "Delivered"}
                                </Button>
                                <Button onClick={() => cancelTicket(ticket.id)} disabled={isDirector} className="h-9 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white">
                                  <XCircle className="w-4 h-4 mr-1" /> Cancelled
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}

                    {orderedTickets.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-12 text-center opacity-40">
                          <Coffee className="w-12 h-12 mx-auto mb-3" />
                          <p className="font-black uppercase tracking-widest text-xs">No orders in queue</p>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              ) : (
                <div className="space-y-3 p-4">
                  <Table>
                    <TableHeader className="bg-muted/10">
                      <TableRow>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Store Item</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Qty</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Tot Status</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Low Threshold</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {baristaStoreItems.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-bold">{item.name}</TableCell>
                          <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                          <TableCell className="font-bold">{formatTotStatus(item)}</TableCell>
                          <TableCell className="font-bold">{item.minStock}</TableCell>
                          <TableCell className="font-black uppercase text-[10px] tracking-widest">
                            {item.stock <= 0 ? "Out" : item.stock < item.minStock ? "Low" : "In Stock"}
                          </TableCell>
                        </TableRow>
                      ))}
                      {baristaStoreItems.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="py-8 text-center opacity-40">
                            <p className="font-black uppercase tracking-widest text-xs">No stock added from inventory yet</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={useEntryId}
                      onChange={(event) => setUseEntryId(event.target.value)}
                    >
                      <option value="">Select item to use</option>
                      {fromStoreEntries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.itemName}
                        </option>
                      ))}
                    </select>
                    <Input type="number" min="1" value={useQty} onChange={(event) => setUseQty(event.target.value)} placeholder="Usage quantity" />
                    <Button className="h-10 font-black uppercase text-[10px] tracking-widest" onClick={addUsage} disabled={!useEntryId}>
                      Record Usage
                    </Button>
                  </div>

                  <Table>
                    <TableHeader className="bg-muted/10">
                      <TableRow>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Quantity Received</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Used</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Remaining</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Conversion</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Date</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fromStoreEntries.map((entry) => {
                        const used = getUsedQty(entry.id);
                        const remaining = Math.max(0, entry.convertedQty - used);
                        return (
                          <TableRow key={entry.id}>
                            <TableCell className="font-bold">{entry.itemName}</TableCell>
                            <TableCell className="font-bold">{entry.convertedQty} units</TableCell>
                            <TableCell className="font-bold">{used} units</TableCell>
                            <TableCell className="font-bold">{remaining} units</TableCell>
                            <TableCell className="font-bold">1 {entry.storeUnit} = {entry.conversionValue} units</TableCell>
                            <TableCell className="font-bold text-sm">{new Date(entry.movedAt).toLocaleString()}</TableCell>
                            <TableCell className="font-black uppercase text-[10px] tracking-widest">Store</TableCell>
                          </TableRow>
                        );
                      })}
                      {fromStoreEntries.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="py-12 text-center opacity-40">
                            <p className="font-black uppercase tracking-widest text-xs">No stock received from store</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-2xl border-none bg-white overflow-hidden">
          <div className="h-1.5 bg-primary" />
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl font-black uppercase tracking-tight">Current Ticket</CardTitle>
              <Badge variant="outline" className="font-black uppercase text-[10px] tracking-widest">
                {cart.reduce((count, line) => count + line.qty, 0)} items
              </Badge>
            </div>
            <CardDescription>Prepare and place a barista order</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {serviceMode === "room-service" ? (
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Room Number</label>
                <Input
                  list="barista-room-numbers"
                  value={roomNumber}
                  onChange={(event) => setRoomNumber(event.target.value)}
                  placeholder="Enter room number"
                />
                <datalist id="barista-room-numbers">
                  {roomSuggestions.map((room) => (
                    <option key={room} value={room} />
                  ))}
                </datalist>
              </div>
            ) : serviceMode === "restaurant" ? (
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Table Number</label>
                <Input
                  list="barista-table-numbers"
                  value={tableNumber}
                  onChange={(event) => setTableNumber(event.target.value)}
                  placeholder="Enter table number"
                />
                <datalist id="barista-table-numbers">
                  {tableSuggestions.map((table) => (
                    <option key={table} value={table} />
                  ))}
                </datalist>
              </div>
            ) : (
              <div className="rounded-xl border p-3 bg-muted/20">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Service Type</p>
                <p className="font-bold">Take Away</p>
              </div>
            )}

            {cart.length === 0 ? (
              <div className="h-44 rounded-xl border border-dashed flex flex-col items-center justify-center text-center opacity-40">
                <Receipt className="w-10 h-10 mb-2" />
                <p className="font-black uppercase tracking-widest text-[10px]">Ticket is empty</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                {cart.map((line) => (
                  <div key={line.item.id} className="border rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-bold leading-tight">{line.item.name}</p>
                        <p className="text-[10px] text-muted-foreground font-black uppercase tracking-widest mt-1">
                          TSh {(line.item.price || 0).toLocaleString()} each
                        </p>
                      </div>
                      <button
                        onClick={() => removeLine(line.item.id)}
                        className="p-1.5 rounded-md text-destructive hover:bg-destructive/10"
                        aria-label={`Remove ${line.item.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => decreaseQty(line.item.id)}>
                          <Minus className="w-3.5 h-3.5" />
                        </Button>
                        <span className="w-8 text-center font-black">{line.qty}</span>
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => increaseQty(line.item.id)}>
                          <Plus className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <span className="font-black text-sm">TSh {((line.item.price || 0) * line.qty).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 border-t pt-4">
              <div className="flex justify-between text-lg font-black pt-2">
                <span>Total</span>
                <span className="text-primary">TSh {subtotal.toLocaleString()}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={clearCart} disabled={cart.length === 0 || isDirector} className="h-11 font-black uppercase text-[10px] tracking-widest">
                Clear Ticket
              </Button>
              <Button onClick={placeTicket} disabled={cart.length === 0 || isDirector} className="h-11 font-black uppercase text-[10px] tracking-widest">
                Place Order
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">Recent Barista Sales</CardTitle>
          <CardDescription>Live completed and credit sales captured from the barista POS</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Code</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Destination</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Method</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentSales.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell className="font-black">{payment.code}</TableCell>
                  <TableCell className="font-bold">{payment.destination}</TableCell>
                  <TableCell className="font-black uppercase text-[10px] tracking-widest">{payment.method}</TableCell>
                  <TableCell className="font-black uppercase text-[10px] tracking-widest">{payment.status}</TableCell>
                  <TableCell className="font-bold">TSh {payment.total.toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {recentSales.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                    No barista sales yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {!isDirector && showSettlementPopup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Select Settlement</CardTitle>
              <CardDescription>Choose Pay Now or Credit</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={() => {
                  setShowSettlementPopup(false);
                  setShowPayNowPopup(true);
                }}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest"
              >
                Paid Now
              </Button>
              <Button
                onClick={() => finalizeOrder("credit", "credit")}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white"
              >
                Credit
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowSettlementPopup(false);
                  setShowPayNowPopup(false);
                }}
                className="w-full h-10 font-black uppercase text-[10px] tracking-widest"
              >
                Close
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {!isDirector && showPayNowPopup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Pay Now Method</CardTitle>
              <CardDescription>Select cash, card, or mobile</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button onClick={() => finalizeOrder("completed", "cash")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Cash
              </Button>
              <Button onClick={() => finalizeOrder("completed", "card")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Card
              </Button>
              <Button onClick={() => finalizeOrder("completed", "mobile")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Mobile
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowPayNowPopup(false);
                  setShowSettlementPopup(true);
                }}
                className="w-full h-10 font-black uppercase text-[10px] tracking-widest"
              >
                Back
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
