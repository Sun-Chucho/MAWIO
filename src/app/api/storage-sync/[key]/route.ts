import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  readServerSyncedStorageValue,
  updateServerSyncedStorageValue,
  writeServerSyncedStorageValue,
} from "@/app/lib/firebase-server";
import { mergeStockEffectArrays } from "@/app/lib/stock-effects";

type RouteContext = {
  params: Promise<{
    key: string;
  }>;
};

class CatalogRevisionConflictError extends Error {}
class CheckoutDeletedError extends Error {}
class StockSnapshotConflictError extends Error {}

type PosTicketSequenceRequest = {
  prefix: string;
  ticketId?: string;
  paymentId?: string;
};

type PosCatalogMutationRequest = {
  expectedMenuItems: unknown[];
  nextMenuItems: unknown[];
};

function decodeStorageKey(rawKey: string) {
  return decodeURIComponent(rawKey);
}

function createStorageEtag(value: unknown) {
  return `"${createHash("sha1").update(JSON.stringify(value)).digest("base64url")}"`;
}

function getReadHeaders(etag: string) {
  return {
    "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
    ETag: etag,
  };
}

function getArrayCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function getCashierTransactions(value: unknown) {
  const transactions = (value as { transactions?: unknown[] } | null)?.transactions;
  return Array.isArray(transactions) ? transactions : [];
}

function getCashierReceiptSeq(value: unknown) {
  const receiptSeq = Number((value as { receiptSeq?: unknown } | null)?.receiptSeq);
  return Number.isFinite(receiptSeq) ? receiptSeq : 0;
}

