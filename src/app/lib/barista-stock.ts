"use client";

import { MainStoreItem } from "@/app/lib/inventory-transfer";
import type { InventoryItem } from "@/app/lib/mock-data";

const TOT_MARKER_PATTERN = /\s*(?:\((?:TOT|TOTS)\)|\b(?:TOT|TOTS)\b)/gi;

const TOT_LIMITS_BY_LABEL: Record<string, number> = {
  "Jagermeister 700ml": 30,
  "Black & White 750ml": 30,
  "Gordons 750ml": 30,
  "Amarula 750ml": 30,
  "Hennessy VSOP 700ml": 28,
  "Hennessy VS BOX 700ml": 28,
  "Campari 750ml": 30,
  "Jack Daniels 700ml": 30,
  "J & B 750ml": 30,
  "Grants 750ml": 30,
  "Johnnie Walker Black Label 750ml": 30,
  "Johnnie Walker Red Label 750ml": 30,
  "Ballantines 750ml": 30,
  "Bacardi Superior White Rum 750ml": 30,
  "Camino Real Blanco 750ml": 30,
  "Captain Morgan Black Rum 750ml": 30,
  "Buttlers Blue Curacao 750ml": 30,
};

export type BaristaCatalogCategory = "espresso" | "coffee" | "tea" | "cold" | "snacks";

function normalizeBaristaCatalogCategory(value: string, itemName = ""): BaristaCatalogCategory {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedName = itemName.trim().toLowerCase();
  if (["espresso", "coffee", "tea", "cold", "snacks"].includes(normalizedValue)) {
    return normalizedValue as BaristaCatalogCategory;
  }
  if (["soft drink", "soda", "energy drink", "water", "beer", "wine", "cider", "spirit", "sparkling", "whisky", "gin", "liqueur", "cognac", "aperitif", "malt", "bar"].includes(normalizedValue)) {
    return "cold";
  }
  if (normalizedName.includes("espresso") || normalizedName.includes("macchiato")) return "espresso";
  if (normalizedName.includes("tea")) return "tea";
  if (normalizedName.includes("ice cream") || normalizedName.includes("snack")) return "snacks";
  if (["iced", "soda", "water", "juice", "beer", "wine"].some((token) => normalizedName.includes(token))) return "cold";
  return "coffee";
}

function getInventoryMenuLabel(item: Pick<InventoryItem, "name" | "size">) {
  const rawName = item.name.trim();
  const isTotItem = /\s*\(?TOTS?\)?$/i.test(rawName);
  const baseName = rawName.replace(/\s*\(?TOTS?\)?$/i, "").trim();
  const size = item.size?.trim() ?? "";
  if (!size) return isTotItem ? `${baseName} (TOTS)` : baseName;
  if (rawName.toLowerCase().includes(size.toLowerCase())) return rawName;
  return isTotItem ? `${baseName} ${size} (TOTS)`.trim() : `${baseName} ${size}`.trim();
}

export function buildInitialBaristaMenuItems(inventory: InventoryItem[]) {
  const deduped = new Map<string, {
    id: string;
    name: string;
    price: number;
    category: BaristaCatalogCategory;
    prepMinutes: number;
    barcode?: string;
    inventoryItemId?: string;
    storeItemId?: string;
  }>();

  inventory
    .filter((item) => {
      const status = item.status?.toUpperCase() ?? "ACTIVE";
      return status === "ACTIVE" && (item.category?.trim().toLowerCase() ?? "") !== "kitchen";
    })
    .forEach((item) => {
      const name = getInventoryMenuLabel(item);
      const isTotItem = (typeof item.totPerBottle === "number" && item.totPerBottle > 0) || /\s*\(?TOTS?\)?$/i.test(item.name);
      const key = `${getMenuBaseLabel(name).toLowerCase()}|${(item.category ?? "").toLowerCase()}|${isTotItem ? "tot" : "full"}`;
      const nextItem = {
        id: item.id,
        name,
        price:
          typeof item.sellingPrice === "number" && item.sellingPrice > 0
            ? item.sellingPrice
            : typeof item.price === "number" && item.price > 0
              ? item.price
              : 0,
        category: normalizeBaristaCatalogCategory(item.category, name),
        prepMinutes: 2,
        barcode: item.barcode || "",
        inventoryItemId: item.id,
      };
      const existing = deduped.get(key);
      if (!existing || nextItem.price > existing.price || (!!nextItem.barcode && !existing.barcode)) {
        deduped.set(key, nextItem);
      }
    });

  return Array.from(deduped.values());
}

