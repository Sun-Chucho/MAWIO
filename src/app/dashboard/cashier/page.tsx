"use client";

import { useEffect, useMemo, useState } from "react";
import { PLATINUM_ROOM_PRICE, ROOMS, Role, Room, STANDARD_ROOM_PRICE } from "@/app/lib/mock-data";
import { readStoredRole } from "@/app/lib/auth";
import { readCashierState, STORAGE_CASHIER_STATE, writeCashierState, getActiveCashierStateKey } from "@/app/lib/storage";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Clock, Phone, Receipt, User } from "lucide-react";
import { useIsDirector } from "@/hooks/use-is-director";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { isBookingStillActive, readRoomsState, syncRoomsStateFromBookings, updateRoomStatusByNumber } from "@/app/lib/rooms-storage";
import { hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { getScopedStorageKey } from "@/app/lib/storage";
import { getLocalMawioTier } from "@/app/lib/login-profiles";

type PaymentMethod = "cash" | "card" | "mobile-money" | "credit";
type TransactionTab = "completed" | "credit";
type BookingDateFilter = "all" | "day" | "week" | "month";
type RoomType = "standard" | "platinum";
type TransactionStatus = "completed" | "credit" | "checked-out";
type BookingCurrency = "TSh" | "$";
type SpecialPackage =
  | "resident-with-breakfast"
  | "non-resident-with-breakfast"
  | "ninety-day-special";

interface BookingRecord {
  id: string;
  receiptNo: string;
  createdAt: number;
  guestName: string;
  phone: string;
  roomType: RoomType;
  roomNumber: string;
  specialPackage?: SpecialPackage;
  currency?: BookingCurrency;
  ratePerNight?: number;
  payment: PaymentMethod;
  checkInDate: string;
  checkInTime: string;
  checkOutDate: string;
  checkOutTime: string;
  nights: number;
  total: number;
  status: TransactionStatus;
  checkedBy?: string;
  extensionPaymentMethod?: PaymentMethod;
  extensionAmount?: number;
  lastExtendedAt?: number;
}

const ROOM_RATE: Record<RoomType, number> = {
  standard: STANDARD_ROOM_PRICE,
  platinum: PLATINUM_ROOM_PRICE,
};

function getRoomTypeLabel(roomType: RoomType): string {
  if (typeof window === "undefined") return roomType === "standard" ? "Standard" : "Premium";
  const scope = getLocalMawioTier();
  if (roomType === "standard") return "Standard";
  return scope === "platinum" ? "Deluxe" : "Premium";
}

const SPECIAL_PACKAGES: Record<
  SpecialPackage,
  { label: string; currency: BookingCurrency; standardRate: number; platinumRate: number }
> = {
  "resident-with-breakfast": {
    label: "Resident with Breakfast",
    currency: "TSh",
    standardRate: STANDARD_ROOM_PRICE,
    platinumRate: PLATINUM_ROOM_PRICE,
  },
  "non-resident-with-breakfast": {
    label: "Non Resident with Breakfast",
    currency: "$",
    standardRate: 60,
    platinumRate: 90,
  },
  "ninety-day-special": {
    label: "90 Day Special Package",
    currency: "TSh",
    standardRate: STANDARD_ROOM_PRICE,
    platinumRate: PLATINUM_ROOM_PRICE,
  },
};

const USD_TO_TSH_RATE = 2500;

const STORAGE_TX = "orange-hotel-cashier-transactions";
const STORAGE_SEQ = "orange-hotel-cashier-seq";

function mergeCashierSnapshots(
  localSnapshot: { transactions: BookingRecord[]; receiptSeq: number },
  remoteSnapshot: { transactions?: BookingRecord[]; receiptSeq?: number },
) {
  const remoteTransactions = Array.isArray(remoteSnapshot.transactions) ? remoteSnapshot.transactions : [];
  const mergedById = new Map<string, BookingRecord>();
  const transactionsWithoutId: BookingRecord[] = [];

  for (const transaction of remoteTransactions) {
    if (transaction.id) {
      mergedById.set(transaction.id, transaction);
    } else {
      transactionsWithoutId.push(transaction);
    }
  }

  for (const transaction of localSnapshot.transactions) {
    if (transaction.id) {
      mergedById.set(transaction.id, transaction);
    } else {
      transactionsWithoutId.push(transaction);
    }
  }

  return {
    transactions: [...Array.from(mergedById.values()), ...transactionsWithoutId].sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    ),
    receiptSeq: Math.max(
      Number.isFinite(localSnapshot.receiptSeq) ? localSnapshot.receiptSeq : 84920,
      Number.isFinite(remoteSnapshot.receiptSeq) ? Number(remoteSnapshot.receiptSeq) : 84920,
    ),
  };
}

