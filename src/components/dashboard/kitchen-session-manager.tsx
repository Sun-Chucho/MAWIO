"use client";

import { useEffect, useMemo, useState } from "react";
import { InventoryItem } from "@/app/lib/mock-data";
import { getStoreItemLabel, MainStoreItem, normalizeStockName, STORAGE_INVENTORY_ITEMS, STORAGE_MAIN_STORE_ITEMS } from "@/app/lib/inventory-transfer";
import {
  KitchenDailyStockHistoryEntry,
  KitchenDailyStockLine,
  KitchenDailyStockSession,
  KitchenPurchaseHistoryEntry,
  KitchenPurchaseLine,
  KitchenPurchaseSession,
  KitchenSessionSignoff,
  STORAGE_KITCHEN_DAILY_STOCK_HISTORY,
  STORAGE_KITCHEN_DAILY_STOCK_SESSION,
  STORAGE_KITCHEN_PURCHASE_HISTORY,
  STORAGE_KITCHEN_PURCHASE_SESSION,
  STORAGE_BARISTA_DAILY_STOCK_HISTORY,
  STORAGE_BARISTA_DAILY_STOCK_SESSION,
  STORAGE_BARISTA_PURCHASE_HISTORY,
  STORAGE_BARISTA_PURCHASE_SESSION,
} from "@/app/lib/kitchen-session-storage";
import { readJson, STORAGE_BARISTA_STATE, writeJson } from "@/app/lib/storage";
import { commitBaristaCatalogAndStockMutation, commitStockArraysAtomically, hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { buildInitialBaristaMenuItems } from "@/app/lib/barista-stock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { Download, Eye } from "lucide-react";

type KitchenWorkflowTab = "purchase" | "daily-stock";
type CloseTarget = "purchase" | "daily-stock" | null;
type SessionDepartment = "kitchen" | "barista";
type BaristaMenuItem = {
  id: string;
  name: string;
  price: number;
  category: string;
  prepMinutes: number;
  barcode?: string;
  buyingPrice?: number;
  inventoryItemId?: string;
  storeItemId?: string;
};
type BaristaPosSnapshot = {
  tickets?: unknown[];
  ticketSeq?: number;
  payments?: unknown[];
  menuItems?: BaristaMenuItem[];
  catalogRevision?: number;
  queueResetAt?: number;
  deletedPaymentKeys?: string[];
};
type HistoryPreviewState =
  | { kind: "purchase"; entry: KitchenPurchaseHistoryEntry }
  | { kind: "daily-stock"; entry: KitchenDailyStockHistoryEntry }
  | null;

const DEFAULT_SIGNOFF: KitchenSessionSignoff = {
  preparedBy: "",
  checkedBy: "",
  approvedBy: "",
  cashier: "",
};

function roundStock(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Number(value.toFixed(2)));
}

function asNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function NumericInput({ value, onChange, ...props }: any) {
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (draft !== null && asNumber(draft) === Number(value)) {
      // Keep draft
    } else {
      setDraft(null);
    }
  }, [value, draft]);

  return (
    <Input
      {...props}
      type="number"
      value={draft !== null ? draft : (value === 0 && draft !== "0" ? "" : String(value))}
      onChange={(e) => {
        setDraft(e.target.value);
        if (onChange) onChange(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        if (props.onBlur) props.onBlur(e);
      }}
    />
  );
}

function createPurchaseLine(item?: MainStoreItem, menuItem?: BaristaMenuItem): KitchenPurchaseLine {
  return {
    id: `purchase-line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    itemId: item?.id ?? null,
    itemName: menuItem?.name ?? item?.name ?? "",
    category: menuItem?.category ?? item?.subCategory ?? "",
    unit: item?.unit ?? "kg",
    previousBalance: roundStock(item?.stock ?? 0),
    addedQty: 0,
    pricePerUnit: roundStock(item?.buyingPrice ?? 0),
    sellingPrice: roundStock(menuItem?.price ?? item?.sellingPrice ?? 0),
  };
}

function findStoreItemForBaristaMenu(storeItems: MainStoreItem[], menuItem: BaristaMenuItem) {
  const linkedStoreItem = menuItem.storeItemId
    ? storeItems.find((item) => item.id === menuItem.storeItemId)
    : undefined;
  if (linkedStoreItem) return linkedStoreItem;

  const menuName = normalizeStockName(menuItem.name);
  return storeItems.find((item) => normalizeStockName(getStoreItemLabel(item)) === menuName)
    ?? storeItems.find((item) => normalizeStockName(item.name) === menuName);
}

function createDailyLine(item?: MainStoreItem): KitchenDailyStockLine {
  return {
    id: `daily-line-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    itemId: item?.id ?? null,
    itemName: item?.name ?? "",
    category: item?.subCategory ?? "",
    unit: item?.unit ?? "kg",
    openingStock: roundStock(item?.stock ?? 0),
    received: 0,
    used: 0,
    wastage: 0,
  };
}

