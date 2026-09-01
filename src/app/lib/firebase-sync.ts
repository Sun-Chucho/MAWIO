import { get, onValue, ref, remove, runTransaction, set } from "firebase/database";
import { ensureFirebaseAuthReady, firebaseDatabase } from "@/app/lib/firebase";
import { getStoreItemLabel, type MainStoreItem } from "@/app/lib/inventory-transfer";
import { mergeKitchenMenuItems, type KitchenMenuItem } from "@/app/lib/kitchen-menu";
import { getDefaultRoomsForTier, type InventoryItem } from "@/app/lib/mock-data";
import { DEFAULT_HARDWARE_SETTINGS } from "@/app/lib/hardware-settings";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";
import { mergeStockEffectArrays } from "@/app/lib/stock-effects";
import {
  applyAtomicBaristaCheckout,
  applyAtomicBaristaCatalogStockMutation,
  applyAtomicBaristaVoid,
  applyAtomicBaristaStockMutation,
  BARISTA_POS_STORAGE_KEY,
  INVENTORY_STORAGE_KEY,
  MAIN_STORE_STORAGE_KEY,
  type AtomicBaristaCheckoutFailureReason,
  type AtomicBaristaCheckoutRequest,
  type AtomicBaristaCatalogStockRequest,
  type AtomicBaristaVoidRequest,
  type AtomicBaristaStockMutationRequest,
  type AtomicBaristaStockEffectRequirement,
  type AtomicManagerHistoryAppendRecord,
} from "@/app/lib/barista-checkout-transaction";

// ── Connectivity monitoring ─────────────────────────────────────────────────
let _isConnected = false;
let _firebaseRealtimeConnected = false;
const _connectionListeners = new Set<(connected: boolean) => void>();
const _lastSyncedAt: Record<string, number> = {};
const _pendingLocalWrites: Record<string, { value: unknown; createdAt: number; generation: number }> = {};
const _syncRetryTimers: Record<string, number> = {};
const _syncRetryAttempts: Record<string, number> = {};
const _syncWriteGenerations: Record<string, number> = {};
// Server polling is only a fallback when the realtime Firebase connection is
// unavailable. Keep it conservative to avoid unnecessary API/CDN traffic.
const FALLBACK_POLL_INTERVAL_MS = 60000;
const POS_FALLBACK_POLL_INTERVAL_MS = 5000;
const PENDING_LOCAL_WRITE_TTL_MS = 15000;
const DIRECT_SYNC_TIMEOUT_MS = 10000;

function withDirectSyncTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error(`${operation} timed out`)),
      DIRECT_SYNC_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchWithSyncTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), DIRECT_SYNC_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function isLatestStorageWrite(key: string, generation: number) {
  return _syncWriteGenerations[key] === generation;
}

function setPendingLocalWrite(key: string, generation: number, value: unknown) {
  if (!isLatestStorageWrite(key, generation)) return;
  _pendingLocalWrites[key] = { value, createdAt: Date.now(), generation };
}

function clearStorageSyncRetry(key: string, generation: number) {
  // An older request may complete after a newer edit has already failed. It
  // must not cancel the newer edit's recovery timer.
  if (!isLatestStorageWrite(key, generation)) return;
  const timer = _syncRetryTimers[key];
  if (typeof window !== "undefined" && timer !== undefined) window.clearTimeout(timer);
  delete _syncRetryTimers[key];
  delete _syncRetryAttempts[key];
}

function scheduleStorageSyncRetry(key: string, generation: number) {
  if (!isLatestStorageWrite(key, generation)) return;
  if (typeof window === "undefined" || _syncRetryTimers[key] !== undefined) return;
  const attempt = (_syncRetryAttempts[key] ?? 0) + 1;
  _syncRetryAttempts[key] = attempt;
  const delay = Math.min(5000 * 2 ** Math.min(attempt - 1, 4), 60000);

  _syncRetryTimers[key] = window.setTimeout(() => {
    delete _syncRetryTimers[key];
    const latestValue = readParsedLocalValue(key);
    if (latestValue !== null) syncStorageValueToFirebase(key, latestValue);
  }, delay);
}

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
  const response = await fetchWithSyncTimeout(`/api/storage-sync/${encodeURIComponent(key)}`, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Server sync read failed for ${key}`);
  }

  const payload = (await response.json()) as { value?: T | null };
  return payload.value ?? null;
}

type SyncedStorageCommitOptions = {
  stockEffectIntent?: "manager" | "operational";
  initializeIfMissing?: boolean;
  expectedStockItems?: unknown[];
};

async function writeServerSyncedStorageValue<T>(
  key: string,
  value: T,
  options?: SyncedStorageCommitOptions,
) {
  const response = await fetchWithSyncTimeout(`/api/storage-sync/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value,
      stockEffectIntent: options?.stockEffectIntent,
      initializeIfMissing: options?.initializeIfMissing,
      expectedStockItems: options?.expectedStockItems,
    }),
  });

  if (!response.ok) {
    throw new Error(`Server sync write failed for ${key}`);
  }

  const payload = (await response.json()) as { value?: T };
  return payload.value ?? value;
}

export type PosTicketSequenceRequest = {
  prefix: string;
  ticketId?: string;
  paymentId?: string;
};

async function commitServerPosStateWithCatalogRevision<T>(
  key: string,
  expectedCatalogRevision: number,
  value: T,
  ticketSequence?: PosTicketSequenceRequest,
) {
  const response = await fetchWithSyncTimeout(`/api/storage-sync/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value, expectedCatalogRevision, ticketSequence }),
  });
  const payload = (await response.json()) as { value?: T | null; conflict?: boolean; deleted?: boolean; error?: string };

  if (response.status === 410 || payload.deleted) {
    return { ok: false as const, reason: "checkout-deleted" as const, value: payload.value ?? null };
  }

  if (response.status === 409 || payload.conflict) {
    return { ok: false as const, reason: "catalog-changed" as const, value: payload.value ?? null };
  }
  if (!response.ok) {
    throw new Error(payload.error || `Server POS commit failed for ${key}`);
  }
  return { ok: true as const, value: payload.value ?? value };
}

async function commitServerPosCatalogMutation<T>(
  key: string,
  expectedCatalogRevision: number,
  value: T,
  expectedMenuItems: unknown[],
  nextMenuItems: unknown[],
) {
  const response = await fetchWithSyncTimeout(`/api/storage-sync/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      value,
      expectedCatalogRevision,
      catalogMutation: { expectedMenuItems, nextMenuItems },
    }),
  });
  const payload = (await response.json()) as { value?: T | null; conflict?: boolean; error?: string };
  if (response.status === 409 || payload.conflict) {
    return { ok: false as const, reason: "catalog-changed" as const, value: payload.value ?? null };
  }
  if (!response.ok) {
    throw new Error(payload.error || `Server catalog commit failed for ${key}`);
  }
  return { ok: true as const, value: payload.value ?? value };
}

async function commitServerAtomicBaristaCheckout(request: AtomicBaristaCheckoutRequest) {
  const response = await fetchWithSyncTimeout("/api/barista-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json() as {
    ok?: boolean;
    reason?: AtomicBaristaCheckoutFailureReason;
    posValue?: unknown;
    storeItems?: unknown[];
    inventoryItems?: unknown[];
    appendedValues?: Record<string, unknown[]>;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    if (payload.reason) {
      return {
        ok: false as const,
        reason: payload.reason,
        posValue: payload.posValue ?? null,
        storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
        inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
      };
    }
    throw new Error(payload.error || "The server could not commit the Barista checkout.");
  }
  return {
    ok: true as const,
    posValue: payload.posValue,
    storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
    inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
    appendedValues: payload.appendedValues ?? {},
  };
}

async function commitServerAtomicBaristaCatalogStock(request: AtomicBaristaCatalogStockRequest) {
  const response = await fetchWithSyncTimeout("/api/barista-catalog-stock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json() as {
    ok?: boolean;
    reason?: "catalog-changed" | "stock-changed" | "invalid-request";
    posValue?: unknown;
    storeItems?: unknown[];
    inventoryItems?: unknown[];
    appendedValues?: Record<string, unknown[]>;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    if (payload.reason) {
      return {
        ok: false as const,
        reason: payload.reason,
        posValue: payload.posValue ?? null,
        storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
        inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
      };
    }
    throw new Error(payload.error || "The server could not commit the Barista catalog and stock change.");
  }
  return {
    ok: true as const,
    posValue: payload.posValue,
    storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
    inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
    appendedValues: payload.appendedValues ?? {},
  };
}

