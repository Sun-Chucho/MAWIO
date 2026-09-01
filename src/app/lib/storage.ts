import { getPosPaymentSyncKey, getStandardScopedLocalKey, removeStorageValueFromFirebase, syncStorageValueToFirebase } from "@/app/lib/firebase-sync";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

export const STORAGE_CASHIER_STATE = "orange-hotel-cashier-state";
export const STORAGE_KITCHEN_STATE = "orange-hotel-kitchen-state";
export const STORAGE_BARISTA_STATE = "orange-hotel-barista-state";

// All reads and writes use the single MAWIO Standard cache and database node.
export function getScopedStorageKey(baseKey: string): string {
  return baseKey;
}

export function getActiveCashierStateKey(): string {
  return STORAGE_CASHIER_STATE;
}

export function getActiveBaristaStateKey(): string {
  return STORAGE_BARISTA_STATE;
}

export function getActiveKitchenStateKey(): string {
  return STORAGE_KITCHEN_STATE;
}

interface CashierState<TTransaction> {
  transactions: TTransaction[];
  receiptSeq: number;
}

interface PosState<TTicket, TPayment, TMenu> {
  tickets: TTicket[];
  ticketSeq: number;
  payments: TPayment[];
  menuItems: TMenu[];
  catalogRevision?: number;
  queueResetAt?: number;
  deletedPaymentKeys?: string[];
  deletedTicketIds?: string[];
  appliedCatalogStockMutationIds?: string[];
  catalogStockMutationFingerprints?: Record<string, string>;
}

