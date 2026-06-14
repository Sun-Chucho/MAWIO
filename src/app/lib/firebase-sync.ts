import { get, onValue, ref, remove, set } from "firebase/database";
import { ensureFirebaseAuthReady, firebaseDatabase } from "@/app/lib/firebase";
import { getStoreItemLabel, type MainStoreItem } from "@/app/lib/inventory-transfer";
import { mergeKitchenMenuItems, type KitchenMenuItem } from "@/app/lib/kitchen-menu";
import { ROOMS, type InventoryItem } from "@/app/lib/mock-data";
import { DEFAULT_HARDWARE_SETTINGS } from "@/app/lib/hardware-settings";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

// ── Connectivity monitoring ─────────────────────────────────────────────────
let _isConnected = false;
let _firebaseRealtimeConnected = false;
const _connectionListeners = new Set<(connected: boolean) => void>();
const _lastSyncedAt: Record<string, number> = {};
const _pendingLocalWrites: Record<string, { value: unknown; createdAt: number }> = {};
const FALLBACK_POLL_INTERVAL_MS = 10000;
const PENDING_LOCAL_WRITE_TTL_MS = 15000;

function dispatchStorageUpdated(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
}

function hasRecentSyncSuccess() {
  const latestSync = Math.max(0, ...Object.values(_lastSyncedAt));
  return latestSync > 0 && Date.now() - latestSync < 120000;
}

function getEffectiveConnectionState() {
  if (_firebaseRealtimeConnected) return true;
  if (hasRecentSyncSuccess()) return true;
  if (typeof window !== "undefined" && window.navigator.onLine && Object.keys(_lastSyncedAt).length > 0) return true;
  return false;
}

function emitConnectionState(connected: boolean) {
  _firebaseRealtimeConnected = connected;
  _isConnected = getEffectiveConnectionState();
  _connectionListeners.forEach((fn) => fn(_isConnected));
}

function markSyncHealthy(key?: string) {
  if (key) {
    _lastSyncedAt[key] = Date.now();
  }
  _isConnected = true;
  _connectionListeners.forEach((fn) => fn(true));
}

async function fetchServerSyncedStorageValue<T>(key: string): Promise<T | null> {
  const response = await fetch(`/api/storage-sync/${encodeURIComponent(key)}?tier=${encodeURIComponent(getMawioTier())}`, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Server sync read failed for ${key}`);
  }

  const payload = (await response.json()) as { value?: T | null };
  return payload.value ?? null;
}

async function writeServerSyncedStorageValue<T>(key: string, value: T) {
  const response = await fetch(`/api/storage-sync/${encodeURIComponent(key)}?tier=${encodeURIComponent(getMawioTier())}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    throw new Error(`Server sync write failed for ${key}`);
  }
}

async function removeServerSyncedStorageValue(key: string) {
  const response = await fetch(`/api/storage-sync/${encodeURIComponent(key)}?tier=${encodeURIComponent(getMawioTier())}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Server sync delete failed for ${key}`);
  }
}

if (typeof window !== "undefined") {
  void ensureFirebaseAuthReady()
    .then(() => {
      onValue(ref(firebaseDatabase, ".info/connected"), (snapshot) => {
        emitConnectionState(snapshot.val() === true);
      });
    })
    .catch((error) => {
      _isConnected = window.navigator.onLine;
      _connectionListeners.forEach((fn) => fn(_isConnected));
      console.error("Firebase connection monitoring failed", error);
    });
}

export function isFirebaseConnected() {
  return _isConnected;
}

export function subscribeToConnectionStatus(onChange: (connected: boolean) => void) {
  _connectionListeners.add(onChange);
  onChange(_isConnected || getEffectiveConnectionState() || (typeof window !== "undefined" ? window.navigator.onLine : false));
  return () => {
    _connectionListeners.delete(onChange);
  };
}

const FIREBASE_STORAGE_ROOT = "mawio";

export function getMawioTier(): "standard" | "platinum" {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const queryTier = params.get("tier");
    if (queryTier === "standard" || queryTier === "platinum") {
      window.localStorage.setItem("mawio-tier", queryTier);
      window.localStorage.setItem("orange-hotel-active-login-scope", queryTier);
      return queryTier;
    }
    // The active login scope is the single source of truth for which hotel the
    // user is signed into. Fall back to the legacy `mawio-tier` flag for safety.
    const activeScope = window.localStorage.getItem("orange-hotel-active-login-scope");
    if (activeScope === "standard" || activeScope === "platinum") return activeScope;
    const localTier = window.localStorage.getItem("mawio-tier");
    if (localTier === "standard" || localTier === "platinum") return localTier;
  }
  return "standard";
}

function toStoragePath(key: string) {
  return `${FIREBASE_STORAGE_ROOT}/${getMawioTier()}/${key.replace(/[.#$[\]/]/g, "-")}`;
}

// ── Tier-scoped local cache keys ────────────────────────────────────────────
// Backend separation already happens through the Firebase path / server `tier`
// param (`mawio/{tier}/{key}`). The browser localStorage cache, however, is a
// single shared bucket, so without scoping the two hotels would clobber each
// other locally and merge on the next sync. We therefore namespace every synced
// business key for the premium (platinum) tier. Standard keeps the bare keys so
// existing standard data continues to load unchanged.
//
// Login profiles are intentionally excluded: they have their own dedicated
// per-scope keys (`...-standard` / `...-platinum`) managed in login-profiles.ts.
// (`TIER_SCOPED_KEYS` / `TIER_SHARED_KEYS` are defined below, after the key
// lists they are built from.)
export function getTierScopedLocalKey(baseKey: string): string {
  if (typeof window === "undefined") return baseKey;
  if (getMawioTier() !== "platinum") return baseKey;
  if (!TIER_SCOPED_KEYS.has(baseKey)) return baseKey;
  return `${baseKey}::platinum`;
}

