
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

export const STANDARD_ROOM_PRICE = 70000;
export const PLATINUM_ROOM_PRICE = 100000;

const STANDARD_ROOM_NUMBERS = [
  "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010",
  "1011", "1012", "1013", "1014", "1015", "1016", "1017", "1018", "1019", "1020",
  "1021", "1022", "1023", "1024", "1025", "1026", "1027", "1028", "1029", "1030",
  "1031", "1032", "1033"
] as const;

const PLATINUM_ROOM_NUMBERS = [
  "2001", "2002", "2003", "2004", "2005", "2006", "2007", "2008", "2009", "2010",
  "2011", "2012", "2013", "2014", "2015", "2016", "2017", "2018", "2019", "2020"
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