export function getBaristaStoreLabel(item: Pick<MainStoreItem, "name" | "size">): string {
  const baseName = item.name.replace(TOT_MARKER_PATTERN, " ").replace(/\s+/g, " ").trim();
  const size = item.size?.trim() ?? "";
  if (!size || baseName.toLowerCase().includes(size.toLowerCase())) return baseName;
  return `${baseName} ${size}`.trim();
}

export function getMenuBaseLabel(menuName: string): string {
  return menuName.replace(TOT_MARKER_PATTERN, " ").replace(/\s+/g, " ").trim();
}

export function getTotLimit(item: Pick<MainStoreItem, "name" | "size" | "totLimit">): number {
  if (typeof item.totLimit === "number" && item.totLimit > 0) return item.totLimit;
  return TOT_LIMITS_BY_LABEL[getMenuBaseLabel(getBaristaStoreLabel(item))] ?? 0;
}

export function isTotTrackedMenuItem(menuName: string): boolean {
  return /\bTOTS?\b/i.test(menuName);
}

export function getRemainingTots(item: Pick<MainStoreItem, "name" | "size" | "stock" | "totLimit" | "totSold">): number {
  const limit = getTotLimit(item);
  if (limit <= 0) return 0;
  const sold = typeof item.totSold === "number" ? item.totSold : 0;
  return Math.max(0, item.stock * limit - sold);
}

export function getBaristaMenuLabel(item: Pick<MainStoreItem, "name" | "size" | "totLimit">): string {
  const storeLabel = getBaristaStoreLabel(item);
  const hasExplicitTotMarker = /\bTOTS?\b/i.test(item.name);
  return getTotLimit(item) > 0 || hasExplicitTotMarker ? `${storeLabel} (TOTS)` : storeLabel;
}

export function formatTotStatus(item: Pick<MainStoreItem, "name" | "size" | "stock" | "totLimit" | "totSold">): string {
  const limit = getTotLimit(item);
  if (limit <= 0) return "-";
  return `${getRemainingTots(item)} tots left`;
}

export function findStoreItemForMenuName(
  items: MainStoreItem[],
  menuName: string,
  storeItemId?: string,
): MainStoreItem | undefined {
  if (storeItemId) {
    const linkedItem = items.find((item) => item.id === storeItemId);
    if (linkedItem) return linkedItem;
  }
  const target = normalizeBaristaTarget(menuName);
  return items.find((item) => normalizeBaristaTarget(getBaristaStoreLabel(item)) === target);
}

function normalizeBaristaTarget(name: string) {
  return getMenuBaseLabel(name).toLowerCase();
}

export function normalizeBaristaMenuItems<
  T extends {
    id: string;
    name: string;
    price: number;
    category: string;
    prepMinutes: number;
    storeItemId?: string;
  },
>(menuItems: T[], storeItems: MainStoreItem[]) {
  return menuItems.map((item) => {
    const matchedStoreItem = findStoreItemForMenuName(storeItems, item.name, item.storeItemId);
    // The manager-published catalog name is authoritative. Normalization may
    // discover a legacy stock link, but it must never rename the menu item.
    return matchedStoreItem && item.storeItemId !== matchedStoreItem.id
      ? { ...item, storeItemId: matchedStoreItem.id }
      : item;
  });
}

export function getMenuStockStatus(items: MainStoreItem[], menuName: string, storeItemId?: string) {
  const matchedStoreItem = findStoreItemForMenuName(items, menuName, storeItemId);
  if (!matchedStoreItem) {
    return {
      available: true,
      label: "Menu Item",
    };
  }

  if (getTotLimit(matchedStoreItem) > 0 || isTotTrackedMenuItem(menuName)) {
    const remainingTots = getRemainingTots(matchedStoreItem);
    return {
      available: remainingTots > 0,
      label: `${remainingTots} tots left`,
    };
  }

  return {
    available: matchedStoreItem.stock > 0,
    label: `${matchedStoreItem.stock} ${matchedStoreItem.unit} left`,
  };
}