function formatMoney(value: number) {
  return `TSh ${Math.round(value).toLocaleString()}`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

function getDateInputValue(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function getTimeInputValue(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toTimeString().slice(0, 5);
  return parsed.toTimeString().slice(0, 5);
}

function combineDateAndTime(dateValue: string, timeValue: string) {
  const safeDate = dateValue || new Date().toISOString().slice(0, 10);
  const safeTime = timeValue || "23:59";
  const combined = new Date(`${safeDate}T${safeTime}:00`);
  if (Number.isNaN(combined.getTime())) {
    return new Date().toISOString();
  }
  return combined.toISOString();
}

function getWorkflowCopy(tab: KitchenWorkflowTab, department: SessionDepartment) {
  const departmentLabel = department === "kitchen" ? "Kitchen" : "Barista";
  if (tab === "purchase") {
    return {
      tabLabel: "Daily Purchases",
      title: `${departmentLabel} Daily Purchase Entries`,
      empty: "Open shift to begin entering daily purchase rows.",
      success: `${departmentLabel} purchase entries saved`,
      active: "Shift Open Since",
      inactive: "Shift Closed",
      openButton: "Open Shift",
      closeButton: "Close Shift",
      dialogTitle: `Close ${departmentLabel} Purchase Shift`,
    };
  }

  return {
    tabLabel: "Daily Entries",
    title: `${departmentLabel} Daily Stock Entries`,
    empty: "Open shift to begin entering the day's stock movement.",
    success: `${departmentLabel} daily entries saved`,
    active: "Shift Open Since",
    inactive: "Shift Closed",
    openButton: "Open Shift",
    closeButton: "Close Shift",
    dialogTitle: `Close ${departmentLabel} Daily Entries Shift`,
  };
}

function getInventoryMatch(inventoryItems: InventoryItem[], storeItem: MainStoreItem) {
  return inventoryItems.find(
    (entry) =>
      entry.category === (storeItem.lane === "barista" ? "Bar" : "Kitchen") &&
      entry.name === storeItem.name &&
      (entry.size ?? "") === (storeItem.size ?? ""),
  );
}

function getPurchaseLineTotalBalance(line: KitchenPurchaseLine) {
  return roundStock(line.previousBalance + line.addedQty);
}

function getPurchaseEntryAmount(entry: KitchenPurchaseHistoryEntry) {
  return roundStock(entry.lines.reduce((sum, line) => sum + line.addedQty * line.pricePerUnit, 0));
}

function getDailyLineClosingStock(line: KitchenDailyStockLine) {
  return roundStock(line.openingStock + line.received - line.used - line.wastage);
}

function getDailyEntryTotals(entry: KitchenDailyStockHistoryEntry) {
  return entry.lines.reduce(
    (acc, line) => {
      acc.received += roundStock(line.received);
      acc.used += roundStock(line.used);
      acc.wastage += roundStock(line.wastage);
      return acc;
    },
    { received: 0, used: 0, wastage: 0 },
  );
}

function matchesSessionSearch(values: Array<string | number | null | undefined>, searchTerm: string) {
  const tokens = searchTerm.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = values
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

function escapeCsvValue(value: string | number | null | undefined) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function getHistoryFileDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "record";
  return parsed.toISOString().slice(0, 10);
}

function downloadCsvFile(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  if (typeof window === "undefined") return;

  const csvContent = rows.map((row) => row.map((value) => escapeCsvValue(value)).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csvContent], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

export function KitchenSessionManager({
  isDirector,
  department = "kitchen",
  externalSearchTerm = "",
  visibleTabs,
}: {
  isDirector: boolean;
  department?: SessionDepartment;
  externalSearchTerm?: string;
  visibleTabs?: KitchenWorkflowTab[];
}) {
  const [activeTab, setActiveTab] = useState<KitchenWorkflowTab>("purchase");
  const [storeItems, setStoreItems] = useState<MainStoreItem[]>([]);
  const [baristaMenuItems, setBaristaMenuItems] = useState<BaristaMenuItem[]>([]);
  const [purchaseSession, setPurchaseSession] = useState<KitchenPurchaseSession | null>(null);
  const [dailySession, setDailySession] = useState<KitchenDailyStockSession | null>(null);
  const [purchaseHistory, setPurchaseHistory] = useState<KitchenPurchaseHistoryEntry[]>([]);
  const [dailyHistory, setDailyHistory] = useState<KitchenDailyStockHistoryEntry[]>([]);
  const [closeTarget, setCloseTarget] = useState<CloseTarget>(null);
  const [historyPreview, setHistoryPreview] = useState<HistoryPreviewState>(null);
  const [closeNotes, setCloseNotes] = useState(DEFAULT_SIGNOFF);
  const [closeDate, setCloseDate] = useState(new Date().toISOString().slice(0, 10));
  const [closeTime, setCloseTime] = useState(new Date().toTimeString().slice(0, 5));
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [isClosingSession, setIsClosingSession] = useState(false);
  const purchaseCopy = getWorkflowCopy("purchase", department);
  const dailyCopy = getWorkflowCopy("daily-stock", department);
  const departmentLabel = department === "kitchen" ? "Kitchen" : "Barista";
  const departmentCategory = department === "kitchen" ? "Kitchen" : "Bar";
  const isBaristaDepartment = department === "barista";
  const availableTabs = useMemo<KitchenWorkflowTab[]>(
    () => visibleTabs ?? (isBaristaDepartment ? ["purchase"] : ["purchase", "daily-stock"]),
    [isBaristaDepartment, visibleTabs],
  );
  const visibleActiveTab = availableTabs.includes(activeTab) ? activeTab : availableTabs[0] ?? "purchase";
  const purchaseSessionKey =
    department === "kitchen" ? STORAGE_KITCHEN_PURCHASE_SESSION : STORAGE_BARISTA_PURCHASE_SESSION;
  const purchaseHistoryKey =
    department === "kitchen" ? STORAGE_KITCHEN_PURCHASE_HISTORY : STORAGE_BARISTA_PURCHASE_HISTORY;
  const dailySessionKey =
    department === "kitchen" ? STORAGE_KITCHEN_DAILY_STOCK_SESSION : STORAGE_BARISTA_DAILY_STOCK_SESSION;
  const dailyHistoryKey =
    department === "kitchen" ? STORAGE_KITCHEN_DAILY_STOCK_HISTORY : STORAGE_BARISTA_DAILY_STOCK_HISTORY;

  const hydrateSharedWriteState = async (keys: string[], description: string) => {
    const results = await Promise.all(
      keys.map((key) => hydrateStorageKeyFromFirebase(key).catch(() => ({ ok: false as const, remoteExists: false as const }))),
    );
    if (results.every((result) => result.ok)) return true;

    toast({
      title: "Shared data could not be refreshed",
      description: `${description} was not saved. Check the connection and try again.`,
      variant: "destructive",
    });
    return false;
  };

  useEffect(() => {
    const applySnapshot = () => {
      const allStore = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
      setStoreItems(allStore.filter((item) => item.lane === department));
      const baristaSnapshot = readJson<BaristaPosSnapshot>(STORAGE_BARISTA_STATE);
      setBaristaMenuItems(Array.isArray(baristaSnapshot?.menuItems) ? baristaSnapshot.menuItems : []);
      setPurchaseSession(readJson<KitchenPurchaseSession>(purchaseSessionKey));
      setDailySession(readJson<KitchenDailyStockSession>(dailySessionKey));
      setPurchaseHistory(readJson<KitchenPurchaseHistoryEntry[]>(purchaseHistoryKey) ?? []);
      setDailyHistory(readJson<KitchenDailyStockHistoryEntry[]>(dailyHistoryKey) ?? []);
    };

    applySnapshot();
    const unsubscribers = [
      subscribeToSyncedStorageKey(STORAGE_MAIN_STORE_ITEMS, applySnapshot),
      subscribeToSyncedStorageKey(STORAGE_INVENTORY_ITEMS, applySnapshot),
      subscribeToSyncedStorageKey(STORAGE_BARISTA_STATE, applySnapshot),
      subscribeToSyncedStorageKey(purchaseSessionKey, applySnapshot),
      subscribeToSyncedStorageKey(purchaseHistoryKey, applySnapshot),
      subscribeToSyncedStorageKey(dailySessionKey, applySnapshot),
      subscribeToSyncedStorageKey(dailyHistoryKey, applySnapshot),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [dailyHistoryKey, dailySessionKey, department, purchaseHistoryKey, purchaseSessionKey]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0] ?? "purchase");
    }
  }, [activeTab, availableTabs]);

  const purchaseTotalAmount = useMemo(
    () =>
      (purchaseSession?.lines ?? []).reduce(
        (sum, line) => sum + roundStock(line.addedQty) * roundStock(line.pricePerUnit),
        0,
      ),
    [purchaseSession],
  );
  const filteredPurchaseLines = useMemo(() => {
    const query = [externalSearchTerm, purchaseSearch].filter(Boolean).join(" ");
    const lines = purchaseSession?.lines ?? [];

    return lines.filter((line) =>
      matchesSessionSearch(
        [line.itemName, line.category, line.unit, line.previousBalance, line.addedQty, line.pricePerUnit, line.sellingPrice],
        query,
      ),
    );
  }, [externalSearchTerm, purchaseSearch, purchaseSession]);

  const filteredDailyLines = useMemo(() => {
    const query = externalSearchTerm;
    const lines = dailySession?.lines ?? [];

    return lines.filter((line) =>
      matchesSessionSearch(
        [line.itemName, line.category, line.unit, line.openingStock, line.received, line.used, line.wastage],
        query,
      ),
    );
  }, [dailySession, externalSearchTerm]);

  const filteredPurchaseHistory = useMemo(
    () =>
      purchaseHistory.filter((entry) =>
        matchesSessionSearch(
          [
            entry.closedAt,
            entry.signoff.preparedBy,
            entry.signoff.checkedBy,
            entry.signoff.approvedBy,
            entry.signoff.cashier,
            entry.lines.length,
            getPurchaseEntryAmount(entry),
            ...entry.lines.flatMap((line) => [line.itemName, line.category, line.unit, line.addedQty, line.pricePerUnit]),
          ],
          externalSearchTerm,
        ),
      ),
    [externalSearchTerm, purchaseHistory],
  );

  const filteredDailyHistory = useMemo(
    () =>
      dailyHistory.filter((entry) =>
        matchesSessionSearch(
          [
            entry.closedAt,
            entry.signoff.preparedBy,
            entry.signoff.checkedBy,
            entry.signoff.approvedBy,
            entry.signoff.cashier,
            entry.lines.length,
            ...entry.lines.flatMap((line) => [line.itemName, line.category, line.unit, line.openingStock, line.received, line.used, line.wastage]),
          ],
          externalSearchTerm,
        ),
      ),
    [dailyHistory, externalSearchTerm],
  );

  const dailyTotals = useMemo(() => {
    return (dailySession?.lines ?? []).reduce(
      (acc, line) => {
        acc.received += roundStock(line.received);
        acc.used += roundStock(line.used);
        acc.wastage += roundStock(line.wastage);
        return acc;
      },
      { received: 0, used: 0, wastage: 0 },
    );
  }, [dailySession]);

  const persistPurchaseSession = (next: KitchenPurchaseSession | null) => {
    setPurchaseSession(next);
    writeJson(purchaseSessionKey, next);
  };

  const persistDailySession = (next: KitchenDailyStockSession | null) => {
    setDailySession(next);
    writeJson(dailySessionKey, next);
  };

  const startPurchaseSession = () => {
    if (isDirector || purchaseSession) return;
    const next: KitchenPurchaseSession = {
      id: `purchase-session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      lines: isBaristaDepartment
        ? baristaMenuItems.map((menuItem) => createPurchaseLine(findStoreItemForBaristaMenu(storeItems, menuItem), menuItem))
        : storeItems.map((item) => createPurchaseLine(item)),
    };
    persistPurchaseSession(next);
    toast({ title: `${departmentLabel} purchase session started` });
  };

  const startDailySession = () => {
    if (isDirector || dailySession) return;
    const next: KitchenDailyStockSession = {
      id: `daily-session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      lines: storeItems.map((item) => createDailyLine(item)),
    };
    persistDailySession(next);
    toast({ title: `${departmentLabel} daily stock sheet started` });
  };

  const updatePurchaseLine = (lineId: string, field: keyof KitchenPurchaseLine, value: string) => {
    if (!purchaseSession) return;
    persistPurchaseSession({
      ...purchaseSession,
      lines: purchaseSession.lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              [field]:
                field === "itemName" || field === "category" || field === "unit"
                  ? value
                  : roundStock(asNumber(value)),
            }
          : line,
      ),
    });
  };

  const updateDailyLine = (lineId: string, field: keyof KitchenDailyStockLine, value: string) => {
    if (!dailySession) return;
    persistDailySession({
      ...dailySession,
      lines: dailySession.lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              [field]:
                field === "itemName" || field === "category" || field === "unit"
                  ? value
                  : roundStock(asNumber(value)),
            }
          : line,
      ),
    });
  };

  const addPurchaseLine = () => {
    if (!purchaseSession || isDirector) return;
    persistPurchaseSession({ ...purchaseSession, lines: [...purchaseSession.lines, createPurchaseLine()] });
  };

  const addDailyLine = () => {
    if (!dailySession || isDirector) return;
    persistDailySession({ ...dailySession, lines: [...dailySession.lines, createDailyLine()] });
  };

  const removePurchaseLine = (lineId: string) => {
    if (!purchaseSession || isDirector) return;
    persistPurchaseSession({ ...purchaseSession, lines: purchaseSession.lines.filter((line) => line.id !== lineId) });
  };

  const removeDailyLine = (lineId: string) => {
    if (!dailySession || isDirector) return;
    persistDailySession({ ...dailySession, lines: dailySession.lines.filter((line) => line.id !== lineId) });
  };

  const openCloseDialog = (target: Exclude<CloseTarget, null>) => {
    if (isDirector) return;
    const sourceTimestamp = target === "purchase" ? purchaseSession?.startedAt : dailySession?.startedAt;
    setCloseNotes(DEFAULT_SIGNOFF);
    setCloseDate(getDateInputValue(sourceTimestamp ?? new Date().toISOString()));
    setCloseTime(getTimeInputValue(new Date().toISOString()));
    setCloseTarget(target);
  };

  const applyStoreAndInventoryChanges = async (
    allStore: MainStoreItem[],
    nextKitchenStore: MainStoreItem[],
    expectedInventory: InventoryItem[],
    nextInventory: InventoryItem[],
    mutationId: string,
  ) => {
    const otherDepartmentStore = allStore.filter((item) => item.lane !== department);
    try {
      const committed = await commitStockArraysAtomically(
        allStore,
        [...otherDepartmentStore, ...nextKitchenStore],
        expectedInventory,
        nextInventory,
        mutationId,
      );
      if (!committed.ok) throw new Error(committed.reason);
      setStoreItems(committed.storeItems.filter((item) => item.lane === department));
      return true;
    } catch {
      toast({
        title: "Shared stock was not confirmed",
        description: `The ${departmentLabel.toLowerCase()} shift remains open. Reconnect, refresh the balances, and close it again.`,
        variant: "destructive",
      });
      return false;
    }
  };

  const closePurchaseSession = async (conflictRetry = 0) => {
    if (!purchaseSession) return;
    const closedAt = combineDateAndTime(closeDate, closeTime);

    const validLines = purchaseSession.lines.filter((line) => line.itemName.trim().length > 0);
    if (validLines.length === 0) {
      toast({ title: "No purchase rows to save", variant: "destructive" });
      return;
    }

    const hydrated = await hydrateSharedWriteState(
      [
        STORAGE_MAIN_STORE_ITEMS,
        STORAGE_INVENTORY_ITEMS,
        purchaseHistoryKey,
        ...(isBaristaDepartment ? [STORAGE_BARISTA_STATE] : []),
      ],
      `The ${departmentLabel.toLowerCase()} purchase shift`,
    );
    if (!hydrated) return;

    const latestAllStore = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    let nextKitchenStore = latestAllStore.filter((item) => item.lane === department);
    const latestInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    let nextInventory = [...latestInventoryItems];
    const latestPurchaseHistory = readJson<KitchenPurchaseHistoryEntry[]>(purchaseHistoryKey) ?? [];
    const purchaseHistoryEntry: KitchenPurchaseHistoryEntry = {
      ...purchaseSession,
      lines: validLines,
      closedAt,
      signoff: closeNotes,
    };

    // A lost response can leave the atomic Barista commit completed while the
    // browser still shows the old open session. Treat the history record as
    // the durable completion marker so retrying never adds the purchase twice.
    if (isBaristaDepartment && latestPurchaseHistory.some((entry) => entry.id === purchaseSession.id)) {
      persistPurchaseSession(null);
      setCloseTarget(null);
      toast({ title: purchaseCopy.success });
      return;
    }
    const baristaSnapshot = isBaristaDepartment
      ? (readJson<BaristaPosSnapshot>(STORAGE_BARISTA_STATE) ?? {})
      : null;
    const publishedBaristaMenu = Array.isArray(baristaSnapshot?.menuItems) ? baristaSnapshot.menuItems : [];
    const baristaCatalogRevision = Number.isFinite(baristaSnapshot?.catalogRevision)
      ? Number(baristaSnapshot?.catalogRevision)
      : 0;
    const currentBaristaMenu = isBaristaDepartment && publishedBaristaMenu.length === 0 && baristaCatalogRevision === 0
      ? buildInitialBaristaMenuItems(latestInventoryItems)
      : publishedBaristaMenu;
    const baristaLineLinks = new Map<string, {
      storeItemId?: string;
      inventoryItemId?: string;
      menuItem?: BaristaMenuItem;
      itemName: string;
      sellingPrice: number;
    }>();

    validLines.forEach((line) => {
      const existingStore = line.itemId ? nextKitchenStore.find((item) => item.id === line.itemId) : null;
      const inventoryBeforeUpdate = existingStore ? getInventoryMatch(nextInventory, existingStore) : undefined;
      const linkedMenuItem = isBaristaDepartment
        ? currentBaristaMenu.find((item) => item.storeItemId === existingStore?.id)
          ?? currentBaristaMenu.find((item) => !!inventoryBeforeUpdate && item.inventoryItemId === inventoryBeforeUpdate.id)
          ?? currentBaristaMenu.find((item) => normalizeStockName(item.name) === normalizeStockName(line.itemName))
        : undefined;
      // Menu Create / manager inventory is the canonical owner of an existing
      // POS row. A purchase sheet may replenish it and attach stable links,
      // but must never replay an older sheet name or selling price.
      const preservePublishedCatalog = !!linkedMenuItem;
      const effectiveName = preservePublishedCatalog ? linkedMenuItem.name : line.itemName.trim();
      const effectiveSellingPrice = preservePublishedCatalog ? linkedMenuItem.price : line.sellingPrice;
      const totalBalance = roundStock((existingStore?.stock ?? line.previousBalance) + line.addedQty);
      let updatedStore: MainStoreItem;
      let updatedInventory: InventoryItem | undefined;

      if (existingStore) {
        nextKitchenStore = nextKitchenStore.map((item) =>
          item.id === existingStore.id
            ? {
                ...item,
                name: effectiveName,
                subCategory: line.category.trim(),
                unit: line.unit.trim() || item.unit,
                stock: totalBalance,
                buyingPrice: line.pricePerUnit > 0 ? line.pricePerUnit : item.buyingPrice,
                sellingPrice: effectiveSellingPrice,
                receivedStock: roundStock((item.receivedStock ?? 0) + line.addedQty),
              }
            : item,
        );

        updatedStore = nextKitchenStore.find((item) => item.id === existingStore.id)!;
        const inventoryMatch = inventoryBeforeUpdate ?? getInventoryMatch(nextInventory, updatedStore);

        if (inventoryMatch) {
          nextInventory = nextInventory.map((item) =>
            item.id === inventoryMatch.id
              ? {
                  ...item,
                  name: updatedStore.name,
                  subCategory: updatedStore.subCategory ?? "",
                  unit: updatedStore.unit,
                  stock: totalBalance,
                  buyingPrice: updatedStore.buyingPrice ?? item.buyingPrice,
                  sellingPrice: effectiveSellingPrice,
                  price: effectiveSellingPrice,
                  receivedStock: roundStock((item.receivedStock ?? 0) + line.addedQty),
                }
              : item,
          );
          updatedInventory = nextInventory.find((item) => item.id === inventoryMatch.id);
        } else {
          updatedInventory = {
            id: `inv-kitchen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            barcode: "",
            name: updatedStore.name,
            category: departmentCategory,
            subCategory: updatedStore.subCategory ?? "",
            size: updatedStore.size ?? "",
            stock: totalBalance,
            totSold: 0,
            buyingPrice: updatedStore.buyingPrice ?? line.pricePerUnit,
            sellingPrice: effectiveSellingPrice,
            price: effectiveSellingPrice,
            status: "ACTIVE",
            minStock: updatedStore.minStock,
            unit: updatedStore.unit,
            damages: 0,
            receivedStock: line.addedQty,
          };
          nextInventory = [updatedInventory, ...nextInventory];
        }
      } else {
        updatedStore = {
          id: `kitchen-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: effectiveName,
          subCategory: line.category.trim(),
          stock: totalBalance,
          unit: line.unit.trim() || "kg",
          minStock: 1,
          lane: department,
          buyingPrice: line.pricePerUnit,
          sellingPrice: effectiveSellingPrice,
          receivedStock: line.addedQty,
          damages: 0,
        };
        updatedInventory = {
          id: `inv-kitchen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          barcode: "",
          name: updatedStore.name,
          category: departmentCategory,
          subCategory: updatedStore.subCategory ?? "",
          size: "",
          stock: totalBalance,
          totSold: 0,
          buyingPrice: line.pricePerUnit,
          sellingPrice: effectiveSellingPrice,
          price: effectiveSellingPrice,
          status: "ACTIVE",
          minStock: 1,
          unit: updatedStore.unit,
          damages: 0,
          receivedStock: line.addedQty,
        };
        nextKitchenStore = [updatedStore, ...nextKitchenStore];
        nextInventory = [updatedInventory, ...nextInventory];
      }

      if (isBaristaDepartment) {
        baristaLineLinks.set(line.id, {
          storeItemId: updatedStore.id,
          ...(updatedInventory ? { inventoryItemId: updatedInventory.id } : {}),
          ...(linkedMenuItem ? { menuItem: linkedMenuItem } : {}),
          itemName: effectiveName,
          sellingPrice: effectiveSellingPrice,
        });
      }
    });

    if (isBaristaDepartment) {
      const snapshot = baristaSnapshot ?? {};
      let nextMenu = [...currentBaristaMenu];
      validLines.forEach((line) => {
        const link = baristaLineLinks.get(line.id);
        const normalizedName = normalizeStockName(link?.itemName ?? line.itemName);
        const match = nextMenu.find((item) => item.id === link?.menuItem?.id)
          ?? nextMenu.find((item) => !!link?.storeItemId && item.storeItemId === link.storeItemId)
          ?? nextMenu.find((item) => !!link?.inventoryItemId && item.inventoryItemId === link.inventoryItemId)
          ?? nextMenu.find((item) => normalizeStockName(item.name) === normalizedName);
        if (match) {
          const updatedMenuItem = {
            ...match,
            buyingPrice: line.pricePerUnit,
            ...(link?.storeItemId ? { storeItemId: link.storeItemId } : {}),
            ...(link?.inventoryItemId ? { inventoryItemId: link.inventoryItemId } : {}),
          };
          if (JSON.stringify(updatedMenuItem) !== JSON.stringify(match)) {
            nextMenu = nextMenu.map((item) => item.id === match.id ? updatedMenuItem : item);
          }
        } else {
          // An existing stock row with no current POS match may have been
          // deliberately removed by a manager. Only a brand-new purchase row
          // is allowed to create a new menu entry.
          if (line.itemId) return;
          const allowedCategories = new Set(["espresso", "coffee", "tea", "cold", "snacks"]);
          nextMenu.push({
            id: `barista-menu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: link?.itemName ?? line.itemName.trim(),
            price: link?.sellingPrice ?? line.sellingPrice,
            buyingPrice: line.pricePerUnit,
            category: allowedCategories.has(line.category.trim().toLowerCase()) ? line.category.trim().toLowerCase() : "coffee",
            prepMinutes: 5,
            ...(link?.storeItemId ? { storeItemId: link.storeItemId } : {}),
            ...(link?.inventoryItemId ? { inventoryItemId: link.inventoryItemId } : {}),
          });
        }
      });
      const baseSnapshot = {
        tickets: Array.isArray(snapshot.tickets) ? snapshot.tickets : [],
        ticketSeq: Number.isFinite(snapshot.ticketSeq) ? Number(snapshot.ticketSeq) : 490,
        payments: Array.isArray(snapshot.payments) ? snapshot.payments : [],
        menuItems: publishedBaristaMenu,
        catalogRevision: baristaCatalogRevision,
        queueResetAt: Number.isFinite(snapshot.queueResetAt) ? Number(snapshot.queueResetAt) : 0,
        deletedPaymentKeys: Array.isArray(snapshot.deletedPaymentKeys) ? snapshot.deletedPaymentKeys : [],
      };
      const nextAllStore = [
        ...latestAllStore.filter((item) => item.lane !== department),
        ...nextKitchenStore,
      ];
      const catalogCommit = await commitBaristaCatalogAndStockMutation(
        baseSnapshot,
        nextMenu,
        latestAllStore,
        nextAllStore,
        latestInventoryItems,
        nextInventory,
        `session-close:${department}:purchase:${purchaseSession.id}`,
        [{
          key: STORAGE_BARISTA_PURCHASE_HISTORY,
          record: purchaseHistoryEntry as unknown as Record<string, unknown>,
        }],
      );
      if (!catalogCommit.ok) {
        if (
          conflictRetry < 2 &&
          (catalogCommit.reason === "catalog-changed" || catalogCommit.reason === "stock-changed")
        ) {
          // Barista sales can legitimately change stock between hydration and
          // commit. Refresh and rebuild from the new balances automatically.
          await closePurchaseSession(conflictRetry + 1);
          return;
        }
        toast({
          title: catalogCommit.reason === "catalog-changed" || catalogCommit.reason === "stock-changed"
            ? "Barista menu or stock changed"
            : "Barista purchase was not confirmed",
          description: catalogCommit.reason === "invalid-request"
            ? "The purchase data could not be accepted. Refresh the page and try closing the shift again."
            : "Another shared change won first or the connection failed. Nothing was partially published; refresh balances and close the shift again.",
          variant: "destructive",
        });
        return;
      }
      setBaristaMenuItems(catalogCommit.value.menuItems as BaristaMenuItem[]);
      setStoreItems(catalogCommit.storeItems.filter((item) => item.lane === department));
      setPurchaseHistory(
        (catalogCommit.appendedValues[STORAGE_BARISTA_PURCHASE_HISTORY] ?? [
          purchaseHistoryEntry,
          ...latestPurchaseHistory,
        ]) as KitchenPurchaseHistoryEntry[],
      );
    }

    if (!isBaristaDepartment && !await applyStoreAndInventoryChanges(
      latestAllStore,
      nextKitchenStore,
      latestInventoryItems,
      nextInventory,
      `session-close:${department}:purchase:${purchaseSession.id}`,
    )) return;

    if (!isBaristaDepartment) {
      writeJson(purchaseHistoryKey, [purchaseHistoryEntry, ...latestPurchaseHistory]);
    }
    persistPurchaseSession(null);
    setCloseTarget(null);
    toast({ title: purchaseCopy.success });
  };

  const closeDailySession = async () => {
    if (!dailySession) return;
    const closedAt = combineDateAndTime(closeDate, closeTime);

    const validLines = dailySession.lines.filter((line) => line.itemName.trim().length > 0);
    if (validLines.length === 0) {
      toast({ title: "No stock sheet rows to save", variant: "destructive" });
      return;
    }

    const hydrated = await hydrateSharedWriteState(
      [STORAGE_MAIN_STORE_ITEMS, STORAGE_INVENTORY_ITEMS, dailyHistoryKey],
      `The ${departmentLabel.toLowerCase()} daily stock shift`,
    );
    if (!hydrated) return;

    const latestAllStore = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    let nextKitchenStore = latestAllStore.filter((item) => item.lane === department);
    const latestInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    let nextInventory = [...latestInventoryItems];
    const latestDailyHistory = readJson<KitchenDailyStockHistoryEntry[]>(dailyHistoryKey) ?? [];

    validLines.forEach((line) => {
      const existingStore = line.itemId ? nextKitchenStore.find((item) => item.id === line.itemId) : null;
      const closingStock = roundStock((existingStore?.stock ?? line.openingStock) + line.received - line.used - line.wastage);

      if (existingStore) {
        nextKitchenStore = nextKitchenStore.map((item) =>
          item.id === existingStore.id
            ? {
                ...item,
                name: line.itemName.trim(),
                subCategory: line.category.trim(),
                unit: line.unit.trim() || item.unit,
                stock: closingStock,
                receivedStock: roundStock((item.receivedStock ?? 0) + line.received),
                damages: roundStock((item.damages ?? 0) + line.wastage),
              }
            : item,
        );

        const refreshedStore = nextKitchenStore.find((item) => item.id === existingStore.id)!;
        const inventoryMatch = getInventoryMatch(nextInventory, refreshedStore);

        if (inventoryMatch) {
          nextInventory = nextInventory.map((item) =>
            item.id === inventoryMatch.id
              ? {
                  ...item,
                  name: refreshedStore.name,
                  subCategory: refreshedStore.subCategory ?? "",
                  unit: refreshedStore.unit,
                  stock: closingStock,
                  receivedStock: roundStock((item.receivedStock ?? 0) + line.received),
                  damages: roundStock((item.damages ?? 0) + line.wastage),
                }
              : item,
          );
        } else {
          nextInventory = [
            {
              id: `inv-kitchen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              barcode: "",
              name: refreshedStore.name,
              category: departmentCategory,
              subCategory: refreshedStore.subCategory ?? "",
              size: refreshedStore.size ?? "",
              stock: closingStock,
              totSold: 0,
              buyingPrice: refreshedStore.buyingPrice ?? 0,
              sellingPrice: 0,
              price: 0,
              status: "ACTIVE",
              minStock: refreshedStore.minStock,
              unit: refreshedStore.unit,
              damages: line.wastage,
              receivedStock: line.received,
            },
            ...nextInventory,
          ];
        }
      } else {
        const newStore: MainStoreItem = {
          id: `kitchen-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: line.itemName.trim(),
          subCategory: line.category.trim(),
          stock: closingStock,
          unit: line.unit.trim() || "kg",
          minStock: 1,
          lane: department,
          buyingPrice: 0,
          receivedStock: line.received,
          damages: line.wastage,
        };

        nextKitchenStore = [newStore, ...nextKitchenStore];
        nextInventory = [
          {
            id: `inv-kitchen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            barcode: "",
            name: newStore.name,
            category: departmentCategory,
            subCategory: newStore.subCategory ?? "",
            size: "",
            stock: closingStock,
            totSold: 0,
            buyingPrice: 0,
            sellingPrice: 0,
            price: 0,
            status: "ACTIVE",
            minStock: 1,
            unit: newStore.unit,
            damages: line.wastage,
            receivedStock: line.received,
          },
          ...nextInventory,
        ];
      }
    });

    if (!await applyStoreAndInventoryChanges(
      latestAllStore,
      nextKitchenStore,
      latestInventoryItems,
      nextInventory,
      `session-close:${department}:daily:${dailySession.id}`,
    )) return;

    writeJson(dailyHistoryKey, [
      {
        ...dailySession,
        lines: validLines,
        closedAt,
        signoff: closeNotes,
      },
      ...latestDailyHistory,
    ]);
    persistDailySession(null);
    setCloseTarget(null);
    toast({ title: dailyCopy.success });
  };

  const submitCloseDialog = async () => {
    if (
      !closeNotes.preparedBy.trim() ||
      !closeNotes.checkedBy.trim() ||
      !closeNotes.approvedBy.trim() ||
      !closeNotes.cashier.trim()
    ) {
      toast({ title: "Fill all signoff fields", variant: "destructive" });
      return;
    }

    if (isClosingSession) return;
    setIsClosingSession(true);
    try {
      if (closeTarget === "purchase") {
        await closePurchaseSession();
        return;
      }

      if (closeTarget === "daily-stock") {
        await closeDailySession();
      }
    } finally {
      setIsClosingSession(false);
    }
  };

  const downloadPurchaseHistoryEntry = (entry: KitchenPurchaseHistoryEntry) => {
    downloadCsvFile(`${department}-purchase-${getHistoryFileDate(entry.closedAt)}.csv`, [
      ["Department", departmentLabel],
      ["Record Type", "Daily Purchases"],
      ["Started At", formatDateTime(entry.startedAt)],
      ["Closed At", formatDateTime(entry.closedAt)],
      ["Prepared By", entry.signoff.preparedBy],
      ["Checked By", entry.signoff.checkedBy],
      ["Approved By", entry.signoff.approvedBy],
      ["Cashier", entry.signoff.cashier],
      [],
      ["Item", "Category", "Unit", "Balance", "Added", "Buying Price", ...(isBaristaDepartment ? ["Selling Price"] : []), "Total Balance", "Amount"],
      ...entry.lines.map((line) => [
        line.itemName,
        line.category,
        line.unit,
        line.previousBalance,
        line.addedQty,
        line.pricePerUnit,
        ...(isBaristaDepartment ? [line.sellingPrice ?? 0] : []),
        getPurchaseLineTotalBalance(line),
        roundStock(line.addedQty * line.pricePerUnit),
      ]),
      [],
      ["Items", entry.lines.length],
      ["Total Amount", getPurchaseEntryAmount(entry)],
    ]);
    toast({ title: `${departmentLabel} purchase entry downloaded` });
  };

  const downloadDailyHistoryEntry = (entry: KitchenDailyStockHistoryEntry) => {
    const totals = getDailyEntryTotals(entry);

    downloadCsvFile(`${department}-daily-stock-${getHistoryFileDate(entry.closedAt)}.csv`, [
      ["Department", departmentLabel],
      ["Record Type", "Daily Stock Entries"],
      ["Started At", formatDateTime(entry.startedAt)],
      ["Closed At", formatDateTime(entry.closedAt)],
      ["Prepared By", entry.signoff.preparedBy],
      ["Checked By", entry.signoff.checkedBy],
      ["Approved By", entry.signoff.approvedBy],
      ["Cashier", entry.signoff.cashier],
      [],
      ["Item", "Category", "Unit", "Opening Stock", "Received", "Used", "Wastage", "Closing Stock"],
      ...entry.lines.map((line) => [
        line.itemName,
        line.category,
        line.unit,
        line.openingStock,
        line.received,
        line.used,
        line.wastage,
        getDailyLineClosingStock(line),
      ]),
      [],
      ["Items", entry.lines.length],
      ["Total Received", totals.received],
      ["Total Used", totals.used],
      ["Total Wastage", totals.wastage],
    ]);
    toast({ title: `${departmentLabel} daily entry downloaded` });
  };

  const renderHistoryPreview = () => {
    if (!historyPreview) return null;

    if (historyPreview.kind === "purchase") {
      const entry = historyPreview.entry;

      return (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Started At</p>
              <p className="mt-2 text-sm font-bold">{formatDateTime(entry.startedAt)}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Closed At</p>
              <p className="mt-2 text-sm font-bold">{formatDateTime(entry.closedAt)}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Items</p>
              <p className="mt-2 text-sm font-bold">{entry.lines.length}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Total Amount</p>
              <p className="mt-2 text-sm font-bold">{formatMoney(getPurchaseEntryAmount(entry))}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Prepared By</p>
              <p className="mt-2 text-sm font-bold">{entry.signoff.preparedBy || "-"}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Checked By</p>
              <p className="mt-2 text-sm font-bold">{entry.signoff.checkedBy || "-"}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Approved By</p>
              <p className="mt-2 text-sm font-bold">{entry.signoff.approvedBy || "-"}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cashier</p>
              <p className="mt-2 text-sm font-bold">{entry.signoff.cashier || "-"}</p>
            </div>
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={isBaristaDepartment ? "min-w-[240px]" : undefined}>Item</TableHead>
                  {!isBaristaDepartment && <TableHead>Category</TableHead>}
                  {!isBaristaDepartment && <TableHead>Unit</TableHead>}
                  <TableHead>Balance</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>{isBaristaDepartment ? "Buying Price" : "Price"}</TableHead>
                  {isBaristaDepartment && <TableHead>Selling Price</TableHead>}
                  <TableHead>Total Balance</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entry.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-bold">{line.itemName}</TableCell>
                    {!isBaristaDepartment && <TableCell className="font-bold">{line.category || "-"}</TableCell>}
                    {!isBaristaDepartment && <TableCell className="font-bold">{line.unit}</TableCell>}
                    <TableCell className="font-bold">{line.previousBalance}</TableCell>
                    <TableCell className="font-bold">{line.addedQty}</TableCell>
                    <TableCell className="font-bold">{formatMoney(line.pricePerUnit)}</TableCell>
                    {isBaristaDepartment && <TableCell className="font-bold">{formatMoney(line.sellingPrice ?? 0)}</TableCell>}
                    <TableCell className="font-bold">{getPurchaseLineTotalBalance(line)}</TableCell>
                    <TableCell className="font-bold">{formatMoney(roundStock(line.addedQty * line.pricePerUnit))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      );
    }

    const entry = historyPreview.entry;
    const totals = getDailyEntryTotals(entry);

    return (
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Started At</p>
            <p className="mt-2 text-sm font-bold">{formatDateTime(entry.startedAt)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Closed At</p>
            <p className="mt-2 text-sm font-bold">{formatDateTime(entry.closedAt)}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Items</p>
            <p className="mt-2 text-sm font-bold">{entry.lines.length}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Received</p>
            <p className="mt-2 text-sm font-bold">{totals.received}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Used</p>
            <p className="mt-2 text-sm font-bold">{totals.used}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Wastage</p>
            <p className="mt-2 text-sm font-bold">{totals.wastage}</p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Prepared By</p>
            <p className="mt-2 text-sm font-bold">{entry.signoff.preparedBy || "-"}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Checked By</p>
            <p className="mt-2 text-sm font-bold">{entry.signoff.checkedBy || "-"}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Approved By</p>
            <p className="mt-2 text-sm font-bold">{entry.signoff.approvedBy || "-"}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cashier</p>
            <p className="mt-2 text-sm font-bold">{entry.signoff.cashier || "-"}</p>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Opening Stock</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Wastage</TableHead>
                <TableHead>Closing Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entry.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-bold">{line.itemName}</TableCell>
                  <TableCell className="font-bold">{line.category || "-"}</TableCell>
                  <TableCell className="font-bold">{line.unit}</TableCell>
                  <TableCell className="font-bold">{line.openingStock}</TableCell>
                  <TableCell className="font-bold">{line.received}</TableCell>
                  <TableCell className="font-bold">{line.used}</TableCell>
                  <TableCell className="font-bold">{line.wastage}</TableCell>
                  <TableCell className="font-bold">{getDailyLineClosingStock(line)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {availableTabs.length > 1 && (
        <Tabs value={visibleActiveTab} onValueChange={(value) => setActiveTab(value as KitchenWorkflowTab)}>
          <TabsList className="h-11">
            {availableTabs.includes("purchase") && (
              <TabsTrigger value="purchase" className="font-black uppercase text-[10px] tracking-widest">
                {purchaseCopy.tabLabel}
              </TabsTrigger>
            )}
            {availableTabs.includes("daily-stock") && (
            <TabsTrigger value="daily-stock" className="font-black uppercase text-[10px] tracking-widest">
              {dailyCopy.tabLabel}
            </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      )}

      {visibleActiveTab === "purchase" && (
        <div className="space-y-6">
          <Card className="shadow-sm">
            <CardHeader className="border-b">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-lg font-black uppercase">{purchaseCopy.title}</CardTitle>
                  <CardDescription>
                    {isBaristaDepartment
                      ? "Search items from the Barista menu. Selling price is filled from Menu Create; enter the buying price and edit any field when needed."
                      : `Start a purchase sheet, enter added stock for the day, then close it to save history and update ${departmentLabel.toLowerCase()} inventory.`}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {purchaseSession ? (
                    <Badge variant="outline" className="border-emerald-500 bg-emerald-50 text-emerald-700">
                      {purchaseCopy.active} {formatDateTime(purchaseSession.startedAt)}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{purchaseCopy.inactive}</Badge>
                  )}
                  <Button onClick={startPurchaseSession} disabled={Boolean(purchaseSession) || isDirector}>
                    {purchaseCopy.openButton}
                  </Button>
                  <Button variant="outline" onClick={() => openCloseDialog("purchase")} disabled={!purchaseSession || isDirector}>
                    {purchaseCopy.closeButton}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              {purchaseSession ? (
                <>
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <Input
                      value={purchaseSearch}
                      onChange={(event) => setPurchaseSearch(event.target.value)}
                      placeholder="Search item"
                      className="max-w-md"
                    />
                    <Button variant="outline" onClick={addPurchaseLine} disabled={isDirector}>
                      Add New Item
                    </Button>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className={isBaristaDepartment ? "min-w-[240px]" : undefined}>Item</TableHead>
                        {!isBaristaDepartment && <TableHead>Category</TableHead>}
                        {!isBaristaDepartment && <TableHead>Unit</TableHead>}
                        <TableHead>Balance</TableHead>
                        <TableHead>Add</TableHead>
                        <TableHead>{isBaristaDepartment ? "Buying Price" : "Price"}</TableHead>
                        {isBaristaDepartment && <TableHead>Selling Price</TableHead>}
                        <TableHead>Total Balance</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredPurchaseLines.map((line) => {
                        const totalBalance = roundStock(line.previousBalance + line.addedQty);
                        const amount = roundStock(line.addedQty * line.pricePerUnit);
                        return (
                          <TableRow key={line.id}>
                            <TableCell className={isBaristaDepartment ? "min-w-[240px]" : undefined}>
                              <Input value={line.itemName} onChange={(event) => updatePurchaseLine(line.id, "itemName", event.target.value)} />
                            </TableCell>
                            {!isBaristaDepartment && (
                              <TableCell>
                                <Input value={line.category} onChange={(event) => updatePurchaseLine(line.id, "category", event.target.value)} />
                              </TableCell>
                            )}
                            {!isBaristaDepartment && (
                              <TableCell>
                                <Input value={line.unit} onChange={(event) => updatePurchaseLine(line.id, "unit", event.target.value)} />
                              </TableCell>
                            )}
                            <TableCell>
                              <NumericInput min="0" value={line.previousBalance} onChange={(event: any) => updatePurchaseLine(line.id, "previousBalance", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.addedQty} onChange={(event: any) => updatePurchaseLine(line.id, "addedQty", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.pricePerUnit} onChange={(event: any) => updatePurchaseLine(line.id, "pricePerUnit", event.target.value)} />
                            </TableCell>
                            {isBaristaDepartment && (
                              <TableCell>
                                <NumericInput min="0" value={line.sellingPrice ?? 0} onChange={(event: any) => updatePurchaseLine(line.id, "sellingPrice", event.target.value)} />
                              </TableCell>
                            )}
                            <TableCell className="font-bold">{totalBalance}</TableCell>
                            <TableCell className="font-bold">{formatMoney(amount)}</TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" onClick={() => removePurchaseLine(line.id)} disabled={isDirector}>
                                Remove
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {filteredPurchaseLines.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={isBaristaDepartment ? 8 : 9} className="py-10 text-center text-xs font-black uppercase tracking-widest text-muted-foreground">
                            No purchase rows match your search
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  <div className="flex justify-end">
                    <p className="text-sm font-black uppercase tracking-widest">Total Amount: {formatMoney(purchaseTotalAmount)}</p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{purchaseCopy.empty}</p>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="border-b">
              <CardTitle className="text-lg font-black uppercase">Saved Purchase History</CardTitle>
              <CardDescription>{`Closed ${departmentLabel.toLowerCase()} purchase sessions are stored here for daily reference.`}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Total Amount</TableHead>
                    <TableHead>Prepared By</TableHead>
                    <TableHead>Approved By</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPurchaseHistory.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-bold">{formatDateTime(entry.closedAt)}</TableCell>
                      <TableCell className="font-bold">{entry.lines.length}</TableCell>
                      <TableCell className="font-bold">{formatMoney(getPurchaseEntryAmount(entry))}</TableCell>
                      <TableCell className="font-bold">{entry.signoff.preparedBy}</TableCell>
                      <TableCell className="font-bold">{entry.signoff.approvedBy}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setHistoryPreview({ kind: "purchase", entry })}>
                            <Eye className="mr-2 h-3.5 w-3.5" />
                            View
                          </Button>
                          <Button size="sm" onClick={() => downloadPurchaseHistoryEntry(entry)}>
                            <Download className="mr-2 h-3.5 w-3.5" />
                            Download
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredPurchaseHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-xs font-black uppercase tracking-widest text-muted-foreground">
                        No saved purchase sessions match your search
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {visibleActiveTab === "daily-stock" && (
        <div className="space-y-6">
          <Card className="shadow-sm">
            <CardHeader className="border-b">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-lg font-black uppercase">{dailyCopy.title}</CardTitle>
                  <CardDescription>
                    {`Start a daily stock session, record opening, received, used, wastage, and close it to save the day and update ${departmentLabel.toLowerCase()} inventory.`}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {dailySession ? (
                    <Badge variant="outline" className="border-emerald-500 bg-emerald-50 text-emerald-700">
                      {dailyCopy.active} {formatDateTime(dailySession.startedAt)}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{dailyCopy.inactive}</Badge>
                  )}
                  <Button onClick={startDailySession} disabled={Boolean(dailySession) || isDirector}>
                    {dailyCopy.openButton}
                  </Button>
                  <Button variant="outline" onClick={() => openCloseDialog("daily-stock")} disabled={!dailySession || isDirector}>
                    {dailyCopy.closeButton}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              {dailySession ? (
                <>
                  <div className="flex justify-end">
                    <Button variant="outline" onClick={addDailyLine} disabled={isDirector}>
                      Add Item Row
                    </Button>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead>Opening Stock</TableHead>
                        <TableHead>Received</TableHead>
                        <TableHead>Used</TableHead>
                        <TableHead>Wastage</TableHead>
                        <TableHead>Closing Stock</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredDailyLines.map((line) => {
                        const closingStock = roundStock(line.openingStock + line.received - line.used - line.wastage);
                        return (
                          <TableRow key={line.id}>
                            <TableCell>
                              <Input value={line.itemName} onChange={(event) => updateDailyLine(line.id, "itemName", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <Input value={line.category} onChange={(event) => updateDailyLine(line.id, "category", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <Input value={line.unit} onChange={(event) => updateDailyLine(line.id, "unit", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.openingStock} onChange={(event: any) => updateDailyLine(line.id, "openingStock", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.received} onChange={(event: any) => updateDailyLine(line.id, "received", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.used} onChange={(event: any) => updateDailyLine(line.id, "used", event.target.value)} />
                            </TableCell>
                            <TableCell>
                              <NumericInput min="0" value={line.wastage} onChange={(event: any) => updateDailyLine(line.id, "wastage", event.target.value)} />
                            </TableCell>
                            <TableCell className="font-bold">{closingStock}</TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" onClick={() => removeDailyLine(line.id)} disabled={isDirector}>
                                Remove
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {filteredDailyLines.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={9} className="py-10 text-center text-xs font-black uppercase tracking-widest text-muted-foreground">
                            No daily stock rows match your search
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Card className="shadow-none">
                      <CardContent className="p-4">
                        <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Received</p>
                        <p className="mt-2 text-2xl font-black">{dailyTotals.received}</p>
                      </CardContent>
                    </Card>
                    <Card className="shadow-none">
                      <CardContent className="p-4">
                        <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Used</p>
                        <p className="mt-2 text-2xl font-black">{dailyTotals.used}</p>
                      </CardContent>
                    </Card>
                    <Card className="shadow-none">
                      <CardContent className="p-4">
                        <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">Wastage</p>
                        <p className="mt-2 text-2xl font-black">{dailyTotals.wastage}</p>
                      </CardContent>
                    </Card>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{dailyCopy.empty}</p>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="border-b">
              <CardTitle className="text-lg font-black uppercase">Saved Daily Stock History</CardTitle>
              <CardDescription>{`Closed ${departmentLabel.toLowerCase()} daily stock sheets are stored here for review.`}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Used</TableHead>
                    <TableHead>Wastage</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDailyHistory.map((entry) => {
                    const totals = getDailyEntryTotals(entry);

                    return (
                      <TableRow key={entry.id}>
                        <TableCell className="font-bold">{formatDateTime(entry.closedAt)}</TableCell>
                        <TableCell className="font-bold">{entry.lines.length}</TableCell>
                        <TableCell className="font-bold">{totals.received}</TableCell>
                        <TableCell className="font-bold">{totals.used}</TableCell>
                        <TableCell className="font-bold">{totals.wastage}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setHistoryPreview({ kind: "daily-stock", entry })}>
                              <Eye className="mr-2 h-3.5 w-3.5" />
                              View
                            </Button>
                            <Button size="sm" onClick={() => downloadDailyHistoryEntry(entry)}>
                              <Download className="mr-2 h-3.5 w-3.5" />
                              Download
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredDailyHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-xs font-black uppercase tracking-widest text-muted-foreground">
                        No saved daily sheets match your search
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={closeTarget !== null} onOpenChange={(open) => !open && !isClosingSession && setCloseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-black uppercase tracking-tight">
              {closeTarget === "purchase" ? purchaseCopy.dialogTitle : dailyCopy.dialogTitle}
            </DialogTitle>
            <DialogDescription>
              Fill the signoff details, then pick the exact close date and time to save the session and update inventory.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <Input placeholder="Prepared by" value={closeNotes.preparedBy} onChange={(event) => setCloseNotes((current) => ({ ...current, preparedBy: event.target.value }))} />
            <Input placeholder="Checked by" value={closeNotes.checkedBy} onChange={(event) => setCloseNotes((current) => ({ ...current, checkedBy: event.target.value }))} />
            <Input placeholder="Approved by" value={closeNotes.approvedBy} onChange={(event) => setCloseNotes((current) => ({ ...current, approvedBy: event.target.value }))} />
            <Input placeholder="Cashier" value={closeNotes.cashier} onChange={(event) => setCloseNotes((current) => ({ ...current, cashier: event.target.value }))} />
            <Input type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />
            <Input type="time" value={closeTime} onChange={(event) => setCloseTime(event.target.value)} />
          </div>
          <Textarea value={`Prepared by: ${closeNotes.preparedBy}\nChecked by: ${closeNotes.checkedBy}\nApproved by: ${closeNotes.approvedBy}\nCashier: ${closeNotes.cashier}\nClose date: ${closeDate}\nClose time: ${closeTime}`} readOnly className="min-h-[130px]" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseTarget(null)} disabled={isClosingSession}>Cancel</Button>
            <Button onClick={submitCloseDialog} disabled={isClosingSession}>
              {isClosingSession ? "Refreshing shared data..." : "Close Shift"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyPreview !== null} onOpenChange={(open) => !open && setHistoryPreview(null)}>
        <DialogContent className="max-h-[85vh] max-w-6xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-black uppercase tracking-tight">
              {historyPreview?.kind === "purchase" ? `${departmentLabel} Purchase Entry` : `${departmentLabel} Daily Stock Entry`}
            </DialogTitle>
            <DialogDescription>
              {historyPreview
                ? `Table view for the ${departmentLabel.toLowerCase()} record closed ${formatDateTime(historyPreview.entry.closedAt)}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            {renderHistoryPreview()}
          </div>
          <DialogFooter>
            {historyPreview?.kind === "purchase" && (
              <Button variant="outline" onClick={() => downloadPurchaseHistoryEntry(historyPreview.entry)}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            )}
            {historyPreview?.kind === "daily-stock" && (
              <Button variant="outline" onClick={() => downloadDailyHistoryEntry(historyPreview.entry)}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            )}
            <Button onClick={() => setHistoryPreview(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
