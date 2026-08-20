export type Role = "manager" | "director" | "inventory" | "cashier" | "kitchen" | "barista" | "standard";

export interface User {
  id: string;
  name: string;
  role: Role;
  avatar: string;
}

export const USERS: User[] = [
  { id: "u1", name: "JACKLINE", role: "cashier", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Jackline" },
  { id: "u2", name: "MONDY", role: "cashier", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Mondy" },
  { id: "u3", name: "LINDA", role: "cashier", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Linda" },
  { id: "u4", name: "FORTUNATA", role: "cashier", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Fortunata" },
];

export interface Room {
  id: string;
  number: string;
  type: "Standard";
  status: "available" | "occupied" | "cleaning" | "maintenance";
  price: number;
}

export const STANDARD_ROOM_PRICE = 20000;

const STANDARD_ROOM_NUMBERS = [
  "101", "102", "103", "104", "105", "106", "107", "108", "110", "111", "113", "133",
] as const;

export const ROOMS: Room[] = STANDARD_ROOM_NUMBERS.map((number) => ({
  id: `r${number}`,
  number,
  type: "Standard",
  status: "available",
  price: STANDARD_ROOM_PRICE,
}));

export function getDefaultRoomsForTier(): Room[] {
  return ROOMS.map((room) => ({ ...room }));
}

export interface InventoryItem {
  id: string;
  barcode: string;
  name: string;
  category: string;
  subCategory?: string;
  size: string;
  stock: number;
  totPerBottle?: number;
  totSold: number;
  buyingPrice: number;
  sellingPrice: number;
  price?: number;
  status: "ACTIVE" | "INACTIVE";
  minStock: number;
  unit: string;
  damages?: number;
  receivedStock?: number;
}

export const INVENTORY: InventoryItem[] = [];

export const SALES_HISTORY: Array<{
  date: string;
  totalRevenue: number;
  roomRevenue: number;
  foodAndDrinksRevenue: number;
}> = [];