function getRecordId(record: unknown) {
  if (typeof record !== "object" || record === null) return null;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function getDeletedTicketIds(snapshot: { deletedTicketIds?: unknown }) {
  return Array.isArray(snapshot.deletedTicketIds)
    ? snapshot.deletedTicketIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function getDeletedPaymentKeys(snapshot: { deletedPaymentKeys?: unknown }) {
  return Array.isArray(snapshot.deletedPaymentKeys)
    ? snapshot.deletedPaymentKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
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

function getPaymentSyncKey(record: unknown) {
  if (typeof record !== "object" || record === null) return "";
  const payment = record as { id?: unknown; code?: unknown; createdAt?: unknown; total?: unknown; destination?: unknown };
  const id = typeof payment.id === "string" ? payment.id.trim() : "";
  return id
    ? `id:${id}`
    : `legacy:${String(payment.code ?? "")}|${String(payment.createdAt ?? "")}|${String(payment.total ?? "")}|${String(payment.destination ?? "")}`;
}

function filterDeletedTickets(tickets: unknown[], deletedTicketIds: string[]) {
  const deletedIds = new Set(deletedTicketIds);
  return tickets.filter((ticket) => {
    const id = getRecordId(ticket);
    return !id || !deletedIds.has(id);
  });
}

function filterDeletedPayments(payments: unknown[], deletedPaymentKeys: string[]) {
  const deletedKeys = new Set(deletedPaymentKeys);
  return payments.filter((payment) => !deletedKeys.has(getPaymentSyncKey(payment)));
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

function sortByCreatedAtDesc(records: unknown[]) {
  return records.sort((a, b) => {
    const left = typeof a === "object" && a !== null ? Number((a as { createdAt?: unknown }).createdAt) : 0;
    const right = typeof b === "object" && b !== null ? Number((b as { createdAt?: unknown }).createdAt) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
}

function mergeRecordsByIdPreservingIncomingChanges(currentRecords: unknown[], incomingRecords: unknown[]) {
  const mergedById = new Map<string, unknown>();
  const recordsWithoutId: unknown[] = [];

  for (const record of currentRecords) {
    const id = getRecordId(record);
    if (id) {
      mergedById.set(id, record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  for (const record of incomingRecords) {
    const id = getRecordId(record);
    if (id) {
      const existingRecord = mergedById.get(id);
      mergedById.set(id, existingRecord ? chooseRecordBySettlementPriority(existingRecord, record) : record);
    } else {
      recordsWithoutId.push(record);
    }
  }

  return sortByCreatedAtDesc([...Array.from(mergedById.values()), ...recordsWithoutId]);
}

function protectIncomingSyncedValue(
  key: string,
  incomingValue: unknown,
  currentValue: unknown,
  stockEffectIntent: "manager" | "operational" = "manager",
) {
  if (key === "orange-hotel-cashier-state") {
    const currentTransactions = getCashierTransactions(currentValue);
    const incomingTransactions = getCashierTransactions(incomingValue);
    const currentSeq = getCashierReceiptSeq(currentValue);
    const incomingSeq = getCashierReceiptSeq(incomingValue);

    if (currentTransactions.length > 0 && incomingTransactions.length < currentTransactions.length && incomingSeq <= currentSeq) {
      return currentValue;
    }

    return {
      ...(typeof incomingValue === "object" && incomingValue !== null ? incomingValue : {}),
      transactions: mergeRecordsByIdPreservingIncomingChanges(currentTransactions, incomingTransactions),
      receiptSeq: Math.max(currentSeq, incomingSeq),
    };
  }

  if (key === "orange-hotel-rooms-state") {
    const currentRooms = Array.isArray(currentValue) ? currentValue : [];
    const incomingRooms = Array.isArray(incomingValue) ? incomingValue : [];
    const currentOccupied = currentRooms.filter((room) => (room as { status?: unknown }).status === "occupied").length;
    const incomingOccupied = incomingRooms.filter((room) => (room as { status?: unknown }).status === "occupied").length;

    if (currentOccupied > 0 && incomingOccupied === 0) {
      return currentValue;
    }
  }

  if (key === "orange-hotel-kitchen-state" || key === "orange-hotel-barista-state") {
    const currentSnapshot = currentValue as { tickets?: unknown[]; ticketSeq?: unknown; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: unknown; queueResetAt?: unknown; deletedPaymentKeys?: unknown[]; deletedTicketIds?: unknown[]; appliedCatalogStockMutationIds?: unknown[]; catalogStockMutationFingerprints?: unknown } | null;
    const incomingSnapshot = incomingValue as { tickets?: unknown[]; ticketSeq?: unknown; payments?: unknown[]; menuItems?: unknown[]; catalogRevision?: unknown; queueResetAt?: unknown; deletedPaymentKeys?: unknown[]; deletedTicketIds?: unknown[]; appliedCatalogStockMutationIds?: unknown[]; catalogStockMutationFingerprints?: unknown } | null;
    const currentTickets = Array.isArray(currentSnapshot?.tickets) ? currentSnapshot.tickets : [];
    const incomingTickets = Array.isArray(incomingSnapshot?.tickets) ? incomingSnapshot.tickets : [];
    const currentPayments = Array.isArray(currentSnapshot?.payments) ? currentSnapshot.payments : [];
    const incomingPayments = Array.isArray(incomingSnapshot?.payments) ? incomingSnapshot.payments : [];
    const currentMenuItems = Array.isArray(currentSnapshot?.menuItems) ? currentSnapshot.menuItems : [];
    const incomingMenuItems = Array.isArray(incomingSnapshot?.menuItems) ? incomingSnapshot.menuItems : [];
    const currentSeq = Number(currentSnapshot?.ticketSeq);
    const incomingSeq = Number(incomingSnapshot?.ticketSeq);
    const currentCatalogRevision = Number(currentSnapshot?.catalogRevision);
    const incomingCatalogRevision = Number(incomingSnapshot?.catalogRevision);
    const currentQueueResetAt = Number(currentSnapshot?.queueResetAt);
    const incomingQueueResetAt = Number(incomingSnapshot?.queueResetAt);
    const resolvedCurrentRevision = Number.isFinite(currentCatalogRevision) ? currentCatalogRevision : 0;
    const resolvedIncomingRevision = Number.isFinite(incomingCatalogRevision) ? incomingCatalogRevision : 0;
    const incomingCatalogWins = currentValue === null || resolvedIncomingRevision > resolvedCurrentRevision;
    const deletedPaymentKeys = Array.from(new Set([
      ...(Array.isArray(currentSnapshot?.deletedPaymentKeys) ? currentSnapshot.deletedPaymentKeys : []),
      ...(Array.isArray(incomingSnapshot?.deletedPaymentKeys) ? incomingSnapshot.deletedPaymentKeys : []),
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)));
    const deletedTicketIds = Array.from(new Set([
      ...getDeletedTicketIds(currentSnapshot ?? {}),
      ...getDeletedTicketIds(incomingSnapshot ?? {}),
    ]));
    const appliedCatalogStockMutationIds = Array.from(new Set([
      ...getAppliedCatalogStockMutationIds(currentSnapshot ?? {}),
      ...getAppliedCatalogStockMutationIds(incomingSnapshot ?? {}),
    ]));
    const catalogStockMutationFingerprints = {
      ...getCatalogStockMutationFingerprints(incomingSnapshot ?? {}),
      ...getCatalogStockMutationFingerprints(currentSnapshot ?? {}),
    };

    return {
      ...(typeof currentValue === "object" && currentValue !== null ? currentValue : {}),
      ...(typeof incomingValue === "object" && incomingValue !== null ? incomingValue : {}),
      tickets: filterDeletedTickets(
        mergeRecordsByIdPreservingIncomingChanges(currentTickets, incomingTickets),
        deletedTicketIds,
      ),
      payments: filterDeletedPayments(
        mergeRecordsByIdPreservingIncomingChanges(currentPayments, incomingPayments),
        deletedPaymentKeys,
      ),
      menuItems: incomingCatalogWins ? incomingMenuItems : currentMenuItems,
      catalogRevision: Math.max(resolvedCurrentRevision, resolvedIncomingRevision),
      queueResetAt: Math.max(
        Number.isFinite(currentQueueResetAt) ? currentQueueResetAt : 0,
        Number.isFinite(incomingQueueResetAt) ? incomingQueueResetAt : 0,
      ),
      ...(deletedPaymentKeys.length ? { deletedPaymentKeys } : {}),
      ...(deletedTicketIds.length ? { deletedTicketIds } : {}),
      ...(appliedCatalogStockMutationIds.length ? { appliedCatalogStockMutationIds } : {}),
      ...(Object.keys(catalogStockMutationFingerprints).length ? { catalogStockMutationFingerprints } : {}),
      ticketSeq: Math.max(
        Number.isFinite(currentSeq) ? currentSeq : 0,
        Number.isFinite(incomingSeq) ? incomingSeq : 0,
      ),
    };
  }

  if (key === "orange-hotel-main-store-items" || key === "orange-hotel-inventory-items") {
    return mergeStockEffectArrays(incomingValue, currentValue, stockEffectIntent);
  }

  if (key === "orange-hotel-company-stock" && Array.isArray(currentValue) && Array.isArray(incomingValue)) {
    return mergeRecordsByIdPreservingIncomingChanges(currentValue, incomingValue);
  }

  if (
    (key === "orange-hotel-barista-waste" || key === "orange-hotel-store-usage") &&
    Array.isArray(currentValue) &&
    Array.isArray(incomingValue)
  ) {
    return mergeRecordsByIdPreservingIncomingChanges(currentValue, incomingValue);
  }

  if (Array.isArray(currentValue) && Array.isArray(incomingValue) && getArrayCount(incomingValue) < getArrayCount(currentValue)) {
    return currentValue;
  }

  return incomingValue;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { key } = await context.params;
    const value = await readServerSyncedStorageValue(decodeStorageKey(key));
    const etag = createStorageEtag(value);

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: getReadHeaders(etag),
      });
    }

    return NextResponse.json({ value }, { headers: getReadHeaders(etag) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read synced storage value." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

}

function parsePosTicketSequenceRequest(value: unknown): PosTicketSequenceRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const request = value as { prefix?: unknown; ticketId?: unknown; paymentId?: unknown };
  const prefix = typeof request.prefix === "string" ? request.prefix.trim().toUpperCase() : "";
  const ticketId = typeof request.ticketId === "string" && request.ticketId.trim()
    ? request.ticketId.trim()
    : undefined;
  const paymentId = typeof request.paymentId === "string" && request.paymentId.trim()
    ? request.paymentId.trim()
    : undefined;
  if (!/^[A-Z]{1,4}$/.test(prefix) || (!ticketId && !paymentId)) return null;
  return { prefix, ticketId, paymentId };
}

function parsePosCatalogMutationRequest(value: unknown): PosCatalogMutationRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const request = value as { expectedMenuItems?: unknown; nextMenuItems?: unknown };
  if (!Array.isArray(request.expectedMenuItems) || !Array.isArray(request.nextMenuItems)) return null;
  return {
    expectedMenuItems: request.expectedMenuItems,
    nextMenuItems: request.nextMenuItems,
  };
}

function buildPosCatalogMutation(
  incomingValue: unknown,
  currentValue: unknown,
  request: PosCatalogMutationRequest,
) {
  const incomingSnapshot = typeof incomingValue === "object" && incomingValue !== null
    ? incomingValue as Record<string, unknown>
    : {};
  const currentSnapshot = typeof currentValue === "object" && currentValue !== null
    ? currentValue as Record<string, unknown>
    : incomingSnapshot;
  const currentRevision = Number(currentSnapshot.catalogRevision);
  const resolvedCurrentRevision = Number.isFinite(currentRevision) && currentRevision >= 0
    ? currentRevision
    : 0;

  // Catalog edits only replace the menu. Queue, payments, tombstones and
  // sequence allocation always come from the transaction-current snapshot.
  return {
    ...currentSnapshot,
    menuItems: request.nextMenuItems,
    catalogRevision: resolvedCurrentRevision + 1,
  };
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
    tickets: filterDeletedTickets(tickets, deletedTicketIds),
    payments: filterDeletedPayments(payments, deletedPaymentKeys),
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
    ...(deletedPaymentKeys.length ? { deletedPaymentKeys } : {}),
    ...(deletedTicketIds.length ? { deletedTicketIds } : {}),
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
  const code = `${request.prefix}-${nextSeq}`;
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

export async function PUT(request: NextRequest, context: RouteContext) {
  let catalogConflictValue: unknown = null;
  let checkoutDeletedValue: unknown = null;
  try {
    const { key } = await context.params;
    const decodedKey = decodeStorageKey(key);
    const body = (await request.json()) as {
      value?: unknown;
      expectedCatalogRevision?: unknown;
      ticketSequence?: unknown;
      catalogMutation?: unknown;
      stockEffectIntent?: unknown;
      initializeIfMissing?: unknown;
      expectedStockItems?: unknown;
    };
    const expectedCatalogRevision = Number(body.expectedCatalogRevision);
    const enforceCatalogRevision =
      (decodedKey === "orange-hotel-kitchen-state" || decodedKey === "orange-hotel-barista-state") &&
      Number.isFinite(expectedCatalogRevision);
    const ticketSequence = enforceCatalogRevision
      ? parsePosTicketSequenceRequest(body.ticketSequence)
      : null;
    const catalogMutation = enforceCatalogRevision
      ? parsePosCatalogMutationRequest(body.catalogMutation)
      : null;
    const nextValue = await updateServerSyncedStorageValue(decodedKey, (currentValue) => {
      if (body.initializeIfMissing === true && currentValue !== null) return currentValue;
      if (
        (decodedKey === "orange-hotel-main-store-items" || decodedKey === "orange-hotel-inventory-items") &&
        Array.isArray(body.expectedStockItems)
      ) {
        const currentItems = Array.isArray(currentValue) ? currentValue : [];
        const incomingItems = Array.isArray(body.value) ? body.value : [];
        if (JSON.stringify(currentItems) === JSON.stringify(incomingItems)) return currentItems;
        if (JSON.stringify(currentItems) !== JSON.stringify(body.expectedStockItems)) {
          throw new StockSnapshotConflictError("Shared stock changed before this manager edit could be saved.");
        }
        return incomingItems;
      }
      const currentPayments = (currentValue as { payments?: unknown[] } | null)?.payments;
      const paymentAlreadyCommitted = Boolean(
        ticketSequence?.paymentId &&
        Array.isArray(currentPayments) &&
        currentPayments.some((record) => getRecordId(record) === ticketSequence.paymentId),
      );
      // A direct Firebase commit can succeed even if its response is lost. The
      // REST retry uses the same payment ID, so recognize it before checking a
      // catalog revision that may have changed after the successful sale.
      if (paymentAlreadyCommitted) return currentValue;

      const currentSnapshot = currentValue as { deletedPaymentKeys?: unknown; deletedTicketIds?: unknown } | null;
      const requestedPaymentWasDeleted = Boolean(
        ticketSequence?.paymentId &&
        getDeletedPaymentKeys(currentSnapshot ?? {}).includes(`id:${ticketSequence.paymentId}`),
      );
      const requestedTicketWasDeleted = Boolean(
        ticketSequence?.ticketId &&
        getDeletedTicketIds(currentSnapshot ?? {}).includes(ticketSequence.ticketId),
      );
      if (requestedPaymentWasDeleted || requestedTicketWasDeleted) {
        checkoutDeletedValue = currentValue;
        throw new CheckoutDeletedError("This checkout was already deleted and cannot be recreated by a retry.");
      }

      if (enforceCatalogRevision) {
        const expectedMenuItems = catalogMutation?.expectedMenuItems
          ?? (body.value as { menuItems?: unknown[] } | null)?.menuItems
          ?? [];
        const currentCatalogRevision = currentValue === null
          ? expectedCatalogRevision
          : Number((currentValue as { catalogRevision?: unknown })?.catalogRevision ?? 0);
        const currentMenuItems = currentValue === null
          ? expectedMenuItems
          : (currentValue as { menuItems?: unknown[] })?.menuItems ?? [];
        if (catalogMutation && JSON.stringify(currentMenuItems) === JSON.stringify(catalogMutation.nextMenuItems)) {
          // A direct Firebase transaction may have committed even when its
          // response was lost. The REST retry is idempotent by exact catalog.
          return currentValue;
        }
        if (
          currentCatalogRevision !== expectedCatalogRevision ||
          JSON.stringify(currentMenuItems) !== JSON.stringify(expectedMenuItems)
        ) {
          catalogConflictValue = currentValue;
          throw new CatalogRevisionConflictError("The POS catalog changed before this update could be saved.");
        }
      }
      if (catalogMutation) {
        return buildPosCatalogMutation(body.value ?? null, currentValue, catalogMutation);
      }
      if (ticketSequence) {
        const checkoutDelta = buildPosCheckoutDelta(body.value ?? null, currentValue, ticketSequence);
        return allocatePosTicketSequence(checkoutDelta, currentValue, ticketSequence);
      }
      return protectIncomingSyncedValue(
        decodedKey,
        body.value ?? null,
        currentValue,
        body.stockEffectIntent === "operational" ? "operational" : "manager",
      );
    });
    return NextResponse.json({ ok: true, value: nextValue }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CheckoutDeletedError) {
      return NextResponse.json(
        { error: error.message, deleted: true, value: checkoutDeletedValue },
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof CatalogRevisionConflictError) {
      return NextResponse.json(
        { error: error.message, conflict: true, value: catalogConflictValue },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof StockSnapshotConflictError) {
      return NextResponse.json(
        { error: error.message, conflict: true },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write synced storage value." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { key } = await context.params;
    await writeServerSyncedStorageValue(decodeStorageKey(key), null);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete synced storage value." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
