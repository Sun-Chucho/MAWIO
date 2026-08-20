import { getDefaultRoomsForTier, Room, STANDARD_ROOM_PRICE } from "@/app/lib/mock-data";
import { readJson, writeJson } from "@/app/lib/storage";

interface ActiveBookingRoom {
  roomNumber: string;
  status?: "completed" | "credit" | "checked-out";
  checkOutDate?: string;
  checkOutTime?: string;
}

export const STORAGE_ROOMS = "orange-hotel-rooms-state";

export function getDefaultRooms(): Room[] {
  return getDefaultRoomsForTier();
}

function normalizeRoomRates(rooms: Room[]): Room[] {
  const standardRoomNumbers = new Set(getDefaultRooms().map((room) => room.number));
  return rooms
    .filter((room) => standardRoomNumbers.has(room.number))
    .map((room) => ({ ...room, type: "Standard", price: STANDARD_ROOM_PRICE }));
}

export function readRoomsState(): Room[] {
  const saved = readJson<Room[]>(STORAGE_ROOMS);
  if (!Array.isArray(saved) || saved.length === 0) return getDefaultRooms();
  const known = new Map(normalizeRoomRates(saved).map((room) => [room.number, room]));
  return getDefaultRooms().map((room) => known.get(room.number) ?? room);
}

function hasSavedRoomsState() {
  const saved = readJson<Room[]>(STORAGE_ROOMS);
  return Array.isArray(saved) && saved.length > 0;
}

export function writeRoomsState(rooms: Room[]) {
  const normalizedRooms = normalizeRoomRates(rooms);
  const saved = readJson<Room[]>(STORAGE_ROOMS);
  if (Array.isArray(saved) && JSON.stringify(saved) === JSON.stringify(normalizedRooms)) return;
  writeJson(STORAGE_ROOMS, normalizedRooms);
}

function readBaseRooms(baseRooms?: Room[]) {
  return Array.isArray(baseRooms) && baseRooms.length > 0
    ? baseRooms
    : hasSavedRoomsState()
      ? readRoomsState()
      : getDefaultRooms();
}

export function getActiveBookedRoomNumbers(bookings: ActiveBookingRoom[]) {
  return new Set(bookings.filter(isBookingStillActive).map((booking) => booking.roomNumber));
}

function reconcileRooms(rooms: Room[], occupiedRooms: Set<string>): Room[] {
  return rooms.map((room) => {
    if (occupiedRooms.has(room.number)) {
      return room.status === "occupied" ? room : { ...room, status: "occupied" as Room["status"] };
    }
    return room.status === "occupied" ? { ...room, status: "available" as Room["status"] } : room;
  });
}

export function updateRoomStatusByNumber(roomNumber: string, status: Room["status"], baseRooms?: Room[]) {
  const nextRooms = readBaseRooms(baseRooms).map((room) => room.number === roomNumber ? { ...room, status } : room);
  writeRoomsState(nextRooms);
  return nextRooms;
}

export function updateRoomStatusById(roomId: string, status: Room["status"], baseRooms?: Room[]) {
  const nextRooms = readBaseRooms(baseRooms).map((room) => room.id === roomId ? { ...room, status } : room);
  writeRoomsState(nextRooms);
  return nextRooms;
}

export function isBookingStillActive(booking: ActiveBookingRoom) {
  return booking.status !== "checked-out";
}

export function deriveRoomsStateFromBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[]) {
  return reconcileRooms(readBaseRooms(baseRooms), getActiveBookedRoomNumbers(bookings));
}

export function syncRoomsStateFromBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[]) {
  const nextRooms = deriveRoomsStateFromBookings(bookings, baseRooms);
  writeRoomsState(nextRooms);
  return nextRooms;
}

export function syncRoomsWithActiveBookings(bookings: ActiveBookingRoom[], baseRooms?: Room[]) {
  return syncRoomsStateFromBookings(bookings, baseRooms);
}
