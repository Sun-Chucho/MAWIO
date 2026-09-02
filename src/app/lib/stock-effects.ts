export type StockEffect = {
  kind: "units" | "tots";
  delta: number;
  totLimit?: number;
  requiresEffectId?: string;
  inverseOfEffectId?: string;
};

type StockEffectRecord = Record<string, unknown> & {
  id?: unknown;
  stock?: unknown;
  totSold?: unknown;
  totLimit?: unknown;
  totPerBottle?: unknown;
  appliedStockEffectIds?: unknown;
  stockEffects?: unknown;
  pendingStockEffects?: unknown;
  stockInventoryDeltas?: unknown;
};

function getRecordId(record: unknown) {
  if (typeof record !== "object" || record === null) return "";
  const id = (record as StockEffectRecord).id;
  return typeof id === "string" ? id : "";
}

function parseStockEffects(rawEffects: unknown) {
  if (typeof rawEffects !== "object" || rawEffects === null || Array.isArray(rawEffects)) {
    return {} as Record<string, StockEffect>;
  }
  return Object.fromEntries(
    Object.entries(rawEffects).filter((entry): entry is [string, StockEffect] => {
      const effect = entry[1] as Partial<StockEffect> | null;
      return Boolean(
        entry[0] &&
        effect &&
        (effect.kind === "units" || effect.kind === "tots") &&
        typeof effect.delta === "number" &&
        Number.isFinite(effect.delta) &&
        (effect.requiresEffectId === undefined || typeof effect.requiresEffectId === "string") &&
        (effect.inverseOfEffectId === undefined || typeof effect.inverseOfEffectId === "string"),
      );
    }),
  );
}

function getStockEffects(record: unknown) {
  if (typeof record !== "object" || record === null) return {} as Record<string, StockEffect>;
  return parseStockEffects((record as StockEffectRecord).stockEffects);
}

function getPendingStockEffects(record: unknown) {
  if (typeof record !== "object" || record === null) return {} as Record<string, StockEffect>;
  return parseStockEffects((record as StockEffectRecord).pendingStockEffects);
}

function applyStockEffect(record: StockEffectRecord, effect: StockEffect) {
  const stock = Number(record.stock);
  const currentStock = Number.isFinite(stock) ? stock : 0;
  if (effect.kind === "units") {
    return { ...record, stock: currentStock + effect.delta };
  }

  const rawLimit = Number(effect.totLimit ?? record.totLimit ?? record.totPerBottle);
  const totLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 0;
  if (totLimit <= 0) return record;
  const rawTotSold = Number(record.totSold);
  const currentTotSold = Number.isFinite(rawTotSold) && rawTotSold > 0 ? rawTotSold : 0;
  if (effect.delta < 0) {
    const nextTotSold = currentTotSold + Math.abs(effect.delta);
    return {
      ...record,
      stock: Math.max(0, currentStock - Math.floor(nextTotSold / totLimit)),
      totSold: nextTotSold % totLimit,
    };
  }

  const nextTotSold = currentTotSold - effect.delta;
  if (nextTotSold >= 0) return { ...record, totSold: nextTotSold };
  const bottlesRestored = Math.ceil(Math.abs(nextTotSold) / totLimit);
  return {
    ...record,
    stock: currentStock + bottlesRestored,
    totSold: nextTotSold + bottlesRestored * totLimit,
  };
}

function canApplyStockEffect(record: StockEffectRecord, effect: StockEffect) {
  if (effect.delta >= 0) return true;
  const stock = Number(record.stock);
  const currentStock = Number.isFinite(stock) ? stock : 0;
  if (effect.kind === "units") return currentStock + effect.delta >= 0;
  const rawLimit = Number(effect.totLimit ?? record.totLimit ?? record.totPerBottle);
  const totLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 0;
  if (totLimit <= 0) return false;
  const rawTotSold = Number(record.totSold);
  const currentTotSold = Number.isFinite(rawTotSold) && rawTotSold > 0 ? rawTotSold : 0;
  return Math.abs(effect.delta) <= currentStock * totLimit - currentTotSold;
}

