"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import {
  markWebsiteBookingsSeen,
  readWebsiteBookings,
  STORAGE_WEBSITE_BOOKINGS,
  type WebsiteBookingPaymentStatus,
  type WebsiteBookingRecord,
  writeWebsiteBookings,
} from "@/app/lib/website-bookings";
import { subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";

const PAID_GATEWAY_STATES = new Set(["CAPTURED", "PURCHASED", "SUCCESS", "SUCCEEDED", "PAID", "AUTHORISED", "AUTHORIZED"]);
const FAILED_GATEWAY_STATES = new Set(["FAILED", "DECLINED", "CANCELLED", "CANCELED", "REJECTED"]);

function getWebsiteRoomTypeLabel(roomType: WebsiteBookingRecord["roomType"]) {
  return roomType === "platinum" ? "Premium" : "Standard";
}

function getReceptionPaymentLabel(booking: WebsiteBookingRecord) {
  if (booking.paymentStatus === "paid") return "Paid";
  if (booking.paymentStatus === "failed") return "Payment Failed";
  if (booking.paymentStatus === "cancelled") return "Payment Cancelled";
  if (booking.paymentStatus === "pending" || booking.paymentOrderReference) return "Payment Pending";
  return "Just Reserved";
}

function getReceptionPaymentClass(booking: WebsiteBookingRecord) {
  if (booking.paymentStatus === "paid") return "border-emerald-500 bg-emerald-50 text-emerald-700";
  if (booking.paymentStatus === "pending" || booking.paymentOrderReference) return "border-amber-500 bg-amber-50 text-amber-700";
  if (booking.paymentStatus === "failed" || booking.paymentStatus === "cancelled") return "border-red-500 bg-red-50 text-red-700";
  return "border-slate-400 bg-slate-50 text-slate-700";
}

export default function WebsiteBookingsPage() {
  const [websiteBookings, setWebsiteBookings] = useState<WebsiteBookingRecord[]>([]);
  const [refreshingPaymentId, setRefreshingPaymentId] = useState<string | null>(null);
  const previousWebsiteBookingIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const applyWebsiteBookings = () => {
      setWebsiteBookings(readWebsiteBookings());
    };

    applyWebsiteBookings();
    const unsubscribe = subscribeToSyncedStorageKey<WebsiteBookingRecord[]>(STORAGE_WEBSITE_BOOKINGS, (value) => {
      setWebsiteBookings(Array.isArray(value) ? value : readWebsiteBookings());
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const previousIds = previousWebsiteBookingIdsRef.current;
    if (previousIds.length > 0) {
      const newBookings = websiteBookings.filter((booking) => !previousIds.includes(booking.id));
      if (newBookings.length > 0) {
        const latestBooking = newBookings[0];
        toast({
          title: "New website booking",
          description: `${latestBooking.fullName} requested a ${getWebsiteRoomTypeLabel(latestBooking.roomType)} room.`,
        });
      }
    }

    previousWebsiteBookingIdsRef.current = websiteBookings.map((booking) => booking.id);
  }, [websiteBookings]);

  const unreadWebsiteBookings = useMemo(
    () => websiteBookings.filter((booking) => booking.status === "new"),
    [websiteBookings],
  );

  const markBookingsAsSeen = (bookingIds?: string[]) => {
    const nextWebsiteBookings = markWebsiteBookingsSeen(websiteBookings, bookingIds);
    setWebsiteBookings(nextWebsiteBookings);
    writeWebsiteBookings(nextWebsiteBookings);
  };

  const refreshPaymentStatus = async (booking: WebsiteBookingRecord) => {
    if (!booking.paymentOrderReference) return;

    setRefreshingPaymentId(booking.id);
    try {
      const response = await fetch(`/api/payments/ngenius/status?orderReference=${encodeURIComponent(booking.paymentOrderReference)}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error ?? "Payment status lookup failed.");
      }

      const gatewayState = typeof result.paymentState === "string" ? result.paymentState.toUpperCase() : "UNKNOWN";
      let nextPaymentStatus: WebsiteBookingPaymentStatus = "pending";
      if (PAID_GATEWAY_STATES.has(gatewayState)) {
        nextPaymentStatus = "paid";
      } else if (FAILED_GATEWAY_STATES.has(gatewayState)) {
        nextPaymentStatus = gatewayState.includes("CANCEL") ? "cancelled" : "failed";
      }
      const checkedAt = new Date().toISOString();
      const nextWebsiteBookings = websiteBookings.map((entry) =>
        entry.id === booking.id
          ? {
              ...entry,
              paymentStatus: nextPaymentStatus,
              paymentGatewayState: gatewayState,
              paymentCheckedAt: checkedAt,
            }
          : entry,
      );

      setWebsiteBookings(nextWebsiteBookings);
      writeWebsiteBookings(nextWebsiteBookings);
      toast({
        title: nextPaymentStatus === "paid" ? "Payment received" : "Payment status updated",
        description: `${booking.bookingReference}: ${getReceptionPaymentLabel({ ...booking, paymentStatus: nextPaymentStatus })}`,
      });
    } catch (error) {
      toast({
        title: "Payment status failed",
        description: error instanceof Error ? error.message : "Could not refresh payment status.",
        variant: "destructive",
      });
    } finally {
      setRefreshingPaymentId(null);
    }
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Website Booking</h1>
          <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Landing-page booking requests synced live for reception follow-up
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="h-10 px-4 font-black uppercase tracking-widest text-[10px]">
            {websiteBookings.length} Requests
          </Badge>
          <Badge variant="outline" className="h-10 border-amber-500 bg-amber-50 px-4 font-black uppercase tracking-widest text-[10px] text-amber-700">
            {unreadWebsiteBookings.length} New
          </Badge>
          <Button
            variant="outline"
            onClick={() => markBookingsAsSeen()}
            disabled={unreadWebsiteBookings.length === 0}
            className="h-10 border-amber-500 font-black uppercase tracking-widest text-[10px] text-amber-800"
          >
            Mark All Seen
          </Button>
        </div>
      </header>

      <Card className="border-none shadow-sm">
        <CardHeader className="border-b bg-amber-50/60">
          <CardTitle className="text-xl font-black uppercase tracking-tight">Website Booking Requests</CardTitle>
          <CardDescription>New online bookings appear here automatically.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Reference</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Guest</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Stay</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Contact</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Payment</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Backend</TableHead>
                <TableHead className="h-12 font-black uppercase tracking-widest text-[10px]">Status</TableHead>
                <TableHead className="h-12 text-right font-black uppercase tracking-widest text-[10px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {websiteBookings.map((booking) => (
                <TableRow key={booking.id}>
                  <TableCell className="font-black">{booking.bookingReference}</TableCell>
                  <TableCell className="font-bold">
                    <p>{booking.fullName}</p>
                    <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      {booking.guests} Guest{booking.guests === 1 ? "" : "s"} | {getWebsiteRoomTypeLabel(booking.roomType)}
                    </p>
                  </TableCell>
                  <TableCell className="font-bold">
                    <p>{booking.checkIn} to {booking.checkOut}</p>
                    <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      {booking.nights} Night{booking.nights === 1 ? "" : "s"} | TZS {booking.totalAmount.toLocaleString()}
                    </p>
                  </TableCell>
                  <TableCell className="font-bold">
                    <p>{booking.phone}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{booking.email}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={getReceptionPaymentClass(booking)}>
                      {getReceptionPaymentLabel(booking)}
                    </Badge>
                    {booking.paymentOrderReference ? (
                      <div className="mt-2 space-y-1">
                        <p className="max-w-[180px] truncate text-xs text-muted-foreground">{booking.paymentOrderReference}</p>
                        {booking.paymentGatewayState ? (
                          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                            Gateway: {booking.paymentGatewayState}
                          </p>
                        ) : null}
                        {booking.paymentCheckedAt ? (
                          <p className="text-[10px] text-muted-foreground">
                            Checked {new Date(booking.paymentCheckedAt).toLocaleString()}
                          </p>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void refreshPaymentStatus(booking)}
                          disabled={refreshingPaymentId === booking.id}
                          className="h-8 px-2 text-[10px] font-black uppercase tracking-widest"
                        >
                          {refreshingPaymentId === booking.id ? "Checking..." : "Check Payment"}
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        booking.backendSyncStatus === "synced"
                          ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                          : "border-red-500 bg-red-50 text-red-700"
                      }
                    >
                      {booking.backendSyncStatus ?? "synced"}
                    </Badge>
                    {booking.backendSyncError ? (
                      <p className="mt-1 max-w-[220px] text-xs text-muted-foreground">{booking.backendSyncError}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={booking.status === "new" ? "border-amber-500 bg-amber-50 text-amber-700" : ""}
                    >
                      {booking.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      onClick={() => markBookingsAsSeen([booking.id])}
                      disabled={booking.status === "seen"}
                      className="h-9 font-black uppercase tracking-widest text-[10px]"
                    >
                      Mark Seen
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {websiteBookings.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center opacity-40">
                    <MonitorSmartphone className="mx-auto mb-3 h-12 w-12" />
                    <p className="font-black uppercase tracking-widest text-xs">No website bookings found</p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