async function commitServerAtomicBaristaVoid(request: AtomicBaristaVoidRequest) {
  const response = await fetchWithSyncTimeout("/api/barista-void", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json() as {
    ok?: boolean;
    reason?: "stock-conflict" | "ticket-not-cancellable" | "invalid-request";
    posValue?: unknown;
    storeItems?: unknown[];
    inventoryItems?: unknown[];
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    if (payload.reason) {
      return {
        ok: false as const,
        reason: payload.reason,
        posValue: payload.posValue ?? null,
        storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
        inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
      };
    }
    throw new Error(payload.error || "The server could not commit the Barista void.");
  }
  return {
    ok: true as const,
    posValue: payload.posValue,
    storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
    inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
  };
}

async function commitServerAtomicBaristaStockMutation(request: AtomicBaristaStockMutationRequest) {
  const response = await fetchWithSyncTimeout("/api/barista-stock-effects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = await response.json() as {
    ok?: boolean;
    reason?: "stock-conflict" | "invalid-request";
    storeItems?: unknown[];
    inventoryItems?: unknown[];
    appendedValues?: Record<string, unknown[]>;
    error?: string;
  };
  if (!response.ok || payload.ok === false) {
    if (payload.reason) return { ok: false as const, reason: payload.reason };
    throw new Error(payload.error || "The server could not commit the Barista stock change.");
  }
  return {
    ok: true as const,
    storeItems: Array.isArray(payload.storeItems) ? payload.storeItems : [],
    inventoryItems: Array.isArray(payload.inventoryItems) ? payload.inventoryItems : [],
    appendedValues: payload.appendedValues ?? {},
  };
}

async function removeServerSyncedStorageValue(key: string) {
  const response = await fetchWithSyncTimeout(`/api/storage-sync/${encodeURIComponent(key)}`, {
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

function toStoragePath(key: string) {
  return `${FIREBASE_STORAGE_ROOT}/standard/current/${key.replace(/[.#$[\]/]/g, "-")}`;
}

// Fresh Standard cache namespace. The previous cache is intentionally not
// migrated so stale business records cannot be uploaded after the clean start.
const STANDARD_CACHE_PREFIX = "MAWIO_CURRENT_";

export function getStandardScopedLocalKey(baseKey: string): string {
  if (typeof window === "undefined") return baseKey;
  if (!STANDARD_SCOPED_KEYS.has(baseKey)) return baseKey;
  return `${STANDARD_CACHE_PREFIX}${baseKey}`;
}

const STANDARD_CACHE_MIGRATION_MARKER = "orange-hotel-standard-current-cache-v1";

export function migrateLocalCacheToStandard() {
  if (typeof window === "undefined") return;

  const markerKey = STANDARD_CACHE_MIGRATION_MARKER;
  if (window.localStorage.getItem(markerKey) === "1") return;

  // Do not copy prior business data into the fresh namespace.
  window.localStorage.setItem(markerKey, "1");
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
  "orange-hotel-barista-waste",
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

const STANDARD_SHARED_KEYS = new Set<string>(["orange-hotel-login-profiles"]);
const STANDARD_SCOPED_KEYS = new Set<string>(
  [...FIREBASE_SYNC_KEYS, ...LEGACY_DEMO_KEYS].filter((key) => !STANDARD_SHARED_KEYS.has(key)),
);



function readParsedLocalValue<T>(key: string) {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(getStandardScopedLocalKey(key));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Physical localStorage writes and reads use the Standard-scoped cache key.
function setLocalCache(key: string, rawValue: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(getStandardScopedLocalKey(key), rawValue);
}

function removeLocalCache(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getStandardScopedLocalKey(key));
}

function getLocalCacheRaw(key: string) {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(getStandardScopedLocalKey(key));
}

function sanitizeSyncedValue<T>(key: string, value: T): T {
  const isKitchenState = key === "orange-hotel-kitchen-state";
  const isBaristaState = key === "orange-hotel-barista-state";
  if ((!isKitchenState && !isBaristaState) || value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  const snapshot = value as {
    tickets?: unknown[];
    ticketSeq?: number;
    payments?: unknown[];
    menuItems?: unknown[];
    catalogRevision?: number;
    queueResetAt?: number;
    deletedPaymentKeys?: unknown[];
    deletedTicketIds?: unknown[];
    appliedCatalogStockMutationIds?: unknown[];
    catalogStockMutationFingerprints?: unknown;
  };

  return {
    ...snapshot,
    tickets: Array.isArray(snapshot.tickets) ? snapshot.tickets : [],
    ticketSeq: Number.isFinite(snapshot.ticketSeq) ? Number(snapshot.ticketSeq) : isKitchenState ? 300 : 490,
    payments: Array.isArray(snapshot.payments) ? snapshot.payments : [],
    menuItems: isKitchenState
      ? mergeKitchenMenuItems((Array.isArray(snapshot.menuItems) ? snapshot.menuItems : []) as KitchenMenuItem[])
      : (Array.isArray(snapshot.menuItems) ? snapshot.menuItems : []),
    catalogRevision: Number.isFinite(snapshot.catalogRevision) ? Number(snapshot.catalogRevision) : 0,
    queueResetAt: Number.isFinite(snapshot.queueResetAt) ? Number(snapshot.queueResetAt) : 0,
    deletedPaymentKeys: Array.isArray(snapshot.deletedPaymentKeys)
      ? snapshot.deletedPaymentKeys.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [],
    deletedTicketIds: Array.isArray(snapshot.deletedTicketIds)
      ? snapshot.deletedTicketIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [],
    appliedCatalogStockMutationIds: Array.isArray(snapshot.appliedCatalogStockMutationIds)
      ? snapshot.appliedCatalogStockMutationIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [],
    catalogStockMutationFingerprints:
      typeof snapshot.catalogStockMutationFingerprints === "object" &&
      snapshot.catalogStockMutationFingerprints !== null &&
      !Array.isArray(snapshot.catalogStockMutationFingerprints)
        ? Object.fromEntries(Object.entries(snapshot.catalogStockMutationFingerprints).filter(
            (entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === "string",
          ))
        : {},
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
    return Array.isArray(value) && value.length >= getDefaultRoomsForTier().length;
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

  // A differing realtime snapshot is transaction-current shared state, not an
  // acknowledgement of this optimistic value. Apply it immediately; ignoring
  // the sole reconnect event could leave a POS on an old catalog forever.
  delete _pendingLocalWrites[key];
  return false;
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
  if (status === "delivered") return 4;
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

export function getPosPaymentSyncKey(record: unknown) {
  if (typeof record !== "object" || record === null) return "";
  const payment = record as {
    id?: unknown;
    code?: unknown;
    createdAt?: unknown;
    total?: unknown;
    destination?: unknown;
  };
  const id = typeof payment.id === "string" ? payment.id.trim() : "";
  if (id) return `id:${id}`;
  return `legacy:${String(payment.code ?? "")}|${String(payment.createdAt ?? "")}|${String(payment.total ?? "")}|${String(payment.destination ?? "")}`;
}

function getDeletedPaymentKeys(snapshot: { deletedPaymentKeys?: unknown }) {
  return Array.isArray(snapshot.deletedPaymentKeys)
    ? snapshot.deletedPaymentKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];
}

function getDeletedTicketIds(snapshot: { deletedTicketIds?: unknown }) {
  return Array.isArray(snapshot.deletedTicketIds)
    ? snapshot.deletedTicketIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function getAppliedCatalogStockMutationIds(snapshot: { appliedCatalogStockMutationIds?: unknown }) {
  return Array.isArray(snapshot.appliedCatalogStockMutationIds)
    ? snapshot.appliedCatalogStockMutationIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function getCatalogStockMutationFingerprints(snapshot: { catalogStockMutationFingerprints?: unknown }) {
  if (
    typeof snapshot.catalogStockMutationFingerprints !== "object" ||
    snapshot.catalogStockMutationFingerprints === null ||
    Array.isArray(snapshot.catalogStockMutationFingerprints)
  ) return {} as Record<string, string>;
  return Object.fromEntries(Object.entries(snapshot.catalogStockMutationFingerprints).filter(
    (entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === "string",
  ));
}

function removeDeletedTickets(tickets: unknown[], deletedTicketIds: string[]) {
  if (deletedTicketIds.length === 0) return tickets;
  const deletedIds = new Set(deletedTicketIds);
  return tickets.filter((ticket) => {
    const id = getRecordId(ticket);
    return !id || !deletedIds.has(id);
  });
}

function removeDeletedPayments(payments: unknown[], deletedPaymentKeys: string[]) {
  if (deletedPaymentKeys.length === 0) return payments;
  const deletedKeys = new Set(deletedPaymentKeys);
  return payments.filter((payment) => !deletedKeys.has(getPosPaymentSyncKey(payment)));
}

function filterRecordsAfterReset(records: unknown[], resetAt: number) {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return records;
  return records.filter((record) => {
    if (typeof record !== "object" || record === null) return false;
    const createdAt = Number((record as { createdAt?: unknown }).createdAt);
    return Number.isFinite(createdAt) && createdAt > resetAt;
  });
}

function mergeArrayRecordsForSync(localValue: unknown, remoteValue: unknown) {
  if (!Array.isArray(localValue) || !Array.isArray(remoteValue)) return localValue;
  return mergeRecordsById(localValue, remoteValue);
}

function mergePosStateForSync(localValue: unknown, remoteValue: unknown) {
  const localSnapshot = localValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: number; queueResetAt?: number; deletedPaymentKeys?: string[]; deletedTicketIds?: string[]; appliedCatalogStockMutationIds?: string[]; catalogStockMutationFingerprints?: Record<string, string> };
  const remoteSnapshot = remoteValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: number; queueResetAt?: number; deletedPaymentKeys?: string[]; deletedTicketIds?: string[]; appliedCatalogStockMutationIds?: string[]; catalogStockMutationFingerprints?: Record<string, string> };

  if (!localSnapshot || typeof localSnapshot !== "object" || !remoteSnapshot || typeof remoteSnapshot !== "object") {
    return localValue;
  }

  const localTickets = Array.isArray(localSnapshot.tickets) ? localSnapshot.tickets : [];
  const remoteTickets = Array.isArray(remoteSnapshot.tickets) ? remoteSnapshot.tickets : [];
  const localPayments = Array.isArray(localSnapshot.payments) ? localSnapshot.payments : [];
  const remotePayments = Array.isArray(remoteSnapshot.payments) ? remoteSnapshot.payments : [];
  const localCatalogRevision = Number(localSnapshot.catalogRevision ?? 0);
  const remoteCatalogRevision = Number(remoteSnapshot.catalogRevision ?? 0);
  const remoteCatalogWins = remoteCatalogRevision > localCatalogRevision;
  const remoteQueueResetWins = Number(remoteSnapshot.queueResetAt) > Number(localSnapshot.queueResetAt ?? 0);
  const queueResetAt = Math.max(Number(localSnapshot.queueResetAt ?? 0), Number(remoteSnapshot.queueResetAt ?? 0));
  const deletedPaymentKeys = Array.from(new Set([...getDeletedPaymentKeys(localSnapshot), ...getDeletedPaymentKeys(remoteSnapshot)]));
  const deletedTicketIds = Array.from(new Set([...getDeletedTicketIds(localSnapshot), ...getDeletedTicketIds(remoteSnapshot)]));
  const appliedCatalogStockMutationIds = Array.from(new Set([
    ...getAppliedCatalogStockMutationIds(localSnapshot),
    ...getAppliedCatalogStockMutationIds(remoteSnapshot),
  ]));
  const catalogStockMutationFingerprints = {
    ...getCatalogStockMutationFingerprints(localSnapshot),
    ...getCatalogStockMutationFingerprints(remoteSnapshot),
  };

  return {
    ...remoteSnapshot,
    ...localSnapshot,
    tickets: removeDeletedTickets(
      filterRecordsAfterReset(remoteQueueResetWins ? remoteTickets : mergeRecordsById(localTickets, remoteTickets), queueResetAt),
      deletedTicketIds,
    ),
    payments: removeDeletedPayments(mergeRecordsById(localPayments, remotePayments), deletedPaymentKeys),
    deletedPaymentKeys,
    deletedTicketIds,
    appliedCatalogStockMutationIds,
    catalogStockMutationFingerprints,
    menuItems: remoteCatalogWins
      ? (Array.isArray(remoteSnapshot.menuItems) ? remoteSnapshot.menuItems : [])
      : (Array.isArray(localSnapshot.menuItems) ? localSnapshot.menuItems : []),
    catalogRevision: Math.max(localCatalogRevision, remoteCatalogRevision),
    queueResetAt,
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
  const localSnapshot = localValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: number; queueResetAt?: number; deletedPaymentKeys?: string[]; deletedTicketIds?: string[]; appliedCatalogStockMutationIds?: string[]; catalogStockMutationFingerprints?: Record<string, string> };
  const remoteSnapshot = remoteValue as { tickets?: unknown[]; ticketSeq?: number; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: number; queueResetAt?: number; deletedPaymentKeys?: string[]; deletedTicketIds?: string[]; appliedCatalogStockMutationIds?: string[]; catalogStockMutationFingerprints?: Record<string, string> };

  if (!localSnapshot || typeof localSnapshot !== "object" || !remoteSnapshot || typeof remoteSnapshot !== "object") {
    return remoteValue;
  }

  const remoteTickets = Array.isArray(remoteSnapshot.tickets) ? remoteSnapshot.tickets : [];
  const localPayments = Array.isArray(localSnapshot.payments) ? localSnapshot.payments : [];
  const remotePayments = Array.isArray(remoteSnapshot.payments) ? remoteSnapshot.payments : [];
  const localCatalogRevision = Number(localSnapshot.catalogRevision ?? 0);
  const remoteCatalogRevision = Number(remoteSnapshot.catalogRevision ?? 0);
  const localCatalogWins = localCatalogRevision > remoteCatalogRevision;
  const queueResetAt = Math.max(Number(localSnapshot.queueResetAt ?? 0), Number(remoteSnapshot.queueResetAt ?? 0));
  const deletedPaymentKeys = Array.from(new Set([...getDeletedPaymentKeys(localSnapshot), ...getDeletedPaymentKeys(remoteSnapshot)]));
  const deletedTicketIds = Array.from(new Set([...getDeletedTicketIds(localSnapshot), ...getDeletedTicketIds(remoteSnapshot)]));
  const appliedCatalogStockMutationIds = Array.from(new Set([
    ...getAppliedCatalogStockMutationIds(localSnapshot),
    ...getAppliedCatalogStockMutationIds(remoteSnapshot),
  ]));
  const catalogStockMutationFingerprints = {
    ...getCatalogStockMutationFingerprints(localSnapshot),
    ...getCatalogStockMutationFingerprints(remoteSnapshot),
  };

  return {
    ...localSnapshot,
    ...remoteSnapshot,
    // The shared queue is authoritative during hydration. Local-only ticket
    // copies can represent an already delivered/cancelled order on another
    // terminal and must never be uploaded or displayed again.
    tickets: removeDeletedTickets(filterRecordsAfterReset(remoteTickets, queueResetAt), deletedTicketIds),
    payments: removeDeletedPayments(mergeRecordsByIdWithRemoteWins(localPayments, remotePayments), deletedPaymentKeys),
    deletedPaymentKeys,
    deletedTicketIds,
    appliedCatalogStockMutationIds,
    catalogStockMutationFingerprints,
    menuItems: localCatalogWins
      ? (Array.isArray(localSnapshot.menuItems) ? localSnapshot.menuItems : [])
      : (Array.isArray(remoteSnapshot.menuItems) ? remoteSnapshot.menuItems : localSnapshot.menuItems ?? []),
    catalogRevision: Math.max(localCatalogRevision, remoteCatalogRevision),
    queueResetAt,
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

  if (key === "orange-hotel-main-store-items" || key === "orange-hotel-inventory-items") {
    return mergeStockEffectArrays(localValue, remoteValue, "manager");
  }

  if (
    key === "orange-hotel-website-bookings" ||
    key === "orange-hotel-company-stock" ||
    key === "orange-hotel-live-chat" ||
    key === "orange-hotel-expenses" ||
    key === "orange-hotel-laundry-records" ||
    key === "orange-hotel-cancelled-tickets" ||
    key === "orange-hotel-barista-waste" ||
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
      return { tickets: [], ticketSeq: 300, payments: [], menuItems: [], catalogRevision: 0, queueResetAt: 0, deletedPaymentKeys: [], deletedTicketIds: [] };
    case "orange-hotel-barista-state":
      return { tickets: [], ticketSeq: 490, payments: [], menuItems: [], catalogRevision: 0, queueResetAt: 0, deletedPaymentKeys: [], deletedTicketIds: [] };
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
      return getDefaultRoomsForTier();
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
      catalogRevision: 0,
      queueResetAt: 0,
      deletedPaymentKeys: [],
      deletedTicketIds: [],
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
      catalogRevision: 0,
      queueResetAt: 0,
      deletedPaymentKeys: [],
      deletedTicketIds: [],
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
  if (key === "orange-hotel-main-store-items" || key === "orange-hotel-inventory-items") {
    // Shared stock is authoritative. Re-uploading local-only rows during a
    // read can resurrect a manager deletion, and GET-then-SET can erase a
    // concurrent checkout effect.
    return remoteValue;
  }
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

export type PosCatalogCommitResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "catalog-changed" | "checkout-deleted" | "sync-failed"; value?: T | null };

export type AtomicBaristaCheckoutCommitResult<TPos, TStoreItem, TInventoryItem> =
  | {
      ok: true;
      value: TPos;
      storeItems: TStoreItem[];
      inventoryItems: TInventoryItem[];
    }
  | {
      ok: false;
      reason: AtomicBaristaCheckoutFailureReason | "sync-failed";
      value?: TPos | null;
      storeItems?: TStoreItem[];
      inventoryItems?: TInventoryItem[];
    };

/** Commit a Barista sale and both of its stock ledgers in one root Firebase
 * transaction. No ticket/payment is visible unless every required deduction
 * was accepted against transaction-current stock. */
export async function commitBaristaCheckoutWithStock<
  TPos extends Record<string, unknown>,
  TStoreItem,
  TInventoryItem,
>(
  expectedCatalogRevision: number,
  posValue: TPos,
  ticketSequence: AtomicBaristaCheckoutRequest["ticketSequence"],
  storeItems: TStoreItem[],
  inventoryItems: TInventoryItem[],
  requiredStockEffects: AtomicBaristaStockEffectRequirement[],
): Promise<AtomicBaristaCheckoutCommitResult<TPos, TStoreItem, TInventoryItem>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const sanitizedPosValue = sanitizeForStorage(
    sanitizeSyncedValue(BARISTA_POS_STORAGE_KEY, posValue),
  ) as TPos;
  const request = sanitizeForStorage({
    expectedCatalogRevision,
    expectedMenuItems: Array.isArray(sanitizedPosValue.menuItems) ? sanitizedPosValue.menuItems : [],
    posValue: sanitizedPosValue,
    ticketSequence,
    storeItems,
    inventoryItems,
    requiredStockEffects,
  }) as AtomicBaristaCheckoutRequest;
  const storageKeys = [
    BARISTA_POS_STORAGE_KEY,
    MAIN_STORE_STORAGE_KEY,
    INVENTORY_STORAGE_KEY,
  ] as const;
  const generations = Object.fromEntries(storageKeys.map((key) => {
    const generation = (_syncWriteGenerations[key] ?? 0) + 1;
    _syncWriteGenerations[key] = generation;
    return [key, generation];
  })) as Record<(typeof storageKeys)[number], number>;
  setPendingLocalWrite(BARISTA_POS_STORAGE_KEY, generations[BARISTA_POS_STORAGE_KEY], request.posValue);
  setPendingLocalWrite(MAIN_STORE_STORAGE_KEY, generations[MAIN_STORE_STORAGE_KEY], request.storeItems);
  setPendingLocalWrite(INVENTORY_STORAGE_KEY, generations[INVENTORY_STORAGE_KEY], request.inventoryItems);

  const applyCommittedValue = (key: (typeof storageKeys)[number], rawValue: unknown) => {
    const generation = generations[key];
    const value = sanitizeForStorage(sanitizeSyncedValue(key, rawValue));
    if (!isLatestStorageWrite(key, generation)) return value;
    setLocalCache(key, JSON.stringify(value));
    mirrorCanonicalStateToLegacyLocal(key, value);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, value);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return value;
  };

  const applyOutcome = (outcome: {
    posValue: unknown;
    storeItems: unknown[];
    inventoryItems: unknown[];
  }) => ({
    value: applyCommittedValue(BARISTA_POS_STORAGE_KEY, outcome.posValue) as TPos,
    storeItems: applyCommittedValue(MAIN_STORE_STORAGE_KEY, outcome.storeItems) as TStoreItem[],
    inventoryItems: applyCommittedValue(INVENTORY_STORAGE_KEY, outcome.inventoryItems) as TInventoryItem[],
  });

  const applyConflictOutcome = (outcome: {
    posValue: unknown;
    storeItems: unknown[];
    inventoryItems: unknown[];
  }) => {
    try {
      return applyOutcome(outcome);
    } catch {
      return {
        value: outcome.posValue as TPos | null,
        storeItems: outcome.storeItems as TStoreItem[],
        inventoryItems: outcome.inventoryItems as TInventoryItem[],
      };
    }
  };

  let transactionOutcome: ReturnType<typeof applyAtomicBaristaCheckout> | null = null;
  try {
    await withDirectSyncTimeout(
      ensureFirebaseAuthReady(),
      "Firebase authentication for atomic Barista checkout",
    );
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, `${FIREBASE_STORAGE_ROOT}/standard/current`),
      (currentRoot) => {
        transactionOutcome = applyAtomicBaristaCheckout(currentRoot, request);
        return transactionOutcome.ok ? transactionOutcome.value : undefined;
      },
      { applyLocally: false },
    ), "Atomic Barista checkout commit");

    if (!result.committed) {
      const failedOutcome = transactionOutcome as ReturnType<typeof applyAtomicBaristaCheckout> | null;
      if (failedOutcome && !failedOutcome.ok) {
        const current = applyConflictOutcome(failedOutcome);
        return { ok: false, reason: failedOutcome.reason, ...current };
      }
      throw new Error("The atomic Barista checkout transaction was not committed.");
    }
    const committedOutcome = applyAtomicBaristaCheckout(result.snapshot.val(), request);
    if (!committedOutcome.ok) throw new Error("The committed Barista checkout could not be verified.");
    return { ok: true, ...applyOutcome(committedOutcome) };
  } catch (directError) {
    console.error("Direct atomic Barista checkout failed", directError);
    try {
      const serverOutcome = await commitServerAtomicBaristaCheckout(request);
      if (!serverOutcome.ok) {
        const current = applyConflictOutcome(serverOutcome);
        return { ok: false, reason: serverOutcome.reason, ...current };
      }
      return { ok: true, ...applyOutcome(serverOutcome) };
    } catch (serverError) {
      storageKeys.forEach((key) => {
        if (isLatestStorageWrite(key, generations[key])) delete _pendingLocalWrites[key];
      });
      emitConnectionState(false);
      console.error("Server atomic Barista checkout failed", serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

export type AtomicBaristaCatalogStockCommitResult<TPos, TStoreItem, TInventoryItem> =
  | { ok: true; value: TPos; storeItems: TStoreItem[]; inventoryItems: TInventoryItem[]; appendedValues: Record<string, unknown[]> }
  | {
      ok: false;
      reason: "catalog-changed" | "stock-changed" | "invalid-request" | "sync-failed";
      value?: TPos | null;
      storeItems?: TStoreItem[];
      inventoryItems?: TInventoryItem[];
      appendedValues?: Record<string, unknown[]>;
    };

/** Compare-and-swap the Barista catalog and both linked stock arrays in one
 * root transaction. This is used when Manager > Inventory creates a sellable
 * Barista item, so POS can never expose dangling stock links. */
export async function commitBaristaCatalogAndStockMutation<
  TPos,
  TMenu,
  TStoreItem,
  TInventoryItem,
>(
  baseSnapshot: TPos & { menuItems: TMenu[]; catalogRevision?: number },
  nextMenuItems: TMenu[],
  expectedStoreItems: TStoreItem[],
  nextStoreItems: TStoreItem[],
  expectedInventoryItems: TInventoryItem[],
  nextInventoryItems: TInventoryItem[],
  mutationId?: string,
  appendRecords: NonNullable<AtomicBaristaCatalogStockRequest["appendRecords"]> = [],
): Promise<AtomicBaristaCatalogStockCommitResult<TPos, TStoreItem, TInventoryItem>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const sanitizedBase = sanitizeForStorage(
    sanitizeSyncedValue(BARISTA_POS_STORAGE_KEY, baseSnapshot),
  ) as TPos & { menuItems: TMenu[]; catalogRevision?: number };
  const request = sanitizeForStorage({
    mutationId: mutationId ?? globalThis.crypto?.randomUUID?.()
      ?? `catalog-stock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    expectedCatalogRevision: Number(sanitizedBase.catalogRevision ?? 0),
    expectedMenuItems: sanitizedBase.menuItems,
    nextMenuItems,
    posBaseValue: sanitizedBase as Record<string, unknown>,
    expectedStoreItems,
    nextStoreItems,
    expectedInventoryItems,
    nextInventoryItems,
    appendRecords,
  }) as AtomicBaristaCatalogStockRequest;
  const keys = Array.from(new Set([
    BARISTA_POS_STORAGE_KEY,
    MAIN_STORE_STORAGE_KEY,
    INVENTORY_STORAGE_KEY,
    ...appendRecords.map((entry) => entry.key),
  ]));
  const generations = Object.fromEntries(keys.map((key) => {
    const generation = (_syncWriteGenerations[key] ?? 0) + 1;
    _syncWriteGenerations[key] = generation;
    return [key, generation];
  })) as Record<string, number>;
  setPendingLocalWrite(BARISTA_POS_STORAGE_KEY, generations[BARISTA_POS_STORAGE_KEY], request.posBaseValue);
  setPendingLocalWrite(MAIN_STORE_STORAGE_KEY, generations[MAIN_STORE_STORAGE_KEY], request.nextStoreItems);
  setPendingLocalWrite(INVENTORY_STORAGE_KEY, generations[INVENTORY_STORAGE_KEY], request.nextInventoryItems);

  const applyValue = (key: string, rawValue: unknown) => {
    const generation = generations[key];
    const value = sanitizeForStorage(sanitizeSyncedValue(key, rawValue));
    if (!isLatestStorageWrite(key, generation)) return value;
    setLocalCache(key, JSON.stringify(value));
    mirrorCanonicalStateToLegacyLocal(key, value);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, value);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return value;
  };
  const applyOutcome = (outcome: { posValue: unknown; storeItems: unknown[]; inventoryItems: unknown[]; appendedValues: Record<string, unknown[]> }) => {
    const applied = {
      value: applyValue(BARISTA_POS_STORAGE_KEY, outcome.posValue) as TPos,
      storeItems: applyValue(MAIN_STORE_STORAGE_KEY, outcome.storeItems) as TStoreItem[],
      inventoryItems: applyValue(INVENTORY_STORAGE_KEY, outcome.inventoryItems) as TInventoryItem[],
      appendedValues: outcome.appendedValues,
    };
    Object.entries(outcome.appendedValues).forEach(([key, value]) => {
      if (generations[key] !== undefined) applyValue(key, value);
    });
    return applied;
  };
  const clearPending = () => keys.forEach((key) => {
    if (isLatestStorageWrite(key, generations[key])) delete _pendingLocalWrites[key];
  });

  let transactionOutcome: ReturnType<typeof applyAtomicBaristaCatalogStockMutation> | null = null;
  try {
    await withDirectSyncTimeout(
      ensureFirebaseAuthReady(),
      "Firebase authentication for atomic Barista catalog and stock update",
    );
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, `${FIREBASE_STORAGE_ROOT}/standard/current`),
      (currentRoot) => {
        transactionOutcome = applyAtomicBaristaCatalogStockMutation(currentRoot, request);
        return transactionOutcome.ok ? transactionOutcome.value : undefined;
      },
      { applyLocally: false },
    ), "Atomic Barista catalog and stock update");
    if (!result.committed) {
      const failed = transactionOutcome as ReturnType<typeof applyAtomicBaristaCatalogStockMutation> | null;
      clearPending();
      return failed && !failed.ok
        ? { ok: false, reason: failed.reason, value: failed.posValue as TPos | null, storeItems: failed.storeItems as TStoreItem[], inventoryItems: failed.inventoryItems as TInventoryItem[] }
        : { ok: false, reason: "sync-failed" };
    }
    const committed = applyAtomicBaristaCatalogStockMutation(result.snapshot.val(), request);
    if (!committed.ok) throw new Error("The committed Barista manager edit could not be verified.");
    return { ok: true, ...applyOutcome(committed) };
  } catch (directError) {
    console.error("Direct atomic Barista catalog and stock update failed", directError);
    try {
      const serverResult = await commitServerAtomicBaristaCatalogStock(request);
      if (!serverResult.ok) {
        clearPending();
        return {
          ok: false,
          reason: serverResult.reason,
          value: serverResult.posValue as TPos | null,
          storeItems: serverResult.storeItems as TStoreItem[],
          inventoryItems: serverResult.inventoryItems as TInventoryItem[],
        };
      }
      return { ok: true, ...applyOutcome(serverResult) };
    } catch (serverError) {
      clearPending();
      emitConnectionState(false);
      console.error("Server atomic Barista catalog and stock update failed", serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

export type AtomicBaristaVoidCommitResult<TPos, TStoreItem, TInventoryItem> =
  | { ok: true; value: TPos; storeItems: TStoreItem[]; inventoryItems: TInventoryItem[] }
  | {
      ok: false;
      reason: "stock-conflict" | "ticket-not-cancellable" | "invalid-request" | "sync-failed";
      value?: TPos | null;
      storeItems?: TStoreItem[];
      inventoryItems?: TInventoryItem[];
    };

export async function commitBaristaVoidWithStock<
  TPos,
  TStoreItem,
  TInventoryItem,
>(
  posBaseValue: TPos,
  cancellableTicketIds: string[],
  deletedPaymentKeys: string[],
  deletedTicketIds: string[],
  storeItems: TStoreItem[],
  inventoryItems: TInventoryItem[],
  requiredStockEffects: AtomicBaristaStockEffectRequirement[],
): Promise<AtomicBaristaVoidCommitResult<TPos, TStoreItem, TInventoryItem>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const request = sanitizeForStorage({
    posBaseValue: sanitizeSyncedValue(BARISTA_POS_STORAGE_KEY, posBaseValue) as Record<string, unknown>,
    cancellableTicketIds,
    deletedPaymentKeys,
    deletedTicketIds,
    storeItems,
    inventoryItems,
    requiredStockEffects,
  }) as AtomicBaristaVoidRequest;
  const keys = [BARISTA_POS_STORAGE_KEY, MAIN_STORE_STORAGE_KEY, INVENTORY_STORAGE_KEY] as const;
  const generations = Object.fromEntries(keys.map((key) => {
    const generation = (_syncWriteGenerations[key] ?? 0) + 1;
    _syncWriteGenerations[key] = generation;
    return [key, generation];
  })) as Record<(typeof keys)[number], number>;
  setPendingLocalWrite(BARISTA_POS_STORAGE_KEY, generations[BARISTA_POS_STORAGE_KEY], request.posBaseValue);
  setPendingLocalWrite(MAIN_STORE_STORAGE_KEY, generations[MAIN_STORE_STORAGE_KEY], request.storeItems);
  setPendingLocalWrite(INVENTORY_STORAGE_KEY, generations[INVENTORY_STORAGE_KEY], request.inventoryItems);

  const applyValue = (key: (typeof keys)[number], rawValue: unknown) => {
    const generation = generations[key];
    const value = sanitizeForStorage(sanitizeSyncedValue(key, rawValue));
    if (!isLatestStorageWrite(key, generation)) return value;
    setLocalCache(key, JSON.stringify(value));
    mirrorCanonicalStateToLegacyLocal(key, value);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, value);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return value;
  };
  const applyOutcome = (outcome: { posValue: unknown; storeItems: unknown[]; inventoryItems: unknown[] }) => ({
    value: applyValue(BARISTA_POS_STORAGE_KEY, outcome.posValue) as TPos,
    storeItems: applyValue(MAIN_STORE_STORAGE_KEY, outcome.storeItems) as TStoreItem[],
    inventoryItems: applyValue(INVENTORY_STORAGE_KEY, outcome.inventoryItems) as TInventoryItem[],
  });
  const clearPending = () => keys.forEach((key) => {
    if (isLatestStorageWrite(key, generations[key])) delete _pendingLocalWrites[key];
  });
  let transactionOutcome: ReturnType<typeof applyAtomicBaristaVoid> | null = null;

  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), "Firebase authentication for atomic Barista void");
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, `${FIREBASE_STORAGE_ROOT}/standard/current`),
      (currentRoot) => {
        transactionOutcome = applyAtomicBaristaVoid(currentRoot, request);
        return transactionOutcome.ok ? transactionOutcome.value : undefined;
      },
      { applyLocally: false },
    ), "Atomic Barista void");
    if (!result.committed) {
      const failed = transactionOutcome as ReturnType<typeof applyAtomicBaristaVoid> | null;
      clearPending();
      return failed && !failed.ok
        ? { ok: false, reason: failed.reason, value: failed.posValue as TPos | null, storeItems: failed.storeItems as TStoreItem[], inventoryItems: failed.inventoryItems as TInventoryItem[] }
        : { ok: false, reason: "sync-failed" };
    }
    const committed = applyAtomicBaristaVoid(result.snapshot.val(), request);
    if (!committed.ok) throw new Error("The committed Barista void could not be verified.");
    return { ok: true, ...applyOutcome(committed) };
  } catch (directError) {
    console.error("Direct atomic Barista void failed", directError);
    try {
      const serverResult = await commitServerAtomicBaristaVoid(request);
      if (!serverResult.ok) {
        clearPending();
        return {
          ok: false,
          reason: serverResult.reason,
          value: serverResult.posValue as TPos | null,
          storeItems: serverResult.storeItems as TStoreItem[],
          inventoryItems: serverResult.inventoryItems as TInventoryItem[],
        };
      }
      return { ok: true, ...applyOutcome(serverResult) };
    } catch (serverError) {
      clearPending();
      emitConnectionState(false);
      console.error("Server atomic Barista void failed", serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

export type AtomicBaristaStockCommitResult<TStoreItem, TInventoryItem> =
  | {
      ok: true;
      storeItems: TStoreItem[];
      inventoryItems: TInventoryItem[];
      appendedValues: Record<string, unknown[]>;
    }
  | { ok: false; reason: "stock-conflict" | "usage-capacity-exceeded" | "invalid-request" | "sync-failed" };

export async function commitBaristaStockEffectsAndLogs<TStoreItem, TInventoryItem>(
  storeItems: TStoreItem[],
  inventoryItems: TInventoryItem[],
  requiredStockEffects: AtomicBaristaStockEffectRequirement[],
  appendRecords: AtomicBaristaStockMutationRequest["appendRecords"] = [],
  usageCapacityRequirements: NonNullable<AtomicBaristaStockMutationRequest["usageCapacityRequirements"]> = [],
  managerMutation?: AtomicBaristaStockMutationRequest["managerMutation"],
): Promise<AtomicBaristaStockCommitResult<TStoreItem, TInventoryItem>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const request = sanitizeForStorage({
    storeItems,
    inventoryItems,
    requiredStockEffects,
    appendRecords,
    usageCapacityRequirements,
    ...(managerMutation ? { managerMutation } : {}),
  }) as AtomicBaristaStockMutationRequest;
  const keys = Array.from(new Set([
    MAIN_STORE_STORAGE_KEY,
    INVENTORY_STORAGE_KEY,
    ...appendRecords.map((entry) => entry.key),
  ]));
  const generations = Object.fromEntries(keys.map((key) => {
    const generation = (_syncWriteGenerations[key] ?? 0) + 1;
    _syncWriteGenerations[key] = generation;
    return [key, generation];
  })) as Record<string, number>;
  setPendingLocalWrite(MAIN_STORE_STORAGE_KEY, generations[MAIN_STORE_STORAGE_KEY], request.storeItems);
  setPendingLocalWrite(INVENTORY_STORAGE_KEY, generations[INVENTORY_STORAGE_KEY], request.inventoryItems);

  const applyValue = (key: string, rawValue: unknown) => {
    const value = sanitizeForStorage(sanitizeSyncedValue(key, rawValue));
    const generation = generations[key];
    if (generation === undefined || !isLatestStorageWrite(key, generation)) return value;
    setLocalCache(key, JSON.stringify(value));
    mirrorCanonicalStateToLegacyLocal(key, value);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, value);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return value;
  };
  const applyOutcome = (outcome: {
    storeItems: unknown[];
    inventoryItems: unknown[];
    appendedValues: Record<string, unknown[]>;
  }) => {
    const committedStoreItems = applyValue(MAIN_STORE_STORAGE_KEY, outcome.storeItems) as TStoreItem[];
    const committedInventoryItems = applyValue(INVENTORY_STORAGE_KEY, outcome.inventoryItems) as TInventoryItem[];
    Object.entries(outcome.appendedValues).forEach(([key, value]) => {
      if (generations[key] !== undefined) applyValue(key, value);
    });
    return {
      storeItems: committedStoreItems,
      inventoryItems: committedInventoryItems,
      appendedValues: outcome.appendedValues,
    };
  };
  const clearPending = () => keys.forEach((key) => {
    if (isLatestStorageWrite(key, generations[key])) delete _pendingLocalWrites[key];
  });
  let transactionOutcome: ReturnType<typeof applyAtomicBaristaStockMutation> | null = null;

  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), "Firebase authentication for atomic Barista stock change");
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, `${FIREBASE_STORAGE_ROOT}/standard/current`),
      (currentRoot) => {
        transactionOutcome = applyAtomicBaristaStockMutation(currentRoot, request);
        return transactionOutcome.ok ? transactionOutcome.value : undefined;
      },
      { applyLocally: false },
    ), "Atomic Barista stock change");
    if (!result.committed) {
      const failed = transactionOutcome as ReturnType<typeof applyAtomicBaristaStockMutation> | null;
      clearPending();
      return failed && !failed.ok
        ? { ok: false, reason: failed.reason }
        : { ok: false, reason: "sync-failed" };
    }
    const committed = applyAtomicBaristaStockMutation(result.snapshot.val(), request);
    if (!committed.ok) throw new Error("The committed Barista stock change could not be verified.");
    return { ok: true, ...applyOutcome(committed) };
  } catch (directError) {
    console.error("Direct atomic Barista stock change failed", directError);
    try {
      const serverResult = await commitServerAtomicBaristaStockMutation(request);
      if (!serverResult.ok) {
        clearPending();
        return serverResult;
      }
      return { ok: true, ...applyOutcome(serverResult) };
    } catch (serverError) {
      clearPending();
      emitConnectionState(false);
      console.error("Server atomic Barista stock change failed", serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

/** Replace Main Store and Inventory together after verifying that both still
 * equal the manager's hydrated snapshots. The mutation ID makes a retry after
 * a lost response return the already-committed pair instead of applying it a
 * second time. */
export function commitStockArraysAtomically<TStoreItem, TInventoryItem>(
  expectedStoreItems: TStoreItem[],
  nextStoreItems: TStoreItem[],
  expectedInventoryItems: TInventoryItem[],
  nextInventoryItems: TInventoryItem[],
  mutationId?: string,
  appendRecords: AtomicManagerHistoryAppendRecord[] = [],
) {
  return commitBaristaStockEffectsAndLogs(
    nextStoreItems,
    nextInventoryItems,
    [],
    appendRecords,
    [],
    {
      id: mutationId ?? globalThis.crypto?.randomUUID?.()
        ?? `stock-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      expectedStoreItems,
      expectedInventoryItems,
    },
  );
}

/**
 * Commit an intentional menu mutation with compare-and-swap semantics. A
 * manager only gets success after the shared catalog accepted the exact edit;
 * a concurrent manager edit returns a conflict instead of silently winning by
 * client clock or replacing another row's change.
 */
export async function commitPosCatalogMutation<
  TMenu,
  TSnapshot extends { menuItems: TMenu[]; catalogRevision?: number },
>(
  key: string,
  baseSnapshot: TSnapshot,
  nextMenuItems: TMenu[],
): Promise<PosCatalogCommitResult<TSnapshot>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const generation = (_syncWriteGenerations[key] ?? 0) + 1;
  _syncWriteGenerations[key] = generation;
  const sanitizedBase = sanitizeForStorage(sanitizeSyncedValue(key, baseSnapshot)) as TSnapshot;
  const expectedCatalogRevision = Number.isFinite(Number(sanitizedBase.catalogRevision))
    ? Number(sanitizedBase.catalogRevision)
    : 0;
  const expectedMenuItems = Array.isArray(sanitizedBase.menuItems) ? sanitizedBase.menuItems : [];
  const sanitizedCandidate = sanitizeForStorage(sanitizeSyncedValue(key, {
    ...sanitizedBase,
    menuItems: nextMenuItems,
  })) as TSnapshot;
  const desiredMenuItems = Array.isArray(sanitizedCandidate.menuItems) ? sanitizedCandidate.menuItems : [];
  let candidateValue: unknown = sanitizedCandidate;
  let catalogChanged = false;
  setPendingLocalWrite(key, generation, candidateValue);

  const applyValue = (nextValue: unknown) => {
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, nextValue));
    if (isLatestStorageWrite(key, generation)) {
      setLocalCache(key, JSON.stringify(sanitizedValue));
      mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
      dispatchStorageUpdated(key);
      setPendingLocalWrite(key, generation, sanitizedValue);
      clearStorageSyncRetry(key, generation);
      markSyncHealthy(key);
    }
    return sanitizedValue as TSnapshot;
  };

  const applyConflictValue = (conflictValue: unknown) => {
    if (!isLatestStorageWrite(key, generation)) return;
    delete _pendingLocalWrites[key];
    clearStorageSyncRetry(key, generation);
    if (conflictValue === null || conflictValue === undefined) return;
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, conflictValue));
    setLocalCache(key, JSON.stringify(sanitizedValue));
    mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
    dispatchStorageUpdated(key);
  };

  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), `Firebase authentication for ${key}`);
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, toStoragePath(key)),
      (currentValue) => {
        const remoteValue = currentValue === null
          ? null
          : sanitizeForStorage(sanitizeSyncedValue(key, currentValue));
        const currentSnapshot = (remoteValue ?? sanitizedBase) as TSnapshot;
        const currentMenuItems = Array.isArray(currentSnapshot.menuItems) ? currentSnapshot.menuItems : [];

        // Idempotent retry after a commit whose response was lost.
        if (areSnapshotsEqual(currentMenuItems, desiredMenuItems)) {
          candidateValue = currentSnapshot;
          setPendingLocalWrite(key, generation, candidateValue);
          return currentSnapshot;
        }

        const currentRevision = Number(currentSnapshot.catalogRevision ?? 0);
        const resolvedCurrentRevision = Number.isFinite(currentRevision) ? currentRevision : 0;
        if (
          resolvedCurrentRevision !== expectedCatalogRevision ||
          !areSnapshotsEqual(currentMenuItems, expectedMenuItems)
        ) {
          catalogChanged = true;
          return;
        }

        candidateValue = sanitizeForStorage(sanitizeSyncedValue(key, {
          ...currentSnapshot,
          menuItems: desiredMenuItems,
          catalogRevision: resolvedCurrentRevision + 1,
        }));
        setPendingLocalWrite(key, generation, candidateValue);
        return candidateValue;
      },
      { applyLocally: false },
    ), `Firebase catalog commit for ${key}`);

    if (!result.committed) {
      if (catalogChanged) {
        const conflictValue = result.snapshot.val();
        applyConflictValue(conflictValue);
        return { ok: false, reason: "catalog-changed", value: conflictValue as TSnapshot | null };
      }
      throw new Error(`Firebase catalog transaction was not committed for ${key}`);
    }

    return { ok: true, value: applyValue(result.snapshot.val()) };
  } catch (error) {
    if (catalogChanged) {
      const conflictValue = await fetchServerSyncedStorageValue<TSnapshot>(key).catch(() => null);
      applyConflictValue(conflictValue);
      return { ok: false, reason: "catalog-changed", value: conflictValue };
    }
    console.error(`Firebase atomic catalog commit failed for ${key}`, error);
    try {
      const serverResult = await commitServerPosCatalogMutation(
        key,
        expectedCatalogRevision,
        sanitizedCandidate,
        expectedMenuItems,
        desiredMenuItems,
      );
      if (!serverResult.ok) {
        applyConflictValue(serverResult.value);
        return { ok: false, reason: "catalog-changed", value: serverResult.value as TSnapshot | null };
      }
      return { ok: true, value: applyValue(serverResult.value) };
    } catch (serverError) {
      if (isLatestStorageWrite(key, generation)) delete _pendingLocalWrites[key];
      emitConnectionState(false);
      console.error(`Server atomic catalog commit failed for ${key}`, serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

function buildPosCheckoutDelta(
  incomingValue: unknown,
  currentValue: unknown,
  request: PosTicketSequenceRequest,
) {
  const incomingSnapshot = incomingValue as {
    tickets?: unknown[];
    payments?: unknown[];
    ticketSeq?: unknown;
    menuItems?: unknown[];
    catalogRevision?: unknown;
    queueResetAt?: unknown;
    deletedPaymentKeys?: unknown[];
    deletedTicketIds?: unknown[];
  } | null;
  const currentSnapshot = currentValue as typeof incomingSnapshot;
  const incomingTickets = Array.isArray(incomingSnapshot?.tickets) ? incomingSnapshot.tickets : [];
  const incomingPayments = Array.isArray(incomingSnapshot?.payments) ? incomingSnapshot.payments : [];
  const newTicket = request.ticketId
    ? incomingTickets.find((record) => getRecordId(record) === request.ticketId)
    : undefined;
  const newPayment = request.paymentId
    ? incomingPayments.find((record) => getRecordId(record) === request.paymentId)
    : undefined;
  if (!newPayment || (request.ticketId && !newTicket)) {
    throw new Error("The POS checkout payload is missing its stable ticket or payment record.");
  }

  const hasRemoteState = typeof currentValue === "object" && currentValue !== null;
  const currentTickets = hasRemoteState && Array.isArray(currentSnapshot?.tickets) ? currentSnapshot.tickets : incomingTickets;
  const currentPayments = hasRemoteState && Array.isArray(currentSnapshot?.payments) ? currentSnapshot.payments : incomingPayments;
  const deletedPaymentKeys = Array.from(new Set([
    ...getDeletedPaymentKeys(currentSnapshot ?? {}),
    ...getDeletedPaymentKeys(incomingSnapshot ?? {}),
  ]));
  const deletedTicketIds = Array.from(new Set([
    ...getDeletedTicketIds(currentSnapshot ?? {}),
    ...getDeletedTicketIds(incomingSnapshot ?? {}),
  ]));
  const tickets = request.ticketId && !currentTickets.some((record) => getRecordId(record) === request.ticketId)
    ? [newTicket, ...currentTickets]
    : currentTickets;
  const payments = request.paymentId && !currentPayments.some((record) => getRecordId(record) === request.paymentId)
    ? [newPayment, ...currentPayments]
    : currentPayments;
  const currentSeq = Number(currentSnapshot?.ticketSeq);
  const incomingSeq = Number(incomingSnapshot?.ticketSeq);

  return {
    ...(hasRemoteState ? currentSnapshot : incomingSnapshot),
    tickets: removeDeletedTickets(tickets, deletedTicketIds),
    payments: removeDeletedPayments(payments, deletedPaymentKeys),
    ticketSeq: Math.max(
      Number.isFinite(currentSeq) ? currentSeq : 0,
      Number.isFinite(incomingSeq) ? incomingSeq : 0,
    ),
    menuItems: hasRemoteState
      ? (Array.isArray(currentSnapshot?.menuItems) ? currentSnapshot.menuItems : [])
      : (Array.isArray(incomingSnapshot?.menuItems) ? incomingSnapshot.menuItems : []),
    catalogRevision: hasRemoteState
      ? Number(currentSnapshot?.catalogRevision ?? 0)
      : Number(incomingSnapshot?.catalogRevision ?? 0),
    queueResetAt: Math.max(
      Number(currentSnapshot?.queueResetAt ?? 0),
      Number(incomingSnapshot?.queueResetAt ?? 0),
    ),
    deletedPaymentKeys,
    deletedTicketIds,
  };
}

function allocatePosTicketSequence(
  value: unknown,
  currentValue: unknown,
  request: PosTicketSequenceRequest,
) {
  if (typeof value !== "object" || value === null) return value;
  const snapshot = value as { tickets?: unknown[]; payments?: unknown[]; ticketSeq?: unknown };
  const currentSnapshot = currentValue as { ticketSeq?: unknown } | null;
  let matchedRecord = false;
  const currentSeq = Number(currentSnapshot?.ticketSeq);
  const incomingSeq = Number(snapshot.ticketSeq);
  const nextSeq = Math.max(
    Number.isFinite(currentSeq) ? currentSeq : 0,
    Number.isFinite(incomingSeq) ? incomingSeq : 0,
  ) + 1;
  const prefix = request.prefix.trim().toUpperCase();
  const code = `${prefix}-${nextSeq}`;
  const tickets = Array.isArray(snapshot.tickets)
    ? snapshot.tickets.map((record) => {
        if (!request.ticketId || getRecordId(record) !== request.ticketId) return record;
        matchedRecord = true;
        return typeof record === "object" && record !== null ? { ...record, code } : record;
      })
    : [];
  const payments = Array.isArray(snapshot.payments)
    ? snapshot.payments.map((record) => {
        if (!request.paymentId || getRecordId(record) !== request.paymentId) return record;
        matchedRecord = true;
        return typeof record === "object" && record !== null ? { ...record, code } : record;
      })
    : [];

  if (!matchedRecord) return value;
  return { ...value, tickets, payments, ticketSeq: nextSeq };
}

/**
 * Commit a checkout only if the shared catalog is still the exact revision the
 * cashier reviewed. The revision check and queue/payment merge happen inside
 * one Firebase transaction (or one conditional REST transaction), closing the
 * final price-change race between validation and saving the sale.
 */
export async function commitPosStateWithCatalogRevision<T>(
  key: string,
  expectedCatalogRevision: number,
  value: T,
  ticketSequence?: PosTicketSequenceRequest,
): Promise<PosCatalogCommitResult<T>> {
  if (typeof window === "undefined") return { ok: false, reason: "sync-failed" };
  const generation = (_syncWriteGenerations[key] ?? 0) + 1;
  _syncWriteGenerations[key] = generation;
  const baseCandidateValue: unknown = sanitizeForStorage(sanitizeSyncedValue(key, value));
  let candidateValue = baseCandidateValue;
  setPendingLocalWrite(key, generation, candidateValue);

  const applyValue = (nextValue: unknown) => {
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, nextValue));
    if (!isLatestStorageWrite(key, generation)) return sanitizedValue;
    setLocalCache(key, JSON.stringify(sanitizedValue));
    mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, sanitizedValue);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return sanitizedValue;
  };

  const applyConflictValue = (conflictValue: unknown) => {
    if (!isLatestStorageWrite(key, generation)) return;
    delete _pendingLocalWrites[key];
    clearStorageSyncRetry(key, generation);
    if (conflictValue === null || conflictValue === undefined) return;
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, conflictValue));
    setLocalCache(key, JSON.stringify(sanitizedValue));
    mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
    dispatchStorageUpdated(key);
  };

  let catalogChanged = false;
  let checkoutDeleted = false;
  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), `Firebase authentication for ${key}`);
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, toStoragePath(key)),
      (currentValue) => {
        const remoteValue = currentValue === null
          ? null
          : sanitizeForStorage(sanitizeSyncedValue(key, currentValue));
        const remotePayments = (remoteValue as { payments?: unknown[] } | null)?.payments;
        const remoteSnapshot = remoteValue as { deletedPaymentKeys?: unknown; deletedTicketIds?: unknown } | null;
        const paymentAlreadyCommitted = Boolean(
          ticketSequence?.paymentId &&
          Array.isArray(remotePayments) &&
          remotePayments.some((record) => getRecordId(record) === ticketSequence.paymentId),
        );
        if (paymentAlreadyCommitted) {
          candidateValue = remoteValue;
          setPendingLocalWrite(key, generation, candidateValue);
          return remoteValue;
        }
        const requestedPaymentWasDeleted = Boolean(
          ticketSequence?.paymentId &&
          getDeletedPaymentKeys(remoteSnapshot ?? {}).includes(`id:${ticketSequence.paymentId}`),
        );
        const requestedTicketWasDeleted = Boolean(
          ticketSequence?.ticketId &&
          getDeletedTicketIds(remoteSnapshot ?? {}).includes(ticketSequence.ticketId),
        );
        if (requestedPaymentWasDeleted || requestedTicketWasDeleted) {
          checkoutDeleted = true;
          return;
        }
        const expectedMenuItems = (baseCandidateValue as { menuItems?: unknown[] } | null)?.menuItems ?? [];
        const currentCatalogRevision = remoteValue === null
          ? expectedCatalogRevision
          : Number((remoteValue as { catalogRevision?: unknown })?.catalogRevision ?? 0);
        const currentMenuItems = remoteValue === null
          ? expectedMenuItems
          : (remoteValue as { menuItems?: unknown[] })?.menuItems ?? [];
        if (
          currentCatalogRevision !== expectedCatalogRevision ||
          !areSnapshotsEqual(currentMenuItems, expectedMenuItems)
        ) {
          catalogChanged = true;
          return;
        }
        const protectedValue = sanitizeForStorage(sanitizeSyncedValue(
          key,
          ticketSequence
            ? buildPosCheckoutDelta(baseCandidateValue, remoteValue, ticketSequence)
            : protectSyncedValueBeforeWrite(key, baseCandidateValue, remoteValue),
        ));
        candidateValue = ticketSequence
          ? sanitizeForStorage(sanitizeSyncedValue(
              key,
              allocatePosTicketSequence(protectedValue, remoteValue, ticketSequence),
            ))
          : protectedValue;
        setPendingLocalWrite(key, generation, candidateValue);
        return candidateValue;
      },
      { applyLocally: false },
    ), `Firebase checkout commit for ${key}`);

    if (!result.committed) {
      if (checkoutDeleted) {
        const deletedValue = result.snapshot.val();
        applyConflictValue(deletedValue);
        return { ok: false, reason: "checkout-deleted", value: deletedValue as T | null };
      }
      if (catalogChanged) {
        const conflictValue = result.snapshot.val();
        applyConflictValue(conflictValue);
        return { ok: false, reason: "catalog-changed", value: conflictValue as T | null };
      }
      throw new Error(`Firebase checkout transaction was not committed for ${key}`);
    }

    const committedValue = applyValue(result.snapshot.val()) as T;
    return { ok: true, value: committedValue };
  } catch (error) {
    if (checkoutDeleted) {
      const deletedValue = await fetchServerSyncedStorageValue<T>(key).catch(() => null);
      applyConflictValue(deletedValue);
      return { ok: false, reason: "checkout-deleted", value: deletedValue };
    }
    if (catalogChanged) {
      const conflictValue = await fetchServerSyncedStorageValue<T>(key).catch(() => null);
      applyConflictValue(conflictValue);
      return { ok: false, reason: "catalog-changed", value: conflictValue };
    }
    console.error(`Firebase atomic POS commit failed for ${key}`, error);
    try {
      const serverResult = await commitServerPosStateWithCatalogRevision(
        key,
        expectedCatalogRevision,
        baseCandidateValue,
        ticketSequence,
      );
      if (!serverResult.ok) {
        applyConflictValue(serverResult.value);
        return { ok: false, reason: serverResult.reason, value: serverResult.value as T | null };
      }
      const committedValue = applyValue(serverResult.value) as T;
      return { ok: true, value: committedValue };
    } catch (serverError) {
      if (isLatestStorageWrite(key, generation)) delete _pendingLocalWrites[key];
      emitConnectionState(false);
      console.error(`Server atomic POS commit failed for ${key}`, serverError);
      return { ok: false, reason: "sync-failed" };
    }
  }
}

