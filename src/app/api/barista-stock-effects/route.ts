import { NextRequest, NextResponse } from "next/server";
import {
  applyAtomicBaristaStockMutation,
  type AtomicBaristaStockMutation,
  type AtomicBaristaStockMutationRequest,
} from "@/app/lib/barista-checkout-transaction";
import { updateServerSyncedStorageRoot } from "@/app/lib/firebase-server";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

class AtomicBaristaStockError extends Error {
  constructor(readonly outcome: Extract<AtomicBaristaStockMutation, { ok: false }>) {
    super(outcome.reason);
  }
}

export async function POST(request: NextRequest) {
  try {
    const mutationRequest = sanitizeForStorage(await request.json()) as AtomicBaristaStockMutationRequest;
    const committedRoot = await updateServerSyncedStorageRoot<Record<string, unknown>>((currentRoot) => {
      const outcome = applyAtomicBaristaStockMutation(currentRoot, mutationRequest);
      if (!outcome.ok) throw new AtomicBaristaStockError(outcome);
      return outcome.value;
    });
    const committedOutcome = applyAtomicBaristaStockMutation(committedRoot, mutationRequest);
    if (!committedOutcome.ok) throw new Error("The atomic Barista stock change could not be verified.");
    return NextResponse.json(committedOutcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AtomicBaristaStockError) {
      return NextResponse.json(
        error.outcome,
        { status: error.outcome.reason === "invalid-request" ? 400 : 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The Barista stock change failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