export const FIREBASE_SYNC_KEYS = [
  "orange-hotel-cashier-state",
  "orange-hotel-kitchen-state",
  "orange-hotel-barista-state",
  "orange-hotel-company-stock",
  "orange-hotel-inventory-items",
  "orange-hotel-main-store-items",
  "orange-hotel-stock-logic",
  "orange-hotel-store-movements",
  "orange-hotel-store-usage",
  "orange-hotel-cancelled-tickets",
  "orange-hotel-rooms-state",
  "orange-hotel-fnb-beverage-cost",
  "orange-hotel-fnb-recipe-cost",
  "orange-hotel-fnb-stock-sales",
  "orange-hotel-settings",
  "orange-hotel-hardware-settings",
  "orange-hotel-website-bookings",
  "orange-hotel-live-chat",
  "orange-hotel-expenses",
  "orange-hotel-laundry-records",
  "orange-hotel-menu-audit-trail",
  "orange-hotel-login-profiles",
  "orange-hotel-staff-members",
  "orange-hotel-kitchen-purchase-session",
  "orange-hotel-kitchen-purchase-history",
  "orange-hotel-kitchen-daily-stock-session",
  "orange-hotel-kitchen-daily-stock-history",
  "orange-hotel-barista-purchase-session",
  "orange-hotel-barista-purchase-history",
  "orange-hotel-barista-daily-stock-session",
  "orange-hotel-barista-daily-stock-history",
] as const;

export const LEGACY_DEMO_KEYS = [
  "orange-hotel-demo-seed-version",
  "orange-hotel-cashier-transactions",
  "orange-hotel-cashier-seq",
  "orange-hotel-kitchen-tickets",
  "orange-hotel-kitchen-seq",
  "orange-hotel-kitchen-payments",
  "orange-hotel-kitchen-menu",
  "orange-hotel-barista-orders",
  "orange-hotel-barista-seq",
  "orange-hotel-barista-payments",
  "orange-hotel-barista-menu",
  "orange-hotel-kitchen-cancelled-tickets",
  "orange-hotel-cashier-seq",
  "orange-hotel-kitchen-seq",
  "orange-hotel-barista-seq",
] as const;

const TIER_SHARED_KEYS = new Set<string>(["orange-hotel-login-profiles"]);
const TIER_SCOPED_KEYS = new Set<string>(
  [...FIREBASE_SYNC_KEYS, ...LEGACY_DEMO_KEYS].filter((key) => !TIER_SHARED_KEYS.has(key)),
);



function readParsedLocalValue<T>(key: string) {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(getTierScopedLocalKey(key));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Physical localStorage writes/reads for synced keys must always go through the
// tier-scoped key so the two hotels never share a cache bucket.
function setLocalCache(key: string, rawValue: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(getTierScopedLocalKey(key), rawValue);
}

function removeLocalCache(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getTierScopedLocalKey(key));
}

function getLocalCacheRaw(key: string) {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(getTierScopedLocalKey(key));
}

function sanitizeSyncedValue<T>(key: string, value: T): T {
  if (key !== "orange-hotel-kitchen-state" || value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const snapshot = value as {
    tickets?: unknown[];
    ticketSeq?: number;
    payments?: unknown[];
    menuItems?: unknown[];
  };

  return {
    tickets: Array.isArray(snapshot.tickets) ? snapshot.tickets : [],
    ticketSeq: Number.isFinite(snapshot.ticketSeq) ? Number(snapshot.ticketSeq) : 300,
    payments: Array.isArray(snapshot.payments) ? snapshot.payments : [],
    menuItems: mergeKitchenMenuItems(
      (Array.isArray(snapshot.menuItems) ? snapshot.menuItems : []) as KitchenMenuItem[],
    ),
  } as T;
}

function mirrorCanonicalStateToLegacyLocal(key: string, value: unknown) {
  if (typeof window === "undefined" || value === null || value === undefined) return;

  if (key === "orange-hotel-cashier-state") {
    const snapshot = value as { transactions?: unknown[]; receiptSeq?: number };
    setLocalCache("orange-hotel-cashier-transactions", JSON.stringify(Array.isArray(snapshot.transactions) ? snapshot.transactions : []));
    setLocalCache("orange-hotel-cashier-seq", String(Number.isFinite(snapshot.receiptSeq) ? snapshot.receiptSeq : 84920));
    localStorage.removeItem("orange-hotel-demo-seed-version");
    return;
  }

  if (key === "orange-hotel-kitchen-state") {
    const snapshot = sanitizeSyncedValue(key, value) as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };
    setLocalCache("orange-hotel-kitchen-tickets", JSON.stringify(Array.isArray(snapshot.tickets) ? snapshot.tickets : []));
    setLocalCache("orange-hotel-kitchen-seq", String(Number.isFinite(snapshot.ticketSeq) ? snapshot.ticketSeq : 300));
    setLocalCache("orange-hotel-kitchen-payments", JSON.stringify(Array.isArray(snapshot.payments) ? snapshot.payments : []));
    setLocalCache("orange-hotel-kitchen-menu", JSON.stringify(Array.isArray(snapshot.menuItems) ? snapshot.menuItems : []));
    localStorage.removeItem("orange-hotel-demo-seed-version");
    return;
  }

  if (key === "orange-hotel-barista-state") {
    const snapshot = value as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };
    setLocalCache("orange-hotel-barista-orders", JSON.stringify(Array.isArray(snapshot.tickets) ? snapshot.tickets : []));
    setLocalCache("orange-hotel-barista-seq", String(Number.isFinite(snapshot.ticketSeq) ? snapshot.ticketSeq : 490));
    setLocalCache("orange-hotel-barista-payments", JSON.stringify(Array.isArray(snapshot.payments) ? snapshot.payments : []));
    setLocalCache("orange-hotel-barista-menu", JSON.stringify(Array.isArray(snapshot.menuItems) ? snapshot.menuItems : []));
    localStorage.removeItem("orange-hotel-demo-seed-version");
  }
}

