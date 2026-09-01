"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readStoredRole } from "@/app/lib/auth";
import {
  KITCHEN_CATEGORY_LABELS,
  KITCHEN_CATEGORY_OPTIONS,
  KitchenMenuCategory,
  KitchenMenuItem,
  mergeKitchenMenuItems,
} from "@/app/lib/kitchen-menu";
import { InventoryItem, ROOMS, Role } from "@/app/lib/mock-data";
import {
  MainStoreItem,
  normalizeStockName,
  STORAGE_MAIN_STORE_ITEMS,
  STORAGE_INVENTORY_ITEMS,
  STORAGE_STORE_MOVEMENTS,
  STORAGE_STORE_USAGE,
  StoreMovementLog,
  StoreUsageLog,
} from "@/app/lib/inventory-transfer";
import { printDepartmentReceipt } from "@/app/lib/receipt-print";
import { buildCheckoutFingerprint, clearCheckoutAttempt, getPendingCheckoutAttempts, persistCheckoutAttempt, resolveCheckoutId } from "@/app/lib/pos-checkout-attempt";
import { getActiveKitchenStateKey, readJson, readPosState, writeJson } from "@/app/lib/storage";
import { useIsDirector } from "@/hooks/use-is-director";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KitchenSessionManager } from "@/components/dashboard/kitchen-session-manager";
import { ChefHat, Minus, Plus, Receipt, Search, Trash2, CheckCircle2, XCircle } from "lucide-react";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { commitBaristaStockEffectsAndLogs, commitPosStateWithCatalogRevision, commitSyncedStorageValueAndWait, hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";

type KitchenCategory = "all" | KitchenMenuCategory;
type ServiceMode = "restaurant" | "room-service" | "take-away";
type BookingEntryMode = "current" | "past";
type KitchenPaymentMethod = "cash" | "card" | "mobile" | "credit";
type KitchenPaymentStatus = "completed" | "credit";
type SalesDateFilter = "all" | "date";

interface CartLine {
  item: KitchenMenuItem;
  qty: number;
}

interface KitchenOrderLine {
  name: string;
  qty: number;
  // Optional so tickets/payments written before catalog-aware pricing remain
  // readable. Every new Kitchen POS order persists all three price fields.
  itemId?: string;
  unitPrice?: number;
  lineTotal?: number;
}

interface KitchenTicket {
  id: string;
  code: string;
  createdAt: number;
  mode: ServiceMode;
  destination: string;
  lines: KitchenOrderLine[];
  total: number;
}

interface CancelledKitchenTicket extends KitchenTicket {
  source?: "kitchen" | "barista";
  cancelledAt: number;
}

interface KitchenPaymentRecord {
  id: string;
  ticketId: string;
  code: string;
  createdAt: number;
  mode: ServiceMode;
  destination: string;
  lines?: KitchenOrderLine[];
  total: number;
  status: KitchenPaymentStatus;
  method: KitchenPaymentMethod;
}

interface PendingOrder {
  checkoutId: string;
  checkoutFingerprint: string;
  mode: ServiceMode;
  destination: string;
  lines: KitchenOrderLine[];
  total: number;
  createdAt: number;
  isPastBooking: boolean;
  catalogRevision: number;
}

const STORAGE_TICKETS = "orange-hotel-kitchen-tickets";
const STORAGE_SEQ = "orange-hotel-kitchen-seq";
const STORAGE_MENU = "orange-hotel-kitchen-menu";
const STORAGE_CANCELLED = "orange-hotel-cancelled-tickets";
const STORAGE_PAYMENTS = "orange-hotel-kitchen-payments";
const STORAGE_CHECKOUT_ATTEMPT = "orange-hotel-kitchen-checkout-attempt";

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

function getNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDayKey(createdAt: number | undefined) {
  const saleDate = new Date(getNumber(createdAt));
  if (!Number.isFinite(saleDate.getTime())) return "";
  return saleDate.toISOString().slice(0, 10);
}

function matchesSalesDateFilter(createdAt: number | undefined, filter: SalesDateFilter, selectedDate: string) {
  if (filter === "all") return true;
  return Boolean(selectedDate) && toDayKey(createdAt) === selectedDate;
}

function formatPaymentDate(createdAt: number | undefined) {
  if (!createdAt) return "-";
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "-";
}

function normalizeKitchenCatalogForRevision(
  menuItems: KitchenMenuItem[],
  catalogRevision: number | undefined,
) {
  return mergeKitchenMenuItems(menuItems, {
    // Revision zero is the only confirmed first/legacy catalog state. Once a
    // catalog has been published, a missing built-in represents an intentional
    // deletion and must remain missing.
    includeDefaultMenu: (catalogRevision ?? 0) === 0,
  });
}

function resolveCartAgainstCatalog(cart: CartLine[], catalog: KitchenMenuItem[]) {
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const lines: CartLine[] = [];
  const removedNames: string[] = [];
  const changedNames: string[] = [];

  cart.forEach((line) => {
    const currentItem = catalogById.get(line.item.id);
    if (!currentItem) {
      removedNames.push(line.item.name);
      return;
    }

    if (currentItem.name !== line.item.name || currentItem.price !== line.item.price) {
      changedNames.push(currentItem.name);
    }

    lines.push({
      ...line,
      item: currentItem,
    });
  });

  return {
    lines,
    removedNames,
    changedNames,
    changed:
      removedNames.length > 0 ||
      lines.some((line, index) => line.item !== cart[index]?.item || line.qty !== cart[index]?.qty),
  };
}

function buildKitchenOrderLines(cart: CartLine[]): KitchenOrderLine[] {
  return cart.map((line) => ({
    itemId: line.item.id,
    name: line.item.name,
    qty: line.qty,
    unitPrice: line.item.price,
    lineTotal: line.item.price * line.qty,
  }));
}

function resolveOrderLinesAgainstCatalog(lines: KitchenOrderLine[], catalog: KitchenMenuItem[]) {
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const catalogByName = new Map(catalog.map((item) => [item.name.trim().toLowerCase(), item]));
  const nextLines: KitchenOrderLine[] = [];
  const removedNames: string[] = [];
  const changedNames: string[] = [];

  lines.forEach((line) => {
    // The exact-name fallback is only for a pending order created by older
    // client code during a hot deployment. New orders always carry itemId.
    const currentItem = line.itemId
      ? catalogById.get(line.itemId)
      : catalogByName.get(line.name.trim().toLowerCase());
    if (!currentItem) {
      removedNames.push(line.name);
      return;
    }

    const qty = Number.isFinite(line.qty) && line.qty > 0 ? line.qty : 0;
    const nextLine: KitchenOrderLine = {
      itemId: currentItem.id,
      name: currentItem.name,
      qty,
      unitPrice: currentItem.price,
      lineTotal: currentItem.price * qty,
    };
    if (
      line.itemId !== nextLine.itemId ||
      line.name !== nextLine.name ||
      line.unitPrice !== nextLine.unitPrice ||
      line.lineTotal !== nextLine.lineTotal
    ) {
      changedNames.push(currentItem.name);
    }
    nextLines.push(nextLine);
  });

  return {
    lines: nextLines,
    removedNames,
    changedNames,
    total: nextLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0),
  };
}