/** Persist a storage mutation and resolve only after Firebase (or the atomic
 * server fallback) has accepted the transaction-current merged value. */
export async function commitSyncedStorageValueAndWait<T>(
  key: string,
  value: T,
  options?: SyncedStorageCommitOptions,
): Promise<T> {
  if (typeof window === "undefined") throw new Error("Synchronized storage is only available in the browser.");
  const generation = (_syncWriteGenerations[key] ?? 0) + 1;
  _syncWriteGenerations[key] = generation;
  let sanitizedValue: unknown = sanitizeForStorage(sanitizeSyncedValue(key, value));
  setPendingLocalWrite(key, generation, sanitizedValue);

  const applyCommittedValue = (committedValue: unknown) => {
    if (!isLatestStorageWrite(key, generation)) {
      throw new Error(`A newer ${key} write superseded this synchronization.`);
    }
    const nextValue = sanitizeForStorage(sanitizeSyncedValue(key, committedValue));
    setLocalCache(key, JSON.stringify(nextValue));
    mirrorCanonicalStateToLegacyLocal(key, nextValue);
    dispatchStorageUpdated(key);
    setPendingLocalWrite(key, generation, nextValue);
    clearStorageSyncRetry(key, generation);
    markSyncHealthy(key);
    return nextValue as T;
  };

  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), `Firebase authentication for ${key}`);
    const result = await withDirectSyncTimeout(runTransaction(
      ref(firebaseDatabase, toStoragePath(key)),
      (currentValue) => {
        if (!isLatestStorageWrite(key, generation)) return currentValue;
        const remoteValue = currentValue === null
          ? null
          : sanitizeForStorage(sanitizeSyncedValue(key, currentValue));
        if (
          options?.expectedStockItems &&
          (key === MAIN_STORE_STORAGE_KEY || key === INVENTORY_STORAGE_KEY)
        ) {
          const currentItems = Array.isArray(remoteValue) ? remoteValue : [];
          if (areSnapshotsEqual(currentItems, sanitizedValue)) return sanitizedValue;
          if (!areSnapshotsEqual(currentItems, options.expectedStockItems)) return;
          return sanitizedValue;
        }
        const protectedValue = options?.stockEffectIntent === "operational" &&
          (key === MAIN_STORE_STORAGE_KEY || key === INVENTORY_STORAGE_KEY)
          ? mergeStockEffectArrays(sanitizedValue, remoteValue, "operational")
          : protectSyncedValueBeforeWrite(key, sanitizedValue, remoteValue);
        sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, protectedValue));
        setPendingLocalWrite(key, generation, sanitizedValue);
        return sanitizedValue;
      },
      { applyLocally: false },
    ), `Firebase storage commit for ${key}`);
    if (!result.committed) throw new Error(`Firebase transaction was not committed for ${key}`);
    return applyCommittedValue(result.snapshot.val());
  } catch (directError) {
    if (!isLatestStorageWrite(key, generation)) throw directError;
    try {
      const committedValue = await writeServerSyncedStorageValue(key, sanitizedValue, options);
      return applyCommittedValue(committedValue);
    } catch (serverError) {
      if (isLatestStorageWrite(key, generation)) delete _pendingLocalWrites[key];
      emitConnectionState(false);
      throw serverError;
    }
  }
}

