import { removeStorageValueFromFirebase, syncStorageValueToFirebase } from "@/app/lib/firebase-sync";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";
import { getLocalMawioTier } from "./login-profiles";

export const STORAGE_CASHIER_STATE = "orange-hotel-cashier-state";
export const STORAGE_KITCHEN_STATE = "orange-hotel-kitchen-state";
export const STORAGE_BARISTA_STATE = "orange-hotel-barista-state";

export function getScopedStorageKey(baseKey: string, scope?: "standard" | "platinum"): string {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  return activeScope === "platinum" ? `${baseKey}-platinum` : baseKey;
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
  const raw = localStorage.getItem(key);
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
  localStorage.setItem(key, JSON.stringify(sanitizedValue));
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
  syncStorageValueToFirebase(key, sanitizedValue);
}

export function removeJson(key: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key);
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key } }));
  removeStorageValueFromFirebase(key);
}

export function readCashierState<TTransaction>(
  legacyTransactionsKey: string,
  legacySeqKey: string,
  defaultSeq: number,
): CashierState<TTransaction> {
  const snapshot = readJson<CashierState<TTransaction>>(STORAGE_CASHIER_STATE);
  if (snapshot) {
    return {
      transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions : [],
      receiptSeq: Number.isFinite(snapshot.receiptSeq) ? snapshot.receiptSeq : defaultSeq,
    };
  }

  const transactions = readJson<TTransaction[]>(legacyTransactionsKey) ?? [];
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(legacySeqKey);
  const parsedSeq = Number(legacySeqRaw);

  return {
    transactions: Array.isArray(transactions) ? transactions : [],
    receiptSeq: Number.isFinite(parsedSeq) && parsedSeq > 0 ? parsedSeq : defaultSeq,
  };
}

export function writeCashierState<TTransaction>(transactions: TTransaction[], receiptSeq: number) {
  writeJson(STORAGE_CASHIER_STATE, { transactions, receiptSeq });
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
  const legacySeqRaw = typeof window === "undefined" ? null : localStorage.getItem(legacySeqKey);
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