function allocateKitchenPaymentAmounts(
  payment: KitchenPaymentRecord,
  lines: KitchenOrderLine[],
  getLegacyUnitPrice: (line: KitchenOrderLine) => number,
) {
  const paymentTotal = getNumber(payment.total);
  const weights = lines.map((line) => {
    if (typeof line.lineTotal === "number" && Number.isFinite(line.lineTotal) && line.lineTotal >= 0) {
      return line.lineTotal;
    }
    if (typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice) && line.unitPrice >= 0) {
      return line.unitPrice * line.qty;
    }
    return getLegacyUnitPrice(line) * line.qty;
  });
  const weightTotal = weights.reduce((sum, amount) => sum + amount, 0);
  const quantityTotal = lines.reduce((sum, line) => sum + line.qty, 0);
  let allocated = 0;

  return lines.map((line, index) => {
    if (index === lines.length - 1) return paymentTotal - allocated;
    const divisor = weightTotal > 0 ? weightTotal : quantityTotal;
    const weight = weightTotal > 0 ? weights[index] : line.qty;
    const amount = Math.round(paymentTotal * (divisor > 0 ? (weight ?? 0) / divisor : 0) * 100) / 100;
    allocated += amount;
    return amount;
  });
}

export default function KitchenPage() {
  const isDirector = useIsDirector();
  const { confirm, dialog } = useConfirmDialog();
  const [role, setRole] = useState<Role | null>(null);
  const isManager = role === "manager";
  const [directorTab, setDirectorTab] = useState<"inventory" | "purchases" | "entries" | "sales">("inventory");
  const [directorSalesDateFilter, setDirectorSalesDateFilter] = useState<SalesDateFilter>("all");
  const [directorSalesDate, setDirectorSalesDate] = useState("");
  const [category, setCategory] = useState<KitchenCategory>("all");
  const [serviceMode, setServiceMode] = useState<ServiceMode>("restaurant");
  const [bookingEntryMode, setBookingEntryMode] = useState<BookingEntryMode>("current");
  const [pastBookingDate, setPastBookingDate] = useState(getLocalDateValue);
  const [pastBookingTime, setPastBookingTime] = useState(() => new Date().toTimeString().slice(0, 5));
  const [searchTerm, setSearchTerm] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [roomNumber, setRoomNumber] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [, setTicketSeq] = useState(300);
  const [menuItems, setMenuItems] = useState<KitchenMenuItem[]>([]);
  const [kitchenPayments, setKitchenPayments] = useState<KitchenPaymentRecord[]>([]);
  const [posHydrated, setPosHydrated] = useState(false);
  const [queueTab, setQueueTab] = useState<"queue" | "from-store">("queue");
  const [kitchenStoreItems, setKitchenStoreItems] = useState<MainStoreItem[]>([]);
  const [fromStoreEntries, setFromStoreEntries] = useState<StoreMovementLog[]>([]);
  const [usageLogs, setUsageLogs] = useState<StoreUsageLog[]>([]);
  const [useEntryId, setUseEntryId] = useState("");
  const [useQty, setUseQty] = useState("1");
  const [cartCatalogNotice, setCartCatalogNotice] = useState("");

  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [showSettlementPopup, setShowSettlementPopup] = useState(false);
  const [showPayNowPopup, setShowPayNowPopup] = useState(false);
  const checkoutInFlightRef = useRef(false);
  const authoritativeHydrationRef = useRef(false);
  const [checkoutInFlight, setCheckoutInFlight] = useState(false);

  useEffect(() => {
    if (!posHydrated) return;
    const committedAttempts = getPendingCheckoutAttempts(STORAGE_CHECKOUT_ATTEMPT)
      .filter((attempt) => kitchenPayments.some((payment) => payment.id === `kp-${attempt.checkoutId}`));
    if (committedAttempts.length === 0) return;
    committedAttempts.forEach((attempt) => clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, attempt.checkoutId));
    setCart([]);
    setPendingOrder(null);
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);
    window.alert("A previously interrupted Kitchen checkout was already recorded. It has been recovered without creating a duplicate.");
  }, [kitchenPayments, posHydrated]);

  const roomSuggestions = useMemo(() => ROOMS.map((room) => room.number), []);
  const tableSuggestions = useMemo(
    () => Array.from({ length: 30 }, (_, index) => String(index + 1)),
    [],
  );

  useEffect(() => {
    const savedRole = readStoredRole();
    setRole(savedRole);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const activeKitchenKey = getActiveKitchenStateKey();

    const applyKitchenSnapshot = () => {
      if (cancelled) return;
      const snapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
        activeKitchenKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        300,
      );
      setTickets(snapshot.tickets);
      setTicketSeq(snapshot.ticketSeq);
      setKitchenPayments(snapshot.payments);
      const nextMenuItems = normalizeKitchenCatalogForRevision(
        snapshot.menuItems,
        snapshot.catalogRevision,
      );
      setMenuItems(nextMenuItems);
      if (authoritativeHydrationRef.current) setPosHydrated(true);
    };

    let retryTimer: number | null = null;
    const hydrateKitchen = async () => {
      const result = await hydrateStorageKeyFromFirebase(activeKitchenKey);
      if (cancelled) return;
      if (result.ok) {
        authoritativeHydrationRef.current = true;
        applyKitchenSnapshot();
        return;
      }
      retryTimer = window.setTimeout(hydrateKitchen, 5000);
    };

    void hydrateKitchen();
    const unsubscribeKitchen = subscribeToSyncedStorageKey(activeKitchenKey, applyKitchenSnapshot);

    return () => {
      cancelled = true;
      authoritativeHydrationRef.current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribeKitchen();
    };
  }, []);

  // The rendered cart is derived from the live menu immediately. The effect
  // then commits that resolved cart so deleted dishes cannot survive in state
  // and price/name changes cannot be charged from an old item object.
  const cartResolution = useMemo(() => resolveCartAgainstCatalog(cart, menuItems), [cart, menuItems]);
  const liveCart = cartResolution.lines;

  useEffect(() => {
    if (!cartResolution.changed) return;
    setCart(cartResolution.lines);
    if (cartResolution.removedNames.length > 0) {
      setCartCatalogNotice(`Removed unavailable menu item(s): ${cartResolution.removedNames.join(", ")}. Review the ticket before ordering.`);
      return;
    }
    if (cartResolution.changedNames.length > 0) {
      setCartCatalogNotice(`Menu pricing was updated for: ${cartResolution.changedNames.join(", ")}. The ticket now uses the current price.`);
    }
  }, [cartResolution]);

  // A manager can publish a price while the settlement modal is already open.
  // Cancel the pending settlement and force a fresh Place Order action so its
  // durable checkout fingerprint can never describe an older-priced basket.
  useEffect(() => {
    if (!pendingOrder) return;
    const resolvedOrder = resolveOrderLinesAgainstCatalog(pendingOrder.lines, menuItems);
    if (resolvedOrder.removedNames.length > 0) {
      setPendingOrder(null);
      setShowSettlementPopup(false);
      setShowPayNowPopup(false);
      setCartCatalogNotice(`Removed unavailable menu item(s): ${resolvedOrder.removedNames.join(", ")}. Build and review the ticket again.`);
      return;
    }
    if (resolvedOrder.changedNames.length === 0 && resolvedOrder.total === pendingOrder.total) return;

    setPendingOrder(null);
    setShowPayNowPopup(false);
    setShowSettlementPopup(false);
    setCartCatalogNotice(`The menu changed. Review the current total of TSh ${resolvedOrder.total.toLocaleString()}, then place the order again.`);
  }, [menuItems, pendingOrder, showPayNowPopup]);

  const loadFromStoreData = () => {
    const savedStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS);
    const savedMovements = readJson<StoreMovementLog[]>(STORAGE_STORE_MOVEMENTS);
    const savedUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE);
    setKitchenStoreItems(Array.isArray(savedStoreItems) ? savedStoreItems.filter((entry) => entry.lane === "kitchen") : []);
    setFromStoreEntries(Array.isArray(savedMovements) ? savedMovements.filter((entry) => entry.destination === "kitchen") : []);
    setUsageLogs(Array.isArray(savedUsage) ? savedUsage.filter((entry) => entry.destination === "kitchen") : []);
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

 const addUsage = async () => {
   const qty = Number(useQty);
   const entry = fromStoreEntries.find((item) => item.id === useEntryId);
   if (!entry || Number.isNaN(qty) || qty <= 0) return;
   const approved = await confirm({
      title: "Record Kitchen Usage",
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
      window.alert("The latest usage and Kitchen Inventory balances could not be refreshed. Nothing was recorded.");
      return;
    }
    const existingUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE) ?? [];
    const remoteUsedQty = existingUsage
      .filter((usage) => usage.destination === "kitchen" && usage.movementId === entry.id)
      .reduce((sum, usage) => sum + usage.quantityUsed, 0);
    const remaining = entry.convertedQty - remoteUsedQty;
    if (qty > remaining) {
      window.alert(`Only ${Math.max(0, remaining)} units remain for this store transfer.`);
      return;
    }
   const log: StoreUsageLog = {
      id: `su-${createCheckoutId("usage")}`,
      movementId: entry.id,
      destination: "kitchen",
     quantityUsed: qty,
     usedAt: Date.now(),
   };
   const existingInventory = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const targetName = normalizeStockName(entry.itemName);
    const target = existingInventory.find((item) =>
      item.category === "Kitchen" && (
        normalizeStockName(item.name) === targetName ||
        normalizeStockName(`${item.name} ${item.size ?? ""}`) === targetName
      ),
   );
    if (!target) {
      window.alert(`No Kitchen Inventory row is linked to ${entry.itemName}.`);
      return;
    }
    if (qty > target.stock) {
      window.alert(`Not enough Kitchen Inventory stock for ${entry.itemName}.`);
      return;
    }
    const effectId = `usage:${log.id}`;
    const nextInventory = existingInventory.map((item) => item.id === target.id
      ? {
          ...item,
          stock: item.stock - qty,
          appliedStockEffectIds: Array.from(new Set([...(item.appliedStockEffectIds ?? []), effectId])),
          stockEffects: {
            ...(item.stockEffects ?? {}),
            [effectId]: { kind: "units" as const, delta: -qty },
          },
        }
      : item);
    const committed = await commitBaristaStockEffectsAndLogs(
      readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [],
      nextInventory,
      [{ id: effectId, target: "inventory", itemId: target.id }],
      [{ key: STORAGE_STORE_USAGE, record: { ...log } }],
      [{ movementId: entry.id, destination: "kitchen", maxQuantity: entry.convertedQty }],
    );
    if (!committed.ok) {
      window.alert(committed.reason === "usage-capacity-exceeded"
        ? "Another terminal used the remaining quantity first. Refresh the transfer balance and try again."
        : "The Kitchen usage and Inventory deduction could not be confirmed together.");
      return;
    }
    setUsageLogs(
      (committed.appendedValues[STORAGE_STORE_USAGE] as StoreUsageLog[])
        .filter((usage) => usage.destination === "kitchen"),
    );
   setUseQty("1");
 };

  const filteredMenu = useMemo(
    () =>
      menuItems.filter((item) => {
        const inCategory = category === "all" || item.category === category;
        const inSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase());
        return inCategory && inSearch;
      }),
    [category, menuItems, searchTerm],
  );

  const subtotal = useMemo(() => liveCart.reduce((sum, line) => sum + line.item.price * line.qty, 0), [liveCart]);
  const completedSalesTotal = useMemo(
    () => kitchenPayments.filter((payment) => payment.status !== "credit").reduce((sum, payment) => sum + payment.total, 0),
    [kitchenPayments],
  );
  const creditSalesTotal = useMemo(
    () => kitchenPayments.filter((payment) => payment.status === "credit").reduce((sum, payment) => sum + payment.total, 0),
    [kitchenPayments],
  );
  const recentSales = useMemo(
    () => [...kitchenPayments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8),
    [kitchenPayments],
  );
  const kitchenMenuPriceByItem = useMemo(() => {
    const priceMap = new Map<string, number>();
    menuItems.forEach((item) => {
      const key = item.name.trim().toLowerCase();
      if (item.price > 0) priceMap.set(key, item.price);
    });
    return priceMap;
  }, [menuItems]);
  const kitchenMenuPriceByItemId = useMemo(() => {
    const priceMap = new Map<string, number>();
    menuItems.forEach((item) => {
      if (item.price > 0) priceMap.set(item.id, item.price);
    });
    return priceMap;
  }, [menuItems]);
  const filteredDirectorSalesPayments = useMemo(
    () =>
      [...kitchenPayments]
        .filter((payment) => matchesSalesDateFilter(payment.createdAt, directorSalesDateFilter, directorSalesDate))
        .sort((a, b) => b.createdAt - a.createdAt),
    [directorSalesDate, directorSalesDateFilter, kitchenPayments],
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
              amount: getNumber(payment.total),
            },
          ];
        }

        const allocatedAmounts = allocateKitchenPaymentAmounts(
          payment,
          payment.lines,
          (line) =>
            (line.itemId ? kitchenMenuPriceByItemId.get(line.itemId) : undefined) ??
            kitchenMenuPriceByItem.get(line.name.trim().toLowerCase()) ??
            0,
        );

        return payment.lines.map((line, index) => {

          return {
            id: `${payment.id}-${index}`,
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
    [filteredDirectorSalesPayments, kitchenMenuPriceByItem, kitchenMenuPriceByItemId],
  );
  const directorSalesQuantityTotal = useMemo(
    () => directorSalesRows.reduce((sum, row) => sum + row.quantity, 0),
    [directorSalesRows],
  );
  const directorSalesAmountTotal = useMemo(
    () => filteredDirectorSalesPayments.reduce((sum, payment) => sum + getNumber(payment.total), 0),
    [filteredDirectorSalesPayments],
  );

  const renderDirectorSalesTable = () => (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-black uppercase tracking-tight">Kitchen Sales</h2>
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            All recorded kitchen POS sales for the selected period.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Tabs value={directorSalesDateFilter} onValueChange={(value) => setDirectorSalesDateFilter(value as SalesDateFilter)}>
          <TabsList className="h-10">
            <TabsTrigger value="all" className="font-black uppercase text-[10px] tracking-widest">All Time</TabsTrigger>
            <TabsTrigger value="date" className="font-black uppercase text-[10px] tracking-widest">Date</TabsTrigger>
          </TabsList>
        </Tabs>
        {directorSalesDateFilter === "date" && (
          <Input type="date" value={directorSalesDate} onChange={(event) => setDirectorSalesDate(event.target.value)} className="h-10 sm:w-[160px]" />
        )}
        </div>
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

  if (!posHydrated) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <p className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">Syncing Kitchen POS</p>
          <h1 className="mt-3 text-2xl font-black uppercase tracking-tight">Loading live menu...</h1>
        </div>
      </div>
    );
  }

  const addToCart = (item: KitchenMenuItem) => {
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
      title: "Clear Kitchen Ticket",
      description: "Are you sure you want to clear the current ticket?",
      actionLabel: "Clear Ticket",
    });
    if (!approved) return;
    setCart([]);
    setCartCatalogNotice("");
  };

  const placeTicket = async () => {
    if (isDirector) return;
    if (liveCart.length === 0) return;

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

    // Re-read the local canonical snapshot at the action boundary. A realtime
    // catalog event can arrive between render and this click, so the rendered
    // subtotal alone is not authoritative enough for checkout.
    const activeKitchenKey = getActiveKitchenStateKey();
    await hydrateStorageKeyFromFirebase(activeKitchenKey).catch(() => undefined);
    const latestSnapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
      activeKitchenKey,
      STORAGE_TICKETS,
      STORAGE_SEQ,
      STORAGE_PAYMENTS,
      STORAGE_MENU,
      300,
    );
    const latestMenuItems = normalizeKitchenCatalogForRevision(
      latestSnapshot.menuItems,
      latestSnapshot.catalogRevision,
    );
    const latestCart = resolveCartAgainstCatalog(liveCart, latestMenuItems);

    if (latestCart.removedNames.length > 0) {
      setCart(latestCart.lines);
      setCartCatalogNotice(`Removed unavailable menu item(s): ${latestCart.removedNames.join(", ")}. Review the ticket before ordering.`);
      window.alert("The menu changed and unavailable items were removed. Review the ticket, then place the order again.");
      return;
    }

    if (latestCart.changedNames.length > 0) {
      setCart(latestCart.lines);
      setCartCatalogNotice(`Menu pricing was updated for: ${latestCart.changedNames.join(", ")}. Review the new total before ordering.`);
      window.alert("The menu price changed. The ticket was updated to the current price; review the new total, then place the order again.");
      return;
    }

    if (latestCart.lines.length === 0) return;
    const pendingLines = buildKitchenOrderLines(latestCart.lines);
    const pendingTotal = pendingLines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
    const checkoutFingerprint = buildCheckoutFingerprint({
      mode: serviceMode,
      destination,
      lines: pendingLines,
      total: pendingTotal,
      ...(bookingEntryMode === "past" ? { historicalCreatedAt: bookingTimestamp } : {}),
    });
    const checkoutId = resolveCheckoutId(
      STORAGE_CHECKOUT_ATTEMPT,
      checkoutFingerprint,
      () => createCheckoutId("kitchen"),
      pendingOrder
        ? { checkoutId: pendingOrder.checkoutId, fingerprint: pendingOrder.checkoutFingerprint }
        : null,
    );
    setCart(latestCart.lines);
    setPendingOrder({
      checkoutId,
      checkoutFingerprint,
      mode: serviceMode,
      destination,
      lines: pendingLines,
      total: pendingTotal,
      createdAt: bookingTimestamp,
      isPastBooking: bookingEntryMode === "past",
      catalogRevision: latestSnapshot.catalogRevision ?? 0,
    });
    setCartCatalogNotice("");
    setShowPayNowPopup(false);
    setShowSettlementPopup(true);
  };

  const finalizeOrder = async (status: KitchenPaymentStatus, method: KitchenPaymentMethod) => {
    if (isDirector || !pendingOrder || checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setCheckoutInFlight(true);
    const orderToFinalize = pendingOrder;

    try {
      const activeKitchenKey = getActiveKitchenStateKey();
      await hydrateStorageKeyFromFirebase(activeKitchenKey).catch(() => undefined);
      const latestSnapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
        activeKitchenKey,
        STORAGE_TICKETS,
        STORAGE_SEQ,
        STORAGE_PAYMENTS,
        STORAGE_MENU,
        300,
      );
      const orderId = `kt-${orderToFinalize.checkoutId}`;
      const paymentId = `kp-${orderToFinalize.checkoutId}`;
      const existingPayment = latestSnapshot.payments.find((payment) => payment.id === paymentId);
      if (existingPayment) {
        clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, orderToFinalize.checkoutId);
        setTickets(latestSnapshot.tickets);
        setTicketSeq(latestSnapshot.ticketSeq);
        setKitchenPayments(latestSnapshot.payments);
        setMenuItems(normalizeKitchenCatalogForRevision(latestSnapshot.menuItems, latestSnapshot.catalogRevision));
        setCart([]);
        setPendingOrder(null);
        setShowSettlementPopup(false);
        setShowPayNowPopup(false);
        window.alert(`This sale was already recorded as ${existingPayment.code}; no duplicate was created.`);
        return;
      }
      const latestMenuItems = normalizeKitchenCatalogForRevision(
        latestSnapshot.menuItems,
        latestSnapshot.catalogRevision,
      );
      const resolvedOrder = resolveOrderLinesAgainstCatalog(orderToFinalize.lines, latestMenuItems);

      if (resolvedOrder.removedNames.length > 0) {
        const latestCart = resolveCartAgainstCatalog(cart, latestMenuItems);
        setMenuItems(latestMenuItems);
        setCart(latestCart.lines);
        setPendingOrder(null);
        setShowSettlementPopup(false);
        setShowPayNowPopup(false);
        setCartCatalogNotice(`Removed unavailable menu item(s): ${resolvedOrder.removedNames.join(", ")}. Build and review the ticket again.`);
        window.alert("This order contains a menu item that is no longer available. It was removed; rebuild and review the ticket before payment.");
        return;
      }

      const expectedCatalogRevision = latestSnapshot.catalogRevision ?? 0;
      const pendingPriceChanged =
        resolvedOrder.changedNames.length > 0 ||
        resolvedOrder.total !== orderToFinalize.total;
      if (pendingPriceChanged) {
        const checkoutFingerprint = buildCheckoutFingerprint({
          mode: orderToFinalize.mode,
          destination: orderToFinalize.destination,
          lines: resolvedOrder.lines,
          total: resolvedOrder.total,
          ...(orderToFinalize.isPastBooking ? { historicalCreatedAt: orderToFinalize.createdAt } : {}),
        });
        setMenuItems(latestMenuItems);
        setCart(resolveCartAgainstCatalog(cart, latestMenuItems).lines);
        setPendingOrder({
          ...orderToFinalize,
          checkoutId: resolveCheckoutId(
            STORAGE_CHECKOUT_ATTEMPT,
            checkoutFingerprint,
            () => createCheckoutId("kitchen"),
          ),
          checkoutFingerprint,
          lines: resolvedOrder.lines,
          total: resolvedOrder.total,
          catalogRevision: expectedCatalogRevision,
        });
        setShowPayNowPopup(false);
        setShowSettlementPopup(true);
        setCartCatalogNotice(`The pending order now uses the current menu total: TSh ${resolvedOrder.total.toLocaleString()}.`);
        window.alert(`The menu changed before payment. The new total is TSh ${resolvedOrder.total.toLocaleString()}. Review it and select settlement again.`);
        return;
      }

      const finalizedOrder: PendingOrder = {
        ...orderToFinalize,
        lines: resolvedOrder.lines,
        total: resolvedOrder.total,
        catalogRevision: expectedCatalogRevision,
      };
      const createdAt = finalizedOrder.createdAt;
      const pendingCode = "K-PENDING";
      const ticket: KitchenTicket = {
        id: orderId,
        code: pendingCode,
        createdAt,
        mode: finalizedOrder.mode,
        destination: finalizedOrder.destination,
        lines: finalizedOrder.lines,
        total: finalizedOrder.total,
      };
      const paymentRecord: KitchenPaymentRecord = {
        id: paymentId,
        ticketId: orderId,
        code: pendingCode,
        createdAt,
        mode: finalizedOrder.mode,
        destination: finalizedOrder.destination,
        lines: finalizedOrder.lines,
        total: finalizedOrder.total,
        status,
        method,
      };
      const nextTickets = [ticket, ...latestSnapshot.tickets];
      const nextPayments = [paymentRecord, ...latestSnapshot.payments];
      persistCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, {
        checkoutId: finalizedOrder.checkoutId,
        fingerprint: finalizedOrder.checkoutFingerprint,
      });
      const commitResult = await commitPosStateWithCatalogRevision(
        activeKitchenKey,
        expectedCatalogRevision,
        {
          tickets: nextTickets,
          ticketSeq: latestSnapshot.ticketSeq,
          payments: nextPayments,
          // Checkout is an operational write. Preserve the exact canonical
          // catalog whose revision was validated instead of persisting a
          // display-normalized or initially seeded view at the same revision.
          menuItems: latestSnapshot.menuItems,
          catalogRevision: expectedCatalogRevision,
          queueResetAt: latestSnapshot.queueResetAt ?? 0,
          deletedPaymentKeys: latestSnapshot.deletedPaymentKeys ?? [],
          deletedTicketIds: latestSnapshot.deletedTicketIds ?? [],
        },
        { prefix: "K", ticketId: orderId, paymentId },
      );

      if (!commitResult.ok) {
        if (commitResult.reason === "checkout-deleted") {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, finalizedOrder.checkoutId);
          setPendingOrder(null);
          setCart([]);
          setShowSettlementPopup(false);
          setShowPayNowPopup(false);
          window.alert("This checkout was deleted after it was first recorded. It was not recreated and no duplicate sale was made.");
        } else if (commitResult.reason === "catalog-changed") {
          clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, finalizedOrder.checkoutId);
          const refreshedSnapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
            activeKitchenKey,
            STORAGE_TICKETS,
            STORAGE_SEQ,
            STORAGE_PAYMENTS,
            STORAGE_MENU,
            300,
          );
          const refreshedMenu = normalizeKitchenCatalogForRevision(
            refreshedSnapshot.menuItems,
            refreshedSnapshot.catalogRevision,
          );
          const refreshedOrder = resolveOrderLinesAgainstCatalog(orderToFinalize.lines, refreshedMenu);
          setMenuItems(refreshedMenu);
          setCart(resolveCartAgainstCatalog(cart, refreshedMenu).lines);
          // The old attempt is cleared above. Force a new Place Order action so
          // the new price and its durable fingerprint/ID are created together.
          setPendingOrder(null);
          setShowPayNowPopup(false);
          setShowSettlementPopup(false);
          setCartCatalogNotice("The manager changed the menu during payment. Review the refreshed order and place it again.");
          window.alert("The menu changed during payment, so the old-priced sale was not recorded. Review the refreshed order and try again.");
        } else {
          window.alert("The sale could not be safely synchronized. Nothing was recorded; please check the connection and try again.");
        }
        return;
      }

      const committedState = commitResult.value;
      clearCheckoutAttempt(STORAGE_CHECKOUT_ATTEMPT, finalizedOrder.checkoutId);
      const committedCode =
        committedState.payments.find((payment) => payment.id === paymentId)?.code ??
        committedState.tickets.find((entry) => entry.id === orderId)?.code;
      setTickets(committedState.tickets);
      setTicketSeq(committedState.ticketSeq);
      setKitchenPayments(committedState.payments);
      setMenuItems(normalizeKitchenCatalogForRevision(
        committedState.menuItems,
        committedState.catalogRevision,
      ));
      setCart([]);
      setCartCatalogNotice("");
      setPendingOrder(null);
      setShowSettlementPopup(false);
      setShowPayNowPopup(false);

      if (!committedCode || committedCode.endsWith("-PENDING")) {
        window.alert("The sale was recorded, but its receipt number could not be confirmed. Check the Kitchen sales list before retrying.");
        return;
      }

      const printResult = await printDepartmentReceipt({
        department: "kitchen",
        code: committedCode,
        destination: finalizedOrder.destination,
        mode: finalizedOrder.mode,
        method,
        status,
        total: finalizedOrder.total,
        createdAt,
        lines: finalizedOrder.lines,
      });

      if (!printResult.ok && printResult.reason) {
        window.alert(`Kitchen receipt was not printed: ${printResult.reason}`);
      }
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutInFlight(false);
    }
  };

  const deliverTicket = async (id: string) => {
    if (isDirector) return;
    const approved = await confirm({
      title: "Deliver Kitchen Order",
      description: "Are you sure you want to mark this kitchen order as delivered?",
      actionLabel: "Deliver",
    });
    if (!approved) return;
    const activeKitchenKey = getActiveKitchenStateKey();
    const hydration = await hydrateStorageKeyFromFirebase(activeKitchenKey);
    if (!hydration.ok) {
      window.alert("The shared Kitchen queue could not be refreshed. Nothing was marked delivered.");
      return;
    }
    const snapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
      activeKitchenKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 300,
    );
    if (!snapshot.tickets.some((ticket) => ticket.id === id)) {
      window.alert("This Kitchen order was already delivered or cancelled on another terminal.");
      return;
    }
    const deletedTicketIds = Array.from(new Set([...(snapshot.deletedTicketIds ?? []), id]));
    const nextTickets = snapshot.tickets.filter((ticket) => ticket.id !== id);
    try {
      const committed = await commitSyncedStorageValueAndWait(activeKitchenKey, {
        ...snapshot,
        tickets: nextTickets,
        deletedTicketIds,
      });
      setTickets(committed.tickets);
    } catch {
      window.alert("The shared Kitchen queue did not confirm delivery. Reconnect and try again.");
    }
  };

  const cancelTicket = async (id: string) => {
    if (isDirector) return;
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    const approved = await confirm({
      title: "Cancel Kitchen Order",
      description: "Are you sure you want to cancel this kitchen order?",
      actionLabel: "Cancel Order",
    });
    if (!approved) return;

    const activeKitchenKey = getActiveKitchenStateKey();
    const hydration = await hydrateStorageKeyFromFirebase(activeKitchenKey);
    if (!hydration.ok) {
      window.alert("The shared Kitchen queue could not be refreshed. Nothing was cancelled.");
      return;
    }
    const snapshot = readPosState<KitchenTicket, KitchenPaymentRecord, KitchenMenuItem>(
      activeKitchenKey, STORAGE_TICKETS, STORAGE_SEQ, STORAGE_PAYMENTS, STORAGE_MENU, 300,
    );
    const currentTicket = snapshot.tickets.find((entry) => entry.id === id);
    if (!currentTicket) {
      window.alert("This Kitchen order was already delivered or cancelled on another terminal.");
      return;
    }
    const deletedTicketIds = Array.from(new Set([...(snapshot.deletedTicketIds ?? []), id]));
    const nextTickets = snapshot.tickets.filter((entry) => entry.id !== id);
    try {
      const committed = await commitSyncedStorageValueAndWait(activeKitchenKey, {
        ...snapshot,
        tickets: nextTickets,
        deletedTicketIds,
      });
      setTickets(committed.tickets);
      const cancelled: CancelledKitchenTicket = {
        ...currentTicket,
        source: "kitchen",
        cancelledAt: Date.now(),
      };
      const existing = readJson<CancelledKitchenTicket[]>(STORAGE_CANCELLED) ?? [];
      writeJson(STORAGE_CANCELLED, [cancelled, ...existing]);
    } catch {
      window.alert("The shared Kitchen queue did not confirm cancellation. Nothing was cancelled.");
    }
  };

  if (isManager) {
    return (
      <div className="space-y-6">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <ChefHat className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight">Kitchen Setup</h1>
              <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
                Inventory, entry history, and sales visibility for kitchen operations
              </p>
            </div>
          </div>
          <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
            {kitchenPayments.length} Sales Records
          </Badge>
        </header>
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl font-black uppercase tracking-tight">Kitchen Inventory from Store</CardTitle>
            <CardDescription>Store additions update here immediately. Menu creation now lives in Menu Create.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-muted/10">
                <TableRow>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Store Qty</TableHead>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Low Threshold</TableHead>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kitchenStoreItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-bold">{item.name}</TableCell>
                    <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                    <TableCell className="font-bold">{item.minStock}</TableCell>
                    <TableCell className="font-black uppercase text-[10px] tracking-widest">
                      {item.stock <= 0 ? "Out" : item.stock < item.minStock ? "Low" : "In Stock"}
                    </TableCell>
                  </TableRow>
                ))}
                {kitchenStoreItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                      No kitchen store stock
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-black uppercase tracking-tight">Kitchen Entry History</h2>
            <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
              View and download saved kitchen purchase and daily stock records.
            </p>
          </div>
          <KitchenSessionManager isDirector />
        </div>

        {renderDirectorSalesTable()}
      </div>
    );
  }

  if (isDirector) {
    return (
      <div className="space-y-6">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <ChefHat className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-3xl font-black tracking-tight">Kitchen Stock</h1>
              <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
                Managing Director read-only controls
              </p>
            </div>
          </div>
          <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
            {kitchenPayments.length} Sales Records
          </Badge>
        </header>

        <Tabs value={directorTab} onValueChange={(value) => setDirectorTab(value as "inventory" | "purchases" | "entries" | "sales")}>
          <TabsList className="h-10">
            <TabsTrigger value="inventory" className="font-black uppercase text-[10px] tracking-widest">Stock / Inventory</TabsTrigger>
            <TabsTrigger value="purchases" className="font-black uppercase text-[10px] tracking-widest">Purchases</TabsTrigger>
            <TabsTrigger value="entries" className="font-black uppercase text-[10px] tracking-widest">Entries</TabsTrigger>
            <TabsTrigger value="sales" className="font-black uppercase text-[10px] tracking-widest">Sales</TabsTrigger>
          </TabsList>
        </Tabs>

        {directorTab === "inventory" ? (
          <div className="space-y-6">
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl font-black uppercase tracking-tight">Kitchen Inventory from Store</CardTitle>
                <CardDescription>Store additions plus received, used, and remaining quantities</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="bg-muted/10">
                    <TableRow>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Store Qty</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Received</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Used</TableHead>
                      <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Remaining</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kitchenStoreItems.map((item) => {
                      const itemEntries = fromStoreEntries.filter((entry) => entry.itemName === item.name);
                      const received = itemEntries.reduce((sum, entry) => sum + entry.convertedQty, 0);
                      const used = itemEntries.reduce((sum, entry) => sum + getUsedQty(entry.id), 0);
                      const remaining = Math.max(0, received - used);
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-bold">{item.name}</TableCell>
                          <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                          <TableCell className="font-bold">{received} units</TableCell>
                          <TableCell className="font-bold">{used} units</TableCell>
                          <TableCell className="font-bold">{remaining} units</TableCell>
                        </TableRow>
                      );
                    })}
                    {kitchenStoreItems.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                          No inventory records
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

          </div>
        ) : directorTab === "purchases" ? (
          <KitchenSessionManager isDirector visibleTabs={["purchase"]} />
        ) : directorTab === "entries" ? (
          <KitchenSessionManager isDirector visibleTabs={["daily-stock"]} />
        ) : (
          renderDirectorSalesTable()
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
            <ChefHat className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight">Kitchen POS</h1>
            <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
              Order intake and delivery control
            </p>
          </div>
        </div>

        <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
          {tickets.length} Active Orders
        </Badge>
      </header>
      {isDirector && (
        <Card className="border-emerald-200 bg-emerald-50/60 shadow-none">
          <CardContent className="p-3 text-xs font-black uppercase tracking-widest text-emerald-700">
            Managing Director View: Kitchen operations analytics and stock visibility only
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
            <p className="mt-2 text-2xl font-black">{kitchenPayments.length}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">Recent Kitchen Sales</CardTitle>
          <CardDescription>Live completed and credit sales captured from the kitchen POS</CardDescription>
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
                    No kitchen sales yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
                </div>
              )}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search dishes..."
                  className="pl-10 h-12"
                />
              </div>

              <Tabs value={category} onValueChange={(value) => setCategory(value as KitchenCategory)}>
                <TabsList className="w-full h-auto flex flex-wrap gap-1 bg-muted/30 p-1.5 rounded-xl">
                  <TabsTrigger value="all" className="font-black uppercase text-[10px] tracking-widest rounded-lg">All</TabsTrigger>
                  {KITCHEN_CATEGORY_OPTIONS.map((option) => (
                    <TabsTrigger key={option.value} value={option.value} className="font-black uppercase text-[10px] tracking-widest rounded-lg">
                      {option.label}
                    </TabsTrigger>
                  ))}
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
                {filteredMenu.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => addToCart(item)}
                    className="text-left bg-white border rounded-2xl p-5 hover:border-primary/50 hover:shadow-md transition-all"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <Badge variant="outline" className="uppercase text-[9px] font-black tracking-widest">
                        {KITCHEN_CATEGORY_LABELS[item.category]}
                      </Badge>
                      <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                        {item.prepMinutes} min
                      </span>
                    </div>
                    <h3 className="font-black text-lg leading-tight">{item.name}</h3>
                    <div className="mt-6 flex items-center justify-between">
                      <span className="font-black">TSh {(item.price || 0).toLocaleString()}</span>
                      <div className="w-9 h-9 rounded-xl bg-primary text-white flex items-center justify-center">
                        <Plus className="w-4 h-4" />
                      </div>
                    </div>
                  </button>
                ))}

                {filteredMenu.length === 0 && (
                  <div className="col-span-full text-center py-10 opacity-50">
                    <p className="font-black uppercase tracking-widest text-xs">No kitchen items ready for sale</p>
                    <p className="mt-2 text-xs text-muted-foreground">Add menu items in Menu Create to start taking kitchen orders.</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Kitchen Operations</CardTitle>
              <CardDescription>Queue and stock received from Main Store</CardDescription>
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
                    {tickets.map((ticket) => (
                      <TableRow key={ticket.id}>
                        <TableCell className="font-black">
                          <p>{ticket.code}</p>
                          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mt-1">
                            {ticket.mode} | {ticket.destination}
                          </p>
                        </TableCell>
                        <TableCell className="font-bold text-sm">
                          {ticket.lines.map((line) => `${line.name} x${line.qty}`).join(" | ")}
                        </TableCell>
                        <TableCell className="font-black">TSh {ticket.total.toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                          <Button onClick={() => deliverTicket(ticket.id)} disabled={isDirector} className="h-9 font-black uppercase text-[10px] tracking-widest bg-green-600 hover:bg-green-600/90">
                            <CheckCircle2 className="w-4 h-4 mr-1" /> Delivered
                          </Button>
                          <Button onClick={() => cancelTicket(ticket.id)} disabled={isDirector} className="h-9 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white">
                            <XCircle className="w-4 h-4 mr-1" /> Cancelled
                          </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}

                    {tickets.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-12 text-center opacity-40">
                          <ChefHat className="w-12 h-12 mx-auto mb-3" />
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
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Low Threshold</TableHead>
                        <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kitchenStoreItems.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-bold">{item.name}</TableCell>
                          <TableCell className="font-bold">{item.stock} {item.unit}</TableCell>
                          <TableCell className="font-bold">{item.minStock}</TableCell>
                          <TableCell className="font-black uppercase text-[10px] tracking-widest">
                            {item.stock <= 0 ? "Out" : item.stock < item.minStock ? "Low" : "In Stock"}
                          </TableCell>
                        </TableRow>
                      ))}
                      {kitchenStoreItems.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="py-8 text-center opacity-40">
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
                {liveCart.reduce((count, line) => count + line.qty, 0)} items
              </Badge>
            </div>
            <CardDescription>Prepare and place a kitchen order</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {serviceMode === "room-service" ? (
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Room Number</label>
                <Input
                  list="kitchen-room-numbers"
                  value={roomNumber}
                  onChange={(event) => setRoomNumber(event.target.value)}
                  placeholder="Enter room number"
                />
                <datalist id="kitchen-room-numbers">
                  {roomSuggestions.map((room) => (
                    <option key={room} value={room} />
                  ))}
                </datalist>
              </div>
            ) : serviceMode === "restaurant" ? (
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Table Number</label>
                <Input
                  list="kitchen-table-numbers"
                  value={tableNumber}
                  onChange={(event) => setTableNumber(event.target.value)}
                  placeholder="Enter table number"
                />
                <datalist id="kitchen-table-numbers">
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

            {liveCart.length === 0 ? (
              <div className="h-44 rounded-xl border border-dashed flex flex-col items-center justify-center text-center opacity-40">
                <Receipt className="w-10 h-10 mb-2" />
                <p className="font-black uppercase tracking-widest text-[10px]">Ticket is empty</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                {liveCart.map((line) => (
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
              <Button variant="outline" onClick={clearCart} disabled={liveCart.length === 0 || isDirector} className="h-11 font-black uppercase text-[10px] tracking-widest">
                Clear Ticket
              </Button>
              <Button onClick={placeTicket} disabled={liveCart.length === 0 || isDirector} className="h-11 font-black uppercase text-[10px] tracking-widest">
                Place Order
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {!isDirector && showSettlementPopup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Select Settlement</CardTitle>
              <CardDescription>
                Current total: TSh {(pendingOrder?.total ?? 0).toLocaleString()}. Choose Pay Now or Credit.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cartCatalogNotice && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-900">
                  {cartCatalogNotice}
                </div>
              )}
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