function buildInventoryItemsFromStoreItems(storeItems: MainStoreItem[]) {
  const normalizedItems = new Map<string, InventoryItem>();

  for (const item of storeItems) {
    const category = item.lane === "barista" ? "Bar" : "Kitchen";
    const name = getStoreItemLabel(item);
    const subCategory = item.subCategory || "";
    const mapKey = `${category}:${subCategory.toLowerCase()}:${name.toLowerCase()}:${item.unit.toLowerCase()}`;
    const existing = normalizedItems.get(mapKey);

    if (existing) {
      existing.stock += item.stock;
      existing.minStock = Math.max(existing.minStock, item.minStock);
      if ((!existing.price || existing.price <= 0) && typeof item.buyingPrice === "number" && item.buyingPrice > 0) {
        existing.price = typeof item.sellingPrice === "number" && item.sellingPrice > 0
          ? item.sellingPrice
          : item.buyingPrice;
      }
      if ((!existing.sellingPrice || existing.sellingPrice <= 0) && typeof item.sellingPrice === "number" && item.sellingPrice > 0) {
        existing.sellingPrice = item.sellingPrice;
      }
      continue;
    }

    normalizedItems.set(mapKey, {
      id: `inv-${item.id}`,
      barcode: "", // Default to empty if not in store item
      name,
      category,
      subCategory,
      size: item.size || "",
      stock: item.stock,
      totSold: 0,
      buyingPrice: typeof item.buyingPrice === "number" ? item.buyingPrice : 0,
      sellingPrice: typeof item.sellingPrice === "number" ? item.sellingPrice : 0,
      status: "ACTIVE" as const,
      minStock: item.minStock,
      unit: item.unit,
      price:
        typeof item.sellingPrice === "number" && item.sellingPrice > 0
          ? item.sellingPrice
          : typeof item.buyingPrice === "number"
            ? item.buyingPrice
            : 0,
    });
  }

  return Array.from(normalizedItems.values());
}

function getSnapshotScore(key: string, value: unknown): number {
  if (value === null || value === undefined) return 0;

  if (key === "orange-hotel-cashier-state") {
    const snapshot = value as { transactions?: unknown[]; receiptSeq?: number };
    return (Array.isArray(snapshot.transactions) ? snapshot.transactions.length * 1000 : 0) + (Number.isFinite(snapshot.receiptSeq) ? 1 : 0);
  }

  if (key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state") {
    const snapshot = value as { tickets?: unknown[]; payments?: unknown[]; menuItems?: unknown[]; ticketSeq?: number };
    return (
      (Array.isArray(snapshot.menuItems) ? snapshot.menuItems.length * 1000 : 0) +
      (Array.isArray(snapshot.tickets) ? snapshot.tickets.length * 100 : 0) +
      (Array.isArray(snapshot.payments) ? snapshot.payments.length * 100 : 0) +
      (Number.isFinite(snapshot.ticketSeq) ? 1 : 0)
    );
  }

  if (Array.isArray(value)) {
    return value.length;
  }

  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }

  return 1;
}

function hasUsableSyncedValue(key: string, value: unknown) {
  if (value === null || value === undefined) return false;

  if (key === "orange-hotel-cashier-state") {
    const snapshot = value as { transactions?: unknown[]; receiptSeq?: number };
    return Array.isArray(snapshot.transactions) && snapshot.transactions.length > 0;
  }

  if (key === "orange-hotel-rooms-state") {
    return Array.isArray(value) && value.length >= ROOMS.length;
  }

  if (key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state") {
    const snapshot = value as { tickets?: unknown[]; payments?: unknown[]; menuItems?: unknown[]; ticketSeq?: number };
    return (
      (Array.isArray(snapshot.tickets) && snapshot.tickets.length > 0) ||
      (Array.isArray(snapshot.payments) && snapshot.payments.length > 0) ||
      (Array.isArray(snapshot.menuItems) && snapshot.menuItems.length > 0) ||
      Number.isFinite(snapshot.ticketSeq)
    );
  }

  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function areSnapshotsEqual(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shouldIgnoreRemoteValue(key: string, remoteValue: unknown) {
  const pending = _pendingLocalWrites[key];
  if (!pending) return false;

  if (Date.now() - pending.createdAt > PENDING_LOCAL_WRITE_TTL_MS) {
    delete _pendingLocalWrites[key];
    return false;
  }

  if (areSnapshotsEqual(remoteValue, pending.value)) {
    delete _pendingLocalWrites[key];
    return false;
  }

  const localValue = sanitizeForStorage(sanitizeSyncedValue(key, readParsedLocalValue(key)));
  return areSnapshotsEqual(localValue, pending.value);
}

function mergeCashierStateForSync(localValue: unknown, remoteValue: unknown) {
  const localSnapshot = localValue as { transactions?: unknown[]; receiptSeq?: number };
  const remoteSnapshot = remoteValue as { transactions?: unknown[]; receiptSeq?: number };

  if (!Array.isArray(localSnapshot?.transactions) || !Array.isArray(remoteSnapshot?.transactions)) {
    return localValue;
  }

  const localTransactions = localSnapshot.transactions;
  const remoteTransactions = remoteSnapshot.transactions;

  const mergedById = new Map<string, unknown>();

  for (const transaction of remoteTransactions) {
    const id = getRecordId(transaction);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, transaction) : transaction);
    }
  }

  for (const transaction of localTransactions) {
    const id = getRecordId(transaction);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, transaction) : transaction);
    }
  }

  const mergedTransactions = Array.from(mergedById.values()).sort((a, b) => {
    const left = typeof a === "object" && a !== null ? Number((a as { createdAt?: unknown }).createdAt) : 0;
    const right = typeof b === "object" && b !== null ? Number((b as { createdAt?: unknown }).createdAt) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });

  if (areSnapshotsEqual(mergedTransactions, localTransactions)) {
    return localValue;
  }

  return {
    ...localSnapshot,
    transactions: mergedTransactions,
    receiptSeq: Math.max(
      Number.isFinite(localSnapshot.receiptSeq) ? Number(localSnapshot.receiptSeq) : 0,
      Number.isFinite(remoteSnapshot.receiptSeq) ? Number(remoteSnapshot.receiptSeq) : 0,
    ),
  };
}

