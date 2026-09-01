import { NextRequest, NextResponse } from "next/server";
import {
  applyAtomicBaristaCatalogStockMutation,
  type AtomicBaristaCatalogStockMutation,
  type AtomicBaristaCatalogStockRequest,
} from "@/app/lib/barista-checkout-transaction";
import { updateServerSyncedStorageRoot } from "@/app/lib/firebase-server";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

class AtomicBaristaCatalogStockError extends Error {
  constructor(readonly outcome: Extract<AtomicBaristaCatalogStockMutation, { ok: false }>) {
    super(outcome.reason);
  }
}

export async function POST(request: NextRequest) {
  try {
    const mutationRequest = sanitizeForStorage(
      await request.json(),
    ) as AtomicBaristaCatalogStockRequest;
    const committedRoot = await updateServerSyncedStorageRoot<Record<string, unknown>>((currentRoot) => {
      const outcome = applyAtomicBaristaCatalogStockMutation(currentRoot, mutationRequest);
      if (!outcome.ok) throw new AtomicBaristaCatalogStockError(outcome);
      return outcome.value;
    });
    const committedOutcome = applyAtomicBaristaCatalogStockMutation(committedRoot, mutationRequest);
    if (!committedOutcome.ok) {
      throw new Error("The atomic Barista catalog and stock change could not be verified.");
    }
    return NextResponse.json(committedOutcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AtomicBaristaCatalogStockError) {
      return NextResponse.json(
        error.outcome,
        { status: error.outcome.reason === "invalid-request" ? 400 : 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The Barista catalog and stock change failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