export function syncStorageValueToFirebase<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  const generation = (_syncWriteGenerations[key] ?? 0) + 1;
  _syncWriteGenerations[key] = generation;
  let sanitizedValue: unknown = sanitizeForStorage(value);
  setPendingLocalWrite(key, generation, sanitizedValue);
  void withDirectSyncTimeout(ensureFirebaseAuthReady(), `Firebase authentication for ${key}`)
    .then(async () => {
      const storageRef = ref(firebaseDatabase, toStoragePath(key));
      const result = await withDirectSyncTimeout(runTransaction(
        storageRef,
        (currentValue) => {
          // A slower request from this browser must never land after a newer
          // local edit. Firebase will rerun this callback after contention.
          if (!isLatestStorageWrite(key, generation)) return currentValue;
          const remoteValue = currentValue === null
            ? null
            : sanitizeForStorage(sanitizeSyncedValue(key, currentValue));
          if (isDangerouslySmallCashierWrite(key, sanitizedValue, remoteValue)) {
            console.warn(`Blocked unsafe cashier sync for ${key}: local snapshot is too small and remote could not be verified.`);
            return currentValue;
          }
          sanitizedValue = sanitizeForStorage(
            sanitizeSyncedValue(key, protectSyncedValueBeforeWrite(key, sanitizedValue, remoteValue)),
          );
          setPendingLocalWrite(key, generation, sanitizedValue);
          return sanitizedValue;
        },
        { applyLocally: false },
      ), `Firebase background sync for ${key}`);
      if (!result.committed) throw new Error(`Firebase transaction was not committed for ${key}`);
    })
    .then(() => {
      clearStorageSyncRetry(key, generation);
      markSyncHealthy(key);
    })
    .catch(async (error) => {
      console.error(`Firebase sync failed for ${key}`, error);
      try {
        if (!isLatestStorageWrite(key, generation)) return;
        const remoteValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue(key).catch(() => null)));
        if (isDangerouslySmallCashierWrite(key, sanitizedValue, remoteValue)) {
          console.warn(`Blocked unsafe server cashier sync for ${key}: local snapshot is too small and remote could not be verified.`);
          return;
        }
        sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, protectSyncedValueBeforeWrite(key, sanitizedValue, remoteValue)));
        setPendingLocalWrite(key, generation, sanitizedValue);
        const committedValue = sanitizeForStorage(
          sanitizeSyncedValue(key, await writeServerSyncedStorageValue(key, sanitizedValue)),
        );
        if (isLatestStorageWrite(key, generation)) {
          sanitizedValue = committedValue;
          setLocalCache(key, JSON.stringify(committedValue));
          mirrorCanonicalStateToLegacyLocal(key, committedValue);
          dispatchStorageUpdated(key);
          setPendingLocalWrite(key, generation, committedValue);
        }
        clearStorageSyncRetry(key, generation);
        markSyncHealthy(key);
      } catch (serverError) {
        emitConnectionState(false);
        console.error(`Server sync fallback failed for ${key}`, serverError);
        scheduleStorageSyncRetry(key, generation);
      }
    });
}

