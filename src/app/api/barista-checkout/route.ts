import { NextRequest, NextResponse } from "next/server";
import {
  applyAtomicBaristaCheckout,
  type AtomicBaristaCheckoutMutation,
  type AtomicBaristaCheckoutRequest,
} from "@/app/lib/barista-checkout-transaction";
import { updateServerSyncedStorageRoot } from "@/app/lib/firebase-server";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

class AtomicBaristaCheckoutError extends Error {
  constructor(readonly outcome: Extract<AtomicBaristaCheckoutMutation, { ok: false }>) {
    super(outcome.reason);
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json() as AtomicBaristaCheckoutRequest;
    const checkoutRequest = sanitizeForStorage(rawBody) as AtomicBaristaCheckoutRequest;
    const committedRoot = await updateServerSyncedStorageRoot<Record<string, unknown>>((currentRoot) => {
      const outcome = applyAtomicBaristaCheckout(currentRoot, checkoutRequest);
      if (!outcome.ok) throw new AtomicBaristaCheckoutError(outcome);
      return outcome.value;
    });

    const committedOutcome = applyAtomicBaristaCheckout(committedRoot, checkoutRequest);
    if (!committedOutcome.ok) {
      throw new Error("The atomic Barista checkout did not return a committed value.");
    }
    return NextResponse.json(
      committedOutcome,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AtomicBaristaCheckoutError) {
      const status = error.outcome.reason === "checkout-deleted"
        ? 410
        : error.outcome.reason === "invalid-request"
          ? 400
          : 409;
      return NextResponse.json(
        error.outcome,
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The Barista checkout could not be committed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
