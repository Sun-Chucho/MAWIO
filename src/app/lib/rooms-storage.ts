import {
  PLATINUM_ROOM_PRICE,
  Room,
  STANDARD_ROOM_PRICE,
  PREMIUM_STANDARD_ROOM_PRICE,
  PREMIUM_DELUXE_ROOM_PRICE,
  PREMIUM_STANDARD_ROOM_NUMBERS,
  PREMIUM_DELUXE_ROOM_NUMBERS,
  getDefaultRoomsForTier,
} from "@/app/lib/mock-data";
import { readJson, writeJson } from "@/app/lib/storage";
import { getLocalMawioTier } from "./login-profiles";

interface ActiveBookingRoom {
  roomNumber: string;
  status?: "completed" | "credit" | "checked-out";
  checkOutDate?: string;
  checkOutTime?: string;
}

export const STORAGE_ROOMS = "orange-hotel-rooms-state";

// Per-tier separation of the rooms cache is handled centrally by the storage
// layer (readJson/writeJson namespace the key by the active hotel). The room
// defaults and pricing below still vary by scope.
function getRoomStorageKey(): string {
  return STORAGE_ROOMS;
}

export function getDefaultRooms(scope?: "standard" | "platinum"): Room[] {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  return getDefaultRoomsForTier(activeScope);
}

function getRoomRateByType(type: Room["type"], scope: "standard" | "platinum") {
  if (scope === "platinum") {
    return type === "Standard" ? PREMIUM_STANDARD_ROOM_PRICE : PREMIUM_DELUXE_ROOM_PRICE;
  }
  return type === "Standard" ? STANDARD_ROOM_PRICE : PLATINUM_ROOM_PRICE;
}

const PREMIUM_STANDARD_ROOM_SET = new Set<string>(PREMIUM_STANDARD_ROOM_NUMBERS);
const PREMIUM_DELUXE_ROOM_SET = new Set<string>(PREMIUM_DELUXE_ROOM_NUMBERS);

// Persisted platinum room lists may carry an outdated number→rate-class
// assignment, so the type is re-derived from the room number before rates are
// applied. Rooms outside the known premium sets (stale entries) are dropped.
function normalizeRoomRates(rooms: Room[], scope: "standard" | "platinum"): Room[] {
  const normalizedRooms =
    scope === "platinum"
      ? rooms
          .filter((room) => PREMIUM_STANDARD_ROOM_SET.has(room.number) || PREMIUM_DELUXE_ROOM_SET.has(room.number))
          .map((room) => {
            const type: Room["type"] = PREMIUM_STANDARD_ROOM_SET.has(room.number) ? "Standard" : "Platinum";
            return room.type === type ? room : { ...room, type };
          })
      : rooms;

  return normalizedRooms.map((room) => {
    const price = getRoomRateByType(room.type, scope);
    return room.price === price ? room : { ...room, price };
  });
}

export function readRoomsState(scope?: "standard" | "platinum"): Room[] {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  const key = getRoomStorageKey();
  const saved = readJson<Room[]>(key);
  if (!Array.isArray(saved) || saved.length === 0) {
    return getDefaultRooms(activeScope);
  }
  const normalized = normalizeRoomRates(saved, activeScope);
  // If normalization dropped stale rooms the persisted platinum list came from
  // the old layout entirely — fall back to the fresh per-tier defaults.
  if (activeScope === "platinum" && normalized.length < getDefaultRoomsForTier("platinum").length) {
    const known = new Map(normalized.map((room) => [room.number, room]));
    return getDefaultRoomsForTier("platinum").map((room) => known.get(room.number) ?? room);
  }
  return normalized;
}

function hasSavedRoomsState(): boolean {
  const key = getRoomStorageKey();
  const saved = readJson<Room[]>(key);
  return Array.isArray(saved) && saved.length > 0;
}

export function writeRoomsState(rooms: Room[], scope?: "standard" | "platinum") {
  const activeScope = scope ?? (typeof window !== "undefined" ? getLocalMawioTier() : "standard");
  const normalizedRooms = normalizeRoomRates(rooms, activeScope);
  const key = getRoomStorageKey();
  const saved = readJson<Room[]>(key);
  if (Array.isArray(saved) && JSON.stringify(saved) === JSON.stringify(normalizedRooms)) return;
  writeJson(key, normalizedRooms);
}

function readBaseRooms(baseRooms?: Room[], scope?: "standard" | "platinum") {
  return Array.isArray(baseRooms) && baseRooms.length > 0
    ? baseRooms
    : hasSavedRoomsState()
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