async function hydrateCashierStateFromServer() {
  if (typeof window === "undefined") return;

  const { getActiveCashierStateKey: getKey } = await import("@/app/lib/storage");
  const activeKey = getKey();
  const response = await fetch(`/api/storage-sync/${encodeURIComponent(activeKey)}`, {
    cache: "no-store",
  });
  if (!response.ok) return;

  const payload = (await response.json()) as { value?: { transactions?: BookingRecord[]; receiptSeq?: number } | null };
  const remoteSnapshot = payload.value;
  if (!remoteSnapshot || !Array.isArray(remoteSnapshot.transactions)) return;

  const localSnapshot = readCashierState<BookingRecord>(STORAGE_TX, STORAGE_SEQ, 84920);
  const mergedSnapshot = mergeCashierSnapshots(localSnapshot, remoteSnapshot);

  localStorage.setItem(activeKey, JSON.stringify(mergedSnapshot));
  localStorage.setItem(STORAGE_TX, JSON.stringify(mergedSnapshot.transactions));
  localStorage.setItem(STORAGE_SEQ, String(mergedSnapshot.receiptSeq));
  window.dispatchEvent(new CustomEvent("orange-hotel-storage-updated", { detail: { key: activeKey } }));

  if (JSON.stringify(mergedSnapshot) !== JSON.stringify(remoteSnapshot)) {
    await fetch(`/api/storage-sync/${encodeURIComponent(activeKey)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: mergedSnapshot }),
    }).catch(() => undefined);
  }
}

function daysBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const inDate = new Date(`${checkIn}T00:00:00`);
  const outDate = new Date(`${checkOut}T00:00:00`);
  const ms = outDate.getTime() - inDate.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

function addDays(dateText: string, days: number): string {
  const baseDate = new Date(`${dateText}T00:00:00`);
  if (!Number.isFinite(baseDate.getTime())) return dateText;
  baseDate.setDate(baseDate.getDate() + days);
  return baseDate.toISOString().slice(0, 10);
}

function getDateTimeMs(dateText: string, timeText: string): number {
  const parsed = new Date(`${dateText}T${timeText || "00:00"}:00`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getBookingReportTimestamp(dateText: string, timeText: string, fallback = Date.now()) {
  const parsed = getDateTimeMs(dateText, timeText);
  return parsed > 0 ? parsed : fallback;
}

function matchesBookingDateFilter(createdAt: number, filter: BookingDateFilter) {
  if (filter === "all") return true;

  const createdDate = new Date(createdAt);
  if (!Number.isFinite(createdDate.getTime())) return false;

  const now = new Date();
  const createdDay = new Date(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (filter === "day") return createdDay === today;

  if (filter === "week") {
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    return createdDate >= startOfWeek && createdDate < endOfWeek;
  }

  return createdDate.getFullYear() === now.getFullYear() && createdDate.getMonth() === now.getMonth();
}

function isOverstay(record: BookingRecord): boolean {
  if (record.status === "checked-out") return false;
  const checkoutAt = new Date(`${record.checkOutDate}T${record.checkOutTime || "00:00"}:00`);
  return Date.now() > checkoutAt.getTime();
}

function toAccountingCurrency(currency: BookingCurrency): BookingCurrency {
  return currency === "$" ? "TSh" : currency;
}

function toAccountingRate(rate: number, currency: BookingCurrency) {
  return currency === "$" ? rate * USD_TO_TSH_RATE : rate;
}

export default function BookingPage() {
  const isDirector = useIsDirector();
  const { confirm, dialog } = useConfirmDialog();
  const today = (() => {
    const eatOffsetMs = 3 * 60 * 60 * 1000;
    const eatDate = new Date(Date.now() + eatOffsetMs);
    return eatDate.getUTCFullYear() + "-" + 
           String(eatDate.getUTCMonth() + 1).padStart(2, '0') + "-" + 
           String(eatDate.getUTCDate()).padStart(2, '0');
  })();
  const defaultCheckOutDate = addDays(today, 1);

  const [transactionTab, setTransactionTab] = useState<TransactionTab>("completed");
  const [bookingDateFilter, setBookingDateFilter] = useState<BookingDateFilter>("all");
  const [roomType, setRoomType] = useState<RoomType>("standard");
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);

  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [checkInDate, setCheckInDate] = useState(today);
  const [checkInTime, setCheckInTime] = useState("14:00");
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOutDate);
  const [checkOutTime, setCheckOutTime] = useState("12:00");
  const [selectedRoomNumber, setSelectedRoomNumber] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<SpecialPackage | "none">("none");
  const [packageRate, setPackageRate] = useState("");

  const [showSettlementPopup, setShowSettlementPopup] = useState(false);
  const [showPayNowPopup, setShowPayNowPopup] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [selectedExtendBookingId, setSelectedExtendBookingId] = useState<string | null>(null);
  const [extendCheckOutDate, setExtendCheckOutDate] = useState("");
  const [extendCheckOutTime, setExtendCheckOutTime] = useState("12:00");
  const [showExtendPaymentPopup, setShowExtendPaymentPopup] = useState(false);

  const [rooms, setRooms] = useState<Room[]>(readRoomsState());
  const [transactions, setTransactions] = useState<BookingRecord[]>([]);
  const [receiptSeq, setReceiptSeq] = useState(84920);
  const [role, setRole] = useState<Role>("cashier");
  const isManager = role === "manager";

  useEffect(() => {
    let cancelled = false;
    setRole(readStoredRole() ?? "cashier");
    const applyCashierSnapshot = (incomingRooms?: Room[]) => {
      if (cancelled) return;
      const snapshot = readCashierState<BookingRecord>(STORAGE_TX, STORAGE_SEQ, 84920);
      const normalizedTransactions: BookingRecord[] = snapshot.transactions.map((tx): BookingRecord => ({
          ...tx,
          status: tx.status === "credit" || tx.status === "checked-out" ? tx.status : "completed",
          checkedBy: tx.checkedBy || (tx.id.startsWith("hist-") ? tx.checkedBy : "Default"),
        }));
      setTransactions(normalizedTransactions);
      setReceiptSeq(snapshot.receiptSeq);
      setRooms(syncRoomsStateFromBookings(normalizedTransactions, incomingRooms));

    };

    const activeCashierKey = getActiveCashierStateKey();
    void Promise.all([
      hydrateStorageKeyFromFirebase(activeCashierKey).catch(() => undefined),
      hydrateCashierStateFromServer().catch(() => undefined),
    ]).finally(() => {
      applyCashierSnapshot();
    });

    const unsubscribeCashier = subscribeToSyncedStorageKey(activeCashierKey, () => {
      applyCashierSnapshot();
    });
    const roomsStorageKey = getScopedStorageKey("orange-hotel-rooms-state");
    const unsubscribeRooms = subscribeToSyncedStorageKey<Room[]>(roomsStorageKey, (value) => {
      applyCashierSnapshot(Array.isArray(value) && value.length > 0 ? value : readRoomsState());
    });

    return () => {
      cancelled = true;
      unsubscribeCashier();
      unsubscribeRooms();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get("tab");
    if (requestedTab === "completed" || requestedTab === "credit") {
      setTransactionTab(requestedTab);
    }
  }, []);

  const nights = useMemo(() => daysBetween(checkInDate, checkOutDate), [checkInDate, checkOutDate]);
  const packageConfig = selectedPackage === "none" ? null : SPECIAL_PACKAGES[selectedPackage];
  const selectedRate = packageConfig
    ? roomType === "standard"
      ? packageConfig.standardRate
      : packageConfig.platinumRate
    : ROOM_RATE[roomType];
  const rate = Number.isFinite(selectedRate) && selectedRate > 0 ? selectedRate : 0;
  const bookingCurrency: BookingCurrency = packageConfig?.currency ?? "TSh";
  const accountingCurrency = toAccountingCurrency(bookingCurrency);
  const accountingRate = toAccountingRate(rate, bookingCurrency);
  const total = nights * accountingRate;
  const canSubmitBooking =
    guestName.trim().length > 0 &&
    phone.trim().length >= 7 &&
    nights >= 1 &&
    Boolean(selectedRoomNumber);
  const bookingBlockerMessage = !guestName.trim()
    ? "Enter guest name."
    : phone.trim().length < 7
      ? "Enter a valid phone number."
      : nights < 1
        ? "Check-out date must be after check-in date."
        : !selectedRoomNumber
          ? "No available room is selected for this room type."
          : null;

  useEffect(() => {
    if (!checkInDate) return;
    if (!checkOutDate || daysBetween(checkInDate, checkOutDate) < 1) {
      setCheckOutDate(addDays(checkInDate, 1));
    }
  }, [checkInDate, checkOutDate]);

  useEffect(() => {
    if (!packageConfig) {
      setPackageRate("");
      return;
    }
    setPackageRate(String(roomType === "standard" ? packageConfig.standardRate : packageConfig.platinumRate));
  }, [packageConfig, roomType]);

  const completedTransactions = useMemo(
    () => transactions.filter((tx) => tx.status === "completed" || tx.status === "checked-out"),
    [transactions],
  );
  const creditTransactions = useMemo(
    () => transactions.filter((tx) => tx.status === "credit"),
    [transactions],
  );
  const visibleTransactions = useMemo(() => {
    const source = transactionTab === "completed" ? completedTransactions : creditTransactions;
    return source.filter((tx) => matchesBookingDateFilter(tx.createdAt, bookingDateFilter));
  }, [bookingDateFilter, completedTransactions, creditTransactions, transactionTab]);
  const activeBookedRoomNumbers = useMemo(
    () =>
      new Set(
        transactions
          .filter((tx) => tx.id !== editingBookingId && isBookingStillActive(tx))
          .map((tx) => tx.roomNumber),
      ),
    [editingBookingId, transactions],
  );
  const roomPickerRooms = useMemo(() => {
    const wantedType = roomType === "standard" ? "Standard" : "Platinum";
    return rooms.filter((room) => room.type === wantedType);
  }, [activeBookedRoomNumbers, roomType, rooms]);
  const availableRooms = useMemo(
    () =>
      roomPickerRooms.filter(
        (room) => room.status === "available" && !activeBookedRoomNumbers.has(room.number),
      ),
    [activeBookedRoomNumbers, roomPickerRooms],
  );

  useEffect(() => {
    if (editingBookingId) return;

    if (availableRooms.length === 0) {
      setSelectedRoomNumber("");
      return;
    }

    const selectedStillAvailable = availableRooms.some((room) => room.number === selectedRoomNumber);
    if (!selectedStillAvailable) {
      setSelectedRoomNumber(availableRooms[0].number);
    }
  }, [availableRooms, selectedRoomNumber]);
  const selectedExtendBooking = useMemo(
    () => transactions.find((entry) => entry.id === selectedExtendBookingId) ?? null,
    [selectedExtendBookingId, transactions],
  );
  const extendCheckoutIsLater = useMemo(
    () =>
      selectedExtendBooking
        ? getDateTimeMs(extendCheckOutDate, extendCheckOutTime) >
          getDateTimeMs(selectedExtendBooking.checkOutDate, selectedExtendBooking.checkOutTime || "12:00")
        : false,
    [extendCheckOutDate, extendCheckOutTime, selectedExtendBooking],
  );
  const extendAddedNights = useMemo(
    () => (selectedExtendBooking && extendCheckoutIsLater ? daysBetween(selectedExtendBooking.checkOutDate, extendCheckOutDate) : 0),
    [extendCheckOutDate, extendCheckoutIsLater, selectedExtendBooking],
  );
  const extendNights = useMemo(
    () => (selectedExtendBooking ? daysBetween(selectedExtendBooking.checkInDate, extendCheckOutDate) : 0),
    [extendCheckOutDate, selectedExtendBooking],
  );
  const extendIncrement = useMemo(
    () => (selectedExtendBooking ? extendAddedNights * (selectedExtendBooking.ratePerNight ?? 0) : 0),
    [extendAddedNights, selectedExtendBooking],
  );
  const extendTotal = useMemo(
    () => (selectedExtendBooking ? selectedExtendBooking.total + extendIncrement : 0),
    [extendIncrement, selectedExtendBooking],
  );

  const totalTransactions = transactions.length;
  const todayRevenueTSh = transactions
    .filter((tx) => (tx.status === "completed" || tx.status === "checked-out") && (tx.currency ?? "TSh") === "TSh")
    .reduce((sum, tx) => sum + tx.total, 0);

  const getRoomBookingState = (room: Room) => {
    if (activeBookedRoomNumbers.has(room.number) || room.status === "occupied") {
      return {
        label: "Occupied",
        canBook: false,
        className: "border-blue-500 bg-blue-50 text-blue-700",
      };
    }

    if (room.status === "cleaning") {
      return {
        label: "Cleaning",
        canBook: false,
        className: "border-orange-500 bg-orange-50 text-orange-700",
      };
    }

    if (room.status === "maintenance") {
      return {
        label: "Maintenance",
        canBook: false,
        className: "border-gray-500 bg-gray-100 text-gray-600",
      };
    }

    return {
      label: "Available",
      canBook: true,
      className: "border-green-500 bg-green-50 text-green-700",
    };
  };

  const resetBookingForm = () => {
    setEditingBookingId(null);
    setGuestName("");
    setPhone("");
    setCheckInDate(today);
    setCheckInTime("14:00");
    setCheckOutDate(defaultCheckOutDate);
    setCheckOutTime("12:00");
    setSelectedRoomNumber("");
    setRoomType("standard");
    setSelectedPackage("none");
    setPackageRate("");
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);
  };

  const openEditBooking = (booking: BookingRecord) => {
    if (isDirector || isManager) return;

    setEditingBookingId(booking.id);
    setGuestName(booking.guestName);
    setPhone(booking.phone);
    setCheckInDate(booking.checkInDate);
    setCheckInTime(booking.checkInTime || "14:00");
    setCheckOutDate(booking.checkOutDate);
    setCheckOutTime(booking.checkOutTime || "12:00");
    setSelectedRoomNumber(booking.roomNumber);
    setRoomType(booking.roomType);
    setSelectedPackage(booking.specialPackage ?? "none");
    setPackageRate(String(booking.ratePerNight ?? ""));
    setShowSettlementPopup(false);
    setShowPayNowPopup(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clearBookingForm = async () => {
    const approved = await confirm({
      title: "Clear Booking Form",
      description: "Are you sure you want to clear this booking form?",
      actionLabel: "Clear Form",
    });
    if (!approved) return;
    resetBookingForm();
  };

  const saveBooking = (status: "completed" | "credit", paymentMethod: PaymentMethod) => {
    if (isDirector) return;
    if (!canSubmitBooking) return;

    if (editingBookingId) {
      const existingBooking = transactions.find((entry) => entry.id === editingBookingId);
      if (!existingBooking) return;

      const nextTransactions = transactions.map((entry) =>
        entry.id === editingBookingId
          ? {
              ...entry,
              guestName: guestName.trim(),
              phone: phone.trim(),
              createdAt: getBookingReportTimestamp(checkInDate, checkInTime, entry.createdAt),
              roomType,
              roomNumber: selectedRoomNumber,
              specialPackage: selectedPackage === "none" ? undefined : selectedPackage,
              currency: accountingCurrency,
              ratePerNight: accountingRate,
              payment: paymentMethod,
              checkInDate,
              checkInTime,
              checkOutDate,
              checkOutTime,
              nights,
              total,
              status,
              checkedBy: localStorage.getItem("orange-hotel-username") || "Reception",
            }
          : entry,
      );

      setTransactions(nextTransactions);
      writeCashierState(nextTransactions, receiptSeq);
      setRooms(syncRoomsStateFromBookings(nextTransactions, rooms));

      setTransactionTab(status === "credit" ? "credit" : "completed");
      resetBookingForm();
      return;
    }

    const nextReceipt = receiptSeq + 1;

    const tx: BookingRecord = {
      id: `tx-${Date.now()}`,
      receiptNo: `#${nextReceipt}`,
      createdAt: getBookingReportTimestamp(checkInDate, checkInTime),
      guestName: guestName.trim(),
      phone: phone.trim(),
      roomType,
      roomNumber: selectedRoomNumber,
      specialPackage: selectedPackage === "none" ? undefined : selectedPackage,
      currency: accountingCurrency,
      ratePerNight: accountingRate,
      payment: paymentMethod,
      checkInDate,
      checkInTime,
      checkOutDate,
      checkOutTime,
      nights,
      total,
      status,
      checkedBy: localStorage.getItem("orange-hotel-username") || "Reception",
    };
    if (selectedPackage !== "none") {
      tx.specialPackage = selectedPackage;
    }

    const nextTransactions = [tx, ...transactions];
    setTransactions(nextTransactions);
    setReceiptSeq(nextReceipt);
    writeCashierState(nextTransactions, nextReceipt);
    setRooms(syncRoomsStateFromBookings(nextTransactions, rooms));
    setTransactionTab(status === "credit" ? "credit" : "completed");
    resetBookingForm();
  };

  const openSettlementPopup = () => {
    if (isDirector) return;
    if (!canSubmitBooking) return;
    setShowPayNowPopup(false);
    setShowSettlementPopup(true);
  };

  const redirectToBookedRooms = (tab: TransactionTab) => {
    window.location.replace(`/dashboard/cashier?tab=${tab}&refresh=${Date.now()}#booked-rooms`);
  };

  const confirmCreditBooking = async () => {
    if (isDirector || !canSubmitBooking) return;
    const approved = await confirm({
      title: "Book Room On Credit",
      description: `Are you sure you want to book room ${selectedRoomNumber} for ${guestName.trim()} on credit?`,
      actionLabel: "Book On Credit",
    });
    if (!approved) return;
    saveBooking("credit", "credit");
    redirectToBookedRooms("credit");
  };

  const completePaidBooking = async (paymentMethod: Exclude<PaymentMethod, "credit">) => {
    if (isDirector || !canSubmitBooking) return;
    const paymentLabel =
      paymentMethod === "mobile-money" ? "mobile money" : paymentMethod;
    const approved = await confirm({
      title: "Complete Booking Payment",
      description: `Are you sure you want to complete booking room ${selectedRoomNumber} for ${guestName.trim()} using ${paymentLabel}?`,
      actionLabel: "Complete Payment",
    });
    if (!approved) return;
    saveBooking("completed", paymentMethod);
    redirectToBookedRooms("completed");
  };

  const openExtendStay = (booking: BookingRecord) => {
    if (isDirector || booking.status === "checked-out") return;
    setSelectedExtendBookingId(booking.id);
    setExtendCheckOutDate(addDays(booking.checkOutDate, 1));
    setExtendCheckOutTime(booking.checkOutTime || "12:00");
    setShowExtendPaymentPopup(false);
  };

  const closeExtendStayDialog = () => {
    setSelectedExtendBookingId(null);
    setExtendCheckOutDate("");
    setExtendCheckOutTime("12:00");
    setShowExtendPaymentPopup(false);
  };

  const openExtendPaymentDialog = async () => {
    if (isDirector || !selectedExtendBookingId || !extendCheckOutDate || !extendCheckOutTime) return;

    const booking = selectedExtendBooking;
    if (!booking) return;

    if (!extendCheckoutIsLater) return;

    const approved = await confirm({
      title: "Extend Stay",
      description: `Are you sure you want to extend ${booking.guestName} in room ${booking.roomNumber} until ${extendCheckOutDate} ${extendCheckOutTime}?`,
      actionLabel: "Extend Stay",
    });
    if (!approved) return;

    setShowExtendPaymentPopup(true);
  };

  const applyExtendStay = (paymentMethod: PaymentMethod) => {
    if (!selectedExtendBookingId || !extendCheckOutDate || !extendCheckOutTime) return;

    const booking = selectedExtendBooking;
    if (!booking) return;

    const nextNights = extendNights;
    if (!extendCheckoutIsLater || nextNights < 1) return;

    const nextStatus: TransactionStatus =
      paymentMethod === "credit"
        ? "credit"
        : booking.status === "credit"
          ? "credit"
          : "completed";

    const nextTransactions = transactions.map((entry) =>
      entry.id === selectedExtendBookingId
        ? {
            ...entry,
            checkOutDate: extendCheckOutDate,
            checkOutTime: extendCheckOutTime,
            nights: nextNights,
            total: extendTotal,
            status: nextStatus,
            extensionPaymentMethod: paymentMethod,
            extensionAmount: extendIncrement,
            lastExtendedAt: Date.now(),
          }
        : entry,
    );

    setTransactions(nextTransactions);
    writeCashierState(nextTransactions, receiptSeq);
    setTransactionTab(nextStatus === "credit" ? "credit" : "completed");
    closeExtendStayDialog();
  };

  const checkoutBooking = async (booking: BookingRecord) => {
    if (isDirector || booking.status === "checked-out") return;

    const approved = await confirm({
      title: "Check Out Guest",
      description: `Are you sure you want to check out ${booking.guestName} from room ${booking.roomNumber}?`,
      actionLabel: "Check Out",
    });
    if (!approved) return;

    const nextTransactions = transactions.map((entry) =>
      entry.id === booking.id ? { ...entry, status: "checked-out" as TransactionStatus } : entry,
    );

    setTransactions(nextTransactions);
    writeCashierState(nextTransactions, receiptSeq);

    const checkedOutRooms = syncRoomsStateFromBookings(nextTransactions, rooms);
    const cleaningRooms = updateRoomStatusByNumber(booking.roomNumber, "cleaning", checkedOutRooms);
    setRooms(cleaningRooms);
  };

  return (
    <div className="space-y-8">
      {dialog}
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Reception Booking</h1>
          <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">
            Guest booking capture and payment processing
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full lg:w-auto">
          <Badge variant="outline" className="h-10 px-4 justify-center border-primary text-primary font-black uppercase text-[10px] tracking-widest">
            {totalTransactions} Transactions
          </Badge>
          <Badge variant="outline" className="h-10 px-4 justify-center font-black uppercase text-[10px] tracking-widest bg-white">
            TSh {todayRevenueTSh.toLocaleString()} Today
          </Badge>
        </div>
      </header>
      {isDirector && (
        <Card className="border-emerald-200 bg-emerald-50/60 shadow-none">
          <CardContent className="p-3 text-xs font-black uppercase tracking-widest text-emerald-700">
            Managing Director View: Booking and revenue visibility only (read-only)
          </CardContent>
        </Card>
      )}

      {!isDirector && (
      <Card className="shadow-2xl border-none bg-white overflow-hidden">
        <div className="h-1.5 bg-primary" />
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">{editingBookingId ? "Edit Booking" : "New Booking"}</CardTitle>
          <CardDescription>
            {editingBookingId ? "Update an existing booking record, including past booking dates." : "Guest details, room selection, stay dates, and payment. Past dates are allowed for backdated entries."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {editingBookingId && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Editing Existing Booking</p>
              <p className="mt-1 text-sm font-bold text-amber-900">Past dates are allowed while updating this record.</p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="Guest name" className="pl-10" />
            </div>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" className="pl-10" />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Selected Room Type</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setRoomType("standard");
                  setRoomPickerOpen(true);
                }}
                className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition ${
                  roomType === "standard" ? "bg-yellow-500 text-black border-yellow-500" : "bg-white"
                }`}
              >
                {getRoomTypeLabel("standard")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRoomType("platinum");
                  setRoomPickerOpen(true);
                }}
                className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition ${
                  roomType === "platinum" ? "bg-yellow-500 text-black border-yellow-500" : "bg-white"
                }`}
              >
                {getRoomTypeLabel("platinum")}
              </button>
            </div>
            {selectedRoomNumber && (
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Selected Room: {selectedRoomNumber}</p>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Special Package</p>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-full"
              value={selectedPackage}
              onChange={(event) => setSelectedPackage(event.target.value as SpecialPackage | "none")}
            >
              <option value="none">No special package</option>
              <option value="resident-with-breakfast">Resident with Breakfast (Standard TSh 70,000 | Premium TSh 100,000)</option>
              <option value="non-resident-with-breakfast">Non Resident with Breakfast (Standard $60 | Premium $90)</option>
              <option value="ninety-day-special">90 Day Special Package (Standard TSh 70,000 | Premium TSh 100,000)</option>
            </select>

            {packageConfig && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Input
                  type="number"
                  value={packageRate}
                  readOnly
                  placeholder="Rate per night"
                />
                <div className="rounded-md border px-3 py-2 text-sm font-black uppercase tracking-widest text-muted-foreground">
                  {getRoomTypeLabel(roomType)} package rate: {packageConfig.currency} {rate.toLocaleString()}
                  {packageConfig.currency === "$" ? ` | TSh ${accountingRate.toLocaleString()} accounting` : ""}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Check-In Date</p>
              <Input type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Check-In Time</p>
              <div className="relative">
                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input type="time" value={checkInTime} onChange={(e) => setCheckInTime(e.target.value)} className="pl-10" />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Check-Out Date</p>
              <Input type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="space-y-1 md:col-span-2">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Check-Out Time</p>
              <div className="relative">
                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input type="time" value={checkOutTime} onChange={(e) => setCheckOutTime(e.target.value)} className="pl-10" />
              </div>
            </div>
          </div>

          <div className="space-y-2 border-t pt-4">
            <div className="flex justify-between text-xs font-black uppercase tracking-widest opacity-60">
              <span>Rate / Night</span>
              <span>{accountingCurrency} {accountingRate.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-xs font-black uppercase tracking-widest opacity-60">
              <span>Days</span>
              <span>{nights}</span>
            </div>
            <div className="flex justify-between text-lg font-black pt-2">
              <span>Total</span>
              <span className="text-primary">{accountingCurrency} {total.toLocaleString()}</span>
            </div>
            {bookingBlockerMessage && (
              <p className="pt-2 text-xs font-bold text-amber-700">{bookingBlockerMessage}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Button variant="outline" onClick={clearBookingForm} className="h-11 font-black uppercase text-[10px] tracking-widest">
              {editingBookingId ? "Cancel Edit" : "Clear"}
            </Button>
            <Button
              onClick={openSettlementPopup}
              disabled={!canSubmitBooking}
              className="h-11 font-black uppercase text-[10px] tracking-widest"
            >
              {editingBookingId ? "Update Booking" : "Complete Booking"}
            </Button>
          </div>
        </CardContent>
      </Card>
      )}

      <Card id="booked-rooms" className="border-none shadow-sm">
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Booked Rooms</CardTitle>
              <CardDescription>Completed and credit booking records filtered by payment date</CardDescription>
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <Tabs value={bookingDateFilter} onValueChange={(value) => setBookingDateFilter(value as BookingDateFilter)}>
                <TabsList className="grid h-10 grid-cols-4">
                  <TabsTrigger value="all" className="text-[10px] font-black uppercase tracking-widest">All</TabsTrigger>
                  <TabsTrigger value="day" className="text-[10px] font-black uppercase tracking-widest">Day</TabsTrigger>
                  <TabsTrigger value="week" className="text-[10px] font-black uppercase tracking-widest">Week</TabsTrigger>
                  <TabsTrigger value="month" className="text-[10px] font-black uppercase tracking-widest">Month</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs value={transactionTab} onValueChange={(value) => setTransactionTab(value as TransactionTab)}>
                <TabsList className="h-10">
                  <TabsTrigger value="completed" className="text-[10px] font-black uppercase tracking-widest">Completed Transactions</TabsTrigger>
                  <TabsTrigger value="credit" className="text-[10px] font-black uppercase tracking-widest">Credit Transactions</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Room #</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Guest Name</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Check-In Date</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Check-Out</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Checked By</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Status</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleTransactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="font-black">{tx.roomNumber}</TableCell>
                  <TableCell className="font-bold">{tx.guestName}</TableCell>
                  <TableCell className="font-bold">{tx.checkInDate}</TableCell>
                  <TableCell className="font-bold">
                    <p>{tx.checkOutDate}</p>
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mt-1">{tx.checkOutTime}</p>
                  </TableCell>
                  <TableCell className="font-black text-xs text-primary uppercase tracking-wider">
                    {tx.checkedBy || "---"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={
                          tx.status !== "checked-out" && !isOverstay(tx)
                            ? "bg-green-600 text-white border-green-600 hover:bg-green-600"
                            : "bg-gray-200 text-gray-600 border-gray-200 hover:bg-gray-200"
                        }
                      >
                        {tx.status === "checked-out" ? "Checked Out" : "Occupied"}
                      </Badge>
                      <Badge
                        className={
                          tx.status !== "checked-out" && isOverstay(tx)
                            ? "bg-red-600 text-white border-red-600 hover:bg-red-600"
                            : "bg-gray-200 text-gray-600 border-gray-200 hover:bg-gray-200"
                        }
                      >
                        Overstay
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {!isDirector ? (
                      <div className="flex justify-end gap-2">
                        {tx.status !== "checked-out" && (
                          <>
                        <Button
                          variant="outline"
                          onClick={() => openExtendStay(tx)}
                          className="h-9 font-black uppercase text-[10px] tracking-widest"
                        >
                          Extend Stay
                        </Button>
                        <Button
                          onClick={() => checkoutBooking(tx)}
                          className="h-9 font-black uppercase text-[10px] tracking-widest bg-green-600 hover:bg-green-600/90"
                        >
                          Check Out
                        </Button>
                          </>
                        )}
                      </div>
                    ) : (
                      <Badge className="bg-gray-200 text-gray-700 border-gray-200 hover:bg-gray-200">View</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}

              {visibleTransactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="opacity-40">
                      <Receipt className="w-10 h-10 mx-auto mb-2" />
                      <p className="font-black uppercase tracking-widest text-xs">
                        No bookings found for this date filter
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {roomPickerOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">
                {getRoomTypeLabel(roomType)} Rooms
              </CardTitle>
              <CardDescription>Select from all rooms. Only available rooms can be booked.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-widest">
                <Badge className="bg-green-50 text-green-700 border border-green-500 hover:bg-green-50">Available</Badge>
                <Badge className="bg-blue-50 text-blue-700 border border-blue-500 hover:bg-blue-50">Occupied</Badge>
                <Badge className="bg-orange-50 text-orange-700 border border-orange-500 hover:bg-orange-50">Cleaning</Badge>
                <Badge className="bg-gray-100 text-gray-600 border border-gray-500 hover:bg-gray-100">Maintenance</Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {roomPickerRooms.map((room) => {
                  const roomState = getRoomBookingState(room);

                  return (
                    <Button
                      key={room.id}
                      type="button"
                      variant="outline"
                      disabled={!roomState.canBook}
                      onClick={() => {
                        if (!roomState.canBook) return;
                        setSelectedRoomNumber(room.number);
                        setRoomPickerOpen(false);
                      }}
                      className={`h-auto min-h-14 flex-col gap-1 border font-black ${
                        selectedRoomNumber === room.number && roomState.canBook
                          ? "border-primary bg-primary text-primary-foreground hover:bg-primary"
                          : roomState.className
                      }`}
                    >
                      <span>{room.number}</span>
                      <span className="text-[10px] uppercase tracking-widest">{roomState.label}</span>
                    </Button>
                  );
                })}
              </div>

              {availableRooms.length === 0 && (
                <p className="text-sm font-bold text-muted-foreground">No available rooms in this category.</p>
              )}

              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setRoomPickerOpen(false)}>
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {selectedExtendBookingId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Extend Stay</CardTitle>
              <CardDescription>Update the guest check-out date and time.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">New Check-Out Date</p>
                <Input
                  type="date"
                  min={selectedExtendBooking?.checkOutDate}
                  value={extendCheckOutDate}
                  onChange={(event) => setExtendCheckOutDate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">New Check-Out Time</p>
                <Input type="time" value={extendCheckOutTime} onChange={(event) => setExtendCheckOutTime(event.target.value)} />
              </div>
              {selectedExtendBooking && (
                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    <span>Rate / Night</span>
                    <span>{selectedExtendBooking.currency ?? "TSh"} {(selectedExtendBooking.ratePerNight ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    <span>Total Days</span>
                    <span>{extendNights}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    <span>Added Days</span>
                    <span>{extendAddedNights}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    <span>Added Amount</span>
                    <span>{selectedExtendBooking.currency ?? "TSh"} {extendIncrement.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between pt-1 text-sm font-black uppercase tracking-widest">
                    <span>New Total</span>
                    <span>{selectedExtendBooking.currency ?? "TSh"} {extendTotal.toLocaleString()}</span>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    closeExtendStayDialog();
                  }}
                  className="h-11 font-black uppercase text-[10px] tracking-widest"
                >
                  Close
                </Button>
                <Button onClick={() => void openExtendPaymentDialog()} disabled={!extendCheckoutIsLater || extendAddedNights < 1} className="h-11 font-black uppercase text-[10px] tracking-widest">
                  Save Extension
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {!isDirector && showExtendPaymentPopup && selectedExtendBooking && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Extended Night Pay Method</CardTitle>
              <CardDescription>
                Choose how the added amount for room {selectedExtendBooking.roomNumber} will be settled.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  <span>Added Nights</span>
                  <span>{extendAddedNights}</span>
                </div>
                <div className="mt-2 flex justify-between text-sm font-black uppercase tracking-widest">
                  <span>Added Amount</span>
                  <span>{selectedExtendBooking.currency ?? "TSh"} {extendIncrement.toLocaleString()}</span>
                </div>
              </div>
              <Button onClick={() => applyExtendStay("cash")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Cash
              </Button>
              <Button onClick={() => applyExtendStay("card")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Card
              </Button>
              <Button onClick={() => applyExtendStay("mobile-money")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Mobile Money
              </Button>
              <Button onClick={() => applyExtendStay("credit")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white">
                Credit
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowExtendPaymentPopup(false)}
                className="w-full h-10 font-black uppercase text-[10px] tracking-widest"
              >
                Back
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {!isDirector && showSettlementPopup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Select Settlement</CardTitle>
              <CardDescription>Choose Pay Now or Credit</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={() => {
                  setShowSettlementPopup(false);
                  setShowPayNowPopup(true);
                }}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest"
              >
                Pay Now
              </Button>
              <Button
                onClick={confirmCreditBooking}
                className="w-full h-11 font-black uppercase text-[10px] tracking-widest bg-red-600 hover:bg-red-600/90 text-white"
              >
                Credit
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowSettlementPopup(false);
                  setShowPayNowPopup(false);
                }}
                className="w-full h-10 font-black uppercase text-[10px] tracking-widest"
              >
                Close
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {!isDirector && showPayNowPopup && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Pay Now Method</CardTitle>
              <CardDescription>Select cash, card, or mobile</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button onClick={() => completePaidBooking("cash")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Cash
              </Button>
              <Button onClick={() => completePaidBooking("card")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Card
              </Button>
              <Button onClick={() => completePaidBooking("mobile-money")} className="w-full h-11 font-black uppercase text-[10px] tracking-widest">
                Mobile
              </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowPayNowPopup(false);
                    setShowSettlementPopup(true);
                }}
                  className="w-full h-10 font-black uppercase text-[10px] tracking-widest"
                >
                  Back
                </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