function getRecordId(record: unknown) {
  if (typeof record !== "object" || record === null) return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function getSettlementPriority(record: unknown) {
  if (typeof record !== "object" || record === null) return 0;
  const status = (record as { status?: unknown }).status;
  if (status === "checked-out") return 3;
  if (status === "completed") return 2;
  if (status === "credit") return 1;
  return 0;
}

function chooseRecordBySettlementPriority(currentRecord: unknown, incomingRecord: unknown) {
  const currentPriority = getSettlementPriority(currentRecord);
  const incomingPriority = getSettlementPriority(incomingRecord);
  return incomingPriority >= currentPriority ? incomingRecord : currentRecord;
}

function mergeRecordsById(localRecords: unknown[], remoteRecords: unknown[]) {
  const mergedById = new Map<string, unknown>();
  const recordsWithoutId: unknown[] = [];

  for (const record of remoteRecords) {
    const id = getRecordId(record);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, record) : record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  for (const record of localRecords) {
    const id = getRecordId(record);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, record) : record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  return [...Array.from(mergedById.values()), ...recordsWithoutId].sort((a, b) => {
    const left = typeof a === "object" && a !== null ? Number((a as { createdAt?: unknown; movedAt?: unknown; usedAt?: unknown; closedAt?: unknown }).createdAt ?? (a as { movedAt?: unknown }).movedAt ?? (a as { usedAt?: unknown }).usedAt ?? Date.parse(String((a as { closedAt?: unknown }).closedAt ?? ""))) : 0;
    const right = typeof b === "object" && b !== null ? Number((b as { createdAt?: unknown; movedAt?: unknown; usedAt?: unknown; closedAt?: unknown }).createdAt ?? (b as { movedAt?: unknown }).movedAt ?? (b as { usedAt?: unknown }).usedAt ?? Date.parse(String((b as { closedAt?: unknown }).closedAt ?? ""))) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
}

function mergeRecordsByIdWithRemoteWins(localRecords: unknown[], remoteRecords: unknown[]) {
  const mergedById = new Map<string, unknown>();
  const recordsWithoutId: unknown[] = [];

  for (const record of localRecords) {
    const id = getRecordId(record);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, record) : record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  for (const record of remoteRecords) {
    const id = getRecordId(record);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, record) : record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  return [...Array.from(mergedById.values()), ...recordsWithoutId].sort((a, b) => {
    const left = typeof a === "object" && a !== null ? Number((a as { createdAt?: unknown; movedAt?: unknown; usedAt?: unknown; closedAt?: unknown }).createdAt ?? (a as { movedAt?: unknown }).movedAt ?? (a as { usedAt?: unknown }).usedAt ?? Date.parse(String((a as { closedAt?: unknown }).closedAt ?? ""))) : 0;
    const right = typeof b === "object" && b !== null ? Number((b as { createdAt?: unknown; movedAt?: unknown; usedAt?: unknown; closedAt?: unknown }).createdAt ?? (b as { movedAt?: unknown }).movedAt ?? (b as { usedAt?: unknown }).usedAt ?? Date.parse(String((b as { closedAt?: unknown }).closedAt ?? ""))) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
}

function mergeArrayRecordsForSync(localValue: unknown, remoteValue: unknown) {
  if (!Array.isArray(localValue) || !Array.isArray(remoteValue)) return localValue;
  return mergeRecordsById(localValue, remoteValue);
}

function mergePosStateForSync(localValue: unknown, remoteValue: unknown) {
  const localSnapshot = localValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };
  const remoteSnapshot = remoteValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };

  if (!localSnapshot || typeof localSnapshot !== "object" || !remoteSnapshot || typeof remoteSnapshot !== "object") {
    return localValue;
  }

  const localTickets = Array.isArray(localSnapshot.tickets) ? localSnapshot.tickets : [];
  const remoteTickets = Array.isArray(remoteSnapshot.tickets) ? remoteSnapshot.tickets : [];
  const localPayments = Array.isArray(localSnapshot.payments) ? localSnapshot.payments : [];
  const remotePayments = Array.isArray(remoteSnapshot.payments) ? remoteSnapshot.payments : [];

  return {
    ...localSnapshot,
    tickets: mergeRecordsById(localTickets, remoteTickets),
    payments: mergeRecordsById(localPayments, remotePayments),
    ticketSeq: Math.max(
      Number.isFinite(localSnapshot.ticketSeq) ? Number(localSnapshot.ticketSeq) : 0,
      Number.isFinite(remoteSnapshot.ticketSeq) ? Number(remoteSnapshot.ticketSeq) : 0,
    ),
  };
}

function mergeCashierStateForRemoteApply(localValue: unknown, remoteValue: unknown) {
  const localSnapshot = localValue as { transactions?: unknown[]; receiptSeq?: number };
  const remoteSnapshot = remoteValue as { transactions?: unknown[]; receiptSeq?: number };

  if (!Array.isArray(localSnapshot?.transactions) || !Array.isArray(remoteSnapshot?.transactions)) {
    return remoteValue;
  }

  return {
    ...localSnapshot,
    ...remoteSnapshot,
    transactions: mergeRecordsByIdWithRemoteWins(localSnapshot.transactions, remoteSnapshot.transactions),
    receiptSeq: Math.max(
      Number.isFinite(localSnapshot.receiptSeq) ? Number(localSnapshot.receiptSeq) : 0,
      Number.isFinite(remoteSnapshot.receiptSeq) ? Number(remoteSnapshot.receiptSeq) : 0,
    ),
  };
}

function mergePosStateForRemoteApply(localValue: unknown, remoteValue: unknown) {
  const localSnapshot = localValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };
  const remoteSnapshot = remoteValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[] };

  if (!localSnapshot || typeof localSnapshot !== "object" || !remoteSnapshot || typeof remoteSnapshot !== "object") {
    return remoteValue;
  }

  const localTickets = Array.isArray(localSnapshot.tickets) ? localSnapshot.tickets : [];
  const remoteTickets = Array.isArray(remoteSnapshot.tickets) ? remoteSnapshot.tickets : [];
  const localPayments = Array.isArray(localSnapshot.payments) ? localSnapshot.payments : [];
  const remotePayments = Array.isArray(remoteSnapshot.payments) ? remoteSnapshot.payments : [];

  return {
    ...localSnapshot,
    ...remoteSnapshot,
    tickets: mergeRecordsByIdWithRemoteWins(localTickets, remoteTickets),
    payments: mergeRecordsByIdWithRemoteWins(localPayments, remotePayments),
    ticketSeq: Math.max(
      Number.isFinite(localSnapshot.ticketSeq) ? Number(localSnapshot.ticketSeq) : 0,
      Number.isFinite(remoteSnapshot.ticketSeq) ? Number(remoteSnapshot.ticketSeq) : 0,
    ),
  };
}

function mergeRemoteValueWithLocalOnlyRecords(key: string, localValue: unknown, remoteValue: unknown) {
  if (key === "orange-hotel-cashier-state") {
    return mergeCashierStateForRemoteApply(localValue, remoteValue);
  }

  if (key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state") {
    return mergePosStateForRemoteApply(localValue, remoteValue);
  }

  if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
    return mergeRecordsByIdWithRemoteWins(localValue, remoteValue);
  }

  return remoteValue;
}

