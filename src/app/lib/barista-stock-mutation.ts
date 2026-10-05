import { InventoryItem } from "@/app/lib/mock-data";
import {
  adjustInventoryQuantity,
  getStoreItemLabel,
  MainStoreItem,
  normalizeBaristaProductTarget,
  normalizeStockName,
  STORAGE_INVENTORY_ITEMS,
  STORAGE_MAIN_STORE_ITEMS,
} from "@/app/lib/inventory-transfer";
import { findStoreItemForMenuName, getRemainingTots, getTotLimit, isTotTrackedMenuItem } from "@/app/lib/barista-stock";
import { readJson } from "@/app/lib/storage";

export type BaristaStockLine = {
  name: string;
  qty: number;
  itemId?: string;
  inventoryItemId?: string;
  storeItemId?: string;
};

export function hasStockEffect(
  item: Pick<MainStoreItem, "appliedStockEffectIds"> | Pick<InventoryItem, "appliedStockEffectIds">,
  effectId: string,
) {
  return item.appliedStockEffectIds?.includes(effectId) ?? false;
}

function appendStockEffectId(existing: string[] | undefined, effectId: string) {
  return Array.from(new Set([...(existing ?? []), effectId]));
}

function trackStoreStockEffect<T extends MainStoreItem>(
  item: T,
  effectId: string | undefined,
  inventoryDelta: number,
  stockEffect?: { kind: "units" | "tots"; delta: number; totLimit?: number; requiresEffectId?: string; inverseOfEffectId?: string },
): T {
  if (!effectId) return item;
  const appliedStockEffectIds = appendStockEffectId(item.appliedStockEffectIds, effectId);
  const stockInventoryDeltas = Object.fromEntries(
    Object.entries({ ...(item.stockInventoryDeltas ?? {}), [effectId]: inventoryDelta })
  );
  const stockEffects = stockEffect
    ? { ...(item.stockEffects ?? {}), [effectId]: stockEffect }
    : item.stockEffects;
  return { ...item, appliedStockEffectIds, stockInventoryDeltas, stockEffects } as T;
}

function queueStoreStockEffect<T extends MainStoreItem>(
  item: T,
  effectId: string | undefined,
  inventoryDelta: number,
  stockEffect: NonNullable<MainStoreItem["pendingStockEffects"]>[string],
): T {
  if (!effectId) return item;
  return {
    ...item,
    stockInventoryDeltas: {
      ...(item.stockInventoryDeltas ?? {}),
      [effectId]: inventoryDelta,
    },
    pendingStockEffects: {
      ...(item.pendingStockEffects ?? {}),
      [effectId]: stockEffect,
    },
  } as T;
}

export function findInventoryStockEffectTarget(
  items: InventoryItem[],
  category: string,
  itemName: string,
  preferredItemId?: string,
) {
  const target = normalizeStockName(itemName);
  return items.find((item) => {
    if (preferredItemId && item.id === preferredItemId) return true;
    return item.category === category && (
      normalizeStockName(item.name) === target ||
      normalizeStockName(`${item.name} ${item.size ?? ""}`) === target
    );
  });
}

