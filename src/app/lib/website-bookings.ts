import { ref, runTransaction } from "firebase/database";
import { firebaseDatabase } from "@/app/lib/firebase";
import { readJson, writeJson } from "@/app/lib/storage";

export const STORAGE_WEBSITE_BOOKINGS = "orange-hotel-website-bookings";
const FIREBASE_STORAGE_ROOT = "mawio";

export type WebsiteBookingStatus = "new" | "seen";
export type WebsiteRoomType = "standard";
export type WebsiteBookingBackendSyncStatus = "synced" | "pending" | "failed";
export type WebsiteBookingPaymentStatus = "pending" | "paid" | "failed" | "cancelled" | "not_started";

export interface WebsiteBookingRecord {
  id: string;
  bookingReference: string;
  fullName: string;
  email: string;
  phone: string;
  roomType: WebsiteRoomType;
  checkIn: string;
  checkOut: string;
  guests: number;
  nights: number;
  pricePerNight: number;
  totalAmount: number;
  currency: "TZS";
  specialRequest: string;
  source: "website";
  status: WebsiteBookingStatus;
  backendSyncStatus: WebsiteBookingBackendSyncStatus;
  backendSyncError: string | null;
  paymentStatus?: WebsiteBookingPaymentStatus;
  paymentProvider?: "ngenius";
  paymentOrderReference?: string | null;
  paymentUrl?: string | null;
  paymentGatewayState?: string | null;
  paymentCheckedAt?: string | null;
  createdAt: string;
  receptionistSeenAt: string | null;
}

export function readWebsiteBookings() {
  const value = readJson<WebsiteBookingRecord[]>(STORAGE_WEBSITE_BOOKINGS);
  return Array.isArray(value) ? value : [];
}

export function writeWebsiteBookings(bookings: WebsiteBookingRecord[]) {
  writeJson(STORAGE_WEBSITE_BOOKINGS, bookings);
}

function toStoragePath(key: string) {
  return `${FIREBASE_STORAGE_ROOT}/standard/${key.replace(/[.#$[\]/]/g, "-")}`;
}

export async function appendWebsiteBooking(booking: WebsiteBookingRecord) {
  await runTransaction(ref(firebaseDatabase, toStoragePath(STORAGE_WEBSITE_BOOKINGS)), (currentValue) => {
    const currentBookings = Array.isArray(currentValue) ? (currentValue as WebsiteBookingRecord[]) : [];
    if (currentBookings.some((entry) => entry.bookingReference === booking.bookingReference)) {
      return currentBookings;
    }
    return [booking, ...currentBookings];
  });
}

export function markWebsiteBookingsSeen(bookings: WebsiteBookingRecord[], bookingIds?: string[]) {
  const targetIds = bookingIds ? new Set(bookingIds) : null;
  const seenAt = new Date().toISOString();

  return bookings.map((booking) => {
    if (booking.status === "seen") {
      return booking;
    }

    if (targetIds && !targetIds.has(booking.id)) {
      return booking;
    }

    return {
      ...booking,
      status: "seen" as const,
      receptionistSeenAt: seenAt,
    };
  });
}
