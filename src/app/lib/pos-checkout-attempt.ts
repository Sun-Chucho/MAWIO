"use client";

type CheckoutFingerprintInput = {
  mode: string;
  destination: string;
  total: number;
  lines: Array<{
    itemId?: string;
    name: string;
    qty: number;
    unitPrice?: number;
    lineTotal?: number;
  }>;
  historicalCreatedAt?: number;
};

type StoredCheckoutAttempt = {
  checkoutId: string;
  fingerprint: string;
  createdAt: number;
};

let stockEffectQueue: Promise<void> = Promise.resolve();

export function buildCheckoutFingerprint(input: CheckoutFingerprintInput) {
  const canonicalLines = input.lines
    .map((line) => ({
      itemId: line.itemId ?? "",
      name: line.name.trim(),
      qty: line.qty,
      unitPrice: line.unitPrice ?? null,
      lineTotal: line.lineTotal ?? null,
    }))
    .sort((left, right) =>
      `${left.itemId}|${left.name}`.localeCompare(`${right.itemId}|${right.name}`));
  return JSON.stringify({
    mode: input.mode,
    destination: input.destination.trim(),
    total: input.total,
    historicalCreatedAt: input.historicalCreatedAt ?? null,
    lines: canonicalLines,
  });
}

function readStoredAttempts(storageKey: string): StoredCheckoutAttempt[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as
      | Array<Partial<StoredCheckoutAttempt>>
      | Partial<StoredCheckoutAttempt>
      | null;
    const candidates = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return candidates
      .filter((attempt): attempt is StoredCheckoutAttempt =>
        typeof attempt.checkoutId === "string" &&
        typeof attempt.fingerprint === "string" &&
        typeof attempt.createdAt === "number")
      .sort((left, right) => right.createdAt - left.createdAt);
  } catch {
    return [];
  }
}

export function getPendingCheckoutAttempts(storageKey: string) {
  return readStoredAttempts(storageKey);
}

export function resolveCheckoutId(
  storageKey: string,
  fingerprint: string,
  createId: () => string,
  currentAttempt?: Pick<StoredCheckoutAttempt, "checkoutId" | "fingerprint"> | null,
) {
  if (currentAttempt?.fingerprint === fingerprint) return currentAttempt.checkoutId;
  const storedAttempt = readStoredAttempts(storageKey).find((attempt) => attempt.fingerprint === fingerprint);
  return storedAttempt ? storedAttempt.checkoutId : createId();
}

export function persistCheckoutAttempt(
  storageKey: string,
  attempt: Pick<StoredCheckoutAttempt, "checkoutId" | "fingerprint">,
) {
  if (typeof window === "undefined") return;
  const attempts = readStoredAttempts(storageKey).filter((entry) => entry.checkoutId !== attempt.checkoutId);
  window.localStorage.setItem(
    storageKey,
    JSON.stringify([{ ...attempt, createdAt: Date.now() }, ...attempts]),
  );
}

export function clearCheckoutAttempt(storageKey: string, checkoutId: string) {
  if (typeof window === "undefined") return;
  const remaining = readStoredAttempts(storageKey).filter((attempt) => attempt.checkoutId !== checkoutId);
  if (remaining.length > 0) {
    window.localStorage.setItem(storageKey, JSON.stringify(remaining));
  } else {
    window.localStorage.removeItem(storageKey);
  }
}

/**
 * Serialize Barista stock effects across same-origin tabs. The durable per-item
 * markers remain the idempotency authority; this lock closes the read/write
 * race when two tabs recover the same checkout at once.
 */
export async function withBaristaStockEffectLock<T>(operation: () => Promise<T> | T): Promise<T> {
  if (typeof navigator !== "undefined") {
    const lockManager = (navigator as Navigator & {
      locks?: { request: <TResult>(name: string, callback: () => Promise<TResult> | TResult) => Promise<TResult> };
    }).locks;
    if (lockManager) {
      return lockManager.request("orange-hotel-barista-stock-effects", operation);
    }
  }

  const result = stockEffectQueue.then(operation, operation);
  stockEffectQueue = result.then(() => undefined, () => undefined);
  return result;
}