export type StorageHydrationResult<T = unknown> =
  | { ok: true; value: T | null; remoteExists: boolean }
  | { ok: false; value?: T | null; remoteExists: false };

export async function hydrateStorageKeyFromFirebase<T = unknown>(key: string): Promise<StorageHydrationResult<T>> {
  if (typeof window === "undefined") return { ok: false, remoteExists: false };

  // Ensure any pre-existing untagged cache is moved into the S_/P_ tagged keys
  // before we read/merge. Marker-guarded, so this is a no-op after the first run.
  migrateLocalCacheToStandard();

  const applyHydratedValue = (value: unknown) => {
    const sanitizedValue = sanitizeForStorage(sanitizeSyncedValue(key, value));
    if (sanitizedValue === null || sanitizedValue === undefined) return null;
    setLocalCache(key, JSON.stringify(sanitizedValue));
    mirrorCanonicalStateToLegacyLocal(key, sanitizedValue);
    dispatchStorageUpdated(key);
    return sanitizedValue;
  };

  try {
    await withDirectSyncTimeout(ensureFirebaseAuthReady(), `Firebase authentication for ${key}`);
    const storageRef = ref(firebaseDatabase, toStoragePath(key));
    const isPosState = key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state";

    if (isPosState) {
      const localValue = getLocalSyncedValue(key);
      const canonicalValue = sanitizeForStorage(getCanonicalDefaultValue(key));
      let remoteExists = false;
      const result = await withDirectSyncTimeout(runTransaction(
        storageRef,
        (currentValue) => {
          remoteExists = currentValue !== null && currentValue !== undefined;
          const remoteValue = remoteExists
            ? sanitizeForStorage(sanitizeSyncedValue(key, currentValue))
            : null;
          let preferredValue: unknown;

          if (remoteValue !== null) {
            preferredValue = hasUsableSyncedValue(key, localValue)
              ? mergeRemoteValueWithLocalOnlyRecords(key, localValue, remoteValue)
              : remoteValue;
          } else if (hasUsableSyncedValue(key, localValue)) {
            preferredValue = localValue;
          } else {
            preferredValue = canonicalValue;
          }

          if (preferredValue === null || preferredValue === undefined) return currentValue;
          return sanitizeForStorage(
            sanitizeSyncedValue(key, protectSyncedValueBeforeWrite(key, preferredValue, remoteValue)),
          );
        },
        { applyLocally: false },
      ), `Firebase hydration for ${key}`);

      if (!result.committed) throw new Error(`Firebase hydrate transaction was not committed for ${key}`);
      const committedValue = result.snapshot.exists()
        ? sanitizeForStorage(sanitizeSyncedValue(key, result.snapshot.val()))
        : null;
      const sanitizedCommittedValue = committedValue === null ? null : applyHydratedValue(committedValue);
      markSyncHealthy(key);
      return { ok: true, value: sanitizedCommittedValue as T | null, remoteExists };
    }

    const localValue = getLocalSyncedValue(key);
    const canonicalValue = sanitizeForStorage(getCanonicalDefaultValue(key));
    let remoteExists = false;
    const result = await withDirectSyncTimeout(runTransaction(
      storageRef,
      (currentValue) => {
        remoteExists = currentValue !== null && currentValue !== undefined;
        if (remoteExists) {
          // An existing shared node, including an intentionally empty array,
          // is authoritative during hydration. Returning the transaction-
          // current value closes the old GET -> SET erasure race.
          return currentValue;
        }
        const initialValue = hasUsableSyncedValue(key, localValue)
          ? localValue
          : canonicalValue;
        return initialValue === undefined ? currentValue : initialValue;
      },
      { applyLocally: false },
    ), `Firebase hydration transaction for ${key}`);
    if (!result.committed) throw new Error(`Firebase hydrate transaction was not committed for ${key}`);
    const committedValue = result.snapshot.exists()
      ? sanitizeForStorage(sanitizeSyncedValue(key, result.snapshot.val()))
      : null;
    const sanitizedPreferredValue = committedValue === null ? null : applyHydratedValue(committedValue);
    markSyncHealthy(key);
    return { ok: true, value: sanitizedPreferredValue as T | null, remoteExists };
  } catch (error) {
    console.error(`Firebase direct hydrate failed for ${key}`, error);
    try {
      const serverValue = sanitizeForStorage(sanitizeSyncedValue(key, await fetchServerSyncedStorageValue(key)));
      const isPosState = key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state";
      if (isPosState) {
        const localValue = getLocalSyncedValue(key);
        const canonicalValue = sanitizeForStorage(getCanonicalDefaultValue(key));
        const preferredValue = serverValue !== null
          ? (hasUsableSyncedValue(key, localValue)
              ? mergeRemoteValueWithLocalOnlyRecords(key, localValue, serverValue)
              : serverValue)
          : (hasUsableSyncedValue(key, localValue) ? localValue : canonicalValue);
        const committedValue = preferredValue === null
          ? null
          : sanitizeForStorage(
              sanitizeSyncedValue(
                key,
                await writeServerSyncedStorageValue(
                  key,
                  preferredValue,
                  serverValue === null ? { initializeIfMissing: true } : undefined,
                ),
              ),
            );
        const sanitizedServerValue = committedValue === null ? null : applyHydratedValue(committedValue);
        markSyncHealthy(key);
        return { ok: true, value: sanitizedServerValue as T | null, remoteExists: serverValue !== null };
      }

      if (serverValue !== null) {
        const sanitizedServerValue = applyHydratedValue(serverValue);
        markSyncHealthy(key);
        return { ok: true, value: sanitizedServerValue as T | null, remoteExists: true };
      }
      const localValue = getLocalSyncedValue(key);
      const canonicalValue = sanitizeForStorage(getCanonicalDefaultValue(key));
      const initialValue = hasUsableSyncedValue(key, localValue) ? localValue : canonicalValue;
      const committedValue = initialValue === null || initialValue === undefined
        ? null
        : sanitizeForStorage(sanitizeSyncedValue(
            key,
            await writeServerSyncedStorageValue(
              key,
              initialValue,
              { initializeIfMissing: true },
            ),
          ));
      const sanitizedServerValue = committedValue === null ? null : applyHydratedValue(committedValue);
      markSyncHealthy(key);
      return { ok: true, value: sanitizedServerValue as T | null, remoteExists: false };
    } catch (serverError) {
      emitConnectionState(false);
      console.error(`Server hydrate fallback failed for ${key}`, serverError);
      return { ok: false, remoteExists: false };
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
    if (event.key === key || event.key === getStandardScopedLocalKey(key)) emitLocalValue();
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
      markSyncHealthy(key);
    } catch {
      // Keep the fallback poll alive; the next successful request or Firebase reconnect will recover state.
    }
  };

  const ensureFallbackPolling = () => {
    if (pollTimer !== null || isDisposed) return;
    void pollServerSnapshot();
    const pollInterval = key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state"
      ? POS_FALLBACK_POLL_INTERVAL_MS
      : FALLBACK_POLL_INTERVAL_MS;
    pollTimer = window.setInterval(() => {
      void pollServerSnapshot();
    }, pollInterval);
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
              void runTransaction(
                ref(firebaseDatabase, toStoragePath(key)),
                (currentValue) => currentValue ?? fallbackValue,
                { applyLocally: false },
              ).catch(() => undefined);
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

// Runs `action` at most once across all devices by recording a completion marker
// in the Standard backend node plus a localStorage fast path. Existing browser guards
// used, so devices that already ran the action skip it). A purge guarded only
// by localStorage re-runs on every new browser and deletes data recorded since
// the last run — the backend marker prevents that.
export async function runOnceAcrossDevices(markerKey: string, action: () => Promise<void>) {
  if (typeof window === "undefined") return;
  const localMarker = `${markerKey}-standard`;
  if (window.localStorage.getItem(localMarker) === "1") return;

  try {
    const response = await fetch(`/api/storage-sync/${encodeURIComponent(markerKey)}`);
    // If the backend marker cannot be verified, do nothing — never run a
    // destructive action blindly. The next load retries.
    if (!response.ok) return;
    const payload = (await response.json()) as { value?: unknown };
    if (payload.value) {
      window.localStorage.setItem(localMarker, "1");
      return;
    }
    await action();
    await writeServerSyncedStorageValue(markerKey, { done: true, at: Date.now() });
    window.localStorage.setItem(localMarker, "1");
  } catch {
    // Leave markers unset so a later load can retry.
  }
}

// Awaitable purge of selected keys from the local cache and Standard database.
export async function purgeSyncedKeys(keys: string[]) {
  if (typeof window === "undefined") return;

  keys.forEach((key) => {
    removeLocalCache(key);
    dispatchStorageUpdated(key);
  });

  try {
    await ensureFirebaseAuthReady();
    await Promise.all(
      keys.map((key) => remove(ref(firebaseDatabase, toStoragePath(key))).catch(() => null)),
    );
  } catch {
    await Promise.all(keys.map((key) => removeServerSyncedStorageValue(key).catch(() => null)));
  }

  // Best-effort: also clear the REST mirror so a stale server snapshot can't be
  // re-hydrated after the Firebase node is emptied.
  await Promise.all(keys.map((key) => removeServerSyncedStorageValue(key).catch(() => null)));
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