function protectSyncedValueBeforeWrite(key: string, localValue: unknown, remoteValue: unknown) {
  if (key === "orange-hotel-cashier-state") {
    return mergeCashierStateForSync(localValue, remoteValue);
  }

  if (key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state") {
    return mergePosStateForSync(localValue, remoteValue);
  }

  if (
    key === "orange-hotel-website-bookings" ||
    key === "orange-hotel-company-stock" ||
    key === "orange-hotel-live-chat" ||
    key === "orange-hotel-expenses" ||
    key === "orange-hotel-laundry-records" ||
    key === "orange-hotel-cancelled-tickets" ||
    key === "orange-hotel-menu-audit-trail" ||
    key === "orange-hotel-store-movements" ||
    key === "orange-hotel-store-usage" ||
    key === "orange-hotel-kitchen-purchase-history" ||
    key === "orange-hotel-kitchen-daily-stock-history" ||
    key === "orange-hotel-barista-purchase-history" ||
    key === "orange-hotel-barista-daily-stock-history"
  ) {
    return mergeArrayRecordsForSync(localValue, remoteValue);
  }

  return localValue;
}

function isDangerouslySmallCashierWrite(key: string, localValue: unknown, remoteValue: unknown) {
  if (key !== "orange-hotel-cashier-state") return false;
  const localTransactions = (localValue as { transactions?: unknown[] } | null)?.transactions;
  const remoteTransactions = (remoteValue as { transactions?: unknown[] } | null)?.transactions;
  const localCount = Array.isArray(localTransactions) ? localTransactions.length : 0;
  const remoteCount = Array.isArray(remoteTransactions) ? remoteTransactions.length : 0;

  return localCount > 0 && localCount < 50 && remoteCount === 0;
}

function getCanonicalDefaultValue(key: string) {
  switch (key) {
    case "orange-hotel-cashier-state":
      return { transactions: [], receiptSeq: 1 };
    case "orange-hotel-kitchen-state":
      return { tickets: [], ticketSeq: 1, payments: [], menuItems: [] };
    case "orange-hotel-barista-state":
      return { tickets: [], ticketSeq: 1, payments: [], menuItems: [] };
    case "orange-hotel-company-stock":
    case "orange-hotel-inventory-items":
    case "orange-hotel-main-store-items":
    case "orange-hotel-stock-logic":
    case "orange-hotel-store-movements":
    case "orange-hotel-store-usage":
    case "orange-hotel-cancelled-tickets":
    case "orange-hotel-fnb-beverage-cost":
    case "orange-hotel-fnb-recipe-cost":
    case "orange-hotel-fnb-stock-sales":
    case "orange-hotel-website-bookings":
    case "orange-hotel-live-chat":
    case "orange-hotel-expenses":
    case "orange-hotel-laundry-records":
    case "orange-hotel-menu-audit-trail":
    case "orange-hotel-staff-members":
    case "orange-hotel-kitchen-purchase-history":
    case "orange-hotel-kitchen-daily-stock-history":
    case "orange-hotel-barista-purchase-history":
    case "orange-hotel-barista-daily-stock-history":
      return [];
    case "orange-hotel-kitchen-purchase-session":
    case "orange-hotel-kitchen-daily-stock-session":
    case "orange-hotel-barista-purchase-session":
    case "orange-hotel-barista-daily-stock-session":
      return null;
    case "orange-hotel-rooms-state":
      return ROOMS;
    case "orange-hotel-settings":
      return {
        fullName: "Alex Rivera",
        email: "alex.rivera@orange.hotel",
        department: "Operations Management",
        notificationsRealtime: true,
        notificationsEmailDigest: true,
        analyticsAdvanced: false,
        requirePinForCheckout: true,
        autoLockMinutes: 15,
        currency: "TSh",
        timezone: "Africa/Dar_es_Salaam",
      };
    case "orange-hotel-hardware-settings":
      return DEFAULT_HARDWARE_SETTINGS;
    case "orange-hotel-login-profiles":
      return {};
    default:
      return null;
  }
}

