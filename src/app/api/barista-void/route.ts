import { NextRequest, NextResponse } from "next/server";
import {
  applyAtomicBaristaVoid,
  type AtomicBaristaVoidMutation,
  type AtomicBaristaVoidRequest,
} from "@/app/lib/barista-checkout-transaction";
import { updateServerSyncedStorageRoot } from "@/app/lib/firebase-server";
import { sanitizeForStorage } from "@/app/lib/storage-sanitize";

class AtomicBaristaVoidError extends Error {
  constructor(readonly outcome: Extract<AtomicBaristaVoidMutation, { ok: false }>) {
    super(outcome.reason);
  }
}

export async function POST(request: NextRequest) {
  try {
    const voidRequest = sanitizeForStorage(await request.json()) as AtomicBaristaVoidRequest;
    const committedRoot = await updateServerSyncedStorageRoot<Record<string, unknown>>((currentRoot) => {
      const outcome = applyAtomicBaristaVoid(currentRoot, voidRequest);
      if (!outcome.ok) throw new AtomicBaristaVoidError(outcome);
      return outcome.value;
    });
    const committedOutcome = applyAtomicBaristaVoid(committedRoot, voidRequest);
    if (!committedOutcome.ok) throw new Error("The atomic Barista void could not be verified.");
    return NextResponse.json(committedOutcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AtomicBaristaVoidError) {
      return NextResponse.json(
        error.outcome,
        { status: error.outcome.reason === "invalid-request" ? 400 : 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The Barista void could not be committed." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
