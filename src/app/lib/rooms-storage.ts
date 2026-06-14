import { PLATINUM_ROOM_PRICE, ROOMS, Room, STANDARD_ROOM_PRICE, PREMIUM_STANDARD_ROOM_PRICE, PREMIUM_DELUXE_ROOM_PRICE } from "@/app/lib/mock-data";
import { readJson, writeJson } from "@/app/lib/storage";
import { getLocalMawioTier } from "./login-profiles";

interface ActiveBookingRoom {
  roomNumber: string;
  status?: "completed" | "credit" | "checked-out";
  checkOutDate?: string;
  checkOutTime?: string;
}

export const STORAGE_ROOMS = "orange-hotel-rooms-state";

function getRoomStorageKey(scope?: "standard" | "platinum"): string {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  return activeScope === "platinum" ? "orange-hotel-rooms-state-platinum" : STORAGE_ROOMS;
}

function getDefaultRoomsByType(type: "Standard" | "Platinum"): Room[] {
  return ROOMS.filter(room => room.type === type).map((room) => ({ ...room }));
}

export function getDefaultRooms(scope?: "standard" | "platinum"): Room[] {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  if (activeScope === "platinum") {
    const standardRooms: Room[] = [
      "301", "302", "303", "304", "305", "306", "307", "308", "309", "310"
    ].map((number) => ({
      id: `r${number}`,
      number,
      type: "Standard",
      status: "available" as Room["status"],
      price: PREMIUM_STANDARD_ROOM_PRICE,
    }));

    const deluxeRooms: Room[] = [
      "311", "312", "313", "314", "315", "316", "317", "318", "319", "320"
    ].map((number) => ({
      id: `r${number}`,
      number,
      type: "Platinum",
      status: "available" as Room["status"],
      price: PREMIUM_DELUXE_ROOM_PRICE,
    }));

    return [...standardRooms, ...deluxeRooms];
  }

  return getDefaultRoomsByType("Standard").concat(getDefaultRoomsByType("Platinum"));
}

function getRoomRateByType(type: Room["type"]) {
  return type === "Standard" ? STANDARD_ROOM_PRICE : PLATINUM_ROOM_PRICE;
}

function normalizeRoomRates(rooms: Room[]): Room[] {
  return rooms.map((room) => {
    const price = getRoomRateByType(room.type);
    return room.price === price ? room : { ...room, price };
  });
}

export function readRoomsState(scope?: "standard" | "platinum"): Room[] {
  const key = getRoomStorageKey(scope);
  const saved = readJson<Room[]>(key);
  if (!Array.isArray(saved) || saved.length === 0) {
    return getDefaultRooms(scope);
  }
  return normalizeRoomRates(saved);
}

function hasSavedRoomsState(scope?: "standard" | "platinum"): boolean {
  const key = getRoomStorageKey(scope);
  const saved = readJson<Room[]>(key);
  return Array.isArray(saved) && saved.length > 0;
}

export function writeRoomsState(rooms: Room[], scope?: "standard" | "platinum") {
  const normalizedRooms = normalizeRoomRates(rooms);
  const key = getRoomStorageKey(scope);
  const saved = readJson<Room[]>(key);
  if (Array.isArray(saved) && JSON.stringify(saved) === JSON.stringify(normalizedRooms)) return;
  writeJson(key, normalizedRooms);
}

function readBaseRooms(baseRooms?: Room[], scope?: "standard" | "platinum") {
  return Array.isArray(baseRooms) && baseRooms.length > 0
    ? baseRooms
    : hasSavedRoomsState(scope)
      ? readRoomsState(scope)
      : getDefaultRooms(scope);
}

export function getActiveBookedRoomNumbers(bookings: ActiveBookingRoom[]) {
  return new Set(
    bookings
      .filter((booking) => isBookingStillActive(booking))
      .map((booking) => booking.roomNumber),
  );
}

function reconcileRooms(rooms: Room[], occupiedRooms: Set<string>): Room[] {
  return rooms.map((room) => {
    if (occupiedRooms.has(room.number)) {
      return room.status === "occupied" ? room : { ...room, status: "occupied" as Room["status"] };
    }

    if (room.status === "occupied") {
      return { ...room, status: "available" as Room["status"] };
    }

    return room;
  });
}

export function updateRoomStatusByNumber(roomNumber: string, status: Room["status"], baseRooms?: Room[], scope?: "standard" | "platinum"): Room[] {
  const nextRooms = readBaseRooms(baseRooms, scope).map((room) =>
    room.number === roomNumber ? { ...room, status } : room,
  );
  writeRoomsState(nextRooms, scope);
  return nextRooms;
}

export function updateRoomStatusById(roomId: string, status: Room["status"], baseRooms?: Room[], scope?: "standard" | "platinum"): Room[] {
  const nextRooms = readBaseRooms(baseRooms, scope).map((room) =>
    room.id === roomId ? { ...room, status } : room,
  );
  writeRoomsState(nextRooms, scope);
  return nextRooms;
}

export function isBookingStillActive(booking: ActiveBookingRoom) {
  return booking.status !== "checked-out";
}

export function deriveRoomsStateFromBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[], scope?: "standard" | "platinum"): Room[] {
  const occupiedRooms = getActiveBookedRoomNumbers(bookings);
  const currentRooms = readBaseRooms(baseRooms, scope);
  return reconcileRooms(currentRooms, occupiedRooms);
}

export function syncRoomsStateFromBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[], scope?: "standard" | "platinum") {
  const nextRooms = deriveRoomsStateFromBookings(bookings, baseRooms, scope);
  writeRoomsState(nextRooms, scope);
  return nextRooms;
}

export function syncRoomsWithActiveBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[], scope?: "standard" | "platinum") {
  const nextRooms = deriveRoomsStateFromBookings(bookings, baseRooms, scope);
  writeRoomsState(nextRooms, scope);
  return nextRooms;
}