export function applyTrackedInventoryEffect(
  items: InventoryItem[],
  category: string,
  itemName: string,
  delta: number,
  effectId: string | undefined,
  preferredItemId?: string,
  forceUnitDelta = false,
  stockEffectOverride?: NonNullable<InventoryItem["stockEffects"]>[string],
): InventoryItem[] {
  if (!effectId) return adjustInventoryQuantity(items, category, itemName, delta);
  const matchedItem = findInventoryStockEffectTarget(items, category, itemName, preferredItemId);
  if (!matchedItem || hasStockEffect(matchedItem, effectId)) return items;
  return items.map((item) => {
    if (item.id !== matchedItem.id) return item;
    let adjustedItem = item;
    const overrideTotLimit = Number(stockEffectOverride?.totLimit);
    const totPerBottle = Number.isFinite(overrideTotLimit) && overrideTotLimit > 0
      ? overrideTotLimit
      : typeof item.totPerBottle === "number"
        ? item.totPerBottle
        : 0;
    const isTotAdjustment =
      !forceUnitDelta &&
      totPerBottle > 0 &&
      (stockEffectOverride?.kind === "tots" || normalizeStockName(itemName).endsWith("tots") || Boolean(preferredItemId));
    if (delta !== 0 && isTotAdjustment) {
      const currentTotSold = typeof item.totSold === "number" ? item.totSold : 0;
      if (delta < 0) {
        const nextTotSold = currentTotSold + Math.abs(delta);
        adjustedItem = {
          ...item,
          stock: Math.max(0, item.stock - Math.floor(nextTotSold / totPerBottle)),
          totSold: nextTotSold % totPerBottle,
        };
      } else {
        const nextTotSold = currentTotSold - delta;
        if (nextTotSold >= 0) {
          adjustedItem = { ...item, totSold: nextTotSold };
        } else {
          const bottlesRestored = Math.ceil(Math.abs(nextTotSold) / totPerBottle);
          adjustedItem = {
            ...item,
            stock: item.stock + bottlesRestored,
            totSold: nextTotSold + bottlesRestored * totPerBottle,
          };
        }
      }
    } else if (delta !== 0) {
      adjustedItem = { ...item, stock: Math.max(0, item.stock + delta) };
    }
    const stockEffect: NonNullable<InventoryItem["stockEffects"]>[string] = stockEffectOverride ?? {
      kind: isTotAdjustment ? "tots" : "units",
      delta,
      ...(isTotAdjustment ? { totLimit: totPerBottle } : {}),
    };
    return {
      ...adjustedItem,
      appliedStockEffectIds: appendStockEffectId(adjustedItem.appliedStockEffectIds, effectId),
      stockEffects: {
        ...(adjustedItem.stockEffects ?? {}),
        [effectId]: stockEffect,
      },
    };
  });
}

function queueTrackedInventoryEffect(
  items: InventoryItem[],
  category: string,
  itemName: string,
  effectId: string | undefined,
  effect: NonNullable<InventoryItem["pendingStockEffects"]>[string],
  preferredItemId?: string,
) {
  if (!effectId) return items;
  const matchedItem = findInventoryStockEffectTarget(items, category, itemName, preferredItemId);
  if (!matchedItem || hasStockEffect(matchedItem, effectId) || matchedItem.pendingStockEffects?.[effectId]) {
    return items;
  }
  return items.map((item) => item.id === matchedItem.id
    ? {
        ...item,
        pendingStockEffects: {
          ...(item.pendingStockEffects ?? {}),
          [effectId]: effect,
        },
      }
    : item);
}

