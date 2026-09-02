import { mergeStockEffectArrays } from "@/app/lib/stock-effects";

export const BARISTA_POS_STORAGE_KEY = "orange-hotel-barista-state";
export const MAIN_STORE_STORAGE_KEY = "orange-hotel-main-store-items";
export const INVENTORY_STORAGE_KEY = "orange-hotel-inventory-items";
export const BARISTA_WASTE_STORAGE_KEY = "orange-hotel-barista-waste";
export const STORE_USAGE_STORAGE_KEY = "orange-hotel-store-usage";
export const STOCK_BATCH_MUTATIONS_STORAGE_KEY = "orange-hotel-stock-batch-mutations";
export const MANAGER_HISTORY_STORAGE_KEYS = [
  "orange-hotel-kitchen-purchase-history",
  "orange-hotel-kitchen-daily-stock-history",
  "orange-hotel-barista-purchase-history",
  "orange-hotel-barista-daily-stock-history",
] as const;
export type ManagerHistoryStorageKey = (typeof MANAGER_HISTORY_STORAGE_KEYS)[number];
export type AtomicManagerHistoryAppendRecord = {
  key: ManagerHistoryStorageKey;
  record: Record<string, unknown>;
};

export type AtomicBaristaStockEffectRequirement = {
  id: string;
  target: "store" | "inventory";
  itemId: string;
  allowPending?: boolean;
};

export type AtomicBaristaCheckoutRequest = {
  expectedCatalogRevision: number;
  expectedMenuItems: unknown[];
  posValue: Record<string, unknown>;
  ticketSequence: {
    prefix: string;
    ticketId?: string;
    paymentId: string;
  };
  storeItems: unknown[];
  inventoryItems: unknown[];
  requiredStockEffects: AtomicBaristaStockEffectRequirement[];
};

export type AtomicBaristaCheckoutFailureReason =
  | "catalog-changed"
  | "checkout-deleted"
  | "stock-conflict"
  | "invalid-request";

export type AtomicBaristaCheckoutMutation =
  | {
      ok: true;
      value: Record<string, unknown>;
      posValue: Record<string, unknown>;
      storeItems: unknown[];
      inventoryItems: unknown[];
    }
  | {
      ok: false;
      reason: AtomicBaristaCheckoutFailureReason;
      value: Record<string, unknown>;
      posValue: Record<string, unknown> | null;
      storeItems: unknown[];
      inventoryItems: unknown[];
    };

export type AtomicBaristaCatalogStockRequest = {
  mutationId: string;
  expectedCatalogRevision: number;
  expectedMenuItems: unknown[];
  nextMenuItems: unknown[];
  posBaseValue: Record<string, unknown>;
  expectedStoreItems: unknown[];
  nextStoreItems: unknown[];
  expectedInventoryItems: unknown[];
  nextInventoryItems: unknown[];
  appendRecords?: AtomicManagerHistoryAppendRecord[];
};

export type AtomicBaristaCatalogStockMutation =
  | {
      ok: true;
      value: Record<string, unknown>;
      posValue: Record<string, unknown>;
      storeItems: unknown[];
      inventoryItems: unknown[];
      appendedValues: Record<string, unknown[]>;
    }
  | {
      ok: false;
      reason: "catalog-changed" | "stock-changed" | "invalid-request";
      value: Record<string, unknown>;
      posValue: Record<string, unknown> | null;
      storeItems: unknown[];
      inventoryItems: unknown[];
      appendedValues: Record<string, unknown[]>;
    };

export type AtomicBaristaVoidRequest = {
  posBaseValue: Record<string, unknown>;
  cancellableTicketIds: string[];
  deletedPaymentKeys: string[];
  deletedTicketIds: string[];
  storeItems: unknown[];
  inventoryItems: unknown[];
  requiredStockEffects: AtomicBaristaStockEffectRequirement[];
};

export type AtomicBaristaVoidMutation =
  | {
      ok: true;
      value: Record<string, unknown>;
      posValue: Record<string, unknown>;
      storeItems: unknown[];
      inventoryItems: unknown[];
    }
  | {
      ok: false;
      reason: "stock-conflict" | "ticket-not-cancellable" | "invalid-request";
      value: Record<string, unknown>;
      posValue: Record<string, unknown> | null;
      storeItems: unknown[];
      inventoryItems: unknown[];
    };

