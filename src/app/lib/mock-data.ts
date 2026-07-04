
export type Role = 'manager' | 'director' | 'inventory' | 'cashier' | 'kitchen' | 'barista' | 'standard' | 'platinum';

export interface User {
  id: string;
  name: string;
  role: Role;
  avatar: string;
}

export const USERS: User[] = [
  { id: 'u1', name: 'JACKLINE', role: 'cashier', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jackline' },
  { id: 'u2', name: 'MONDY', role: 'cashier', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Mondy' },
  { id: 'u3', name: 'LINDA', role: 'cashier', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Linda' },
  { id: 'u4', name: 'FORTUNATA', role: 'cashier', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Fortunata' },
];

export interface Room {
  id: string;
  number: string;
  type: 'Standard' | 'Platinum';
  status: 'available' | 'occupied' | 'cleaning' | 'maintenance';
  price: number;
}

export const STANDARD_ROOM_PRICE = 20000;
export const PLATINUM_ROOM_PRICE = 30000;

const STANDARD_ROOM_NUMBERS = [
  "101", "102", "103", "104", "105", "106", "107", "108", "110", "111", "113", "133"
] as const;

const PLATINUM_ROOM_NUMBERS = [
  "109", "110", "112", "114", "115", "116", "117", "118", "119", "120",
  "121", "122", "123", "124", "125", "126", "127", "128", "129", "130",
  "131", "132"
] as const;

export const PREMIUM_STANDARD_ROOM_PRICE = 60000;
export const PREMIUM_DELUXE_ROOM_PRICE = 80000;

export const PREMIUM_STANDARD_ROOM_NUMBERS = [
  "301", "306", "308", "313", "314", "315", "317", "318", "319", "320"
] as const;

export const PREMIUM_DELUXE_ROOM_NUMBERS = [
  "302", "303", "304", "305", "307", "309", "310", "311", "312", "316"
] as const;

const standardRooms: Room[] = STANDARD_ROOM_NUMBERS.map((number) => ({
  id: `r${number}`,
  number,
  type: "Standard",
  status: "available",
  price: STANDARD_ROOM_PRICE,
}));

const platinumRooms: Room[] = PLATINUM_ROOM_NUMBERS.map((number) => ({
  id: `r${number}`,
  number,
  type: "Platinum",
  status: "available",
  price: PLATINUM_ROOM_PRICE,
}));

export const ROOMS: Room[] = [...standardRooms, ...platinumRooms];

// Premium (platinum) hotel rooms are a fully separate set — numbers 301-320 —
// split into two rate classes by explicit room-number lists.
export const PLATINUM_HOTEL_ROOMS: Room[] = [
  ...PREMIUM_STANDARD_ROOM_NUMBERS.map((number): Room => ({
    id: `r${number}`,
    number,
    type: "Standard",
    status: "available",
    price: PREMIUM_STANDARD_ROOM_PRICE,
  })),
  ...PREMIUM_DELUXE_ROOM_NUMBERS.map((number): Room => ({
    id: `r${number}`,
    number,
    type: "Platinum",
    status: "available",
    price: PREMIUM_DELUXE_ROOM_PRICE,
  })),
];

export function getDefaultRoomsForTier(tier: "standard" | "platinum"): Room[] {
  return (tier === "platinum" ? PLATINUM_HOTEL_ROOMS : ROOMS).map((room) => ({ ...room }));
}

export interface InventoryItem {
  id: string;
  barcode: string;
  name: string;
  category: string;
  subCategory?: string;
  size: string;
  stock: number; // Bottles or Units
  totPerBottle?: number;
  totSold: number; // Currently sold tots from the active bottle
  buyingPrice: number;
  sellingPrice: number;
  price?: number;
  status: 'ACTIVE' | 'INACTIVE';
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