export function prepareBaristaStockMutation(
    lines: BaristaStockLine[],
    direction: "consume" | "restore",
    stockApplicationId?: string,
    requiredSourceStockApplicationId?: string,
) {
    const allStoreItems = readJson<Array<MainStoreItem & { lane?: "kitchen" | "barista" }>>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const otherStoreItems = allStoreItems.filter((entry) => entry.lane !== "barista");
    const currentBaristaItems = allStoreItems
      .filter((entry) => entry.lane === "barista")
      .map((entry) => ({ ...entry, lane: "barista" as const }));
    const nextBaristaItems = [...currentBaristaItems];
    let nextInventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const appliedEffects: Array<{
      id: string;
      target: "store" | "inventory";
      itemId: string;
      allowPending?: boolean;
    }> = [];

    for (const [lineIndex, line] of lines.entries()) {
      const effectSuffix = `${lineIndex}:${line.itemId ?? normalizeBaristaProductTarget(line.name)}`;
      const effectId = stockApplicationId
        ? `${stockApplicationId}:${effectSuffix}`
        : undefined;
      const requiredSourceEffectId = requiredSourceStockApplicationId
        ? `${requiredSourceStockApplicationId}:${effectSuffix}`
        : undefined;
      const matchedItem = findStoreItemForMenuName(nextBaristaItems, line.name, line.storeItemId);
      if (!matchedItem) {
        const inventoryMatch = line.inventoryItemId
          ? nextInventoryItems.find((item) => item.id === line.inventoryItemId)
          : nextInventoryItems.find((item) => {
          if (item.category !== "Bar") return false;
          const itemName = item.size ? `${item.name} ${item.size}` : item.name;
          return normalizeBaristaProductTarget(itemName) === normalizeBaristaProductTarget(line.name) || normalizeBaristaProductTarget(item.name) === normalizeBaristaProductTarget(line.name);
        });

        if (!inventoryMatch) {
          if (line.storeItemId || line.inventoryItemId) {
            return {
              ok: false as const,
              error: `The linked stock row for ${line.name} is missing. Ask a manager to relink the item before selling it.`,
            };
          }
          continue;
        }
        if (effectId && hasStockEffect(inventoryMatch, effectId)) {
          appliedEffects.push({ id: effectId, target: "inventory", itemId: inventoryMatch.id });
          continue;
        }
        const sourceEffect = requiredSourceEffectId
          ? inventoryMatch.stockEffects?.[requiredSourceEffectId]
          : undefined;
        if (direction === "restore" && requiredSourceEffectId && !sourceEffect) {
          const pendingEffect = {
            kind: "units" as const,
            delta: 0,
            requiresEffectId: requiredSourceEffectId,
            inverseOfEffectId: requiredSourceEffectId,
          };
          nextInventoryItems = queueTrackedInventoryEffect(
            nextInventoryItems,
            inventoryMatch.category,
            line.name,
            effectId,
            pendingEffect,
            inventoryMatch.id,
          );
          if (effectId) {
            appliedEffects.push({
              id: effectId,
              target: "inventory",
              itemId: inventoryMatch.id,
              allowPending: true,
            });
          }
          continue;
        }
        const availableUnits = typeof inventoryMatch.stock === "number" ? inventoryMatch.stock : 0;
        const availableTots = typeof inventoryMatch.totPerBottle === "number" && inventoryMatch.totPerBottle > 0
          ? availableUnits * inventoryMatch.totPerBottle - (typeof inventoryMatch.totSold === "number" ? inventoryMatch.totSold : 0)
          : availableUnits;

        if (direction === "consume" && line.qty > availableTots) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }

        const inventoryDelta = direction === "consume"
          ? -line.qty
          : sourceEffect
            ? -sourceEffect.delta
            : line.qty;
        nextInventoryItems = applyTrackedInventoryEffect(
          nextInventoryItems,
          inventoryMatch.category,
          line.name,
          inventoryDelta,
          effectId,
          inventoryMatch.id,
          false,
          direction === "restore" && requiredSourceEffectId
            ? {
                ...(sourceEffect ?? { kind: "units" as const, delta: -line.qty }),
                delta: inventoryDelta,
                requiresEffectId: requiredSourceEffectId,
                inverseOfEffectId: requiredSourceEffectId,
              }
            : undefined,
        );
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: inventoryMatch.id,
            allowPending: direction === "restore" && Boolean(requiredSourceEffectId),
          });
        }
        continue;
      }

      const itemIndex = nextBaristaItems.findIndex((entry) => entry.id === matchedItem.id);
      if (itemIndex < 0) continue;

      const currentItem = nextBaristaItems[itemIndex];
      const inventoryLabel = getStoreItemLabel(currentItem);
      const linkedInventoryItem = findInventoryStockEffectTarget(
        nextInventoryItems,
        "Bar",
        inventoryLabel,
        line.inventoryItemId,
      );
      const sourceStoreEffect = requiredSourceEffectId
        ? currentItem.stockEffects?.[requiredSourceEffectId]
        : undefined;
      const sourceInventoryEffect = requiredSourceEffectId
        ? linkedInventoryItem?.stockEffects?.[requiredSourceEffectId]
        : undefined;
      const applyInventoryMirror = (
        delta: number,
        effectOverride?: NonNullable<InventoryItem["stockEffects"]>[string],
        forceUnitDelta = true,
      ) => {
        if (!linkedInventoryItem) return;
        nextInventoryItems = applyTrackedInventoryEffect(
          nextInventoryItems,
          "Bar",
          inventoryLabel,
          delta,
          effectId,
          linkedInventoryItem.id,
          forceUnitDelta,
          effectOverride,
        );
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: linkedInventoryItem.id,
            allowPending: direction === "restore" && Boolean(requiredSourceEffectId),
          });
        }
      };
      const applyOrQueueDependentInventoryRestore = () => {
        if (!linkedInventoryItem || !effectId || !requiredSourceEffectId) return;
        if (!sourceInventoryEffect) {
          nextInventoryItems = queueTrackedInventoryEffect(
            nextInventoryItems,
            "Bar",
            inventoryLabel,
            effectId,
            {
              kind: "units",
              delta: 0,
              requiresEffectId: requiredSourceEffectId,
              inverseOfEffectId: requiredSourceEffectId,
            },
            linkedInventoryItem.id,
          );
          appliedEffects.push({
            id: effectId,
            target: "inventory",
            itemId: linkedInventoryItem.id,
            allowPending: true,
          });
          return;
        }
        applyInventoryMirror(-sourceInventoryEffect.delta, {
          ...sourceInventoryEffect,
          delta: -sourceInventoryEffect.delta,
          requiresEffectId: requiredSourceEffectId,
          inverseOfEffectId: requiredSourceEffectId,
        }, sourceInventoryEffect.kind !== "tots");
      };
      if (effectId && hasStockEffect(currentItem, effectId)) {
        if (direction === "restore" && requiredSourceEffectId) {
          applyOrQueueDependentInventoryRestore();
        } else {
          const existingStoreEffect = currentItem.stockEffects?.[effectId];
          if (existingStoreEffect?.kind === "tots") {
            applyInventoryMirror(existingStoreEffect.delta, existingStoreEffect, false);
          } else {
            applyInventoryMirror(currentItem.stockInventoryDeltas?.[effectId] ?? 0);
          }
        }
        appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
        continue;
      }
      if (direction === "restore" && requiredSourceEffectId && !sourceStoreEffect) {
        nextBaristaItems[itemIndex] = queueStoreStockEffect(
          currentItem,
          effectId,
          0,
          {
            kind: getTotLimit(currentItem) > 0 ? "tots" : "units",
            delta: 0,
            ...(getTotLimit(currentItem) > 0 ? { totLimit: getTotLimit(currentItem) } : {}),
            requiresEffectId: requiredSourceEffectId,
            inverseOfEffectId: requiredSourceEffectId,
          },
        );
        applyOrQueueDependentInventoryRestore();
        if (effectId) {
          appliedEffects.push({
            id: effectId,
            target: "store",
            itemId: currentItem.id,
            allowPending: true,
          });
        }
        continue;
      }
      if (getTotLimit(currentItem) > 0 || isTotTrackedMenuItem(line.name)) {
        const totLimit = getTotLimit(currentItem);
        if (totLimit <= 0) {
          return { ok: false as const, error: `Missing tot limit for ${line.name}.` };
        }

        const currentTotSold = typeof currentItem.totSold === "number" && currentItem.totSold > 0 ? currentItem.totSold : 0;
        if (direction === "consume") {
          const remainingTots = getRemainingTots(currentItem);
          if (line.qty > remainingTots) {
            return { ok: false as const, error: `Not enough tots remaining for ${line.name}.` };
          }

          const totalTotSold = currentTotSold + line.qty;
          const bottlesConsumed = Math.floor(totalTotSold / totLimit);
          nextBaristaItems[itemIndex] = trackStoreStockEffect(
            {
              ...currentItem,
              stock: currentItem.stock - bottlesConsumed,
              totLimit,
              totSold: totalTotSold % totLimit,
            },
            effectId,
            -bottlesConsumed,
            { kind: "tots", delta: -line.qty, totLimit },
          );
          applyInventoryMirror(-line.qty, { kind: "tots", delta: -line.qty, totLimit }, false);
          if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
          continue;
        }

        const restoreQty = sourceStoreEffect ? Math.abs(sourceStoreEffect.delta) : line.qty;
        const restoreInventoryDelta = requiredSourceEffectId
          ? -(currentItem.stockInventoryDeltas?.[requiredSourceEffectId] ?? 0)
          : 0;
        const dependentRestoreFields = requiredSourceEffectId
          ? { requiresEffectId: requiredSourceEffectId, inverseOfEffectId: requiredSourceEffectId }
          : {};
        const totalTotSold = currentTotSold - restoreQty;
        if (totalTotSold >= 0) {
          nextBaristaItems[itemIndex] = trackStoreStockEffect(
            { ...currentItem, totLimit, totSold: totalTotSold },
            effectId,
            restoreInventoryDelta,
            { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
          );
          if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
          else applyInventoryMirror(
            restoreQty,
            { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
            false,
          );
          if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
          continue;
        }

        const bottlesRestored = Math.ceil(Math.abs(totalTotSold) / totLimit);
        nextBaristaItems[itemIndex] = trackStoreStockEffect(
          {
            ...currentItem,
            stock: currentItem.stock + bottlesRestored,
            totLimit,
            totSold: totalTotSold + bottlesRestored * totLimit,
          },
          effectId,
          requiredSourceEffectId ? restoreInventoryDelta : bottlesRestored,
          { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
        );
        if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
        else applyInventoryMirror(
          restoreQty,
          { kind: "tots", delta: restoreQty, totLimit, ...dependentRestoreFields },
          false,
        );
        if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
        continue;
      }

      if (direction === "consume") {
        if (line.qty > currentItem.stock) {
          return { ok: false as const, error: `Not enough stock for ${line.name}.` };
        }
        nextBaristaItems[itemIndex] = trackStoreStockEffect(
          { ...currentItem, stock: currentItem.stock - line.qty },
          effectId,
          -line.qty,
          { kind: "units", delta: -line.qty },
        );
        applyInventoryMirror(-line.qty);
        if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id });
        continue;
      }

      const restoreUnits = sourceStoreEffect ? Math.abs(sourceStoreEffect.delta) : line.qty;
      nextBaristaItems[itemIndex] = trackStoreStockEffect(
        { ...currentItem, stock: currentItem.stock + restoreUnits },
        effectId,
        requiredSourceEffectId
          ? -(currentItem.stockInventoryDeltas?.[requiredSourceEffectId] ?? 0)
          : restoreUnits,
        {
          kind: "units",
          delta: restoreUnits,
          ...(requiredSourceEffectId
            ? { requiresEffectId: requiredSourceEffectId, inverseOfEffectId: requiredSourceEffectId }
            : {}),
        },
      );
      if (requiredSourceEffectId) applyOrQueueDependentInventoryRestore();
      else applyInventoryMirror(restoreUnits);
      if (effectId) appliedEffects.push({ id: effectId, target: "store", itemId: currentItem.id, allowPending: Boolean(requiredSourceEffectId) });
    }

    const nextStoreItems = [...otherStoreItems, ...nextBaristaItems];
    return {
      ok: true as const,
      appliedEffects,
      storeItems: nextStoreItems,
      inventoryItems: nextInventoryItems,
    };
  }
