export const STORAGE_KITCHEN_PURCHASE_SESSION = "orange-hotel-kitchen-purchase-session";
export const STORAGE_KITCHEN_PURCHASE_HISTORY = "orange-hotel-kitchen-purchase-history";
export const STORAGE_KITCHEN_DAILY_STOCK_SESSION = "orange-hotel-kitchen-daily-stock-session";
export const STORAGE_KITCHEN_DAILY_STOCK_HISTORY = "orange-hotel-kitchen-daily-stock-history";
export const STORAGE_BARISTA_PURCHASE_SESSION = "orange-hotel-barista-purchase-session";
export const STORAGE_BARISTA_PURCHASE_HISTORY = "orange-hotel-barista-purchase-history";
export const STORAGE_BARISTA_DAILY_STOCK_SESSION = "orange-hotel-barista-daily-stock-session";
export const STORAGE_BARISTA_DAILY_STOCK_HISTORY = "orange-hotel-barista-daily-stock-history";

export interface KitchenSessionSignoff {
  preparedBy: string;
  checkedBy: string;
  approvedBy: string;
  cashier: string;
}

export interface KitchenPurchaseLine {
  id: string;
  itemId: string | null;
  itemName: string;
  category: string;
  unit: string;
  previousBalance: number;
  addedQty: number;
  pricePerUnit: number;
  sellingPrice: number;
}

export interface KitchenPurchaseSession {
  id: string;
  startedAt: string;
  lines: KitchenPurchaseLine[];
}

export interface KitchenPurchaseHistoryEntry extends KitchenPurchaseSession {
  closedAt: string;
  signoff: KitchenSessionSignoff;
}

export interface KitchenDailyStockLine {
  id: string;
  itemId: string | null;
  itemName: string;
  category: string;
  unit: string;
  openingStock: number;
  received: number;
  used: number;
  wastage: number;
}

export interface KitchenDailyStockSession {
  id: string;
  startedAt: string;
  lines: KitchenDailyStockLine[];
}

export interface KitchenDailyStockHistoryEntry extends KitchenDailyStockSession {
  closedAt: string;
  signoff: KitchenSessionSignoff;
}
