"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { buildInitialBaristaMenuItems, findStoreItemForMenuName, formatTotStatus, getBaristaMenuLabel, getMenuStockStatus, getRemainingTots, getTotLimit, isTotTrackedMenuItem, normalizeBaristaMenuItems } from "@/app/lib/barista-stock";
import { printDepartmentReceipt } from "@/app/lib/receipt-print";
import { buildCheckoutFingerprint, clearCheckoutAttempt, getPendingCheckoutAttempts, persistCheckoutAttempt, resolveCheckoutId, withBaristaStockEffectLock } from "@/app/lib/pos-checkout-attempt";
import { getActiveBaristaStateKey, readJson, readPosState, writeJson } from "@/app/lib/storage";
import { BARISTA_INVENTORY_SEED } from "@/app/lib/seed-barista-data";
import { useIsDirector } from "@/hooks/use-is-director";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SyncStatusIndicator } from "@/components/sync-status-indicator";
import { KitchenSessionManager } from "@/components/dashboard/kitchen-session-manager";
import { CheckCircle2, Coffee, Lock, Minus, Pencil, Plus, Receipt, Search, Trash2, User, XCircle } from "lucide-react";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { toast } from "@/hooks/use-toast";
import { commitBaristaCatalogAndStockMutation, commitBaristaCheckoutWithStock, commitBaristaStockEffectsAndLogs, commitBaristaVoidWithStock, commitPosCatalogMutation, commitPosStateWithCatalogRevision, commitSyncedStorageValueAndWait, getPosPaymentSyncKey, hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { DEFAULT_LOGIN_PASSWORD, getProfilePassword, readActiveSessionUsername, readLocalLoginProfiles, saveLoginProfileToServer, STORAGE_LOGIN_PROFILES, subscribeToSessionIdentity, upsertProfileUser } from "@/app/lib/login-profiles";

type BaristaCategory = "all" | "espresso" | "coffee" | "tea" | "cold" | "snacks";
type ServiceMode = "restaurant" | "room-service" | "take-away";
type BookingEntryMode = "current" | "past";
type BaristaPaymentMethod = "cash" | "card" | "mobile" | "credit";
type BaristaPaymentStatus = "completed" | "credit";
type BaristaOrderLine = {
  name: string;
  qty: number;
  itemId?: string;
  inventoryItemId?: string;
  storeItemId?: string;
  unitPrice?: number;
  lineTotal?: number;
};
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
  inventoryItemId?: string;
  storeItemId?: string;
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
  stockRequired?: boolean;
}

interface CancelledBaristaTicket extends BaristaTicket {
  source?: "kitchen" | "barista";
  cancelledAt: number;
}

interface PendingOrder {
  checkoutId: string;
  checkoutFingerprint: string;
  mode: ServiceMode;
  destination: string;
  lines: BaristaOrderLine[];
  total: number;
  createdAt: number;
  isPastBooking: boolean;
  paymentMethod?: BaristaPaymentMethod;
  catalogRevision?: number;
}

const BARISTA_MENU: BaristaMenuItem[] = [];

const STORAGE_TICKETS = "orange-hotel-barista-orders";
const STORAGE_SEQ = "orange-hotel-barista-seq";
const STORAGE_MENU = "orange-hotel-barista-menu";
const STORAGE_PAYMENTS = "orange-hotel-barista-payments";
const STORAGE_CANCELLED = "orange-hotel-cancelled-tickets";
const STORAGE_WASTE = "orange-hotel-barista-waste";
const STORAGE_CHECKOUT_ATTEMPT = "orange-hotel-barista-checkout-attempt";

function getLocalDateValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function getBookingTimestamp(mode: BookingEntryMode, dateValue: string, timeValue: string) {
  if (mode === "current") return Date.now();
  const timestamp = new Date(`${dateValue}T${timeValue || "12:00"}:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function createCheckoutId(prefix: string) {
  const randomPart = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

function hasStockEffect(
  item: Pick<MainStoreItem, "appliedStockEffectIds"> | Pick<InventoryItem, "appliedStockEffectIds">,
  effectId: string,
) {
  return item.appliedStockEffectIds?.includes(effectId) ?? false;
}

function appendStockEffectId(existing: string[] | undefined, effectId: string) {
  return Array.from(new Set([...(existing ?? []), effectId]));
}

function trackStoreStockEffect<T extends MainStoreItem>(
  item: T,
  effectId: string | undefined,
  inventoryDelta: number,
  stockEffect?: { kind: "units" | "tots"; delta: number; totLimit?: number; requiresEffectId?: string; inverseOfEffectId?: string },
): T {
  if (!effectId) return item;
  const appliedStockEffectIds = appendStockEffectId(item.appliedStockEffectIds, effectId);
  const stockInventoryDeltas = Object.fromEntries(
    Object.entries({ ...(item.stockInventoryDeltas ?? {}), [effectId]: inventoryDelta })
  );
  const stockEffects = stockEffect
    ? { ...(item.stockEffects ?? {}), [effectId]: stockEffect }
    : item.stockEffects;
  return { ...item, appliedStockEffectIds, stockInventoryDeltas, stockEffects } as T;
}

function queueStoreStockEffect<T extends MainStoreItem>(
  item: T,
  effectId: string | undefined,
  inventoryDelta: number,
  stockEffect: NonNullable<MainStoreItem["pendingStockEffects"]>[string],
): T {
  if (!effectId) return item;
  return {
    ...item,
    stockInventoryDeltas: {
      ...(item.stockInventoryDeltas ?? {}),
      [effectId]: inventoryDelta,
    },
    pendingStockEffects: {
      ...(item.pendingStockEffects ?? {}),
      [effectId]: stockEffect,
    },
  } as T;
}

function findInventoryStockEffectTarget(
  items: InventoryItem[],
  category: string,
  itemName: string,
  preferredItemId?: string,
) {
  const target = normalizeStockName(itemName);
  return items.find((item) => {
    if (preferredItemId && item.id === preferredItemId) return true;
    return item.category === category && (
      normalizeStockName(item.name) === target ||
      normalizeStockName(`${item.name} ${item.size ?? ""}`) === target
    );
  });
}

function applyTrackedInventoryEffect(
  items: InventoryItem[],
  category: string,
  itemName: string,
  delta: number,
  effectId: string | undefined,
  preferredItemId?: string,
  forceUnitDelta = false,
  stockEffectOverride?: NonNullable<InventoryItem["stockEffects"]>[string],
): InventoryItem[] {
  if (!effectId) return adjustInventoryQuantity(items, category, itemName, delta);
  const matchedItem = findInventoryStockEffectTarget(items, category, itemName, preferredItemId);
  if (!matchedItem || hasStockEffect(matchedItem, effectId)) return items;
  return items.map((item) => {
    if (item.id !== matchedItem.id) return item;
    let adjustedItem = item;
    const overrideTotLimit = Number(stockEffectOverride?.totLimit);
    const totPerBottle = Number.isFinite(overrideTotLimit) && overrideTotLimit > 0
      ? overrideTotLimit
      : typeof item.totPerBottle === "number"
        ? item.totPerBottle
        : 0;
    const isTotAdjustment =
      !forceUnitDelta &&
      totPerBottle > 0 &&
      (stockEffectOverride?.kind === "tots" || normalizeStockName(itemName).endsWith("tots") || Boolean(preferredItemId));
    if (delta !== 0 && isTotAdjustment) {
      const currentTotSold = typeof item.totSold === "number" ? item.totSold : 0;
      if (delta < 0) {
        const nextTotSold = currentTotSold + Math.abs(delta);
        adjustedItem = {
          ...item,
          stock: Math.max(0, item.stock - Math.floor(nextTotSold / totPerBottle)),
          totSold: nextTotSold % totPerBottle,
        };
      } else {
        const nextTotSold = currentTotSold - delta;
        if (nextTotSold >= 0) {
          adjustedItem = { ...item, totSold: nextTotSold };
        } else {
          const bottlesRestored = Math.ceil(Math.abs(nextTotSold) / totPerBottle);
          adjustedItem = {
            ...item,
            stock: item.stock + bottlesRestored,
            totSold: nextTotSold + bottlesRestored * totPerBottle,
          };
        }
      }
    } else if (delta !== 0) {
      adjustedItem = { ...item, stock: Math.max(0, item.stock + delta) };
    }
    const stockEffect: NonNullable<InventoryItem["stockEffects"]>[string] = stockEffectOverride ?? {
      kind: isTotAdjustment ? "tots" : "units",
      delta,
      ...(isTotAdjustment ? { totLimit: totPerBottle } : {}),
    };
    return {
      ...adjustedItem,
      appliedStockEffectIds: appendStockEffectId(adjustedItem.appliedStockEffectIds, effectId),
      stockEffects: {
        ...(adjustedItem.stockEffects ?? {}),
        [effectId]: stockEffect,
      },
    };
  });
}

function queueTrackedInventoryEffect(
  items: InventoryItem[],
  category: string,
  itemName: string,
  effectId: string | undefined,
  effect: NonNullable<InventoryItem["pendingStockEffects"]>[string],
  preferredItemId?: string,
) {
  if (!effectId) return items;
  const matchedItem = findInventoryStockEffectTarget(items, category, itemName, preferredItemId);
  if (!matchedItem || hasStockEffect(matchedItem, effectId) || matchedItem.pendingStockEffects?.[effectId]) {
    return items;
  }
  return items.map((item) => item.id === matchedItem.id
    ? {
        ...item,
        pendingStockEffects: {
          ...(item.pendingStockEffects ?? {}),
          [effectId]: effect,
        },
      }
    : item);
}

function reconcileBaristaCartWithCatalog(sourceCart: CartLine[], catalog: BaristaMenuItem[]) {
  const currentById = new Map(catalog.map((item) => [item.id, item]));
  let removedCount = 0;
  let changed = false;
  const removedNames: string[] = [];
  const changedNames: string[] = [];
  const nextCart = sourceCart.flatMap((line) => {
    const currentItem = currentById.get(line.item.id);
    if (!currentItem) {
      removedCount += 1;
      removedNames.push(line.item.name);
      changed = true;
      return [];
    }
    if (
      currentItem.name === line.item.name &&
      currentItem.price === line.item.price &&
      currentItem.category === line.item.category &&
      currentItem.prepMinutes === line.item.prepMinutes &&
      currentItem.inventoryItemId === line.item.inventoryItemId &&
      currentItem.storeItemId === line.item.storeItemId
      ) return [line];
      changed = true;
      changedNames.push(currentItem.name);
      return [{ ...line, item: currentItem }];
  });
  return { nextCart, removedCount, removedNames, changedNames, changed };
}

function createBaristaOrderLines(sourceCart: CartLine[]): BaristaOrderLine[] {
  return sourceCart.map((line) => ({
    itemId: line.item.id,
    inventoryItemId: line.item.inventoryItemId,
    storeItemId: line.item.storeItemId,
    name: line.item.name,
    qty: line.qty,
    unitPrice: line.item.price,
    lineTotal: line.item.price * line.qty,
  }));
}

function reconcileBaristaOrderLinesWithCatalog(
  sourceLines: BaristaOrderLine[],
  catalog: BaristaMenuItem[],
) {
  const currentById = new Map(catalog.map((item) => [item.id, item]));
  let removedCount = 0;
  let changed = false;
  const nextCart: CartLine[] = [];
  const nextLines = sourceLines.flatMap((line) => {
    const currentItem = line.itemId
      ? currentById.get(line.itemId)
      : catalog.find((item) => item.name.trim().toLowerCase() === line.name.trim().toLowerCase());
    if (!currentItem) {
      removedCount += 1;
      changed = true;
      return [];
    }

    const nextLine: BaristaOrderLine = {
      itemId: currentItem.id,
      inventoryItemId: currentItem.inventoryItemId,
      storeItemId: currentItem.storeItemId,
      name: currentItem.name,
      qty: line.qty,
      unitPrice: currentItem.price,
      lineTotal: currentItem.price * line.qty,
    };
    nextCart.push({ item: currentItem, qty: line.qty });

    if (
      line.itemId !== nextLine.itemId ||
      line.inventoryItemId !== nextLine.inventoryItemId ||
      line.storeItemId !== nextLine.storeItemId ||
      line.name !== nextLine.name ||
      line.unitPrice !== nextLine.unitPrice ||
      line.lineTotal !== nextLine.lineTotal
    ) changed = true;
    return [nextLine];
  });

  return { nextLines, nextCart, removedCount, changed };
}

function getBaristaLegacySalesKey(name: string) {
  return `name:${normalizeBaristaTarget(name)}:${isTotTrackedMenuItem(name) ? "tots" : "standard"}`;
}

function getBaristaOrderLineSalesKey(line: BaristaOrderLine) {
  return line.itemId ? `item:${line.itemId}` : getBaristaLegacySalesKey(line.name);
}

function allocateBaristaPaymentAmounts(
  payment: BaristaPaymentRecord,
  lines: BaristaOrderLine[],
  getLegacyUnitPrice: (line: BaristaOrderLine) => number,
) {
  const weights = lines.map((line) => {
    const storedLineTotal = Number(line.lineTotal);
    const storedUnitPrice = Number(line.unitPrice);
    if (Number.isFinite(storedLineTotal) && storedLineTotal >= 0) return storedLineTotal;
    if (Number.isFinite(storedUnitPrice) && storedUnitPrice >= 0) return storedUnitPrice * line.qty;
    return getLegacyUnitPrice(line) * line.qty;
  });
  const weightTotal = weights.reduce((sum, amount) => sum + amount, 0);
  const quantityTotal = lines.reduce((sum, line) => sum + line.qty, 0);
  let allocated = 0;

  return lines.map((line, index) => {
    if (index === lines.length - 1) return payment.total - allocated;
    const divisor = weightTotal > 0 ? weightTotal : quantityTotal;
    const weight = weightTotal > 0 ? weights[index] : line.qty;
    const amount = Math.round(payment.total * (divisor > 0 ? (weight ?? 0) / divisor : 0) * 100) / 100;
    allocated += amount;
    return amount;
  });
}

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

function syncBaristaMenuItemsWithSharedInventory(
  menuItems: BaristaMenuItem[],
  inventory: InventoryItem[],
  _storeItems: MainStoreItem[],
  allowInitialSeed = true,
) {
  // The POS menu is authoritative: the seeded drink list plus any
  // manual edits made in the manager Drinks / Inventory tabs. We deliberately do
  // NOT merge items in from the shared inventory/store here. That shared data was
  // historically included stale data, so merging it back could restore removed drinks.
  // Stock levels are resolved separately at render time via getMenuStockStatus.
  if (menuItems.length === 0 && allowInitialSeed) {
    return buildInitialBaristaMenuItems(inventory) as BaristaMenuItem[];
  }
  return menuItems;
}

function buildBaristaDisplayCatalog(
  menuItems: BaristaMenuItem[],
  catalogRevision: number | undefined,
  inventory: InventoryItem[],
  storeItems: MainStoreItem[],
) {
  return normalizeBaristaMenuItems(
    syncBaristaMenuItemsWithSharedInventory(
      menuItems,
      inventory,
      storeItems,
      (catalogRevision ?? 0) === 0,
    ),
    storeItems,
  ).map((item) => {
    if (item.storeItemId) return item;
    const linkedInventoryItem = inventory.find((entry) =>
      entry.id === item.inventoryItemId || entry.id === item.id);
    if (!linkedInventoryItem) return item;
    const linkedStoreItem = findStoreItemForMenuName(
      storeItems,
      getBaristaInventoryLabel(linkedInventoryItem),
    );
    return linkedStoreItem ? { ...item, storeItemId: linkedStoreItem.id } : item;
  });
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
  const [bookingEntryMode, setBookingEntryMode] = useState<BookingEntryMode>("current");
  const [pastBookingDate, setPastBookingDate] = useState(getLocalDateValue);
  const [pastBookingTime, setPastBookingTime] = useState(() => new Date().toTimeString().slice(0, 5));
  const [pastPaymentMethod, setPastPaymentMethod] = useState<BaristaPaymentMethod>("cash");
  const [searchTerm, setSearchTerm] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [roomNumber, setRoomNumber] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartCatalogNotice, setCartCatalogNotice] = useState("");
  const [tickets, setTickets] = useState<BaristaTicket[]>([]);
  const [, setTicketSeq] = useState(1);
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
  const checkoutInFlightRef = useRef(false);
  const stockRecoveryInFlightRef = useRef(false);
  const authoritativeHydrationRef = useRef(false);
  const [checkoutInFlight, setCheckoutInFlight] = useState(false);
  const [accountTab, setAccountTab] = useState<"session" | "password">("session");
  const [activeUsername, setActiveUsername] = useState("");
  const [currentPasswordInput, setCurrentPasswordInput] = useState("");
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [confirmPasswordInput, setConfirmPasswordInput] = useState("");
  const [passwordFeedback, setPasswordFeedback] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [deliveringTicketId, setDeliveringTicketId] = useState<string | null>(null);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);

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

      const menuItems = buildBaristaDisplayCatalog(
        snapshot.menuItems,
        snapshot.catalogRevision,
        inventory,
        readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
      );
      setStoredMenuItems(menuItems);
      if (authoritativeHydrationRef.current) setPosHydrated(true);
    };

    const bootstrapBarista = async () => {
      return Promise.all([
        hydrateStorageKeyFromFirebase(activeBaristaKey),
        hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
        hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      ]);
    };

    let retryTimer: number | null = null;
    const hydrateBarista = async () => {
      const results = await bootstrapBarista();
      if (cancelled) return;
      if (results.every((result) => result.ok)) {
        authoritativeHydrationRef.current = true;
        applyBaristaSnapshot();
        return;
      }
      retryTimer = window.setTimeout(hydrateBarista, 5000);
    };

    void hydrateBarista();
    const unsubscribeBarista = subscribeToSyncedStorageKey(activeBaristaKey, applyBaristaSnapshot);
    const unsubscribeInventory = subscribeToSyncedStorageKey(STORAGE_INVENTORY_ITEMS, applyBaristaSnapshot);

    return () => {
      cancelled = true;
      authoritativeHydrationRef.current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
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
    const syncedMenuItems = buildBaristaDisplayCatalog(
      snapshot.menuItems,
      snapshot.catalogRevision,
      inventoryItems,
      baristaStoreItems,
    );
    setStoredMenuItems((current) =>
      JSON.stringify(syncedMenuItems) === JSON.stringify(current) ? current : syncedMenuItems);
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
    persist = false,
    stockApplicationId?: string,
    requiredSourceStockApplicationId?: string,
  ) => {
    const allStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const otherStoreItems = allStoreItems.filter((entry) => entry.lane !== "barista");
    const currentBaristaItems = allStoreItems
      .filter((entry) => entry.lane === "barista")
      .map((entry) => ({ ...entry, lane: "barista" as const }));
    const nextBaristaItems = [...currentBaristaItems];
    let nextInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const appliedEffects: Array<{
      id: string;
      target: "store" | "inventory";
      itemId: string;
      allowPending?: boolean;
    }> = [];

    for (const [lineIndex, line] of lines.entries()) {
      const effectSuffix = `${lineIndex}:${line.itemId ?? normalizeBaristaTarget(line.name)}`;
      const effectId = stockApplicationId
        ? `${stockApplicationId}:${effectSuffix}`
        : undefined;
      const requiredSourceEffectId = requiredSourceStockApplicationId
        ? `${requiredSourceStockApplicationId}:${effectSuffix}`
        : undefined;
      const matchedItem = findStoreItemForMenuName(nextBaristaItems, line.name, line.storeItemId);
      if (!matchedItem) {
        const inventoryMatch = line.inventoryItemId
          ? nextInventoryItems.find((item) => item.id === line.inventoryItemId)
          : nextInventoryItems.find((item) => {
          if (item.category !== "Bar") return false;
          const itemName = item.size ? `${item.name} ${item.size}` : item.name;
          return normalizeBaristaTarget(itemName) === normalizeBaristaTarget(line.name) || normalizeBaristaTarget(item.name) === normalizeBaristaTarget(line.name);
        });

        if (!inventoryMatch) {
          if (line.storeItemId || line.inventoryItemId) {
            return {
              ok: false as const,
              error: `The linked stock row for ${line.name} is missing. Ask a manager to relink the item before selling it.`,
            };
          }
          continue;
        }
        if (effectId && hasStockEffect(inventoryMatch, effectId)) {
          appliedEffects.push({ id: effectId, target: "inventory", itemId: inventoryMatch.id });
          continue;
        }
        const sourceEffect = requiredSourceEffectId
          ? inventoryMatch.stockEffects?.[requiredSourceEffectId]
          : undefined;
        if (direction === "restore" && requiredSourceEffectId && !sourceEffect) {
          const pendingEffect = {
            kind: "units" as const,
            delta: 0,
            requiresEffectId: requiredSourceEffectId,
            inverseOfEffectId: requiredSourceEffectId,
          };
          nextInventoryItems = queueTrackedInventoryEffect(
            nextInventoryItems,
            inventoryMatch.category,
            line.name,
            effectId,
            pendingEffect,
            inventoryMatch.id,
          );
          if (effectId) {
            appliedEffects.push({
              id: effectId,
              target: "inventory",
              itemId: inventoryMatch.id,
              allowPending: true,
            });
          }
          continue;
        }
        const availableUnits = typeof inventoryMatch.stock === "number" ? inventoryMatch.stock : 0;
        const availableTots = typeof inventoryMatch.totPerBottle === "number" && inventoryMatch.totPerBottle > 0
          ? availableUnits * inventoryMatch.totPerBottle - (typeof inventoryMatch.totSold === "number" ? inventoryMatch.totSold : 0)
          : availableUnits;

        if (direction === "consume" && line.qty > availableTots) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }

        const inventoryDelta = direction === "consume"
          ? -line.qty
          : sourceEffect
            ? -sourceEffect.delta
            : line.qty;
        nextInventoryItems = applyTrackedInventoryEffect(
          nextInventoryItems,
          inventoryMatch.category,
          line.name,
          inventoryDelta,
          effectId,
          inventoryMatch.id,
          false,
          direction === "restore" && requiredSourceEffectId
            ? {
                ...(sourceEffect ?? { kind: "units" as const, delta: -line.qty }),
                delta: inventoryDelta,
                requiresEffectId: requiredSourceEffectId,
                inverseOfEffectId: requiredSourceEffectId,
              }
            : undefined,
        );
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: inventoryMatch.id,
            allowPending: direction === "restore" && Boolean(requiredSourceEffectId),
          });
        }
        continue;
      }

      const itemIndex = nextBaristaItems.findIndex((entry) => entry.id === matchedItem.id);
      if (itemIndex < 0) continue;

      const currentItem = nextBaristaItems[itemIndex];
      const inventoryLabel = getStoreItemLabel(currentItem);
      const linkedInventoryItem = findInventoryStockEffectTarget(
        nextInventoryItems,
        "Bar",
        inventoryLabel,
        line.inventoryItemId,
      );
      const sourceStoreEffect = requiredSourceEffectId
        ? currentItem.stockEffects?.[requiredSourceEffectId]
        : undefined;
      const sourceInventoryEffect = requiredSourceEffectId
        ? linkedInventoryItem?.stockEffects?.[requiredSourceEffectId]
        : undefined;
      const applyInventoryMirror = (
        delta: number,
        effectOverride?: NonNullable<InventoryItem["stockEffects"]>[string],
        forceUnitDelta = true,
      ) => {
        if (!linkedInventoryItem) return;
        nextInventoryItems = applyTrackedInventoryEffect(
          nextInventoryItems,
          "Bar",
          inventoryLabel,
          delta,
          effectId,
          linkedInventoryItem.id,
          forceUnitDelta,
          effectOverride,
        );
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: linkedInventoryItem.id,
            allowPending: direction === "restore" && Boolean(requiredSourceEffectId),
          });
        }
      };
      const applyOrQueueDependentInventoryRestore = () => {
        if (!linkedInventoryItem || !effectId || !requiredSourceEffectId) return;
        if (!sourceInventoryEffect) {
          nextInventoryItems = queueTrackedInventoryEffect(
            nextInventoryItems,
            "Bar",
            inventoryLabel,
            effectId,
            {
              kind: "units",
              delta: 0,
              requiresEffectId: requiredSourceEffectId,
              inverseOfEffectId: requiredSourceEffectId,
            },
            linkedInventoryItem.id,
          );
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: linkedInventoryItem.id,
            allowPending: true,
          });
          return;
        }
        applyInventoryMirror(-sourceInventoryEffect.delta, {
          ...sourceInventoryEffect,
          delta: -sourceInventoryEffect.delta,
          requiresEffectId: requiredSourceEffectId,
          inverseOfEffectId: requiredSourceEffectId,
        }, sourceInventoryEffect.kind !== "tots");
      };
      if (effectId && hasStockEffect(currentItem, effectId)) {
        if (direction === "restore" && requiredSourceEffectId) {
          applyOrQueueDependentInventoryRestore();
        } else {
          const existingStoreEffect = currentItem.stockEffects?.[effectId];
          if (existingStoreEffect?.kind === "tots") {
            applyInventoryMirror(existingStoreEffect.delta, existingStoreEffect, false);
          } else {
            applyInventoryMirror(currentItem.stockInventoryDeltas?.[effectId] ?? 0);
          }
        }
        appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
        continue;
      }
      if (direction === "restore" && requiredSourceEffectId && !sourceStoreEffect) {
        nextBaristaItems[itemIndex] = queueStoreStockEffect(
          currentItem,
          effectId,
          0,
          {
            kind: getTotLimit(currentItem) > 0 ? "tots" : "units",
            delta: 0,
            ...(getTotLimit(currentItem) > 0 ? { totLimit: getTotLimit(currentItem) } : {}),
            requiresEffectId: requiredSourceEffectId,
            inverseOfEffectId: requiredSourceEffectId,
          },
        );
        applyOrQueueDependentInventoryRestore();
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "store",
            itemId: currentItem.id,
            allowPending: true,
          });
        }
        continue;
      }
      if (getTotLimit(currentItem) > 0 || isTotTrackedMenuItem(line.name)) {
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
          nextBaristaItems[itemIndex] = trackStoreStockEffect(
            {
              ...currentItem,
              stock: currentItem.stock - bottlesConsumed,
              totLimit,
              totSold: totalTotSold % totLimit,
            },
            effectId,
            -bottlesConsumed,
            { kind: "tots", delta: -line.qty, totLimit },
          );
          applyInventoryMirror(-line.qty, { kind: "tots", delta: -line.qty, totLimit }, false);
          if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
          continue;
        }

        const restoreQty = sourceStoreEffect ? Math.abs(sourceStoreEffect.delta) : line.qty;
        const restoreInventoryDelta = requiredSourceEffectId
          ? -(currentItem.stockInventoryDeltas?.[requiredSourceEffectId] ?? 0)
          : 0;
        const dependentRestoreFields = requiredSourceEffectId
          ? { requiresEffectId: requiredSourceEffectId, inverseOfEffectId: requiredSourceEffectId }
          : {};
        const totalTotSold = currentTotSold - restoreQty;
        if (totalTotSold >= 0) {
          nextBaristaItems[itemIndex] = trackStoreStockEffect(
            { ...currentItem, totLimit, totSold: totalTotSold },
            effectId,
            restoreInventoryDelta,
            { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
          );
          if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
          else applyInventoryMirror(
            restoreQty,
            { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
            false,
          );
          if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
          continue;
        }

        const bottlesRestored = Math.ceil(Math.abs(totalTotSold) / totLimit);
        nextBaristaItems[itemIndex] = trackStoreStockEffect(
          {
            ...currentItem,
            stock: currentItem.stock + bottlesRestored,
            totLimit,
            totSold: totalTotSold + bottlesRestored * totLimit,
          },
          effectId,
          requiredSourceEffectId ? restoreInventoryDelta : bottlesRestored,
          { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
        );
        if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
        else applyInventoryMirror(
          restoreQty,
          { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
          false,
        );
        if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
        continue;
      }

      if (direction === "consume") {
        if (line.qty > currentItem.stock) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }
        nextBaristaItems[itemIndex] = trackStoreStockEffect(
          { ...currentItem, stock: currentItem.stock - line.qty },
          effectId,
          -line.qty,
          { kind: "units", delta: -line.qty },
        );
        applyInventoryMirror(-line.qty);
        if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
        continue;
      }

      const restoreUnits = sourceStoreEffect ? Math.abs(sourceStoreEffect.delta) : line.qty;
      nextBaristaItems[itemIndex] = trackStoreStockEffect(
        { ...currentItem, stock: currentItem.stock + restoreUnits },
        effectId,
        requiredSourceEffectId
          ? -(currentItem.stockInventoryDeltas?.[requiredSourceEffectId] ?? 0)
          : restoreUnits,
        {
          kind: "units",
          delta: restoreUnits,
          ...(requiredSourceEffectId
            ? { requiresEffectId: requiredSourceEffectId, inverseOfEffectId: requiredSourceEffectId }
            : {}),
        },
      );
      if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
      else applyInventoryMirror(restoreUnits);
      if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
    }

    const nextStoreItems = [...otherStoreItems, ...nextBaristaItems];
    if (!persist) {
      return {
        ok: true as const,
        appliedEffects,
        storeItems: nextStoreItems,
        inventoryItems: nextInventoryItems,
      };
    }
    setBaristaStoreItems(nextBaristaItems);
    writeJson(STORAGE_MAIN_STORE_ITEMS, nextStoreItems);
    writeJson(STORAGE_INVENTORY_ITEMS, nextInventoryItems);
    return {
      ok: true as const,
      appliedEffects,
      storeItems: nextStoreItems,
      inventoryItems: nextInventoryItems,
    };
  };

  const confirmBaristaStockResult = async (
    result: ReturnType<typeof updateBaristaStoreStock>,
    appendRecords: Array<{
      key: typeof STORAGE_WASTE | typeof STORAGE_STORE_USAGE;
      record: Record<string, unknown>;
    }> = [],
  ) => {
    if (!result.ok) return result;
    if (!result.storeItems || !result.inventoryItems) return result;
    try {
      const committed = await commitBaristaStockEffectsAndLogs(
        result.storeItems,
        result.inventoryItems,
        result.appliedEffects,
        appendRecords,
      );
      if (!committed.ok) {
        return { ok: false as const, error: "The stock change was not confirmed by shared storage." };
      }
      const committedStoreItems = committed.storeItems;
      const committedInventoryItems = committed.inventoryItems;
      const missingEffect = result.appliedEffects.find((effect) => {
        const committedItem = effect.target === "store"
          ? committedStoreItems.find((item) => item.id === effect.itemId)
          : committedInventoryItems.find((item) => item.id === effect.itemId);
        if (!committedItem) return true;
        if (committedItem.appliedStockEffectIds?.includes(effect.id)) return false;
        return !(effect.allowPending && committedItem.pendingStockEffects?.[effect.id]);
      });
      return missingEffect
        ? { ok: false as const, error: "The stock change was not confirmed by shared storage." }
        : { ok: true as const, appliedEffects: result.appliedEffects };
    } catch {
      return { ok: false as const, error: "The stock change could not be confirmed by shared storage." };
    }
  };

  useEffect(() => {
    if (!posHydrated || stockRecoveryInFlightRef.current) return;
    const localAttempts = getPendingCheckoutAttempts(STORAGE_CHECKOUT_ATTEMPT);
    const localAttemptIds = new Set(localAttempts.map((attempt) => attempt.checkoutId));
    const recoverableByCheckoutId = new Map<string, {
      checkoutId: string;
      payment: BaristaPaymentRecord;
      hasLocalAttempt: boolean;
    }>();
    localAttempts.forEach((attempt) => {
      const payment = baristaPayments.find((entry) => entry.id === `bp-${attempt.checkoutId}`);
      if (payment) {
        recoverableByCheckoutId.set(attempt.checkoutId, {
          checkoutId: attempt.checkoutId,
          payment,
          hasLocalAttempt: true,
        });
      }
    });
    // Shared payments are also recovery intents. This closes the legacy case
    // where a device recorded a payment before its stock commit and never came
    // back; any other Barista terminal can finish the stable effect exactly once.
    baristaPayments.forEach((payment) => {
      if (!payment.id.startsWith("bp-") || payment.stockRequired === false) return;
      const checkoutId = payment.id.slice(3);
      if (!checkoutId || recoverableByCheckoutId.has(checkoutId)) return;
      recoverableByCheckoutId.set(checkoutId, {
        checkoutId,
        payment,
        hasLocalAttempt: localAttemptIds.has(checkoutId),
      });
    });
    const recoverableAttempts = Array.from(recoverableByCheckoutId.values());
    if (recoverableAttempts.length === 0) return;

    stockRecoveryInFlightRef.current = true;
    void (async () => {
      for (const { checkoutId, payment, hasLocalAttempt } of recoverableAttempts) {
        if (
          payment.stockRequired !== false &&
          payment.ticketId &&
          !tickets.some((ticket) => ticket.id === payment.ticketId)
        ) {
          // A cancelled/tombstoned order must never be consumed later by
          // recovery after its original stock request was delayed.
          if (hasLocalAttempt) clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, checkoutId);
          continue;
        }
        if (payment.stockRequired === false || !Array.isArray(payment.lines) || payment.lines.length === 0) {
          if (hasLocalAttempt) clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, checkoutId);
          continue;
        }
        const preview = updateBaristaStoreStock(payment.lines, "consume", false, checkoutId);
        if (!preview.ok) continue;
        const currentStoreItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
        const currentInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
        const needsRecovery = preview.appliedEffects.some((effect) => {
          const item = effect.target === "store"
            ? currentStoreItems.find((entry) => entry.id === effect.itemId)
            : currentInventoryItems.find((entry) => entry.id === effect.itemId);
          return !item || (!hasStockEffect(item, effect.id) && !(effect.allowPending && item.pendingStockEffects?.[effect.id]));
        });
        if (!needsRecovery) {
          if (hasLocalAttempt) clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, checkoutId);
          continue;
        }
        const result = await withBaristaStockEffectLock(async () =>
          confirmBaristaStockResult(
            updateBaristaStoreStock(payment.lines ?? [], "consume", false, checkoutId),
          ));
        if (result.ok && hasLocalAttempt) clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, checkoutId);
      }
    })().finally(() => {
      stockRecoveryInFlightRef.current = false;
    });
  }, [baristaPayments, posHydrated, tickets]);

  const addUsage = async () => {
    const qty = Number(useQty);
    const entry = fromStoreEntries.find((item) => item.id === useEntryId);
    if (!entry || Number.isNaN(qty) || qty <= 0) return;
    const approved = await confirm({
      title: "Record Barista Usage",
      description: `Are you sure you want to record ${qty} units used for ${entry.itemName}?`,
      actionLabel: "Record Usage",
    });
    if (!approved) return;
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_STORE_USAGE),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The latest usage and Inventory balances could not be refreshed. Nothing was recorded.");
      return;
    }
    const existingUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE) ?? [];
    const remoteUsedQty = existingUsage
      .filter((usage) => usage.destination === "barista" && usage.movementId === entry.id)
      .reduce((sum, usage) => sum + usage.quantityUsed, 0);
    const remaining = entry.convertedQty - remoteUsedQty;
    if (qty > remaining) {
      window.alert(`Only ${Math.max(0, remaining)} units remain for this store transfer.`);
      return;
    }
    const createdAt = Date.now();
    const log: StoreUsageLog = {
      id: `su-${createCheckoutId("usage")}`,
      movementId: entry.id,
      destination: "barista",
      quantityUsed: qty,
      usedAt: createdAt,
    };
    const effectId = `usage:${log.id}`;
    const inventoryResult = await withBaristaStockEffectLock(async () => {
      const existingInventory = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
      const target = findInventoryStockEffectTarget(existingInventory, "Bar", entry.itemName);
      if (!target) return { ok: false as const, error: `No Inventory row is linked to ${entry.itemName}.` };
      const available = typeof target.totPerBottle === "number" && target.totPerBottle > 0
        ? target.stock * target.totPerBottle - (target.totSold ?? 0)
        : target.stock;
      if (qty > available) {
        return { ok: false as const, error: `Not enough Inventory stock for ${entry.itemName}.` };
      }
      const nextInventory = applyTrackedInventoryEffect(
        existingInventory,
        "Bar",
        entry.itemName,
        -qty,
        effectId,
        target.id,
        false,
      );
      const committed = await commitBaristaStockEffectsAndLogs(
        readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
        nextInventory,
        [{ id: effectId, target: "inventory", itemId: target.id }],
        [{ key: STORAGE_STORE_USAGE, record: { ...log } }],
        [{ movementId: entry.id, destination: "barista", maxQuantity: entry.convertedQty }],
      );
      return committed.ok
        ? { ok: true as const, usage: committed.appendedValues[STORAGE_STORE_USAGE] ?? [] }
        : {
            ok: false as const,
            error: committed.reason === "usage-capacity-exceeded"
              ? "Another terminal used the remaining quantity first. Refresh the transfer balance and try again."
              : "The usage and its Inventory deduction could not be confirmed together.",
          };
    });
    if (!inventoryResult.ok) {
      window.alert(inventoryResult.error);
      return;
    }
    setUsageLogs(
      (inventoryResult.usage as StoreUsageLog[]).filter((usage) => usage.destination === "barista"),
    );
    setUseQty("1");
  };

  const menuItems = useMemo(
    () => normalizeBaristaMenuItems(storedMenuItems, baristaStoreItems),
    [baristaStoreItems, storedMenuItems],
  );

  // Reconcile against the same normalized catalog rendered by the POS. Missing
  // items are removed, so a manager deletion can never remain chargeable.
  useEffect(() => {
    if (!posHydrated) return;
    const reconciliation = reconcileBaristaCartWithCatalog(cart, menuItems);
    if (!reconciliation.changed) return;
    setCart(reconciliation.nextCart);
    setCartCatalogNotice(
      reconciliation.removedCount > 0
        ? `Removed unavailable item(s): ${reconciliation.removedNames.join(", ")}. Review the ticket before ordering.`
        : `The manager updated: ${reconciliation.changedNames.join(", ")}. Review the new price before ordering.`,
    );
  }, [cart, menuItems, posHydrated]);

  useEffect(() => {
    if (!posHydrated || !pendingOrder) return;
    const reconciliation = reconcileBaristaOrderLinesWithCatalog(pendingOrder.lines, menuItems);
    if (!reconciliation.changed && reconciliation.removedCount === 0) return;
    setCart(reconciliation.nextCart);
    setPendingOrder(null);
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);
    setCartCatalogNotice("The manager changed the menu during settlement. Review the refreshed ticket before ordering again.");
    toast({
      title: reconciliation.removedCount > 0 ? "Menu item removed" : "Menu price updated",
      description: "The cart now has the manager's latest menu. Review it before placing the order again.",
    });
  }, [menuItems, pendingOrder, posHydrated]);

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

  const baristaMenuPriceByLegacySalesKey = useMemo(() => {
    const priceMap = new Map<string, number>();
    menuItems.forEach((item) => {
      if (typeof item.price === "number" && item.price > 0) {
        priceMap.set(getBaristaLegacySalesKey(item.name), item.price);
      }
    });
    return priceMap;
  }, [menuItems]);

  const baristaMenuPriceByItemId = useMemo(() => {
    const priceMap = new Map<string, number>();
    menuItems.forEach((item) => {
      if (typeof item.price === "number" && item.price > 0) priceMap.set(item.id, item.price);
    });
    return priceMap;
  }, [menuItems]);

  const baristaSalesByItem = useMemo(() => {
    const salesMap = new Map<string, { quantity: number; revenue: number; label: string }>();

    baristaPayments.forEach((payment) => {
      if (!Array.isArray(payment.lines) || payment.lines.length === 0) return;
      const allocatedAmounts = allocateBaristaPaymentAmounts(
        payment,
        payment.lines,
        (line) =>
          (line.itemId ? baristaMenuPriceByItemId.get(line.itemId) : undefined) ??
          baristaMenuPriceByLegacySalesKey.get(getBaristaLegacySalesKey(line.name)) ??
          0,
      );

      payment.lines.forEach((line, index) => {
        const key = getBaristaOrderLineSalesKey(line);
        const current = salesMap.get(key) ?? { quantity: 0, revenue: 0, label: line.name };
        salesMap.set(key, {
          quantity: current.quantity + line.qty,
          revenue: current.revenue + (allocatedAmounts[index] ?? 0),
          label: line.name || current.label,
        });
      });
    });

    return salesMap;
  }, [baristaMenuPriceByItemId, baristaMenuPriceByLegacySalesKey, baristaPayments]);

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
    () => {
      const seenMenuItemIds = new Set<string>();
      const linkedStoreItemIds = new Set(
        menuItems.map((item) => item.storeItemId).filter((id): id is string => Boolean(id)),
      );
      const orderedStoreItems = [...baristaStoreItems].sort(
        (left, right) => Number(linkedStoreItemIds.has(right.id)) - Number(linkedStoreItemIds.has(left.id)),
      );
      return orderedStoreItems.flatMap((item) => {
        const inventoryMatch = resolveBaristaInventoryItem(item);
        const expectedMenuName = getTotLimit(item) > 0
          ? `${getStoreItemLabel(item)} (TOTS)`
          : getStoreItemLabel(item);
        const matchedMenuItem = menuItems.find(
          (entry) =>
            entry.id === item.id ||
            entry.storeItemId === item.id ||
            (!!inventoryMatch && (entry.inventoryItemId === inventoryMatch.id || entry.id === inventoryMatch.id)),
        ) ?? menuItems.find(
          (entry) => getBaristaLegacySalesKey(entry.name) === getBaristaLegacySalesKey(expectedMenuName),
        );
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
          typeof matchedMenuItem?.price === "number" && matchedMenuItem.price > 0
            ? matchedMenuItem.price
            : typeof baristaMenuPriceByItem.get(normalizeBaristaTarget(getStoreItemLabel(item))) === "number" &&
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
        const idSales = matchedMenuItem ? baristaSalesByItem.get(`item:${matchedMenuItem.id}`) : undefined;
        const legacySales = baristaSalesByItem.get(getBaristaLegacySalesKey(expectedMenuName));
        const quantitySold = (idSales?.quantity ?? 0) + (legacySales?.quantity ?? 0);
        const capital = item.stock * buyingPrice;
        const revenue =
          (idSales?.revenue ?? 0) +
          (legacySales?.revenue ?? 0);
        const profitLoss = revenue - capital;

        if (matchedMenuItem?.id && seenMenuItemIds.has(matchedMenuItem.id)) return [];
        if (matchedMenuItem?.id) seenMenuItemIds.add(matchedMenuItem.id);

        return [{
          ...item,
          menuItemId: matchedMenuItem?.id,
          displayName: getStoreItemLabel(item),
          buyingPrice,
          sellingPrice,
          quantitySold,
          capital,
          revenue,
          profitLoss,
        }];
      });
    },
    [baristaMenuBuyingPriceByItem, baristaMenuPriceByItem, baristaSalesByItem, baristaStoreItems, inventoryItems, menuItems],
  );

  const baristaFinanceRows = useMemo(() => {
    const matchedMenuItemIds = new Set(
      baristaInventoryRows
        .map((row) => row.menuItemId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    const menuOnlyRows = menuItems
      .filter((menuItem) => !matchedMenuItemIds.has(menuItem.id))
      .map((menuItem) => {
        const idSales = baristaSalesByItem.get(`item:${menuItem.id}`);
        const legacySales = baristaSalesByItem.get(getBaristaLegacySalesKey(menuItem.name));
        const quantitySold = (idSales?.quantity ?? 0) + (legacySales?.quantity ?? 0);
        const revenue = (idSales?.revenue ?? 0) + (legacySales?.revenue ?? 0);
        const buyingPrice =
          typeof menuItem.buyingPrice === "number" && menuItem.buyingPrice > 0
            ? menuItem.buyingPrice
            : 0;
        const sellingPrice = typeof menuItem.price === "number" && menuItem.price > 0 ? menuItem.price : 0;

        return {
          id: `menu-finance-${menuItem.id}`,
          menuItemId: menuItem.id,
          name: menuItem.name,
          displayName: menuItem.name,
          stock: 0,
          unit: "",
          buyingPrice,
          sellingPrice,
          quantitySold,
          capital: 0,
          revenue,
          profitLoss: revenue,
        };
      });

    const consumedItemIds = new Set([
      ...matchedMenuItemIds,
      ...menuItems.map((item) => item.id),
    ]);
    const archivedRows = Array.from(baristaSalesByItem.entries())
      .filter(([key]) => key.startsWith("item:") && !consumedItemIds.has(key.slice(5)))
      .map(([key, sales]) => ({
        id: `archived-finance-${key.slice(5)}`,
        menuItemId: key.slice(5),
        name: sales.label,
        displayName: `${sales.label} (Archived)`,
        stock: 0,
        unit: "",
        buyingPrice: 0,
        sellingPrice: sales.quantity > 0 ? sales.revenue / sales.quantity : 0,
        quantitySold: sales.quantity,
        capital: 0,
        revenue: sales.revenue,
        profitLoss: sales.revenue,
      }));

    return [...baristaInventoryRows, ...menuOnlyRows, ...archivedRows];
  }, [baristaInventoryRows, baristaSalesByItem, menuItems]);

  // Editable per-item pricing rows for the manager Inventory tab. Driven by the
  // POS menu so every drink gets editable Buying and Selling Price fields.
  const baristaManagerPricingRows = useMemo(
    () =>
      menuItems.map((menuItem) => {
        const target = normalizeBaristaTarget(menuItem.name);
        const storeMatch = baristaStoreItems.find(
          (entry) => entry.id === menuItem.storeItemId || normalizeBaristaTarget(getStoreItemLabel(entry)) === target,
        );
        const inventoryMatch = inventoryItems.find(
          (entry) => entry.id === menuItem.inventoryItemId || entry.id === menuItem.id,
        ) ?? inventoryItems.find((entry) => {
          if (entry.category !== "Bar") return false;
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
        const idSales = baristaSalesByItem.get(`item:${menuItem.id}`);
        const legacySales = baristaSalesByItem.get(getBaristaLegacySalesKey(menuItem.name));
        const quantitySold = (idSales?.quantity ?? 0) + (legacySales?.quantity ?? 0);
        return {
          id: menuItem.id,
          menuItemId: menuItem.id,
          inventoryItemId: inventoryMatch?.id ?? menuItem.inventoryItemId,
          storeItemId: storeMatch?.id ?? menuItem.storeItemId,
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
  const updateBaristaItemPricing = async (menuId: string, menuName: string, patch: { price?: number; buyingPrice?: number }) => {
    const activeBaristaKey = getActiveBaristaStateKey();
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The shared Barista menu could not be refreshed. No price change was saved; reconnect and try again.");
      return;
    }
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const sourceMenuItems =
      (snapshot.catalogRevision ?? 0) === 0 && snapshot.menuItems.length === 0
        ? menuItems
        : snapshot.menuItems;
    const sourceMenuItem = sourceMenuItems.find((item) => item.id === menuId);
    const targetKey = getBaristaLegacySalesKey(menuName);
    const latestInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const linkedInventoryItem = latestInventoryItems.find(
      (entry) => entry.id === sourceMenuItem?.inventoryItemId || entry.id === menuId,
    ) ?? latestInventoryItems.find(
      (entry) => entry.category === "Bar" && getBaristaLegacySalesKey(getBaristaInventoryLabel(entry)) === targetKey,
    );
    const allStoreItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const linkedStoreItem = allStoreItems.find(
      (entry) =>
        entry.lane === "barista" &&
        (entry.id === sourceMenuItem?.storeItemId || getBaristaLegacySalesKey(getBaristaMenuLabel(entry)) === targetKey),
    );
    let matched = false;
    const next = sourceMenuItems.map((item) => {
      if (item.id === menuId) {
        matched = true;
        return {
          ...item,
          ...(linkedInventoryItem ? { inventoryItemId: linkedInventoryItem.id } : {}),
          ...(linkedStoreItem ? { storeItemId: linkedStoreItem.id } : {}),
          ...patch,
        };
      }
      return item;
    });
    if (!matched) {
      // Legacy snapshots may not share the row ID. Fall back to one exact
      // display-name match only; broad target matching collapses bottle/TOTS
      // variants and used to change both prices together.
      const exactName = menuName.trim().replace(/\s+/g, " ").toLowerCase();
      const legacyIndex = next.findIndex((entry) => entry.name.trim().replace(/\s+/g, " ").toLowerCase() === exactName);
      if (legacyIndex >= 0) {
        next[legacyIndex] = { ...next[legacyIndex], ...patch };
        matched = true;
      }
    }
    if (!matched) return;
    const nextStoreItems = allStoreItems.map((entry) =>
      linkedStoreItem && entry.id === linkedStoreItem.id
        ? {
            ...entry,
            ...(typeof patch.price === "number" ? { sellingPrice: patch.price } : {}),
            ...(typeof patch.buyingPrice === "number" ? { buyingPrice: patch.buyingPrice } : {}),
          }
        : entry,
    );
    const nextInventoryItems = latestInventoryItems.map((entry) =>
      linkedInventoryItem && entry.id === linkedInventoryItem.id
        ? {
            ...entry,
            ...(typeof patch.price === "number" ? { sellingPrice: patch.price, price: patch.price } : {}),
            ...(typeof patch.buyingPrice === "number" ? { buyingPrice: patch.buyingPrice } : {}),
          }
        : entry,
    );
    const catalogCommit = await commitBaristaCatalogAndStockMutation(
      snapshot,
      next,
      allStoreItems,
      nextStoreItems,
      latestInventoryItems,
      nextInventoryItems,
    );
    if (!catalogCommit.ok) {
      window.alert(catalogCommit.reason === "catalog-changed" || catalogCommit.reason === "stock-changed"
        ? "Another manager or sale changed the Barista menu or stock first. Nothing was overwritten; review it and try the price edit again."
        : "The Barista price could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setStoredMenuItems(buildBaristaDisplayCatalog(
      catalogCommit.value.menuItems,
      catalogCommit.value.catalogRevision,
      catalogCommit.inventoryItems,
      catalogCommit.storeItems,
    ));
    setBaristaStoreItems(catalogCommit.storeItems.filter((entry) => entry.lane === "barista"));
    setInventoryItems(catalogCommit.inventoryItems);
  };

  // Set the available barista stock quantity for a menu item from the manager
  // Inventory tab. Quantity lives on the barista-lane store item (created on
  // demand for menu-only items) so POS stock checks and
  // sale deductions keep working.
  const updateBaristaItemStock = async (
    menuItem: {
      menuItemId: string;
      inventoryItemId?: string;
      storeItemId?: string;
      name: string;
      category: string;
      buyingPrice?: number;
      sellingPrice?: number;
    },
    qty: number,
  ) => {
    const activeBaristaKey = getActiveBaristaStateKey();
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("Shared Barista stock could not be refreshed. No quantity change was saved; reconnect and try again.");
      return;
    }
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const sourceMenuItems =
      (snapshot.catalogRevision ?? 0) === 0 && snapshot.menuItems.length === 0
        ? menuItems
        : snapshot.menuItems;
    const currentMenuItem = sourceMenuItems.find((item) => item.id === menuItem.menuItemId);
    if (!currentMenuItem) {
      window.alert("This Barista item was removed by another manager. Nothing was changed.");
      return;
    }
    const allStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const latestInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const target = normalizeBaristaTarget(menuItem.name);
    const index = allStoreItems.findIndex(
      (entry) =>
        entry.lane === "barista" &&
        (entry.id === currentMenuItem?.storeItemId ||
          entry.id === menuItem.storeItemId ||
          normalizeBaristaTarget(getStoreItemLabel(entry)) === target),
    );

    let nextStoreItems: Array<MainStoreItem & { lane?: "kitchen" | "barista" }>;
    let resolvedStoreItemId: string;
    if (index >= 0) {
      resolvedStoreItemId = allStoreItems[index].id;
      nextStoreItems = allStoreItems.map((entry, idx) => (idx === index ? { ...entry, stock: qty } : entry));
    } else {
      const seedRef = BARISTA_INVENTORY_SEED.find(
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
      resolvedStoreItemId = newStoreItem.id;
      nextStoreItems = [...allStoreItems, newStoreItem];
    }
    const inventoryTarget = latestInventoryItems.find((entry) =>
      entry.id === currentMenuItem.inventoryItemId || entry.id === menuItem.inventoryItemId,
    ) ?? latestInventoryItems.find((entry) =>
      entry.category === "Bar" && normalizeBaristaTarget(getBaristaInventoryLabel(entry)) === target,
    );
    const resolvedInventoryId = inventoryTarget?.id
      ?? `inv-barista-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const nextInventoryItems = inventoryTarget
      ? latestInventoryItems.map((entry) =>
          entry.id === inventoryTarget.id ? { ...entry, stock: qty } : entry)
      : [
          {
            id: resolvedInventoryId,
            barcode: currentMenuItem.barcode ?? "",
            name: menuItem.name,
            category: "Bar",
            subCategory: menuItem.category,
            size: "",
            stock: qty,
            totSold: 0,
            buyingPrice: menuItem.buyingPrice ?? 0,
            sellingPrice: menuItem.sellingPrice ?? currentMenuItem.price,
            price: menuItem.sellingPrice ?? currentMenuItem.price,
            status: "ACTIVE" as const,
            minStock: 0,
            unit: "Bottle",
            damages: 0,
            receivedStock: 0,
          },
          ...latestInventoryItems,
        ];
    const nextMenuItems = sourceMenuItems.map((item) =>
      item.id === currentMenuItem.id
        ? {
            ...item,
            storeItemId: resolvedStoreItemId,
            inventoryItemId: resolvedInventoryId,
          }
        : item,
    );
    const catalogCommit = await commitBaristaCatalogAndStockMutation(
      snapshot,
      nextMenuItems,
      allStoreItems,
      nextStoreItems,
      latestInventoryItems,
      nextInventoryItems,
    );
    if (!catalogCommit.ok) {
      window.alert(catalogCommit.reason === "catalog-changed" || catalogCommit.reason === "stock-changed"
        ? "Another manager or sale changed the Barista menu or stock first. Nothing was overwritten; review the latest quantity and try again."
        : "The Barista quantity could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setBaristaStoreItems(catalogCommit.storeItems.filter((entry) => entry.lane === "barista"));
    setInventoryItems(catalogCommit.inventoryItems);
    setStoredMenuItems(buildBaristaDisplayCatalog(
      catalogCommit.value.menuItems,
      catalogCommit.value.catalogRevision,
      catalogCommit.inventoryItems,
      catalogCommit.storeItems,
    ));
  };

  const recordWaste = async (item: BaristaMenuItem) => {
    if (isDirector) return;
    const approved = await confirm({
      title: "Remove Waste",
      description: `Are you sure you want to record 1 x ${item.name} as waste? This permanently removes it from barista stock.`,
      actionLabel: "Yes, Record Waste",
    });
    if (!approved) return;
    const wasteLog: BaristaWasteLog = {
      id: `bw-${createCheckoutId("waste")}`,
      name: item.name,
      qty: 1,
      createdAt: Date.now(),
    };
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_WASTE),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The latest stock and waste log could not be refreshed. Nothing was recorded.");
      return;
    }
    const stockResult = await withBaristaStockEffectLock(async () =>
      confirmBaristaStockResult(updateBaristaStoreStock([
      {
        itemId: item.id,
        inventoryItemId: item.inventoryItemId,
        storeItemId: item.storeItemId,
        name: item.name,
        qty: 1,
      },
      ], "consume", false, `waste:${wasteLog.id}`), [{
        key: STORAGE_WASTE,
        record: { ...wasteLog },
      }]));
    if (!stockResult.ok) {
      window.alert(stockResult.error);
      return;
    }
    window.alert(`Recorded waste: 1 x ${item.name}`);
  };

  const baristaCapitalTotal = useMemo(
    () => baristaFinanceRows.reduce((sum, item) => sum + item.capital, 0),
    [baristaFinanceRows],
  );
  const totalBaristaRevenue = useMemo(
    () => baristaPayments.reduce((sum, payment) => sum + (payment.total || 0), 0),
    [baristaPayments],
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
              paymentId: payment.id,
              actionRowSpan: 1,
              showDeleteAction: true,
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

        const allocatedAmounts = allocateBaristaPaymentAmounts(
          payment,
          payment.lines,
          (line) =>
            (line.itemId ? baristaMenuPriceByItemId.get(line.itemId) : undefined) ??
            baristaMenuPriceByItem.get(normalizeBaristaTarget(line.name)) ??
            0,
        );

        return payment.lines.map((line, index) => {

          return {
            id: `${payment.id}-${index}`,
            paymentId: payment.id,
            actionRowSpan: payment.lines?.length ?? 1,
            showDeleteAction: index === 0,
            code: payment.code,
            createdAt: payment.createdAt,
            itemName: line.name,
            quantity: line.qty,
            destination: payment.destination,
            method: payment.method,
            status: payment.status,
            amount: allocatedAmounts[index] ?? 0,
          };
        });
      }),
    [baristaMenuPriceByItem, baristaMenuPriceByItemId, filteredDirectorSalesPayments],
  );
  const directorSalesQuantityTotal = useMemo(
    () => directorSalesRows.reduce((sum, row) => sum + row.quantity, 0),
    [directorSalesRows],
  );
  const directorSalesAmountTotal = useMemo(
    () => filteredDirectorSalesPayments.reduce((sum, payment) => sum + payment.total, 0),
    [filteredDirectorSalesPayments],
  );

  const deleteBaristaSale = async (paymentId: string) => {
    if (!isManager || deletingPaymentId) return;

    const payment = baristaPayments.find((entry) => entry.id === paymentId);
    if (!payment) return;

    const approved = await confirm({
      title: "Delete Barista Sale",
      description: `Delete sale ${payment.code} for TSh ${payment.total.toLocaleString()}? This removes the full sale from reports and restores stock when it came from a current POS order.`,
      actionLabel: "Delete Sale",
    });
    if (!approved) return;

    setDeletingPaymentId(paymentId);
    try {
      const activeBaristaKey = getActiveBaristaStateKey();
      const hydration = await Promise.all([
        hydrateStorageKeyFromFirebase(activeBaristaKey),
        hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
        hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      ]);
      if (!hydration.every((result) => result.ok)) {
        window.alert("Shared Barista sales and stock could not be refreshed. Nothing was deleted; reconnect and try again.");
        return;
      }
      const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
        activeBaristaKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        490,
      );
      const currentPayment = snapshot.payments.find((entry) => entry.id === paymentId);
      if (!currentPayment) {
        toast({ title: "Sale already removed", description: `${payment.code} is no longer in Barista sales.` });
        return;
      }

      const linkedTicket = snapshot.tickets.find((ticket) => ticket.id === currentPayment.ticketId);
      const sourceStockApplicationId = currentPayment.id?.startsWith("bp-")
        ? currentPayment.id.slice(3)
        : currentPayment.ticketId?.startsWith("bt-")
          ? currentPayment.ticketId.slice(3)
          : currentPayment.ticketId ?? currentPayment.id ?? getPosPaymentSyncKey(currentPayment);
      const voidLines = currentPayment.stockRequired === false
        ? []
        : Array.isArray(linkedTicket?.lines) && linkedTicket.lines.length > 0
          ? linkedTicket.lines
          : Array.isArray(currentPayment.lines)
            ? currentPayment.lines
            : [];
      const stockCandidate = updateBaristaStoreStock(
        voidLines,
        "restore",
        false,
        `compensate:${sourceStockApplicationId}`,
        sourceStockApplicationId,
      );
      if (!stockCandidate.ok || !stockCandidate.storeItems || !stockCandidate.inventoryItems) {
        window.alert(stockCandidate.ok ? "The shared stock compensation could not be prepared." : stockCandidate.error);
        return;
      }

      const deletedPaymentKeys = Array.from(new Set([...(snapshot.deletedPaymentKeys ?? []), getPosPaymentSyncKey(currentPayment)]));
      const deletedTicketIds = currentPayment.ticketId
        ? Array.from(new Set([...(snapshot.deletedTicketIds ?? []), currentPayment.ticketId]))
        : snapshot.deletedTicketIds;
      const voidResult = await commitBaristaVoidWithStock(
        snapshot,
        [],
        deletedPaymentKeys,
        deletedTicketIds ?? [],
        stockCandidate.storeItems,
        stockCandidate.inventoryItems,
        stockCandidate.appliedEffects,
      );
      if (!voidResult.ok) {
        window.alert(voidResult.reason === "stock-conflict"
          ? "Stock changed while this sale was being deleted. Nothing was deleted or restored; refresh and try again."
          : "The shared sale deletion could not be confirmed. Nothing was deleted or restored; reconnect and try again.");
        return;
      }
      const committedSnapshot = voidResult.value;
      setBaristaPayments(committedSnapshot.payments);
      setTickets(committedSnapshot.tickets);
      setTicketSeq(committedSnapshot.ticketSeq);
      setStoredMenuItems(buildBaristaDisplayCatalog(
        committedSnapshot.menuItems,
        committedSnapshot.catalogRevision,
        readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
        readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
      ));
      toast({ title: "Barista sale deleted", description: `${currentPayment.code} was removed and sales totals were updated.` });
    } finally {
      setDeletingPaymentId(null);
    }
  };

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
            {baristaFinanceRows.map((item) => (
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
            {baristaFinanceRows.length === 0 && (
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
                {isManager && <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Action</TableHead>}
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
                  {isManager && row.showDeleteAction && (
                    <TableCell rowSpan={row.actionRowSpan} className="align-top">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-2 text-red-600 hover:border-red-300 hover:text-red-700"
                        disabled={deletingPaymentId !== null}
                        onClick={() => deleteBaristaSale(row.paymentId)}
                        aria-label={`Delete sale ${row.code}`}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        {deletingPaymentId === row.paymentId ? "Deleting..." : "Delete"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {directorSalesRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isManager ? 9 : 8} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
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
    setCartCatalogNotice("");
  };

  const placeTicket = async () => {
    if (isDirector) return;
    if (cart.length === 0) return;

    if (cartCatalogNotice) {
      setCartCatalogNotice("");
      window.alert("The ticket has been refreshed from the manager's latest menu. Review it once, then place the order again.");
      return;
    }

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

    const bookingTimestamp = getBookingTimestamp(bookingEntryMode, pastBookingDate, pastBookingTime);
    if (!Number.isFinite(bookingTimestamp) || bookingTimestamp > Date.now()) {
      window.alert("Choose a valid past booking date and time that is not in the future.");
      return;
    }

    const activeBaristaKey = getActiveBaristaStateKey();
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The latest Barista menu and stock could not be refreshed. No order was placed; reconnect and try again.");
      return;
    }
    const latestSnapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey,
      STORAGE_TICKETS,
      STORAGE_SEQ,
      STORAGE_PAYMENTS,
      STORAGE_MENU,
      490,
    );
    const allStoreItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const latestStoreItems = allStoreItems.filter((item) => item.lane === "barista");
    const latestCatalog = buildBaristaDisplayCatalog(
      latestSnapshot.menuItems,
      latestSnapshot.catalogRevision,
      readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
      latestStoreItems,
    );
    const reconciliation = reconcileBaristaCartWithCatalog(cart, latestCatalog);

    if (reconciliation.removedCount > 0) {
      setCart(reconciliation.nextCart);
      setCartCatalogNotice("Unavailable menu items were removed. Review the ticket before ordering.");
      window.alert("One or more items were removed by the manager. The cart was updated; please review it before checkout.");
      return;
    }
    if (reconciliation.changed) {
      setCart(reconciliation.nextCart);
      setCartCatalogNotice("Menu prices changed. Review the refreshed ticket before ordering.");
      window.alert("A manager changed a menu item or price. The cart now shows the latest values; please review and place the order again.");
      return;
    }

    const orderLines = createBaristaOrderLines(reconciliation.nextCart);
    const liveTotal = orderLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
    const checkoutFingerprint = buildCheckoutFingerprint({
      mode: serviceMode,
      destination,
      lines: orderLines,
      total: liveTotal,
      ...(bookingEntryMode === "past" ? { historicalCreatedAt: bookingTimestamp } : {}),
    });
    const checkoutId = resolveCheckoutId(
      STORAGE_CHECKOUT_ATTEMPT,
      checkoutFingerprint,
      () => createCheckoutId("barista"),
      pendingOrder
        ? { checkoutId: pendingOrder.checkoutId, fingerprint: pendingOrder.checkoutFingerprint }
        : null,
    );
    setPendingOrder({
      checkoutId,
      checkoutFingerprint,
      mode: serviceMode,
      destination,
      lines: orderLines,
      total: liveTotal,
      createdAt: bookingTimestamp,
      isPastBooking: bookingEntryMode === "past",
      paymentMethod: bookingEntryMode === "past" ? pastPaymentMethod : undefined,
      catalogRevision: latestSnapshot.catalogRevision,
    });
    setCartCatalogNotice("");
    setShowPayNowPopup(false);
    setShowSettlementPopup(true);
  };

  const finalizeOrder = async (status: BaristaPaymentStatus, method: BaristaPaymentMethod) => {
    if (isDirector || !pendingOrder || checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setCheckoutInFlight(true);
    const orderToFinalize = pendingOrder;

    try {
      const activeBaristaKey = getActiveBaristaStateKey();
      const hydration = await Promise.all([
        hydrateStorageKeyFromFirebase(activeBaristaKey),
        hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
        hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      ]);
      if (!hydration.every((result) => result.ok)) {
        window.alert("The latest Barista menu and stock could not be refreshed. Nothing was recorded; reconnect and try again.");
        return;
      }
      const latestSnapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
        activeBaristaKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        490,
      );
      const orderId = `bt-${orderToFinalize.checkoutId}`;
      const paymentId = `bp-${orderToFinalize.checkoutId}`;
      const existingPayment = latestSnapshot.payments.find((payment) => payment.id === paymentId);
      if (existingPayment) {
        if (
          existingPayment.stockRequired !== false &&
          existingPayment.ticketId &&
          !latestSnapshot.tickets.some((ticket) => ticket.id === existingPayment.ticketId)
        ) {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);
          setCart([]);
          setPendingOrder(null);
          setShowSettlementPopup(false);
          setShowPayNowPopup(false);
          window.alert(`Sale ${existingPayment.code} belongs to a cancelled order. It was not recreated and no stock was consumed.`);
          return;
        }
        const recoveredStockResult = orderToFinalize.isPastBooking
          ? { ok: true as const }
          : await withBaristaStockEffectLock(async () =>
              confirmBaristaStockResult(updateBaristaStoreStock(
                Array.isArray(existingPayment.lines) && existingPayment.lines.length > 0
                  ? existingPayment.lines
                  : orderToFinalize.lines,
                "consume",
                false,
                orderToFinalize.checkoutId,
              )));
        if (recoveredStockResult.ok) {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);
        }
        setTickets(latestSnapshot.tickets);
        setTicketSeq(latestSnapshot.ticketSeq);
        setBaristaPayments(latestSnapshot.payments);
        setStoredMenuItems(buildBaristaDisplayCatalog(
          latestSnapshot.menuItems,
          latestSnapshot.catalogRevision,
          readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
          readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
        ));
        setCart([]);
        setPendingOrder(null);
        setShowSettlementPopup(false);
        setShowPayNowPopup(false);
        window.alert(
          recoveredStockResult.ok
            ? `This sale was already recorded as ${existingPayment.code}; no duplicate was created and its stock deduction is confirmed.`
            : `This sale was already recorded as ${existingPayment.code}; no duplicate was created, but stock still needs attention: ${recoveredStockResult.error}`,
        );
        return;
      }
      const latestStoreItems = (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [])
        .filter((item) => item.lane === "barista");
      const latestCatalog = buildBaristaDisplayCatalog(
        latestSnapshot.menuItems,
        latestSnapshot.catalogRevision,
        readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
        latestStoreItems,
      );
      const reconciliation = reconcileBaristaOrderLinesWithCatalog(orderToFinalize.lines, latestCatalog);

      if (reconciliation.removedCount > 0 || reconciliation.changed) {
        setCart(reconciliation.nextCart);
        setPendingOrder(null);
        setShowSettlementPopup(false);
        setShowPayNowPopup(false);
        setCartCatalogNotice("The manager changed the menu before payment. Review the refreshed ticket before ordering again.");
        window.alert(
          reconciliation.removedCount > 0
            ? "A manager removed an item before payment. The cart was updated; please review it and place the order again."
            : "A manager changed a menu item or price before payment. The cart now has the latest values; please review it and place the order again.",
        );
        return;
      }

      const liveLines = reconciliation.nextLines;
      const liveTotal = liveLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
      let stockCandidate: ReturnType<typeof updateBaristaStoreStock> | null = null;
      if (!orderToFinalize.isPastBooking) {
        stockCandidate = updateBaristaStoreStock(
          liveLines,
          "consume",
          false,
          orderToFinalize.checkoutId,
        );
        if (!stockCandidate.ok) {
          window.alert(stockCandidate.error);
          return;
        }
      }

      const expectedCatalogRevision = latestSnapshot.catalogRevision ?? 0;
      const createdAt = orderToFinalize.createdAt;
      const pendingCode = "B-PENDING";
      const ticket: BaristaTicket = {
        id: orderId,
        code: pendingCode,
        createdAt,
        mode: orderToFinalize.mode,
        destination: orderToFinalize.destination,
        lines: liveLines,
        total: liveTotal,
      };
      const paymentRecord: BaristaPaymentRecord = {
        id: paymentId,
        ticketId: orderId,
        code: pendingCode,
        createdAt,
        mode: orderToFinalize.mode,
        destination: orderToFinalize.destination,
        total: liveTotal,
        status,
        method,
        lines: liveLines,
        stockRequired: !orderToFinalize.isPastBooking,
      };
      const nextTickets = orderToFinalize.isPastBooking ? latestSnapshot.tickets : [ticket, ...latestSnapshot.tickets];
      const nextPayments = [paymentRecord, ...latestSnapshot.payments];
      persistCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, {
        checkoutId: orderToFinalize.checkoutId,
        fingerprint: orderToFinalize.checkoutFingerprint,
      });
      const posCandidate = {
          tickets: nextTickets,
          ticketSeq: latestSnapshot.ticketSeq,
          payments: nextPayments,
          menuItems: latestSnapshot.menuItems,
          catalogRevision: expectedCatalogRevision,
          queueResetAt: latestSnapshot.queueResetAt ?? 0,
          deletedPaymentKeys: latestSnapshot.deletedPaymentKeys ?? [],
          deletedTicketIds: latestSnapshot.deletedTicketIds ?? [],
        };
      const ticketSequence = {
          prefix: "B",
          ...(orderToFinalize.isPastBooking ? {} : { ticketId: orderId }),
          paymentId,
        };
      const commitResult = orderToFinalize.isPastBooking
        ? await commitPosStateWithCatalogRevision(
            activeBaristaKey,
            expectedCatalogRevision,
            posCandidate,
            ticketSequence,
          )
        : stockCandidate?.ok && stockCandidate.storeItems && stockCandidate.inventoryItems
          ? await commitBaristaCheckoutWithStock(
              expectedCatalogRevision,
              posCandidate,
              ticketSequence,
              stockCandidate.storeItems,
              stockCandidate.inventoryItems,
              stockCandidate.appliedEffects,
            )
          : { ok: false as const, reason: "sync-failed" as const };

      if (!commitResult.ok) {
        if (commitResult.reason === "checkout-deleted") {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);
          setPendingOrder(null);
          setCart([]);
          setShowSettlementPopup(false);
          setShowPayNowPopup(false);
          window.alert("This checkout was deleted after it was first recorded. It was not recreated, no stock was changed, and no duplicate sale was made.");
        } else if (commitResult.reason === "catalog-changed") {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);
          const refreshedSnapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
            activeBaristaKey,
            STORAGE_TICKETS,
            STORAGE_SEQ,
            STORAGE_PAYMENTS,
            STORAGE_MENU,
            490,
          );
          const refreshedStoreItems = (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [])
            .filter((item) => item.lane === "barista");
          const refreshedCatalog = buildBaristaDisplayCatalog(
            refreshedSnapshot.menuItems,
            refreshedSnapshot.catalogRevision,
            readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
            refreshedStoreItems,
          );
          const refreshedOrder = reconcileBaristaOrderLinesWithCatalog(orderToFinalize.lines, refreshedCatalog);
          setStoredMenuItems(refreshedCatalog);
          setCart(refreshedOrder.nextCart);
          setPendingOrder(null);
          setShowSettlementPopup(false);
          setShowPayNowPopup(false);
          setCartCatalogNotice("The manager changed the menu during payment. Review the refreshed ticket before ordering again.");
          window.alert("The menu changed during payment, so the old-priced sale was not recorded. Review the refreshed ticket and try again.");
        } else if (commitResult.reason === "stock-conflict") {
          await Promise.all([
            hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
            hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
          ]);
          window.alert("Stock changed while this payment was being saved. No sale or ticket was recorded; review the refreshed quantities and try again.");
        } else {
          window.alert("The sale could not be safely synchronized. Nothing was recorded; please check the connection and try again.");
        }
        return;
      }

      const committedState = commitResult.value;
      const committedCode =
        committedState.payments.find((payment) => payment.id === paymentId)?.code ??
        committedState.tickets.find((entry) => entry.id === orderId)?.code;
      setTickets(committedState.tickets);
      setTicketSeq(committedState.ticketSeq);
      setBaristaPayments(committedState.payments);
      setStoredMenuItems(buildBaristaDisplayCatalog(
        committedState.menuItems,
        committedState.catalogRevision,
        readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
        readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
      ));

      clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);

      setCart([]);
      setCartCatalogNotice("");
      setPendingOrder(null);
      setShowSettlementPopup(false);
      setShowPayNowPopup(false);

      if (!committedCode || committedCode.endsWith("-PENDING")) {
        window.alert("The sale was recorded, but its receipt number could not be confirmed. Check the Barista sales list before retrying.");
        return;
      }

      if (orderToFinalize.isPastBooking) {
        toast({ title: "Past Barista payment recorded", description: new Date(createdAt).toLocaleString() });
        return;
      }

      const printResult = await printDepartmentReceipt({
        department: "barista",
        code: committedCode,
        destination: orderToFinalize.destination,
        mode: orderToFinalize.mode,
        method,
        status,
        total: liveTotal,
        createdAt,
        lines: liveLines,
      });

      if (!printResult.ok && printResult.reason) {
        window.alert(`Barista receipt was not printed: ${printResult.reason}`);
      }
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutInFlight(false);
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
      const hydration = await hydrateStorageKeyFromFirebase(activeBaristaKey);
      if (!hydration.ok) {
        window.alert("The shared Barista queue could not be refreshed. Nothing was marked delivered.");
        return;
      }
      const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
        activeBaristaKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        490,
      );
      const currentTicket = snapshot.tickets.find((ticket) => ticket.id === id);
      if (!currentTicket) {
        window.alert("This Barista order was cancelled or completed on another terminal.");
        return;
      }
      const deliveredAt = Date.now();
      const nextTickets = snapshot.tickets.map((ticket) =>
        ticket.id === id ? { ...ticket, status: "delivered" as const, deliveredAt } : ticket,
      );
      const committedSnapshot = await commitSyncedStorageValueAndWait(activeBaristaKey, {
        ...snapshot,
        tickets: nextTickets,
      });
      const committedTicket = committedSnapshot.tickets.find((ticket) => ticket.id === id);
      if (!committedTicket || committedTicket.status !== "delivered") {
        window.alert("This Barista order was cancelled on another terminal before delivery committed.");
        return;
      }
      setTickets(committedSnapshot.tickets);
      setTicketSeq(committedSnapshot.ticketSeq);
      setBaristaPayments(committedSnapshot.payments);
      setStoredMenuItems(buildBaristaDisplayCatalog(
        committedSnapshot.menuItems,
        committedSnapshot.catalogRevision,
        readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
        readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
      ));
    } catch {
      window.alert("The shared Barista queue did not confirm delivery. Reconnect and try again.");
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

    const activeBaristaKey = getActiveBaristaStateKey();
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("Shared Barista orders and stock could not be refreshed. Nothing was cancelled; reconnect and try again.");
      return;
    }
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const currentTicket = snapshot.tickets.find((entry) => entry.id === id);
    if (!currentTicket || currentTicket.status === "delivered") {
      window.alert("This Barista order was already completed or cancelled on another terminal.");
      return;
    }
    const sourceStockApplicationId = id.startsWith("bt-") ? id.slice(3) : id;
    const stockCandidate = updateBaristaStoreStock(
      currentTicket.lines,
      "restore",
      false,
      `compensate:${sourceStockApplicationId}`,
      sourceStockApplicationId,
    );
    if (!stockCandidate.ok || !stockCandidate.storeItems || !stockCandidate.inventoryItems) {
      window.alert(stockCandidate.ok ? "The cancellation stock compensation could not be prepared." : stockCandidate.error);
      return;
    }

    const cancelled: CancelledBaristaTicket = {
      ...currentTicket,
      source: "barista",
      cancelledAt: Date.now(),
    };

    const deletedTicketIds = Array.from(new Set([...(snapshot.deletedTicketIds ?? []), id]));
    const voidResult = await commitBaristaVoidWithStock(
      snapshot,
      [id],
      snapshot.deletedPaymentKeys ?? [],
      deletedTicketIds,
      stockCandidate.storeItems,
      stockCandidate.inventoryItems,
      stockCandidate.appliedEffects,
    );
    if (!voidResult.ok) {
      window.alert(voidResult.reason === "ticket-not-cancellable"
        ? "This order was delivered or cancelled on another terminal before the cancellation committed. No stock was restored."
        : voidResult.reason === "stock-conflict"
          ? "Stock changed while this order was being cancelled. Nothing was cancelled or restored; refresh and try again."
          : "The shared order cancellation could not be confirmed. Nothing was cancelled or restored; reconnect and try again.");
      return;
    }
    const committedSnapshot = voidResult.value;
    setTickets(committedSnapshot.tickets);
    setBaristaPayments(committedSnapshot.payments);
    setTicketSeq(committedSnapshot.ticketSeq);
    setStoredMenuItems(buildBaristaDisplayCatalog(
      committedSnapshot.menuItems,
      committedSnapshot.catalogRevision,
      readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
      readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
    ));
    const existing = readJson<CancelledBaristaTicket[]>(STORAGE_CANCELLED) ?? [];
    writeJson(STORAGE_CANCELLED, [cancelled, ...existing]);
  };

  const saveDrink = async () => {
    const name = drinkName.trim();
    const price = parseFloat(drinkPrice);
    if (!name || isNaN(price) || price < 0) return;
    const prep = Math.max(0, parseInt(drinkPrepMinutes, 10) || 5);

    const activeBaristaKey = getActiveBaristaStateKey();
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The shared Barista menu could not be refreshed. No drink change was saved; reconnect and try again.");
      return;
    }
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const latestInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const allStoreItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const latestStoreItems = allStoreItems.filter((item) => item.lane === "barista");
    const sourceMenuItems = buildBaristaDisplayCatalog(
      snapshot.menuItems,
      snapshot.catalogRevision,
      latestInventoryItems,
      latestStoreItems,
    );
    let next: BaristaMenuItem[];
    let nextInventoryItems = latestInventoryItems;
    let nextStoreItems = allStoreItems;
    if (drinkEditId) {
      const currentItem = sourceMenuItems.find((item) => item.id === drinkEditId);
      if (!currentItem) {
        window.alert("This Barista item was removed by another manager. The latest menu was loaded; nothing was changed.");
        setDrinkEditId(null);
        return;
      }
      next = sourceMenuItems.map((item) =>
        item.id === drinkEditId ? { ...item, name, price, category: drinkCategory, prepMinutes: prep } : item,
      );
      const targetKey = normalizeBaristaTarget(currentItem.name);
      const linkedInventoryItem = latestInventoryItems.find((item) =>
        item.id === currentItem.inventoryItemId || item.id === currentItem.id,
      ) ?? latestInventoryItems.find((item) =>
        item.category === "Bar" && normalizeBaristaTarget(getBaristaInventoryLabel(item)) === targetKey,
      );
      const linkedStoreItem = allStoreItems.find((item) =>
        item.lane === "barista" &&
        (item.id === currentItem.storeItemId || normalizeBaristaTarget(getStoreItemLabel(item)) === targetKey),
      );
      nextInventoryItems = latestInventoryItems.map((item) =>
        linkedInventoryItem && item.id === linkedInventoryItem.id
          ? { ...item, sellingPrice: price, price }
          : item,
      );
      nextStoreItems = allStoreItems.map((item) =>
        linkedStoreItem && item.id === linkedStoreItem.id
          ? { ...item, sellingPrice: price }
          : item,
      );
    } else {
      const newDrink: BaristaMenuItem = {
        id: `d-${Date.now()}`,
        name,
        price,
        category: drinkCategory,
        prepMinutes: prep,
      };
      next = [...sourceMenuItems, newDrink];
    }
    const catalogCommit = await commitBaristaCatalogAndStockMutation(
      snapshot,
      next,
      allStoreItems,
      nextStoreItems,
      latestInventoryItems,
      nextInventoryItems,
    );
    if (!catalogCommit.ok) {
      window.alert(catalogCommit.reason === "catalog-changed" || catalogCommit.reason === "stock-changed"
        ? "Another manager or sale changed the Barista menu or stock first. Nothing was overwritten; review the latest values and try again."
        : "The Barista menu change could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setStoredMenuItems(buildBaristaDisplayCatalog(
      catalogCommit.value.menuItems,
      catalogCommit.value.catalogRevision,
      catalogCommit.inventoryItems,
      catalogCommit.storeItems,
    ));
    setInventoryItems(catalogCommit.inventoryItems);
    setBaristaStoreItems(catalogCommit.storeItems.filter((item) => item.lane === "barista"));
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
    const hydration = await hydrateStorageKeyFromFirebase(activeBaristaKey);
    if (!hydration.ok) {
      window.alert("The shared Barista menu could not be refreshed. No drink was deleted; reconnect and try again.");
      return;
    }
    const snapshot = readPosState<BaristaTicket, BaristaPaymentRecord, BaristaMenuItem>(
      activeBaristaKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 490,
    );
    const sourceMenuItems =
      (snapshot.catalogRevision ?? 0) === 0 && snapshot.menuItems.length === 0
        ? storedMenuItems
        : snapshot.menuItems;
    const next = sourceMenuItems.filter((item) => item.id !== id);
    const catalogCommit = await commitPosCatalogMutation(activeBaristaKey, snapshot, next);
    if (!catalogCommit.ok) {
      window.alert(catalogCommit.reason === "catalog-changed"
        ? "Another manager changed the Barista menu first. The latest menu was loaded; review it and try deleting again."
        : "The Barista menu deletion could not be confirmed in shared storage. Nothing was deleted; reconnect and try again.");
      return;
    }
    setStoredMenuItems(buildBaristaDisplayCatalog(
      catalogCommit.value.menuItems,
      catalogCommit.value.catalogRevision,
      readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [],
      readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
    ));
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
          <TabsContent value="finance">{renderFinanceTable()}</TabsContent>
          <TabsContent value="inventory">
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
                                void updateBaristaItemStock(
                                  {
                                    menuItemId: item.menuItemId,
                                    inventoryItemId: item.inventoryItemId,
                                    storeItemId: item.storeItemId,
                                    name: item.name,
                                    category: item.category,
                                    buyingPrice: item.buyingPrice,
                                    sellingPrice: item.sellingPrice,
                                  },
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
                                updateBaristaItemPricing(item.id, item.name, { buyingPrice: value });
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
                                updateBaristaItemPricing(item.id, item.name, { price: value });
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
          </TabsContent>
          <TabsContent value="sales">{renderDirectorSalesTable()}</TabsContent>
          <TabsContent value="drinks">{renderDrinksManager()}</TabsContent>
        </Tabs>
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
          <TabsContent value="inventory">
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
          </TabsContent>
          <TabsContent value="finance">
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
          </TabsContent>
          <TabsContent value="sales">{renderDirectorSalesTable()}</TabsContent>
          <TabsContent value="purchases">
            <KitchenSessionManager isDirector department="barista" visibleTabs={["purchase"]} />
          </TabsContent>
        </Tabs>
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
              <Tabs value={bookingEntryMode} onValueChange={(value) => setBookingEntryMode(value as BookingEntryMode)}>
                <TabsList className="w-full grid grid-cols-2 h-11 bg-muted/30 rounded-xl">
                  <TabsTrigger value="current" className="font-black uppercase text-[10px] tracking-widest">Current Booking</TabsTrigger>
                  <TabsTrigger value="past" className="font-black uppercase text-[10px] tracking-widest">Record Past Booking</TabsTrigger>
                </TabsList>
              </Tabs>
              {bookingEntryMode === "past" && (
                <div className="grid grid-cols-1 gap-3 rounded-xl border bg-amber-50/60 p-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Booking Date</label>
                    <Input type="date" max={getLocalDateValue()} value={pastBookingDate} onChange={(event) => setPastBookingDate(event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Booking Time</label>
                    <Input type="time" value={pastBookingTime} onChange={(event) => setPastBookingTime(event.target.value)} />
                  </div>
                  <div className="space-y-1.5 md:col-span-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Payment Method</label>
                    <Tabs value={pastPaymentMethod} onValueChange={(value) => setPastPaymentMethod(value as BaristaPaymentMethod)}>
                      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-white/70 p-1 md:grid-cols-4">
                        <TabsTrigger value="cash" className="font-black uppercase text-[10px] tracking-widest">Cash</TabsTrigger>
                        <TabsTrigger value="card" className="font-black uppercase text-[10px] tracking-widest">Card</TabsTrigger>
                        <TabsTrigger value="mobile" className="font-black uppercase text-[10px] tracking-widest">Mobile</TabsTrigger>
                        <TabsTrigger value="credit" className="font-black uppercase text-[10px] tracking-widest">Credit</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  <p className="text-xs font-bold text-amber-800 md:col-span-2">Past bookings update dated payment reports only. Current and closing stock will not change.</p>
                </div>
              )}
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
                  const stockStatus = getMenuStockStatus(baristaStoreItems, item.name, item.storeItemId);
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

            {cartCatalogNotice && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-900">
                {cartCatalogNotice}
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
              <CardTitle className="text-xl font-black uppercase tracking-tight">{pendingOrder?.isPastBooking ? "Confirm Past Booking" : "Select Settlement"}</CardTitle>
              <CardDescription>{pendingOrder?.isPastBooking ? `${new Date(pendingOrder.createdAt).toLocaleString()} · ${pendingOrder.paymentMethod?.toUpperCase()}` : "Choose Pay Now or Credit"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingOrder?.isPastBooking ? (
                <Button
                  disabled={checkoutInFlight}
                  onClick={() => finalizeOrder(pendingOrder.paymentMethod === "credit" ? "credit" : "completed", pendingOrder.paymentMethod ?? "cash")}
                  className="w-full h-11 font-black uppercase text-[10px] tracking-widest"
                >
                  Record Past Payment
                </Button>
              ) : (
              <>
                <Button
                disabled={checkoutInFlight}
                onClick={() => {
                  setShowSettlementPopup(false);
                  setShowPayNowPopup(true);
                }}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest"
              >
                Paid Now
              </Button>
              <Button
                disabled={checkoutInFlight}
                onClick={() => finalizeOrder("credit", "credit")}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white"
              >
                Credit
              </Button>
              </>
              )}
              <Button
                variant="outline"
                disabled={checkoutInFlight}
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
              <Button disabled={checkoutInFlight} onClick={() => finalizeOrder("completed", "cash")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Cash
              </Button>
              <Button disabled={checkoutInFlight} onClick={() => finalizeOrder("completed", "card")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Card
              </Button>
              <Button disabled={checkoutInFlight} onClick={() => finalizeOrder("completed", "mobile")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Mobile
              </Button>
              <Button
                variant="outline"
                disabled={checkoutInFlight}
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
