export type TransferDestination = "kitchen" | "barista";
export type StoreLane = "kitchen" | "barista";

export interface MainStoreItem {
  id: string;
  name: string;
  stock: number;
  unit: string;
  minStock: number;
  lane: StoreLane;
  subCategory?: string;
  size?: string;
  buyingPrice?: number;
  sellingPrice?: number;
  totLimit?: number;
  totSold?: number;
  damages?: number;
  receivedStock?: number;
  /** Internal idempotency markers for POS stock effects. */
  appliedStockEffectIds?: string[];
  /** Inventory mirror deltas keyed by the same POS stock effect ID. */
  stockInventoryDeltas?: Record<string, number>;
  /** Append-only effects let concurrent terminals merge stock changes safely. */
  stockEffects?: Record<string, { kind: "units" | "tots"; delta: number; totLimit?: number; requiresEffectId?: string; inverseOfEffectId?: string }>;
  /** Compensating effects waiting for their referenced checkout effect. */
  pendingStockEffects?: Record<string, { kind: "units" | "tots"; delta: number; totLimit?: number; requiresEffectId?: string; inverseOfEffectId?: string }>;
}

export interface StoreMovementLog {
  id: string;
  itemId: string;
  itemName: string;
  source: "store";
  destination: TransferDestination;
  storeQtyMoved: number;
  storeUnit: string;
  conversionValue: number;
  conversionNote: string;
  convertedQty: number;
  movedAt: number;
}

export interface StockLogicRule {
  id: string;
  itemId: string;
  itemName: string;
  destination: TransferDestination;
  storeUnit: string;
  departmentUnit: string;
  unitToMenu: number;
  logicNote: string;
  updatedAt: number;
}

export interface StoreUsageLog {
  id: string;
  movementId: string;
  destination: TransferDestination;
  quantityUsed: number;
  usedAt: number;
}

export const STORAGE_INVENTORY_ITEMS = "orange-hotel-inventory-items";
export const STORAGE_MAIN_STORE_ITEMS = "orange-hotel-main-store-items";
export const STORAGE_STORE_MOVEMENTS = "orange-hotel-store-movements";
export const STORAGE_STORE_USAGE = "orange-hotel-store-usage";
export const STORAGE_STOCK_LOGIC = "orange-hotel-stock-logic";

export function getStoreItemLabel(item: Pick<MainStoreItem, "name" | "size">) {
  return item.size ? `${item.name} ${item.size}` : item.name;
}

export function normalizeStockName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const SODA_SIZE_RULES = [
  { pattern: /coca cola soda/, size: "350ml" },
  { pattern: /fanta soda/, size: "350ml" },
  { pattern: /krest bitter lemon/, size: "300ml" },
  { pattern: /krest tonic water/, size: "300ml" },
  { pattern: /krest soda water/, size: "300ml" },
  { pattern: /stoney soda/, size: "300ml" },
  { pattern: /krest ginger/, size: "300ml" },
] as const;

export function normalizeBaristaProductTarget(value: string) {
  const normalized = normalizeStockName(
    value.replace(/\s*(?:\((?:TOT|TOTS)\)|\b(?:TOT|TOTS)\b)/gi, " ").trim(),
  );

  if (normalized === "soda" || normalized.startsWith("soda ")) {
    if (normalized.includes("350ml")) return "soda 350ml";
    if (normalized.includes("300ml")) return "soda 300ml";
    return "soda";
  }

  for (const rule of SODA_SIZE_RULES) {
    if (rule.pattern.test(normalized)) {
      return `soda ${rule.size}`;
    }
  }

  return normalized;
}

export function adjustInventoryQuantity<
  T extends {
    name: string;
    category: string;
    stock: number;
    totPerBottle?: number;
    totSold?: number;
    size?: string;
  }
>(items: T[], category: string, itemName: string, delta: number) {
  const target = normalizeStockName(itemName);
  const isTotAdjustment = target.endsWith("tots");

  return items.map((item) => {
    const itemTarget = normalizeStockName(item.name);
    const itemWithSizeTarget = normalizeStockName(`${item.name} ${item.size ?? ""}`);
    
    const matches =
      item.category === category &&
      (itemTarget === target || itemWithSizeTarget === target);

    if (!matches) {
      return item;
    }

    // TOTS Logic
    if (isTotAdjustment && typeof item.totPerBottle === "number" && item.totPerBottle > 0) {
      const currentTotSold = typeof item.totSold === "number" ? item.totSold : 0;
      
      if (delta < 0) {
        // Sale/Consumption (delta is negative, e.g., -1 for 1 tot)
        const totsToDeduct = Math.abs(delta);
        const nextTotSold = currentTotSold + totsToDeduct;
        const bottlesToDeduct = Math.floor(nextTotSold / item.totPerBottle);
        
        return {
          ...item,
          stock: Math.max(0, item.stock - bottlesToDeduct),
          totSold: nextTotSold % item.totPerBottle,
        };
      } else {
        // Intake/Restore (delta is positive)
        const totsToAdd = delta;
        const totalTots = (item.stock * item.totPerBottle) + (item.totPerBottle - currentTotSold) + totsToAdd;
        const nextStock = Math.floor(totalTots / item.totPerBottle);
        const nextTotSold = item.totPerBottle - (totalTots % item.totPerBottle);

        return {
          ...item,
          stock: nextStock,
          totSold: nextTotSold === item.totPerBottle ? 0 : nextTotSold,
        };
      }
    }

    // Standard Logic (Bottles/Units)
    return {
      ...item,
      stock: Math.max(0, item.stock + delta),
    };
  });
}