function getLocalFallbackForSync(key: string) {
  if (typeof window === "undefined") return null;

  const directValue = readParsedLocalValue(key);
  if (directValue !== null) {
    return directValue;
  }

  if (key === "orange-hotel-cashier-state") {
    const transactions = readParsedLocalValue<unknown[]>("orange-hotel-cashier-transactions") ?? [];
    const receiptSeq = Number(getLocalCacheRaw("orange-hotel-cashier-seq"));
    if (transactions.length === 0 && !Number.isFinite(receiptSeq)) return null;
    return {
      transactions,
      receiptSeq: Number.isFinite(receiptSeq) && receiptSeq > 0 ? receiptSeq : 84920,
    };
  }

  if (key === "orange-hotel-kitchen-state") {
    const tickets = readParsedLocalValue<unknown[]>("orange-hotel-kitchen-tickets") ?? [];
    const payments = readParsedLocalValue<unknown[]>("orange-hotel-kitchen-payments") ?? [];
    const menuItems = mergeKitchenMenuItems(
      ((readParsedLocalValue<unknown[]>("orange-hotel-kitchen-menu") ?? []) as KitchenMenuItem[]),
    );
    const ticketSeq = Number(getLocalCacheRaw("orange-hotel-kitchen-seq"));
    if (tickets.length === 0 && payments.length === 0 && menuItems.length === 0 && !Number.isFinite(ticketSeq)) {
      return null;
    }
    return {
      tickets,
      ticketSeq: Number.isFinite(ticketSeq) && ticketSeq > 0 ? ticketSeq : 300,
      payments,
      menuItems,
    };
  }

  if (key === "orange-hotel-barista-state") {
    const tickets = readParsedLocalValue<unknown[]>("orange-hotel-barista-orders") ?? [];
    const payments = readParsedLocalValue<unknown[]>("orange-hotel-barista-payments") ?? [];
    const menuItems = readParsedLocalValue<unknown[]>("orange-hotel-barista-menu") ?? [];
    const ticketSeq = Number(getLocalCacheRaw("orange-hotel-barista-seq"));
    if (tickets.length === 0 && payments.length === 0 && menuItems.length === 0 && !Number.isFinite(ticketSeq)) {
      return null;
    }
    return {
      tickets,
      ticketSeq: Number.isFinite(ticketSeq) && ticketSeq > 0 ? ticketSeq : 490,
      payments,
      menuItems,
    };
  }

  if (key === "orange-hotel-inventory-items") {
    const storeItems = readParsedLocalValue<MainStoreItem[]>("orange-hotel-main-store-items") ?? [];
    if (storeItems.length === 0) return null;
    return buildInventoryItemsFromStoreItems(storeItems);
  }

  return null;
}

function getLocalSyncedValue(key: string) {
  if (typeof window === "undefined") return null;
  return sanitizeForStorage(sanitizeSyncedValue(key, getLocalFallbackForSync(key) ?? readParsedLocalValue(key) ?? null));
}

function getLocalCashierTransactionsForRooms() {
  const canonical = readParsedLocalValue<{ transactions?: unknown[] }>("orange-hotel-cashier-state");
  if (Array.isArray(canonical?.transactions)) return canonical.transactions;
  return readParsedLocalValue<unknown[]>("orange-hotel-cashier-transactions") ?? [];
}

function getActiveLocalBookedRoomNumbers() {
  return new Set(
    getLocalCashierTransactionsForRooms()
      .filter((booking) => {
        if (typeof booking !== "object" || booking === null) return false;
        const roomNumber = (booking as { roomNumber?: unknown }).roomNumber;
        const status = (booking as { status?: unknown }).status;
        return typeof roomNumber === "string" && roomNumber.trim().length > 0 && status !== "checked-out";
      })
      .map((booking) => (booking as { roomNumber: string }).roomNumber),
  );
}

function applyLocalBookingOccupancy(key: string, value: unknown) {
  if (key !== "orange-hotel-rooms-state" || !Array.isArray(value)) return value;

  const occupiedRooms = getActiveLocalBookedRoomNumbers();
  if (occupiedRooms.size === 0) return value;

  return value.map((room) => {
    if (typeof room !== "object" || room === null) return room;
    const roomNumber = (room as { number?: unknown }).number;
    if (typeof roomNumber !== "string" || !occupiedRooms.has(roomNumber)) return room;
    return (room as { status?: unknown }).status === "occupied" ? room : { ...room, status: "occupied" };
  });
}

function mergeRemoteValueForLocalApply(key: string, remoteValue: unknown) {
  const localValue = getLocalSyncedValue(key);
  if (!hasUsableSyncedValue(key, localValue)) return applyLocalBookingOccupancy(key, remoteValue);
  if (!hasUsableSyncedValue(key, remoteValue)) return applyLocalBookingOccupancy(key, localValue);
  return applyLocalBookingOccupancy(key, mergeRemoteValueWithLocalOnlyRecords(key, localValue, remoteValue));
}

function readSnapshotValue<T>(key: string, rawValue: T | null, onChange: (value: T | null) => void) {
  if (typeof window === "undefined") return;
  if (rawValue === null) {
    removeLocalCache(key);
    dispatchStorageUpdated(key);
    onChange(null);
    return;
  }

  setLocalCache(key, JSON.stringify(rawValue));
  dispatchStorageUpdated(key);
  onChange(rawValue);
}

export function syncStorageValueToFirebase<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  let sanitizedValue: unknown = sanitizeForStorage(value);
  _pendingLocalWrites[key] = { value: sanitizedValue, createdAt: Date.now() };
  void ensureFirebaseAuthReady()
    .then(async () => {
      const snapshot = await get(ref(firebaseDatabase, toStoragePath(key))).catch(() => null);
      const remoteValue = snapshot?.exists() ? sanitizeForStorage(sanitizeSyncedValue(key, snapshot.val())) : null;
      if (isDangerouslySmallCashierWrite(key, sanitizedValue, remoteValue)) {
        console.warn(`Blocked unsafe cashier sync for ${key}: local snapshot is too small and remote could not be verified.`);
        return;
      }
      sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, protectSyncedValueBeforeWrite(key, sanitizedValue, remoteValue)));
      _pendingLocalWrites[key] = { value: sanitizedValue, createdAt: Date.now() };
      await set(ref(firebaseDatabase, toStoragePath(key)), sanitizedValue);
    })
    .then(() => {
      markSyncHealthy(key);
    })
    .catch(async (error) => {
      console.error(`Firebase sync failed for ${key}`, error);
      try {
        const remoteValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue(key).catch(() => null)));
        if (isDangerouslySmallCashierWrite(key, sanitizedValue, remoteValue)) {
          console.warn(`Blocked unsafe server cashier sync for ${key}: local snapshot is too small and remote could not be verified.`);
          return;
        }
        sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, protectSyncedValueBeforeWrite(key, sanitizedValue, remoteValue)));
        _pendingLocalWrites[key] = { value: sanitizedValue, createdAt: Date.now() };
        await writeServerSyncedStorageValue(key, sanitizedValue);
        markSyncHealthy(key);
      } catch (serverError) {
        emitConnectionState(false);
        console.error(`Server sync fallback failed for ${key}`, serverError);
      }
    });
}