function getPosTicketId(ticket: unknown) {
  if (typeof ticket !== "object" || ticket === null) return "";
  const id = (ticket as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function getPosCatalogRevision(value: unknown) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function getPosQueueResetAt(value: unknown) {
  const resetAt = Number(value);
  return Number.isFinite(resetAt) && resetAt >= 0 ? resetAt : 0;
}

export function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(getStandardScopedLocalKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  const sanitizedValue = sanitizeForStorage(value);
  const scopedKey = getStandardScopedLocalKey(key);
  const serializedValue = JSON.stringify(sanitizedValue);
  if (localStorage.getItem(scopedKey) === serializedValue) {
    // A prior direct + fallback attempt may have failed. Re-sending an
    // explicit identical write makes the operation retryable.
    syncStorageValueToFirebase(key, sanitizedValue);
    return;
  }
  // Write only to the active Standard cache namespace.
  localStorage.setItem(scopedKey, serializedValue);
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
  syncStorageValueToFirebase(key, sanitizedValue);
}

export function removeJson(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getStandardScopedLocalKey(key));
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
  removeStorageValueFromFirebase(key);
}

export function readCashierState<TTransaction>(
  legacyTransactionsKey: string,
  legacySeqKey: string,
  defaultSeq: number,
): CashierState<TTransaction> {
  const activeKey = getActiveCashierStateKey();
  const snapshot = readJson<CashierState<TTransaction>>(activeKey);
  if (snapshot) {
    return {
      transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions : [],
      receiptSeq: Number.isFinite(snapshot.receiptSeq) ? snapshot.receiptSeq : defaultSeq,
    };
  }

  const transactions = readJson<TTransaction[]>(legacyTransactionsKey) ?? [];
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(getStandardScopedLocalKey(legacySeqKey));
  const parsedSeq = Number(legacySeqRaw);

  return {
    transactions: Array.isArray(transactions) ? transactions : [],
    receiptSeq: Number.isFinite(parsedSeq) && parsedSeq > 0 ? parsedSeq : defaultSeq,
  };
}

export function writeCashierState<TTransaction>(transactions: TTransaction[], receiptSeq: number) {
  writeJson(getActiveCashierStateKey(), { transactions, receiptSeq });
}

export function readPosState<TTicket, TPayment, TMenu>(
  storageKey: string,
  legacyTicketsKey: string,
  legacySeqKey: string,
  legacyPaymentsKey: string,
  legacyMenuKey: string,
  defaultSeq: number,
): PosState<TTicket, TPayment, TMenu> {
  const snapshot = readJson<PosState<TTicket, TPayment, TMenu>>(storageKey);
  if (snapshot) {
    const deletedPaymentKeys = Array.isArray(snapshot.deletedPaymentKeys) ? snapshot.deletedPaymentKeys : [];
    const deletedPaymentKeySet = new Set(deletedPaymentKeys);
    const deletedTicketIds = Array.isArray(snapshot.deletedTicketIds) ? snapshot.deletedTicketIds : [];
    const deletedTicketIdSet = new Set(deletedTicketIds);
    const appliedCatalogStockMutationIds = Array.isArray(snapshot.appliedCatalogStockMutationIds)
      ? snapshot.appliedCatalogStockMutationIds
      : [];
    const catalogStockMutationFingerprints = snapshot.catalogStockMutationFingerprints ?? {};
    return {
      tickets: Array.isArray(snapshot.tickets)
        ? snapshot.tickets.filter((ticket) => !deletedTicketIdSet.has(getPosTicketId(ticket)))
        : [],
      ticketSeq: Number.isFinite(snapshot.ticketSeq) ? snapshot.ticketSeq : defaultSeq,
      payments: Array.isArray(snapshot.payments)
        ? snapshot.payments.filter((payment) => !deletedPaymentKeySet.has(getPosPaymentSyncKey(payment)))
        : [],
      menuItems: Array.isArray(snapshot.menuItems) ? snapshot.menuItems : [],
      catalogRevision: getPosCatalogRevision(snapshot.catalogRevision),
      queueResetAt: getPosQueueResetAt(snapshot.queueResetAt),
      deletedPaymentKeys,
      deletedTicketIds,
      appliedCatalogStockMutationIds,
      catalogStockMutationFingerprints,
    };
  }

  const tickets = readJson<TTicket[]>(legacyTicketsKey) ?? [];
  const payments = readJson<TPayment[]>(legacyPaymentsKey) ?? [];
  const menuItems = readJson<TMenu[]>(legacyMenuKey) ?? [];
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(getStandardScopedLocalKey(legacySeqKey));
  const parsedSeq = Number(legacySeqRaw);

  return {
    tickets: Array.isArray(tickets) ? tickets : [],
    ticketSeq: Number.isFinite(parsedSeq) && parsedSeq > 0 ? parsedSeq : defaultSeq,
    payments: Array.isArray(payments) ? payments : [],
    menuItems: Array.isArray(menuItems) ? menuItems : [],
    catalogRevision: 0,
    queueResetAt: 0,
    deletedPaymentKeys: [],
    deletedTicketIds: [],
    appliedCatalogStockMutationIds: [],
    catalogStockMutationFingerprints: {},
  };
}

export function writePosState<TTicket, TPayment, TMenu>(
  storageKey: string,
  tickets: TTicket[],
  ticketSeq: number,
  payments: TPayment[],
  menuItems: TMenu[],
  deletedPaymentKeys?: string[],
  deletedTicketIds?: string[],
) {
  const existing = readJson<Partial<PosState<TTicket, TPayment, TMenu>>>(storageKey);
  const resolvedDeletedPaymentKeys = deletedPaymentKeys ?? existing?.deletedPaymentKeys ?? [];
  const deletedPaymentKeySet = new Set(resolvedDeletedPaymentKeys);
  const resolvedDeletedTicketIds = deletedTicketIds ?? existing?.deletedTicketIds ?? [];
  const deletedTicketIdSet = new Set(resolvedDeletedTicketIds);
  const appliedCatalogStockMutationIds = existing?.appliedCatalogStockMutationIds ?? [];
  const catalogStockMutationFingerprints = existing?.catalogStockMutationFingerprints ?? {};
  // Ticket/payment writes must not put a stale React menu back into the shared
  // snapshot. Intentional catalog changes use writePosCatalogState below.
  const resolvedMenuItems = Array.isArray(existing?.menuItems) ? existing.menuItems : menuItems;
  writeJson(storageKey, {
    tickets: tickets.filter((ticket) => !deletedTicketIdSet.has(getPosTicketId(ticket))),
    ticketSeq,
    payments: payments.filter((payment) => !deletedPaymentKeySet.has(getPosPaymentSyncKey(payment))),
    menuItems: resolvedMenuItems,
    catalogRevision: getPosCatalogRevision(existing?.catalogRevision),
    queueResetAt: getPosQueueResetAt(existing?.queueResetAt),
    ...(resolvedDeletedPaymentKeys.length ? { deletedPaymentKeys: resolvedDeletedPaymentKeys } : {}),
    ...(resolvedDeletedTicketIds.length ? { deletedTicketIds: resolvedDeletedTicketIds } : {}),
    ...(appliedCatalogStockMutationIds.length ? { appliedCatalogStockMutationIds } : {}),
    ...(Object.keys(catalogStockMutationFingerprints).length ? { catalogStockMutationFingerprints } : {}),
  });
}

/**
 * Persist an intentional POS menu mutation without replacing newer queue or
 * payment data from another view. The monotonic revision makes this catalog
 * authoritative over stale operational writes on other devices.
 */
export function writePosCatalogState<TTicket, TPayment, TMenu>(
  storageKey: string,
  fallbackTickets: TTicket[],
  fallbackTicketSeq: number,
  fallbackPayments: TPayment[],
  menuItems: TMenu[],
  fallbackDeletedPaymentKeys?: string[],
) {
  const existing = readJson<Partial<PosState<TTicket, TPayment, TMenu>>>(storageKey);
  const tickets = Array.isArray(existing?.tickets) ? existing.tickets : fallbackTickets;
  const payments = Array.isArray(existing?.payments) ? existing.payments : fallbackPayments;
  const ticketSeq = Math.max(
    Number.isFinite(existing?.ticketSeq) ? Number(existing?.ticketSeq) : 0,
    Number.isFinite(fallbackTicketSeq) ? fallbackTicketSeq : 0,
  );
  const deletedPaymentKeys = existing?.deletedPaymentKeys ?? fallbackDeletedPaymentKeys ?? [];
  const deletedPaymentKeySet = new Set(deletedPaymentKeys);
  const deletedTicketIds = existing?.deletedTicketIds ?? [];
  const deletedTicketIdSet = new Set(deletedTicketIds);
  const appliedCatalogStockMutationIds = existing?.appliedCatalogStockMutationIds ?? [];
  const catalogStockMutationFingerprints = existing?.catalogStockMutationFingerprints ?? {};
  const currentRevision = getPosCatalogRevision(existing?.catalogRevision);

  writeJson(storageKey, {
    tickets: tickets.filter((ticket) => !deletedTicketIdSet.has(getPosTicketId(ticket))),
    ticketSeq,
    payments: payments.filter((payment) => !deletedPaymentKeySet.has(getPosPaymentSyncKey(payment))),
    menuItems,
    catalogRevision: Math.max(Date.now(), currentRevision + 1),
    queueResetAt: getPosQueueResetAt(existing?.queueResetAt),
    ...(deletedPaymentKeys.length ? { deletedPaymentKeys } : {}),
    ...(deletedTicketIds.length ? { deletedTicketIds } : {}),
    ...(appliedCatalogStockMutationIds.length ? { appliedCatalogStockMutationIds } : {}),
    ...(Object.keys(catalogStockMutationFingerprints).length ? { catalogStockMutationFingerprints } : {}),
  });
}