function resolveStockEffect(
  effect: StockEffect,
  appliedEffects: Record<string, StockEffect>,
): StockEffect | null {
  if (!effect.inverseOfEffectId) return effect;
  const sourceEffect = appliedEffects[effect.inverseOfEffectId];
  if (!sourceEffect) return null;
  return {
    ...sourceEffect,
    delta: -sourceEffect.delta,
    requiresEffectId: effect.requiresEffectId ?? effect.inverseOfEffectId,
    inverseOfEffectId: effect.inverseOfEffectId,
  };
}

/**
 * Merge append-only stock effects into transaction-current inventory records.
 * When at least one unseen effect exists, remote fields are the baseline so a
 * sale from a stale terminal cannot overwrite another terminal's deduction.
 */
export type StockEffectMergeIntent = "manager" | "manager-purchase" | "operational" | "auto";

export function mergeStockEffectArrays(
  incomingValue: unknown,
  currentValue: unknown,
  intent: StockEffectMergeIntent = "auto",
) {
  if (!Array.isArray(incomingValue) || !Array.isArray(currentValue)) {
    return incomingValue;
  }
  if (currentValue.length === 0) return intent === "operational" ? [] : incomingValue;

  const currentById = new Map(currentValue.map((record) => [getRecordId(record), record]));
  const incomingById = new Map(incomingValue.map((record) => [getRecordId(record), record]));
  const incomingHasUnseenEffect = incomingValue.some((record) => {
    const id = getRecordId(record);
    const currentRecord = id ? currentById.get(id) : undefined;
    if (!currentRecord) return false;
    const currentEffects = getStockEffects(currentRecord);
    const currentPendingEffects = getPendingStockEffects(currentRecord);
    return Object.keys(getStockEffects(record)).some((effectId) => !currentEffects[effectId]) ||
      Object.keys(getPendingStockEffects(record)).some((effectId) => !currentPendingEffects[effectId]);
  });
  const remoteHasEffectsMissingFromIncoming = currentValue.some((currentRecord) => {
    const id = getRecordId(currentRecord);
    const incomingRecord = id ? incomingById.get(id) : undefined;
    const remoteEffects = getStockEffects(currentRecord);
    const remotePendingEffects = getPendingStockEffects(currentRecord);
    if (!incomingRecord) {
      return Object.keys(remoteEffects).length > 0 || Object.keys(remotePendingEffects).length > 0;
    }
    const incomingEffects = getStockEffects(incomingRecord);
    const incomingPendingEffects = getPendingStockEffects(incomingRecord);
    return Object.keys(remoteEffects).some((effectId) => !incomingEffects[effectId]) ||
      Object.keys(remotePendingEffects).some((effectId) => !incomingPendingEffects[effectId]);
  });
  if (
    intent !== "operational" &&
    !incomingHasUnseenEffect &&
    !remoteHasEffectsMissingFromIncoming
  ) {
    return incomingValue;
  }

  const mergedById = new Map<string, unknown>();
  currentValue.forEach((record) => {
    const id = getRecordId(record);
    if (id) mergedById.set(id, record);
  });

  incomingValue.forEach((incomingRecord) => {
    const id = getRecordId(incomingRecord);
    if (!id) return;
    const currentRecord = mergedById.get(id);
    if (typeof currentRecord !== "object" || currentRecord === null) {
      // A genuinely new manager-created record has no transaction-current
      // stock baseline to protect. Operational writes must never resurrect a
      // row that a manager deleted after the cashier hydrated it.
      if (intent !== "operational") mergedById.set(id, incomingRecord);
      return;
    }

    const remote = currentRecord as StockEffectRecord;
    const incoming = incomingRecord as StockEffectRecord;
    const currentEffects = getStockEffects(remote);
    const currentPendingEffects = getPendingStockEffects(remote);
    const incomingEffects = getStockEffects(incoming);
    const incomingPendingEffects = getPendingStockEffects(incoming);
    const recordLedgerChanged =
      JSON.stringify(Object.entries(currentEffects).sort(([left], [right]) => left.localeCompare(right))) !==
        JSON.stringify(Object.entries(incomingEffects).sort(([left], [right]) => left.localeCompare(right))) ||
      JSON.stringify(Object.entries(currentPendingEffects).sort(([left], [right]) => left.localeCompare(right))) !==
        JSON.stringify(Object.entries(incomingPendingEffects).sort(([left], [right]) => left.localeCompare(right)));
    if (!recordLedgerChanged) {
      if (intent === "operational" || intent === "manager-purchase") {
        // An idempotent retry may carry an old menu price/name. The shared
        // record is authoritative once the same effect ledger is already
        // present. This also protects unrelated rows during a purchase save.
        mergedById.set(id, {
          ...incoming,
          ...remote,
        });
      } else {
        // With an unchanged ledger this is an ordinary manager quantity or
        // metadata edit, so the incoming record is intentional.
        mergedById.set(id, incomingRecord);
      }
      return;
    }
    const incomingIntroducesOperationalEffect = intent === "operational" || (
      intent === "auto" && (
      Object.keys(incomingEffects).some((effectId) => !currentEffects[effectId] && !currentPendingEffects[effectId]) ||
      Object.keys(incomingPendingEffects).some((effectId) => !currentEffects[effectId] && !currentPendingEffects[effectId]) ||
      Object.keys(incomingPendingEffects).length > 0
      )
    );

    // Operational POS writes append effects to transaction-current metadata,
    // so a stale cashier cannot revert a manager's latest name or price. A
    // manager purchase keeps its new buying-price metadata while applying the
    // received quantity to transaction-current stock and effect ledgers.
    let nextRecord: StockEffectRecord = {
      ...(incomingIntroducesOperationalEffect ? incoming : remote),
      ...(incomingIntroducesOperationalEffect ? remote : incoming),
      stock: remote.stock,
      totSold: remote.totSold,
      appliedStockEffectIds: remote.appliedStockEffectIds,
      stockEffects: remote.stockEffects,
      pendingStockEffects: remote.pendingStockEffects,
      stockInventoryDeltas: remote.stockInventoryDeltas,
    };
    const stockEffects: Record<string, StockEffect> = { ...currentEffects };
    const pendingStockEffects: Record<string, StockEffect> = { ...currentPendingEffects };
    const candidateEffects = { ...incomingEffects, ...incomingPendingEffects };

    Object.entries(candidateEffects).forEach(([effectId, effect]) => {
      if (stockEffects[effectId] || pendingStockEffects[effectId]) return;
      if (effect.requiresEffectId && !stockEffects[effect.requiresEffectId]) {
        pendingStockEffects[effectId] = effect;
        return;
      }
      const resolvedEffect = resolveStockEffect(effect, stockEffects);
      if (!resolvedEffect || !canApplyStockEffect(nextRecord, resolvedEffect)) return;
      nextRecord = applyStockEffect(nextRecord, resolvedEffect);
      stockEffects[effectId] = resolvedEffect;
    });

    // A cancellation may reach shared storage before the original consume.
    // Once that consume appears, apply its queued inverse in this same atomic
    // merge so stock can never be inflated or left deducted by message order.
    let appliedPending = true;
    while (appliedPending) {
      appliedPending = false;
      Object.entries(pendingStockEffects).forEach(([effectId, effect]) => {
        if (effect.requiresEffectId && !stockEffects[effect.requiresEffectId]) return;
        const resolvedEffect = resolveStockEffect(effect, stockEffects);
        if (!resolvedEffect || !canApplyStockEffect(nextRecord, resolvedEffect)) return;
        nextRecord = applyStockEffect(nextRecord, resolvedEffect);
        stockEffects[effectId] = resolvedEffect;
        delete pendingStockEffects[effectId];
        appliedPending = true;
      });
    }

    const retainedEffectIds = Object.keys(stockEffects);
    const retainedLedgerIds = new Set([
      ...retainedEffectIds,
      ...Object.keys(pendingStockEffects),
    ]);
    nextRecord = {
      ...nextRecord,
      stockEffects,
      pendingStockEffects: Object.keys(pendingStockEffects).length > 0 ? pendingStockEffects : undefined,
      appliedStockEffectIds: retainedEffectIds,
      stockInventoryDeltas: {
        ...(remote.stockInventoryDeltas as Record<string, number> | undefined),
        ...Object.fromEntries(
          Object.entries(
            incoming.stockInventoryDeltas as Record<string, number> | undefined ?? {},
          ).filter(([effectId]) => retainedLedgerIds.has(effectId)),
        ),
      },
    };
    mergedById.set(id, nextRecord);
  });

  return Array.from(mergedById.values());
}
