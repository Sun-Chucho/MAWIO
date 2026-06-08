
export type Role = 'manager' | 'director' | 'inventory' | 'cashier' | 'kitchen' | 'barista';

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

export const STANDARD_ROOM_PRICE = 70000;
export const PLATINUM_ROOM_PRICE = 100000;

const PLATINUM_ROOM_NUMBERS = [
  "1001", "1002", "1003", "1004", "1005",
  "1006", "1007", "1008", "1009", "1010",
  "2001", "2002", "2003", "2004", "2005",
  "2006", "2007", "2008", "2009", "2010"
] as const;

const STANDARD_ROOM_NUMBERS = [
  "3001", "3002", "3003", "3004", "3005", "3006", "3007", "3008", "3009", "3010", "3011",
  "4001", "4002", "4003", "4004", "4005", "4006", "4007", "4008", "4009", "4010", "4011",
  "5001", "5002", "5003", "5004", "5005", "5006", "5007", "5008", "5009", "5010", "5011"
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