export type AtomicBaristaStockMutationRequest = {
  storeItems: unknown[];
  inventoryItems: unknown[];
  requiredStockEffects: AtomicBaristaStockEffectRequirement[];
  appendRecords: Array<{
    key: typeof BARISTA_WASTE_STORAGE_KEY | typeof STORE_USAGE_STORAGE_KEY | ManagerHistoryStorageKey;
    record: Record<string, unknown>;
  }>;
  managerMutation?: {
    id: string;
    expectedStoreItems: unknown[];
    expectedInventoryItems: unknown[];
  };
  managerPurchase?: {
    id: string;
  };
  usageCapacityRequirements?: Array<{
    movementId: string;
    destination: string;
    maxQuantity: number;
  }>;
};

export type AtomicBaristaStockMutation =
  | {
      ok: true;
      value: Record<string, unknown>;
      storeItems: unknown[];
      inventoryItems: unknown[];
      appendedValues: Record<string, unknown[]>;
    }
  | {
      ok: false;
      reason: "stock-conflict" | "usage-capacity-exceeded" | "invalid-request";
      value: Record<string, unknown>;
      storeItems: unknown[];
      inventoryItems: unknown[];
      appendedValues: Record<string, unknown[]>;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getRecordId(record: unknown) {
  const value = asRecord(record);
  const id = value?.id;
  return typeof id === "string" && id.trim() ? id : "";
}

function getPaymentSyncKey(record: unknown) {
  const value = asRecord(record);
  if (!value) return "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  return id
    ? `id:${id}`
    : `legacy:${String(value.code ?? "")}|${String(value.createdAt ?? "")}|${String(value.total ?? "")}|${String(value.destination ?? "")}`;
}

function getStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function snapshotsMatch(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createMutationFingerprint(value: unknown) {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${serialized.length}:${(hash >>> 0).toString(36)}`;
}

function getMutationFingerprintMap(value: unknown) {
  if (Array.isArray(value)) {
    return Object.fromEntries(getStringArray(value).map((id) => [id, ""]));
  }
  const record = asRecord(value);
  if (!record) return {} as Record<string, string>;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] =>
      Boolean(entry[0]) && typeof entry[1] === "string"),
  );
}

function appendMutationFingerprint(
  fingerprints: Record<string, string>,
  id: string,
  fingerprint: string,
) {
  return Object.fromEntries([
    ...Object.entries(fingerprints).filter(([existingId]) => existingId !== id),
    [id, fingerprint] as [string, string],
  ].slice(-200));
}

function isManagerHistoryStorageKey(value: unknown): value is ManagerHistoryStorageKey {
  return typeof value === "string" && (MANAGER_HISTORY_STORAGE_KEYS as readonly string[]).includes(value);
}

function getCurrentAppendedValues(
  currentRoot: Record<string, unknown>,
  appendRecords: Array<{ key: string }> | undefined,
) {
  const values: Record<string, unknown[]> = {};
  (appendRecords ?? []).forEach(({ key }) => {
    if (!key || values[key]) return;
    values[key] = Array.isArray(currentRoot[key]) ? currentRoot[key] as unknown[] : [];
  });
  return values;
}

function appendRecordsById(
  currentValues: Record<string, unknown[]>,
  appendRecords: Array<{ key: string; record: Record<string, unknown> }>,
) {
  const nextValues = { ...currentValues };
  appendRecords.forEach(({ key, record }) => {
    const currentRecords = nextValues[key] ?? [];
    const recordId = getRecordId(record);
    nextValues[key] = currentRecords.some((entry) => getRecordId(entry) === recordId)
      ? currentRecords
      : [record, ...currentRecords];
  });
  return nextValues;
}

function buildCheckoutDelta(
  incomingValue: Record<string, unknown>,
  currentValue: Record<string, unknown> | null,
  request: AtomicBaristaCheckoutRequest["ticketSequence"],
) {
  const incomingTickets = Array.isArray(incomingValue.tickets) ? incomingValue.tickets : [];
  const incomingPayments = Array.isArray(incomingValue.payments) ? incomingValue.payments : [];
  const newTicket = request.ticketId
    ? incomingTickets.find((record) => getRecordId(record) === request.ticketId)
    : undefined;
  const newPayment = incomingPayments.find((record) => getRecordId(record) === request.paymentId);
  if (!newPayment || (request.ticketId && !newTicket)) return null;

  const currentTickets = currentValue && Array.isArray(currentValue.tickets)
    ? currentValue.tickets
    : incomingTickets;
  const currentPayments = currentValue && Array.isArray(currentValue.payments)
    ? currentValue.payments
    : incomingPayments;
  const deletedPaymentKeys = Array.from(new Set([
    ...getStringArray(currentValue?.deletedPaymentKeys),
    ...getStringArray(incomingValue.deletedPaymentKeys),
  ]));
  const deletedTicketIds = Array.from(new Set([
    ...getStringArray(currentValue?.deletedTicketIds),
    ...getStringArray(incomingValue.deletedTicketIds),
  ]));
  const deletedPayments = new Set(deletedPaymentKeys);
  const deletedTickets = new Set(deletedTicketIds);
  const tickets = request.ticketId && !currentTickets.some((record) => getRecordId(record) === request.ticketId)
    ? [newTicket, ...currentTickets]
    : currentTickets;
  const payments = !currentPayments.some((record) => getRecordId(record) === request.paymentId)
    ? [newPayment, ...currentPayments]
    : currentPayments;
  const currentSeq = Number(currentValue?.ticketSeq);
  const incomingSeq = Number(incomingValue.ticketSeq);

  return {
    ...(currentValue ?? incomingValue),
    tickets: tickets.filter((record) => !deletedTickets.has(getRecordId(record))),
    payments: payments.filter((record) => !deletedPayments.has(getPaymentSyncKey(record))),
    ticketSeq: Math.max(
      Number.isFinite(currentSeq) ? currentSeq : 0,
      Number.isFinite(incomingSeq) ? incomingSeq : 0,
    ),
    menuItems: currentValue
      ? (Array.isArray(currentValue.menuItems) ? currentValue.menuItems : [])
      : (Array.isArray(incomingValue.menuItems) ? incomingValue.menuItems : []),
    catalogRevision: currentValue
      ? Number(currentValue.catalogRevision ?? 0)
      : Number(incomingValue.catalogRevision ?? 0),
    queueResetAt: Math.max(
      Number(currentValue?.queueResetAt ?? 0),
      Number(incomingValue.queueResetAt ?? 0),
    ),
    deletedPaymentKeys,
    deletedTicketIds,
  };
}

function allocateTicketSequence(
  value: Record<string, unknown>,
  currentValue: Record<string, unknown> | null,
  request: AtomicBaristaCheckoutRequest["ticketSequence"],
) {
  let matchedRecord = false;
  const currentSeq = Number(currentValue?.ticketSeq);
  const incomingSeq = Number(value.ticketSeq);
  const nextSeq = Math.max(
    Number.isFinite(currentSeq) ? currentSeq : 0,
    Number.isFinite(incomingSeq) ? incomingSeq : 0,
  ) + 1;
  const code = `${request.prefix.trim().toUpperCase()}-${nextSeq}`;
  const tickets = Array.isArray(value.tickets)
    ? value.tickets.map((record) => {
        if (!request.ticketId || getRecordId(record) !== request.ticketId) return record;
        matchedRecord = true;
        return asRecord(record) ? { ...asRecord(record), code } : record;
      })
    : [];
  const payments = Array.isArray(value.payments)
    ? value.payments.map((record) => {
        if (getRecordId(record) !== request.paymentId) return record;
        matchedRecord = true;
        return asRecord(record) ? { ...asRecord(record), code } : record;
      })
    : [];
  return matchedRecord ? { ...value, tickets, payments, ticketSeq: nextSeq } : null;
}

function hasRequiredStockEffect(
  items: unknown[],
  requirement: AtomicBaristaStockEffectRequirement,
) {
  const item = items.find((record) => getRecordId(record) === requirement.itemId);
  const value = asRecord(item);
  if (!value) return false;
  const appliedIds = getStringArray(value.appliedStockEffectIds);
  const stockEffects = asRecord(value.stockEffects);
  if (appliedIds.includes(requirement.id) && Boolean(stockEffects?.[requirement.id])) return true;
  if (!requirement.allowPending) return false;
  return Boolean(asRecord(value.pendingStockEffects)?.[requirement.id]);
}

/**
 * Build one root-level Firebase mutation containing the Barista receipt,
 * queue ticket, Main Store deduction and Inventory mirror. A rejected stock
 * effect rejects the entire checkout, so revenue can never be recorded without
 * its confirmed stock impact.
 */
export function applyAtomicBaristaCheckout(
  currentRootValue: unknown,
  request: AtomicBaristaCheckoutRequest,
): AtomicBaristaCheckoutMutation {
  const currentRoot = asRecord(currentRootValue) ?? {};
  const currentPos = asRecord(currentRoot[BARISTA_POS_STORAGE_KEY]);
  const currentStoreItems = Array.isArray(currentRoot[MAIN_STORE_STORAGE_KEY])
    ? currentRoot[MAIN_STORE_STORAGE_KEY] as unknown[]
    : [];
  const currentInventoryItems = Array.isArray(currentRoot[INVENTORY_STORAGE_KEY])
    ? currentRoot[INVENTORY_STORAGE_KEY] as unknown[]
    : [];
  const failure = (reason: AtomicBaristaCheckoutFailureReason): AtomicBaristaCheckoutMutation => ({
    ok: false,
    reason,
    value: currentRoot,
    posValue: currentPos,
    storeItems: currentStoreItems,
    inventoryItems: currentInventoryItems,
  });

  if (
    !Number.isFinite(request.expectedCatalogRevision) ||
    !Array.isArray(request.expectedMenuItems) ||
    !asRecord(request.posValue) ||
    !Array.isArray(request.storeItems) ||
    !Array.isArray(request.inventoryItems) ||
    !Array.isArray(request.requiredStockEffects) ||
    !/^[A-Z]{1,4}$/.test(request.ticketSequence.prefix.trim().toUpperCase()) ||
    !request.ticketSequence.paymentId
  ) {
    return failure("invalid-request");
  }

  const deletedPaymentKeys = getStringArray(currentPos?.deletedPaymentKeys);
  const deletedTicketIds = getStringArray(currentPos?.deletedTicketIds);
  if (
    deletedPaymentKeys.includes(`id:${request.ticketSequence.paymentId}`) ||
    (request.ticketSequence.ticketId && deletedTicketIds.includes(request.ticketSequence.ticketId))
  ) {
    return failure("checkout-deleted");
  }

  const currentPayments = Array.isArray(currentPos?.payments) ? currentPos.payments : [];
  const paymentAlreadyCommitted = currentPayments.some(
    (record) => getRecordId(record) === request.ticketSequence.paymentId,
  );
  let nextPos = currentPos;
  if (!paymentAlreadyCommitted) {
    const currentRevision = currentPos
      ? Number(currentPos.catalogRevision ?? 0)
      : request.expectedCatalogRevision;
    const currentMenuItems = currentPos
      ? (Array.isArray(currentPos.menuItems) ? currentPos.menuItems : [])
      : request.expectedMenuItems;
    if (
      currentRevision !== request.expectedCatalogRevision ||
      !snapshotsMatch(currentMenuItems, request.expectedMenuItems)
    ) {
      return failure("catalog-changed");
    }
    const checkoutDelta = buildCheckoutDelta(request.posValue, currentPos, request.ticketSequence);
    nextPos = checkoutDelta
      ? allocateTicketSequence(checkoutDelta, currentPos, request.ticketSequence)
      : null;
    if (!nextPos) return failure("invalid-request");
  }
  if (!nextPos) return failure("invalid-request");

  const nextStoreItems = mergeStockEffectArrays(
    request.storeItems,
    currentStoreItems,
    "operational",
  );
  const nextInventoryItems = mergeStockEffectArrays(
    request.inventoryItems,
    currentInventoryItems,
    "operational",
  );
  if (!Array.isArray(nextStoreItems) || !Array.isArray(nextInventoryItems)) {
    return failure("invalid-request");
  }
  const missingEffect = request.requiredStockEffects.find((requirement) =>
    !hasRequiredStockEffect(
      requirement.target === "store" ? nextStoreItems : nextInventoryItems,
      requirement,
    ));
  if (missingEffect) return failure("stock-conflict");

  const nextRoot: Record<string, unknown> = {
    ...currentRoot,
    [BARISTA_POS_STORAGE_KEY]: nextPos,
    [MAIN_STORE_STORAGE_KEY]: nextStoreItems,
    [INVENTORY_STORAGE_KEY]: nextInventoryItems,
  };
  return {
    ok: true,
    value: nextRoot,
    posValue: nextPos,
    storeItems: nextStoreItems,
    inventoryItems: nextInventoryItems,
  };
}

/** Commit a manager's Barista catalog change and its linked stock records as
 * one compare-and-swap mutation. This prevents POS from exposing a linked item
 * unless both of its stock rows exist in the same committed root snapshot. */
export function applyAtomicBaristaCatalogStockMutation(
  currentRootValue: unknown,
  request: AtomicBaristaCatalogStockRequest,
): AtomicBaristaCatalogStockMutation {
  const currentRoot = asRecord(currentRootValue) ?? {};
  const currentPos = asRecord(currentRoot[BARISTA_POS_STORAGE_KEY]);
  const currentStoreItems = Array.isArray(currentRoot[MAIN_STORE_STORAGE_KEY])
    ? currentRoot[MAIN_STORE_STORAGE_KEY] as unknown[]
    : [];
  const currentInventoryItems = Array.isArray(currentRoot[INVENTORY_STORAGE_KEY])
    ? currentRoot[INVENTORY_STORAGE_KEY] as unknown[]
    : [];
  const appendRecords = Array.isArray(request.appendRecords) ? request.appendRecords : [];
  const currentAppendedValues = getCurrentAppendedValues(currentRoot, appendRecords);
  const failure = (
    reason: "catalog-changed" | "stock-changed" | "invalid-request",
  ): AtomicBaristaCatalogStockMutation => ({
    ok: false,
    reason,
    value: currentRoot,
    posValue: currentPos,
    storeItems: currentStoreItems,
    inventoryItems: currentInventoryItems,
    appendedValues: currentAppendedValues,
  });
  if (
    typeof request.mutationId !== "string" ||
    !request.mutationId.trim() ||
    !Number.isFinite(request.expectedCatalogRevision) ||
    !Array.isArray(request.expectedMenuItems) ||
    !Array.isArray(request.nextMenuItems) ||
    !asRecord(request.posBaseValue) ||
    !Array.isArray(request.expectedStoreItems) ||
    !Array.isArray(request.nextStoreItems) ||
    !Array.isArray(request.expectedInventoryItems) ||
    !Array.isArray(request.nextInventoryItems) ||
    (request.appendRecords !== undefined && !Array.isArray(request.appendRecords)) ||
    appendRecords.some((entry) =>
      !isManagerHistoryStorageKey(entry.key) || !asRecord(entry.record) || !getRecordId(entry.record))
  ) {
    return failure("invalid-request");
  }

  const currentRevision = currentPos
    ? Number(currentPos.catalogRevision ?? 0)
    : request.expectedCatalogRevision;
  const currentMenuItems = currentPos
    ? (Array.isArray(currentPos.menuItems) ? currentPos.menuItems : [])
    : request.expectedMenuItems;
  const appliedMutationIds = getStringArray(currentPos?.appliedCatalogStockMutationIds);
  const mutationFingerprint = createMutationFingerprint({
    expectedCatalogRevision: request.expectedCatalogRevision,
    expectedMenuItems: request.expectedMenuItems,
    nextMenuItems: request.nextMenuItems,
    expectedStoreItems: request.expectedStoreItems,
    nextStoreItems: request.nextStoreItems,
    expectedInventoryItems: request.expectedInventoryItems,
    nextInventoryItems: request.nextInventoryItems,
    appendRecords,
  });
  const mutationFingerprints = getMutationFingerprintMap(
    currentPos?.catalogStockMutationFingerprints,
  );
  if (appliedMutationIds.includes(request.mutationId)) {
    if (mutationFingerprints[request.mutationId] && mutationFingerprints[request.mutationId] !== mutationFingerprint) {
      return failure("invalid-request");
    }
    return {
      ok: true,
      value: currentRoot,
      posValue: currentPos ?? request.posBaseValue,
      storeItems: currentStoreItems,
      inventoryItems: currentInventoryItems,
      appendedValues: currentAppendedValues,
    };
  }
  if (
    currentRevision !== request.expectedCatalogRevision ||
    !snapshotsMatch(currentMenuItems, request.expectedMenuItems)
  ) {
    return failure("catalog-changed");
  }
  if (
    !snapshotsMatch(currentStoreItems, request.expectedStoreItems) ||
    !snapshotsMatch(currentInventoryItems, request.expectedInventoryItems)
  ) {
    return failure("stock-changed");
  }

  const nextPos = {
    ...(currentPos ?? request.posBaseValue),
    menuItems: request.nextMenuItems,
    catalogRevision: request.expectedCatalogRevision + 1,
    appliedCatalogStockMutationIds: Array.from(new Set([
      ...getStringArray((currentPos ?? request.posBaseValue).appliedCatalogStockMutationIds),
      request.mutationId,
    ])).slice(-200),
    catalogStockMutationFingerprints: appendMutationFingerprint(
      mutationFingerprints,
      request.mutationId,
      mutationFingerprint,
    ),
  };
  const appendedValues = appendRecordsById(currentAppendedValues, appendRecords);
  const nextRoot: Record<string, unknown> = {
    ...currentRoot,
    [BARISTA_POS_STORAGE_KEY]: nextPos,
    [MAIN_STORE_STORAGE_KEY]: request.nextStoreItems,
    [INVENTORY_STORAGE_KEY]: request.nextInventoryItems,
  };
  Object.entries(appendedValues).forEach(([key, value]) => {
    nextRoot[key] = value;
  });
  return {
    ok: true,
    value: nextRoot,
    posValue: nextPos,
    storeItems: request.nextStoreItems,
    inventoryItems: request.nextInventoryItems,
    appendedValues,
  };
}

/** Atomically apply stock compensation and POS tombstones. Concurrent catalog
 * edits and unrelated sales are preserved from the transaction-current POS
 * node; only the explicitly identified tickets/payments are removed. */
export function applyAtomicBaristaVoid(
  currentRootValue: unknown,
  request: AtomicBaristaVoidRequest,
): AtomicBaristaVoidMutation {
  const currentRoot = asRecord(currentRootValue) ?? {};
  const currentPos = asRecord(currentRoot[BARISTA_POS_STORAGE_KEY]);
  const currentStoreItems = Array.isArray(currentRoot[MAIN_STORE_STORAGE_KEY])
    ? currentRoot[MAIN_STORE_STORAGE_KEY] as unknown[]
    : [];
  const currentInventoryItems = Array.isArray(currentRoot[INVENTORY_STORAGE_KEY])
    ? currentRoot[INVENTORY_STORAGE_KEY] as unknown[]
    : [];
  const failure = (
    reason: "stock-conflict" | "ticket-not-cancellable" | "invalid-request",
  ): AtomicBaristaVoidMutation => ({
    ok: false,
    reason,
    value: currentRoot,
    posValue: currentPos,
    storeItems: currentStoreItems,
    inventoryItems: currentInventoryItems,
  });
  if (
    !asRecord(request.posBaseValue) ||
    !Array.isArray(request.cancellableTicketIds) ||
    !Array.isArray(request.deletedPaymentKeys) ||
    !Array.isArray(request.deletedTicketIds) ||
    !Array.isArray(request.storeItems) ||
    !Array.isArray(request.inventoryItems) ||
    !Array.isArray(request.requiredStockEffects)
  ) {
    return failure("invalid-request");
  }

  const basePos = currentPos ?? request.posBaseValue;
  const currentDeletedTicketIds = getStringArray(basePos.deletedTicketIds);
  const currentTickets = Array.isArray(basePos.tickets) ? basePos.tickets : [];
  const cannotCancelTicket = request.cancellableTicketIds.some((ticketId) => {
    if (currentDeletedTicketIds.includes(ticketId)) return false;
    const ticket = currentTickets.find((record) => getRecordId(record) === ticketId);
    const ticketValue = asRecord(ticket);
    return !ticketValue || ticketValue.status === "delivered";
  });
  if (cannotCancelTicket) return failure("ticket-not-cancellable");
  const deletedPaymentKeys = Array.from(new Set([
    ...getStringArray(basePos.deletedPaymentKeys),
    ...getStringArray(request.deletedPaymentKeys),
  ]));
  const deletedTicketIds = Array.from(new Set([
    ...currentDeletedTicketIds,
    ...getStringArray(request.deletedTicketIds),
  ]));
  const deletedPaymentSet = new Set(deletedPaymentKeys);
  const deletedTicketSet = new Set(deletedTicketIds);
  const nextPos = {
    ...basePos,
    tickets: (Array.isArray(basePos.tickets) ? basePos.tickets : [])
      .filter((record) => !deletedTicketSet.has(getRecordId(record))),
    payments: (Array.isArray(basePos.payments) ? basePos.payments : [])
      .filter((record) => !deletedPaymentSet.has(getPaymentSyncKey(record))),
    deletedPaymentKeys,
    deletedTicketIds,
  };
  const nextStoreItems = mergeStockEffectArrays(
    request.storeItems,
    currentStoreItems,
    "operational",
  );
  const nextInventoryItems = mergeStockEffectArrays(
    request.inventoryItems,
    currentInventoryItems,
    "operational",
  );
  if (!Array.isArray(nextStoreItems) || !Array.isArray(nextInventoryItems)) {
    return failure("invalid-request");
  }
  const missingEffect = request.requiredStockEffects.find((requirement) =>
    !hasRequiredStockEffect(
      requirement.target === "store" ? nextStoreItems : nextInventoryItems,
      requirement,
    ));
  if (missingEffect) return failure("stock-conflict");

  const nextRoot = {
    ...currentRoot,
    [BARISTA_POS_STORAGE_KEY]: nextPos,
    [MAIN_STORE_STORAGE_KEY]: nextStoreItems,
    [INVENTORY_STORAGE_KEY]: nextInventoryItems,
  };
  return {
    ok: true,
    value: nextRoot,
    posValue: nextPos,
    storeItems: nextStoreItems,
    inventoryItems: nextInventoryItems,
  };
}

/** Apply Main Store and Inventory effects together, optionally appending a
 * waste/usage record in the same root transaction. This closes partial mirror
 * writes and makes a lost-response retry idempotent by the stable effect/log
 * IDs already present in the request. */
export function applyAtomicBaristaStockMutation(
  currentRootValue: unknown,
  request: AtomicBaristaStockMutationRequest,
): AtomicBaristaStockMutation {
  const currentRoot = asRecord(currentRootValue) ?? {};
  const currentStoreItems = Array.isArray(currentRoot[MAIN_STORE_STORAGE_KEY])
    ? currentRoot[MAIN_STORE_STORAGE_KEY] as unknown[]
    : [];
  const currentInventoryItems = Array.isArray(currentRoot[INVENTORY_STORAGE_KEY])
    ? currentRoot[INVENTORY_STORAGE_KEY] as unknown[]
    : [];
  const appendRecords = Array.isArray(request.appendRecords) ? request.appendRecords : [];
  const currentAppendedValues = getCurrentAppendedValues(currentRoot, appendRecords);
  const managerMutation = asRecord(request.managerMutation);
  const managerPurchase = asRecord(request.managerPurchase);
  const failure = (
    reason: "stock-conflict" | "usage-capacity-exceeded" | "invalid-request",
  ): AtomicBaristaStockMutation => ({
    ok: false,
    reason,
    value: currentRoot,
    storeItems: currentStoreItems,
    inventoryItems: currentInventoryItems,
    appendedValues: currentAppendedValues,
  });
  if (
    !Array.isArray(request.storeItems) ||
    !Array.isArray(request.inventoryItems) ||
    !Array.isArray(request.requiredStockEffects) ||
    !Array.isArray(request.appendRecords) ||
    (request.usageCapacityRequirements !== undefined && !Array.isArray(request.usageCapacityRequirements)) ||
    appendRecords.some((entry) =>
      (managerMutation || managerPurchase
        ? !isManagerHistoryStorageKey(entry.key)
        : entry.key !== BARISTA_WASTE_STORAGE_KEY && entry.key !== STORE_USAGE_STORAGE_KEY) ||
      !asRecord(entry.record) ||
      !getRecordId(entry.record)) ||
    (request.usageCapacityRequirements ?? []).some((entry) =>
      typeof entry.movementId !== "string" ||
      !entry.movementId.trim() ||
      typeof entry.destination !== "string" ||
      !entry.destination.trim() ||
      !Number.isFinite(entry.maxQuantity) ||
      entry.maxQuantity < 0)
  ) {
    return failure("invalid-request");
  }

  if (request.managerMutation !== undefined && (
    !managerMutation ||
    typeof managerMutation.id !== "string" ||
    !managerMutation.id.trim() ||
    !Array.isArray(managerMutation.expectedStoreItems) ||
    !Array.isArray(managerMutation.expectedInventoryItems) ||
    request.requiredStockEffects.length > 0 ||
    (request.usageCapacityRequirements?.length ?? 0) > 0
  )) {
    return failure("invalid-request");
  }
  if (request.managerPurchase !== undefined && (
    managerMutation ||
    !managerPurchase ||
    typeof managerPurchase.id !== "string" ||
    !managerPurchase.id.trim() ||
    (request.usageCapacityRequirements?.length ?? 0) > 0
  )) {
    return failure("invalid-request");
  }

  const appliedManagerMutationFingerprints = getMutationFingerprintMap(
    currentRoot[STOCK_BATCH_MUTATIONS_STORAGE_KEY],
  );
  const managerMutationFingerprint = managerMutation
    ? createMutationFingerprint({
        expectedStoreItems: managerMutation.expectedStoreItems,
        nextStoreItems: request.storeItems,
        expectedInventoryItems: managerMutation.expectedInventoryItems,
        nextInventoryItems: request.inventoryItems,
        appendRecords,
      })
    : "";
  if (managerMutation && Object.prototype.hasOwnProperty.call(appliedManagerMutationFingerprints, managerMutation.id as string)) {
    const priorFingerprint = appliedManagerMutationFingerprints[managerMutation.id as string];
    if (priorFingerprint && priorFingerprint !== managerMutationFingerprint) {
      return failure("invalid-request");
    }
    return {
      ok: true,
      value: currentRoot,
      storeItems: currentStoreItems,
      inventoryItems: currentInventoryItems,
      appendedValues: currentAppendedValues,
    };
  }

  if (managerMutation && (
    !snapshotsMatch(currentStoreItems, managerMutation.expectedStoreItems) ||
    !snapshotsMatch(currentInventoryItems, managerMutation.expectedInventoryItems)
  )) {
    return failure("stock-conflict");
  }

  const nextStoreItems = managerMutation
    ? request.storeItems
    : mergeStockEffectArrays(
        request.storeItems,
        currentStoreItems,
        managerPurchase ? "manager-purchase" : "operational",
      );
  const nextInventoryItems = managerMutation
    ? request.inventoryItems
    : mergeStockEffectArrays(
        request.inventoryItems,
        currentInventoryItems,
        managerPurchase ? "manager-purchase" : "operational",
      );
  if (!Array.isArray(nextStoreItems) || !Array.isArray(nextInventoryItems)) {
    return failure("invalid-request");
  }
  const missingEffect = request.requiredStockEffects.find((requirement) =>
    !hasRequiredStockEffect(
      requirement.target === "store" ? nextStoreItems : nextInventoryItems,
      requirement,
    ));
  if (missingEffect) return failure("stock-conflict");

  const currentUsageRecords = currentAppendedValues[STORE_USAGE_STORAGE_KEY] ?? [];
  const usageRecordsToAppend = appendRecords
    .filter((entry) => entry.key === STORE_USAGE_STORAGE_KEY)
    .map((entry) => entry.record)
    .filter((record) => !currentUsageRecords.some((current) => getRecordId(current) === getRecordId(record)));
  const capacityExceeded = (request.usageCapacityRequirements ?? []).some((requirement) => {
    const matchesRequirement = (record: unknown) => {
      const value = asRecord(record);
      return value?.movementId === requirement.movementId && value?.destination === requirement.destination;
    };
    const getQuantity = (record: unknown) => {
      const quantity = Number(asRecord(record)?.quantityUsed);
      return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
    };
    const currentQuantity = currentUsageRecords
      .filter(matchesRequirement)
      .reduce<number>((sum, record) => sum + getQuantity(record), 0);
    const appendedQuantity = usageRecordsToAppend
      .filter(matchesRequirement)
      .reduce<number>((sum, record) => sum + getQuantity(record), 0);
    return currentQuantity + appendedQuantity > requirement.maxQuantity + Number.EPSILON;
  });
  if (capacityExceeded) return failure("usage-capacity-exceeded");

  const appendedValues = appendRecordsById(currentAppendedValues, appendRecords);
  const nextRoot: Record<string, unknown> = {
    ...currentRoot,
    [MAIN_STORE_STORAGE_KEY]: nextStoreItems,
    [INVENTORY_STORAGE_KEY]: nextInventoryItems,
    ...(managerMutation
      ? {
          [STOCK_BATCH_MUTATIONS_STORAGE_KEY]: appendMutationFingerprint(
            appliedManagerMutationFingerprints,
            managerMutation.id as string,
            managerMutationFingerprint,
          ),
        }
      : {}),
  };
  Object.entries(appendedValues).forEach(([key, value]) => {
    if (appendRecords.some((entry) => entry.key === key)) nextRoot[key] = value;
  });
  return {
    ok: true,
    value: nextRoot,
    storeItems: nextStoreItems,
    inventoryItems: nextInventoryItems,
    appendedValues,
  };
}