export async function hydrateStorageKeyFromFirebase(key: string) {
  if (typeof window === "undefined") return;

  const applyHydratedValue = (value: unknown) => {
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, value));
    if (sanitizedValue === null || sanitizedValue === undefined) return null;
    setLocalCache(key, JSON.stringify(sanitizedValue));
    mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
    dispatchStorageUpdated(key);
    return sanitizedValue;
  };

  try {
    const serverValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue(key).catch(() => null)));
    if (hasUsableSyncedValue(key, serverValue)) {
      const mergedServerValue = sanitizeForStorage(sanitizeSyncedValue(key, mergeRemoteValueForLocalApply(key, serverValue)));
      const sanitizedServerValue = applyHydratedValue(mergedServerValue);
      if (sanitizedServerValue !== null && !areSnapshotsEqual(serverValue, sanitizedServerValue)) {
        await writeServerSyncedStorageValue(key, sanitizedServerValue).catch(() => undefined);
      }
      markSyncHealthy(key);
      return;
    }

    await ensureFirebaseAuthReady();
    const snapshot = await get(ref(firebaseDatabase, toStoragePath(key)));
    const remoteValue = snapshot.exists() ? sanitizeForStorage(sanitizeSyncedValue(key, snapshot.val())) : null;
    const localValue = getLocalSyncedValue(key);

    const canonicalValue = sanitizeForStorage(getCanonicalDefaultValue(key));
    if (remoteValue === null && localValue === null && canonicalValue === null) return;

    const remoteScore = hasUsableSyncedValue(key, remoteValue) ? getSnapshotScore(key, remoteValue) : 0;
    const localScore = getSnapshotScore(key, localValue);
    const canonicalScore = getSnapshotScore(key, canonicalValue);

    let preferredValue: unknown = canonicalValue;
    if (remoteScore > 0) {
      preferredValue = mergeRemoteValueForLocalApply(key, remoteValue);
    } else if (localScore >= remoteScore && localScore >= canonicalScore) {
      preferredValue = localValue;
    }

    if (preferredValue === null) return;

    const sanitizedPreferredValue = applyHydratedValue(preferredValue);
    if (sanitizedPreferredValue === null) return;

    if (!areSnapshotsEqual(remoteValue, sanitizedPreferredValue)) {
      await set(ref(firebaseDatabase, toStoragePath(key)), sanitizedPreferredValue);
      await writeServerSyncedStorageValue(key, sanitizedPreferredValue).catch(() => undefined);
    }

    markSyncHealthy(key);
  } catch (error) {
    console.error(`Firebase hydrate failed for ${key}`, error);
    try {
      const remoteValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue(key)));
      if (remoteValue !== null) {
        applyHydratedValue(remoteValue);
      }
      markSyncHealthy(key);
    } catch (serverError) {
      emitConnectionState(false);
      console.error(`Server hydrate fallback failed for ${key}`, serverError);
    }
  }
}

export async function hydrateDefaultAppStateFromFirebase() {
  await Promise.all(FIREBASE_SYNC_KEYS.map((key) => hydrateStorageKeyFromFirebase(key)));
}

export function subscribeToSyncedStorageKey<T>(key: string, onChange: (value: T | null) => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const emitLocalValue = () => {
    const raw = getLocalCacheRaw(key);
    if (!raw) {
      onChange(null);
      return;
    }

    try {
      onChange(JSON.parse(raw) as T);
    } catch {
      onChange(null);
    }
  };

  const handleCustomEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail;
    if (detail?.key === key) emitLocalValue();
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === key || event.key === getTierScopedLocalKey(key)) emitLocalValue();
  };

  window.addEventListener("orange-hotel-storage-updated", handleCustomEvent as EventListener);
  window.addEventListener("storage", handleStorageEvent);

  let firebaseUnsubscribe: () => void = () => {};
  let isDisposed = false;
  let pollTimer: number | null = null;

  const stopFallbackPolling = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const pollServerSnapshot = async () => {
    try {
      const remoteValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue<T>(key)));
      if (remoteValue === null) return;
      if (shouldIgnoreRemoteValue(key, remoteValue)) return;
      const nextValue = sanitizeForStorage(sanitizeSyncedValue(key, mergeRemoteValueForLocalApply(key, remoteValue)));
      const currentValue = sanitizeForStorage(readParsedLocalValue<T>(key));
      if (!areSnapshotsEqual(currentValue, nextValue)) {
        setLocalCache(key, JSON.stringify(nextValue));
        mirrorCanonicalStateToLegacyLocal(key, nextValue);
        dispatchStorageUpdated(key);
        onChange(nextValue as T);
      }
      if (!areSnapshotsEqual(remoteValue, nextValue)) {
        await writeServerSyncedStorageValue(key, nextValue).catch(() => undefined);
      }
      markSyncHealthy(key);
    } catch {
      // Keep the fallback poll alive; the next successful request or Firebase reconnect will recover state.
    }
  };

  const ensureFallbackPolling = () => {
    if (pollTimer !== null || isDisposed) return;
    void pollServerSnapshot();
    pollTimer = window.setInterval(() => {
      void pollServerSnapshot();
    }, FALLBACK_POLL_INTERVAL_MS);
  };

  void ensureFirebaseAuthReady()
    .then(() => {
      if (isDisposed) return;

      firebaseUnsubscribe = onValue(
        ref(firebaseDatabase, toStoragePath(key)),
        (snapshot) => {
          if (!snapshot.exists()) {
            const fallbackValue = sanitizeForStorage((getLocalFallbackForSync(key) ?? getCanonicalDefaultValue(key)) as T | null);
            if (fallbackValue !== null) {
              setLocalCache(key, JSON.stringify(fallbackValue));
              mirrorCanonicalStateToLegacyLocal(key, fallbackValue);
              void set(ref(firebaseDatabase, toStoragePath(key)), fallbackValue).catch(() => undefined);
              dispatchStorageUpdated(key);
              onChange(fallbackValue);
              markSyncHealthy(key);
              stopFallbackPolling();
              return;
            }
            readSnapshotValue<T>(key, null, onChange);
            return;
          }
          const nextValue = sanitizeForStorage(sanitizeSyncedValue(key, snapshot.val() as T));
          if (shouldIgnoreRemoteValue(key, nextValue)) {
            return;
          }
          const mergedValue = sanitizeForStorage(sanitizeSyncedValue(key, mergeRemoteValueForLocalApply(key, nextValue)));
          mirrorCanonicalStateToLegacyLocal(key, mergedValue);
          readSnapshotValue<T>(key, mergedValue as T, onChange);
          if (!areSnapshotsEqual(nextValue, mergedValue)) {
            void set(ref(firebaseDatabase, toStoragePath(key)), mergedValue).catch(() => undefined);
            void writeServerSyncedStorageValue(key, mergedValue).catch(() => undefined);
          }
          markSyncHealthy(key);
          stopFallbackPolling();
        },
        (error) => {
          emitConnectionState(false);
          console.error(`Firebase subscription failed for ${key}`, error);
          ensureFallbackPolling();
        },
      );
    })
    .catch((error) => {
      emitConnectionState(false);
      console.error(`Firebase auth bootstrap failed for ${key}`, error);
      ensureFallbackPolling();
    });

  return () => {
    isDisposed = true;
    window.removeEventListener("orange-hotel-storage-updated", handleCustomEvent as EventListener);
    window.removeEventListener("storage", handleStorageEvent);
    firebaseUnsubscribe();
    stopFallbackPolling();
  };
}

