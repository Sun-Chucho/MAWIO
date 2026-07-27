import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import {
  readServerSyncedStorageValue,
  writeServerSyncedStorageValue,
} from "@/app/lib/firebase-server";

type RouteContext = {
  params: Promise<{
    key: string;
  }>;
};

function decodeStorageKey(rawKey: string) {
  return decodeURIComponent(rawKey);
}

function getRequestTier(request: NextRequest) {
  const queryTier = request.nextUrl.searchParams.get("tier");
  const headerTier = request.headers.get("x-mawio-tier");
  const requestedTier = queryTier ?? headerTier;

  if (queryTier && headerTier && queryTier !== headerTier) return null;
  return requestedTier === "standard" || requestedTier === "platinum" ? requestedTier : null;
}

function missingTierResponse() {
  return NextResponse.json(
    { error: "A valid hotel tier (standard or platinum) is required." },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

function createStorageEtag(value: unknown) {
  return `"${createHash("sha1").update(JSON.stringify(value)).digest("base64url")}"`;
}

function getReadHeaders(etag: string) {
  return {
    "Cache-Control": "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
    ETag: etag,
    Vary: "x-mawio-tier",
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

function protectIncomingSyncedValue(key: string, incomingValue: unknown, currentValue: unknown) {
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
    const currentSnapshot = currentValue as { tickets?: unknown[]; ticketSeq?: unknown; payments?: unknown[]; menuItems?: unknown[] } | null;
    const incomingSnapshot = incomingValue as { tickets?: unknown[]; ticketSeq?: unknown; payments?: unknown[]; menuItems?: unknown[] } | null;
    const currentTickets = Array.isArray(currentSnapshot?.tickets) ? currentSnapshot.tickets : [];
    const incomingTickets = Array.isArray(incomingSnapshot?.tickets) ? incomingSnapshot.tickets : [];
    const currentPayments = Array.isArray(currentSnapshot?.payments) ? currentSnapshot.payments : [];
    const incomingPayments = Array.isArray(incomingSnapshot?.payments) ? incomingSnapshot.payments : [];
    const currentSeq = Number(currentSnapshot?.ticketSeq);
    const incomingSeq = Number(incomingSnapshot?.ticketSeq);

    return {
      ...(typeof incomingValue === "object" && incomingValue !== null ? incomingValue : {}),
      tickets: mergeRecordsByIdPreservingIncomingChanges(currentTickets, incomingTickets),
      payments: mergeRecordsByIdPreservingIncomingChanges(currentPayments, incomingPayments),
      ticketSeq: Math.max(
        Number.isFinite(currentSeq) ? currentSeq : 0,
        Number.isFinite(incomingSeq) ? incomingSeq : 0,
      ),
    };
  }

  if (key === "orange-hotel-company-stock" && Array.isArray(currentValue) && Array.isArray(incomingValue)) {
    return mergeRecordsByIdPreservingIncomingChanges(currentValue, incomingValue);
  }

  if (Array.isArray(currentValue) && Array.isArray(incomingValue) && getArrayCount(incomingValue) < getArrayCount(currentValue)) {
    return currentValue;
  }

  return incomingValue;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const tier = getRequestTier(request);
    if (!tier) return missingTierResponse();

    const { key } = await context.params;
    const value = await readServerSyncedStorageValue(decodeStorageKey(key), { tier });
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

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const tier = getRequestTier(request);
    if (!tier) return missingTierResponse();

    const { key } = await context.params;
    const decodedKey = decodeStorageKey(key);
    const body = (await request.json()) as { value?: unknown };
    const currentValue = await readServerSyncedStorageValue(decodedKey, { tier }).catch(() => null);
    const nextValue = protectIncomingSyncedValue(decodedKey, body.value ?? null, currentValue);
    await writeServerSyncedStorageValue(decodedKey, nextValue, { tier });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write synced storage value." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const tier = getRequestTier(request);
    if (!tier) return missingTierResponse();

    const { key } = await context.params;
    await writeServerSyncedStorageValue(decodeStorageKey(key), null, { tier });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete synced storage value." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
