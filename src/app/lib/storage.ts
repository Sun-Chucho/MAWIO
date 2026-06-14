import { getTierScopedLocalKey, removeStorageValueFromFirebase, syncStorageValueToFirebase } from "@/app/lib/firebase-sync";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

export const STORAGE_CASHIER_STATE = "orange-hotel-cashier-state";
export const STORAGE_KITCHEN_STATE = "orange-hotel-kitchen-state";
export const STORAGE_BARISTA_STATE = "orange-hotel-barista-state";

// Tier separation (standard vs premium/platinum) is now handled centrally inside
// the storage layer: every read/write of a synced business key is transparently
// namespaced per hotel by `getTierScopedLocalKey`. Callers therefore always use
// the bare/base key — these helpers exist for backwards compatibility and simply
// return the base key.
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
}

export function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(getTierScopedLocalKey(key));
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
  // Local cache is namespaced per hotel tier; the base key is used for the
  // change event and backend sync (which adds its own tier prefix to the path).
  localStorage.setItem(getTierScopedLocalKey(key), JSON.stringify(sanitizedValue));
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
  syncStorageValueToFirebase(key, sanitizedValue);
}

export function removeJson(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getTierScopedLocalKey(key));
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
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(getTierScopedLocalKey(legacySeqKey));
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
    return {
      tickets: Array.isArray(snapshot.tickets) ? snapshot.tickets : [],
      ticketSeq: Number.isFinite(snapshot.ticketSeq) ? snapshot.ticketSeq : defaultSeq,
      payments: Array.isArray(snapshot.payments) ? snapshot.payments : [],
      menuItems: Array.isArray(snapshot.menuItems) ? snapshot.menuItems : [],
    };
  }

  const tickets = readJson<TTicket[]>(legacyTicketsKey) ?? [];
  const payments = readJson<TPayment[]>(legacyPaymentsKey) ?? [];
  const menuItems = readJson<TMenu[]>(legacyMenuKey) ?? [];
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(getTierScopedLocalKey(legacySeqKey));
  const parsedSeq = Number(legacySeqRaw);

  return {
    tickets: Array.isArray(tickets) ? tickets : [],
    ticketSeq: Number.isFinite(parsedSeq) && parsedSeq > 0 ? parsedSeq : defaultSeq,
    payments: Array.isArray(payments) ? payments : [],
    menuItems: Array.isArray(menuItems) ? menuItems : [],
  };
}

export function writePosState<TTicket, TPayment, TMenu>(
  storageKey: string,
  tickets: TTicket[],
  ticketSeq: number,
  payments: TPayment[],
  menuItems: TMenu[],
) {
  writeJson(storageKey, { tickets, ticketSeq, payments, menuItems });
}
