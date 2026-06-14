"use client";

import { useEffect, useMemo, useState } from "react";
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
  adjustInventoryQuantity,
  MainStoreItem,
  STORAGE_MAIN_STORE_ITEMS,
  STORAGE_INVENTORY_ITEMS,
  STORAGE_STORE_MOVEMENTS,
  STORAGE_STORE_USAGE,
  StoreMovementLog,
  StoreUsageLog,
} from "@/app/lib/inventory-transfer";
import { printDepartmentReceipt } from "@/app/lib/receipt-print";
import { getActiveKitchenStateKey, readJson, readPosState, writeJson, writePosState } from "@/app/lib/storage";
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
import { hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";

type KitchenCategory = "all" | KitchenMenuCategory;
type ServiceMode = "restaurant" | "room-service" | "take-away";
type KitchenPaymentMethod = "cash" | "card" | "mobile" | "credit";
type KitchenPaymentStatus = "completed" | "credit";
type SalesDateFilter = "all" | "date";

interface CartLine {
  item: KitchenMenuItem;
  qty: number;
}

interface KitchenTicket {
  id: string;
  code: string;
  createdAt: number;
  mode: ServiceMode;
  destination: string;
  lines: Array<{ name: string; qty: number }>;
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
  lines?: Array<{ name: string; qty: number }>;
  total: number;
  status: KitchenPaymentStatus;
  method: KitchenPaymentMethod;
}

interface PendingOrder {
  mode: ServiceMode;
  destination: string;
  lines: Array<{ name: string; qty: number }>;
  total: number;
}

const STORAGE_TICKETS = "orange-hotel-kitchen-tickets";
const STORAGE_SEQ = "orange-hotel-kitchen-seq";
const STORAGE_MENU = "orange-hotel-kitchen-menu";
const STORAGE_CANCELLED = "orange-hotel-cancelled-tickets";
const STORAGE_PAYMENTS = "orange-hotel-kitchen-payments";

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
  const [searchTerm, setSearchTerm] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [roomNumber, setRoomNumber] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [ticketSeq, setTicketSeq] = useState(300);
  const [menuItems, setMenuItems] = useState<KitchenMenuItem[]>([]);
  const [kitchenPayments, setKitchenPayments] = useState<KitchenPaymentRecord[]>([]);
  const [posHydrated, setPosHydrated] = useState(false);
  const [queueTab, setQueueTab] = useState<"queue" | "from-store">("queue");
  const [kitchenStoreItems, setKitchenStoreItems] = useState<MainStoreItem[]>([]);
  const [fromStoreEntries, setFromStoreEntries] = useState<StoreMovementLog[]>([]);
  const [usageLogs, setUsageLogs] = useState<StoreUsageLog[]>([]);
  const [useEntryId, setUseEntryId] = useState("");
  const [useQty, setUseQty] = useState("1");

  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);
  const [showSettlementPopup, setShowSettlementPopup] = useState(false);
  const [showPayNowPopup, setShowPayNowPopup] = useState(false);

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
      const nextMenuItems = mergeKitchenMenuItems(snapshot.menuItems);
      setMenuItems(nextMenuItems);
      setPosHydrated(true);
      if (JSON.stringify(nextMenuItems) !== JSON.stringify(snapshot.menuItems)) {
        writePosState(activeKitchenKey, snapshot.tickets, snapshot.ticketSeq, snapshot.payments, nextMenuItems);
      }
    };

    void hydrateStorageKeyFromFirebase(activeKitchenKey).finally(applyKitchenSnapshot);
    const unsubscribeKitchen = subscribeToSyncedStorageKey(activeKitchenKey, applyKitchenSnapshot);

    return () => {
      cancelled = true;
      unsubscribeKitchen();
    };
  }, []);

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
    const remaining = entry.convertedQty - getUsedQty(entry.id);
    if (qty > remaining) return;
    const approved = await confirm({
      title: "Record Kitchen Usage",
      description: `Are you sure you want to record ${qty} units used for ${entry.itemName}?`,
      actionLabel: "Record Usage",
    });
    if (!approved) return;
    const log: StoreUsageLog = {
      id: `su-${Date.now()}`,
      movementId: entry.id,
      destination: "kitchen",
      quantityUsed: qty,
      usedAt: Date.now(),
    };
    const next = [log, ...usageLogs];
    setUsageLogs(next);
    const existingUsage = readJson<StoreUsageLog[]>(STORAGE_STORE_USAGE) ?? [];
    const existingInventory = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const nextInventory = adjustInventoryQuantity(existingInventory, "Kitchen", entry.itemName, -qty);
    writeJson(
      STORAGE_STORE_USAGE,
      [...next, ...existingUsage.filter((i) => i.destination !== "kitchen")],
    );
    writeJson(STORAGE_INVENTORY_ITEMS, nextInventory);
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

  const subtotal = useMemo(() => cart.reduce((sum, line) => sum + line.item.price * line.qty, 0), [cart]);
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

        return payment.lines.map((line, index) => {
          const price = kitchenMenuPriceByItem.get(line.name.trim().toLowerCase()) ?? 0;
          const amount = price > 0
            ? line.qty * price
            : payment.lines?.length === 1
              ? getNumber(payment.total)
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
    [filteredDirectorSalesPayments, kitchenMenuPriceByItem],
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

  const finalizeOrder = async (status: KitchenPaymentStatus, method: KitchenPaymentMethod) => {
    if (isDirector) return;
    if (!pendingOrder) return;

    const nextSeq = ticketSeq + 1;
    const createdAt = Date.now();
    setTicketSeq(nextSeq);

    const orderId = `kt-${createdAt}`;
    const code = `K-${nextSeq}`;

    const ticket: KitchenTicket = {
      id: orderId,
      code,
      createdAt,
      mode: pendingOrder.mode,
      destination: pendingOrder.destination,
      lines: pendingOrder.lines,
      total: pendingOrder.total,
    };

    const paymentRecord: KitchenPaymentRecord = {
      id: `kp-${createdAt}`,
      ticketId: orderId,
      code,
      createdAt,
      mode: pendingOrder.mode,
      destination: pendingOrder.destination,
      lines: pendingOrder.lines,
      total: pendingOrder.total,
      status,
      method,
    };

    const nextTickets = [ticket, ...tickets];
    const nextPayments = [paymentRecord, ...kitchenPayments];
    setTickets(nextTickets);
    setKitchenPayments(nextPayments);
    writePosState(getActiveKitchenStateKey(), nextTickets, nextSeq, nextPayments, menuItems);

    setCart([]);
    setPendingOrder(null);
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);

    const printResult = await printDepartmentReceipt({
      department: "kitchen",
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
      window.alert(`Kitchen receipt was not printed: ${printResult.reason}`);
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
    const nextTickets = tickets.filter((ticket) => ticket.id !== id);
    setTickets(nextTickets);
    writePosState(getActiveKitchenStateKey(), nextTickets, ticketSeq, kitchenPayments, menuItems);
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

    const cancelled: CancelledKitchenTicket = {
      ...ticket,
      source: "kitchen",
      cancelledAt: Date.now(),
    };

    const existing = readJson<CancelledKitchenTicket[]>(STORAGE_CANCELLED) ?? [];
    writeJson(STORAGE_CANCELLED, [cancelled, ...existing]);

    const nextTickets = tickets.filter((t) => t.id !== id);
    setTickets(nextTickets);
    writePosState(getActiveKitchenStateKey(), nextTickets, ticketSeq, kitchenPayments, menuItems);
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
                {cart.reduce((count, line) => count + line.qty, 0)} items
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