export function removeStorageValueFromFirebase(key: string) {
  if (typeof window === "undefined") return;
  void ensureFirebaseAuthReady()
    .then(() => remove(ref(firebaseDatabase, toStoragePath(key))))
    .then(() => markSyncHealthy(key))
    .catch((error) => {
      console.error(`Firebase remove failed for ${key}`, error);
      void removeServerSyncedStorageValue(key)
        .then(() => markSyncHealthy(key))
        .catch((serverError) => {
          emitConnectionState(false);
          console.error(`Server sync delete fallback failed for ${key}`, serverError);
        });
    });
}

export function clearLocalBusinessState() {
  if (typeof window === "undefined") return;

  [...FIREBASE_SYNC_KEYS, ...LEGACY_DEMO_KEYS].forEach((key) => {
    removeLocalCache(key);
  });
}

export async function clearFirebaseBusinessState() {
  try {
    await ensureFirebaseAuthReady();
    await Promise.all([...FIREBASE_SYNC_KEYS, ...LEGACY_DEMO_KEYS].map((key) => remove(ref(firebaseDatabase, toStoragePath(key))).catch(() => null)));
    markSyncHealthy();
  } catch {
    await Promise.all([...FIREBASE_SYNC_KEYS, ...LEGACY_DEMO_KEYS].map((key) => removeServerSyncedStorageValue(key).catch(() => null)));
    markSyncHealthy();
  }
}

export async function runOneTimeBusinessDataReset(resetVersion: string) {
  if (typeof window === "undefined") return;

  const markerKey = "orange-hotel-business-reset-version";
  if (localStorage.getItem(markerKey) === resetVersion) return;

  clearLocalBusinessState();
  await clearFirebaseBusinessState();
  localStorage.setItem(markerKey, resetVersion);
}

// ── Sync diagnostics ────────────────────────────────────────────────────────

export interface SyncKeyDiagnostic {
  key: string;
  localRecordCount: number;
  lastSyncedAt: number | null;
}

export interface SyncDiagnostics {
  connected: boolean;
  keys: SyncKeyDiagnostic[];
}

function countRecords(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 1;
}

export function getSyncDiagnostics(): SyncDiagnostics {
  const keys: SyncKeyDiagnostic[] = FIREBASE_SYNC_KEYS.map((key) => {
    const raw = typeof window !== "undefined" ? getLocalCacheRaw(key) : null;
    let localRecordCount = 0;
    if (raw) {
      try {
        localRecordCount = countRecords(JSON.parse(raw));
      } catch {
        localRecordCount = 0;
      }
    }
    return {
      key,
      localRecordCount,
      lastSyncedAt: _lastSyncedAt[key] ?? null,
    };
  });

  return {
    connected: _isConnected,
    keys,
  };
}

export async function getRemoteRecordCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    await ensureFirebaseAuthReady();
    await Promise.all(
      FIREBASE_SYNC_KEYS.map(async (key) => {
        try {
          const snapshot = await get(ref(firebaseDatabase, toStoragePath(key)));
          counts[key] = snapshot.exists() ? countRecords(snapshot.val()) : 0;
        } catch {
          counts[key] = -1;
        }
      }),
    );
    markSyncHealthy();
  } catch {
    await Promise.all(
      FIREBASE_SYNC_KEYS.map(async (key) => {
        try {
          const value = await fetchServerSyncedStorageValue(key);
          counts[key] = countRecords(value);
        } catch {
          counts[key] = -1;
        }
      }),
    );
  }
  return counts;
}

export async function wipeStorageCategory(key: string) {
  if (typeof window === "undefined") return;
  const defaultValue = sanitizeForStorage(getCanonicalDefaultValue(key));

  // Wipe locally
  setLocalCache(key, JSON.stringify(defaultValue));
  
  try {
    await ensureFirebaseAuthReady();
    await set(ref(firebaseDatabase, toStoragePath(key)), defaultValue);
    markSyncHealthy(key);
  } catch {
    await writeServerSyncedStorageValue(key, defaultValue);
    markSyncHealthy(key);
  }

  // Trigger local state updates
  dispatchStorageUpdated(key);
}
