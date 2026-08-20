"use client";

import { useEffect, useMemo, useState } from "react";
import { Room } from "@/app/lib/mock-data";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  BedDouble,
  CheckCircle2,
  Clock,
  DoorOpen,
  Search,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsDirector } from "@/hooks/use-is-director";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { isBookingStillActive, readRoomsState, syncRoomsStateFromBookings, updateRoomStatusById } from "@/app/lib/rooms-storage";
import { subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { readCashierState, STORAGE_CASHIER_STATE, writeCashierState } from "@/app/lib/storage";
import { toast } from "@/hooks/use-toast";

type StatusFilter = "all" | Room["status"];

interface BookingRoomRecord {
  id: string;
  roomNumber: string;
  status?: "completed" | "credit" | "checked-out";
  createdAt?: number;
}

function getRoomTypeLabel(type: Room["type"]) {
  return type;
}

export default function RoomsPage() {
  const isDirector = useIsDirector();
  const { confirm, dialog } = useConfirmDialog();
  const [rooms, setRooms] = useState<Room[]>(readRoomsState());
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);

  useEffect(() => {
    const applyRoomSnapshot = (baseRooms?: Room[]) => {
      const cashierSnapshot = readCashierState<BookingRoomRecord>(
        "orange-hotel-cashier-transactions",
        "orange-hotel-cashier-seq",
        84920,
      );
      const nextRooms = syncRoomsStateFromBookings(cashierSnapshot.transactions, baseRooms);
      setRooms(nextRooms);
    };

    applyRoomSnapshot();

    const unsubscribeRooms = subscribeToSyncedStorageKey<Room[]>("orange-hotel-rooms-state", (value) => {
      applyRoomSnapshot(Array.isArray(value) && value.length > 0 ? value : readRoomsState());
    });
    const unsubscribeCashier = subscribeToSyncedStorageKey(STORAGE_CASHIER_STATE, () => {
      applyRoomSnapshot();
    });

    return () => {
      unsubscribeRooms();
      unsubscribeCashier();
    };
  }, []);

  const filteredRooms = useMemo(() => {
    return rooms.filter((room) => {
      const normalizedSearch = searchTerm.toLowerCase();
      const inSearch =
        room.number.includes(searchTerm) ||
        room.type.toLowerCase().includes(normalizedSearch) ||
        getRoomTypeLabel(room.type).toLowerCase().includes(normalizedSearch);
      const inStatus = statusFilter === "all" || room.status === statusFilter;
      return inSearch && inStatus;
    });
  }, [rooms, searchTerm, statusFilter]);

  const counts = useMemo(
    () => ({
      available: rooms.filter((room) => room.status === "available").length,
      occupied: rooms.filter((room) => room.status === "occupied").length,
      cleaning: rooms.filter((room) => room.status === "cleaning").length,
      maintenance: rooms.filter((room) => room.status === "maintenance").length,
    }),
    [rooms],
  );

  const hasActiveBookingForRoom = (roomNumber: string) => {
    const cashierSnapshot = readCashierState<BookingRoomRecord>(
      "orange-hotel-cashier-transactions",
      "orange-hotel-cashier-seq",
      84920,
    );

    return cashierSnapshot.transactions.some(
      (booking) => booking.roomNumber === roomNumber && isBookingStillActive(booking),
    );
  };

  const setRoomStatus = (roomId: string, roomNumber: string, status: Room["status"]) => {
    if (status !== "occupied") {
      const cashierSnapshot = readCashierState<BookingRoomRecord>(
        "orange-hotel-cashier-transactions",
        "orange-hotel-cashier-seq",
        84920,
      );
      const activeBooking = [...cashierSnapshot.transactions]
        .filter((booking) => booking.roomNumber === roomNumber && isBookingStillActive(booking))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

      if (activeBooking) {
        const nextTransactions = cashierSnapshot.transactions.map((booking) =>
          booking.id === activeBooking.id
            ? { ...booking, status: "checked-out" as const }
            : booking,
        );
        writeCashierState(nextTransactions, cashierSnapshot.receiptSeq);
      }
    }

    const nextRooms = updateRoomStatusById(roomId, status, rooms);
    setRooms(nextRooms);
  };

  const confirmAndSetRoomStatus = async (roomId: string, roomNumber: string, status: Room["status"]) => {
    if (isDirector) return;
    if (status === "occupied" && !hasActiveBookingForRoom(roomNumber)) {
      toast({
        title: "Active booking required",
        description: `Room ${roomNumber} can only be marked occupied from an active booking.`,
        variant: "destructive",
      });
      return false;
    }
    const labels: Record<Room["status"], string> = {
      available: "available",
      occupied: "occupied",
      cleaning: "cleaning",
      maintenance: "maintenance",
    };
    const approved = await confirm({
      title: "Update Room Status",
      description: `Are you sure you want to mark room ${roomNumber} as ${labels[status]}?`,
      actionLabel: "Update Room",
    });
    if (!approved) return false;
    setRoomStatus(roomId, roomNumber, status);
    return true;
  };

  const getStatusIcon = (status: Room["status"]) => {
    switch (status) {
      case "available":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "occupied":
        return <BedDouble className="w-4 h-4 text-blue-500" />;
      case "cleaning":
        return <Clock className="w-4 h-4 text-orange-500" />;
      case "maintenance":
        return <Wrench className="w-4 h-4 text-gray-500" />;
      default:
        return null;
    }
  };

  const getStatusCardStyles = (status: Room["status"]) => {
    switch (status) {
      case "available":
        return "border-green-200 bg-gradient-to-br from-green-50 to-white";
      case "occupied":
        return "border-blue-200 bg-gradient-to-br from-blue-50 to-white";
      case "cleaning":
        return "border-orange-200 bg-gradient-to-br from-orange-50 to-white";
      case "maintenance":
        return "border-gray-300 bg-gradient-to-br from-gray-100 to-white";
      default:
        return "border-border bg-white";
    }
  };

  const getStatusTextStyles = (status: Room["status"]) => {
    switch (status) {
      case "available":
        return "bg-green-600 text-white border-green-600 hover:bg-green-600";
      case "occupied":
        return "bg-blue-600 text-white border-blue-600 hover:bg-blue-600";
      case "cleaning":
        return "bg-orange-500 text-white border-orange-500 hover:bg-orange-500";
      case "maintenance":
        return "bg-gray-700 text-white border-gray-700 hover:bg-gray-700";
      default:
        return "";
    }
  };

  const handleRoomStatusUpdate = async (room: Room, status: Room["status"]) => {
    const updated = await confirmAndSetRoomStatus(room.id, room.number, status);
    if (!updated) return;
    setSelectedRoom((current) => (current && current.id === room.id ? { ...current, status } : current));
  };

  return (
    <div className="space-y-6">
      {dialog}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Room Management</h1>
          <p className="text-muted-foreground text-sm uppercase font-bold tracking-wider">Real-time status and occupancy control</p>
        </div>
      </header>
      {isDirector && (
        <Card className="border-emerald-200 bg-emerald-50/60 shadow-none">
          <CardContent className="p-3 text-xs font-black uppercase tracking-widest text-emerald-700">
            Managing Director View: Read-only room analytics and occupancy visibility
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Card className="bg-green-50/50 border-green-100 shadow-none">
          <CardContent className="flex items-center gap-3 p-3 md:gap-4 md:p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-500 text-white shadow-lg shadow-green-500/20 md:h-10 md:w-10">
              <CheckCircle2 className="h-5 w-5 md:h-6 md:w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase leading-4 tracking-wider text-green-700">Available</p>
              <h3 className="text-2xl font-black">{counts.available}</h3>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-blue-50/50 border-blue-100 shadow-none">
          <CardContent className="flex items-center gap-3 p-3 md:gap-4 md:p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500 text-white shadow-lg shadow-blue-500/20 md:h-10 md:w-10">
              <BedDouble className="h-5 w-5 md:h-6 md:w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase leading-4 tracking-wider text-blue-700">Occupied</p>
              <h3 className="text-2xl font-black">{counts.occupied}</h3>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-orange-50/50 border-orange-100 shadow-none">
          <CardContent className="flex items-center gap-3 p-3 md:gap-4 md:p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white shadow-lg shadow-orange-500/20 md:h-10 md:w-10">
              <Clock className="h-5 w-5 md:h-6 md:w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase leading-4 tracking-wider text-orange-700">Cleaning</p>
              <h3 className="text-2xl font-black">{counts.cleaning}</h3>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gray-50/50 border-gray-100 shadow-none">
          <CardContent className="flex items-center gap-3 p-3 md:gap-4 md:p-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-500 text-white shadow-lg shadow-gray-500/20 md:h-10 md:w-10">
              <Wrench className="h-5 w-5 md:h-6 md:w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase leading-4 tracking-wider text-gray-700">Maintenance</p>
              <h3 className="text-2xl font-black">{counts.maintenance}</h3>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm border-none bg-white">
        <CardHeader className="border-b bg-muted/10 px-6 py-4 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by room # or type..."
                className="pl-10 h-11 shadow-sm"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
              <TabsList className="h-10">
                <TabsTrigger value="all" className="text-[10px] font-black uppercase tracking-widest">All</TabsTrigger>
                <TabsTrigger value="available" className="text-[10px] font-black uppercase tracking-widest">Available</TabsTrigger>
                <TabsTrigger value="occupied" className="text-[10px] font-black uppercase tracking-widest">Occupied</TabsTrigger>
                <TabsTrigger value="cleaning" className="text-[10px] font-black uppercase tracking-widest">Cleaning</TabsTrigger>
                <TabsTrigger value="maintenance" className="text-[10px] font-black uppercase tracking-widest">Maintenance</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>

        <CardContent className="p-6">
          {filteredRooms.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filteredRooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => setSelectedRoom(room)}
                  className={cn(
                    "group rounded-3xl border p-5 text-left shadow-sm transition-all hover:-translate-y-1 hover:shadow-lg",
                    getStatusCardStyles(room.status),
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">Room</p>
                      <h2 className="mt-2 text-4xl font-black tracking-tight">{room.number}</h2>
                    </div>
                    <div className="rounded-2xl bg-white/80 p-3 shadow-sm">
                      {getStatusIcon(room.status)}
                    </div>
                  </div>

                  <div className="mt-6 flex items-center justify-between gap-3">
                    <Badge className="font-black uppercase text-[10px] tracking-widest bg-black text-white border-black hover:bg-black">
                      {getRoomTypeLabel(room.type)}
                    </Badge>
                    <Badge className={cn("font-black uppercase text-[10px] tracking-widest", getStatusTextStyles(room.status))}>
                      {room.status === "available" ? "Free" : room.status === "occupied" ? "Occupied" : room.status === "cleaning" ? "Cleaning" : "Fix"}
                    </Badge>
                  </div>

                  <div className="mt-6 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">Rate</p>
                      <p className="mt-1 text-lg font-black">TSh {room.price.toLocaleString()}</p>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      <DoorOpen className="w-4 h-4" />
                      {isDirector ? "View" : "Open"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center opacity-50">
              <DoorOpen className="mx-auto h-10 w-10" />
              <p className="mt-3 text-xs font-black uppercase tracking-widest">No rooms match the current filters</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedRoom)} onOpenChange={(open) => !open && setSelectedRoom(null)}>
        <DialogContent className="sm:max-w-lg">
          {selectedRoom && (
            <>
              <DialogHeader>
                <DialogTitle className="text-2xl font-black uppercase tracking-tight">Room {selectedRoom.number}</DialogTitle>
                <DialogDescription>
                  {isDirector ? "Room details only. Actions are disabled for managing director access." : "Select a room action. Existing room status behavior remains unchanged."}
                </DialogDescription>
              </DialogHeader>

              <div className={cn("rounded-3xl border p-5", getStatusCardStyles(selectedRoom.status))}>
                <div className="flex items-center justify-between gap-3">
                  <Badge className="font-black uppercase text-[10px] tracking-widest bg-black text-white border-black hover:bg-black">
                    {getRoomTypeLabel(selectedRoom.type)}
                  </Badge>
                  <Badge className={cn("font-black uppercase text-[10px] tracking-widest", getStatusTextStyles(selectedRoom.status))}>
                    {selectedRoom.status}
                  </Badge>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">Room Number</p>
                    <p className="mt-1 text-3xl font-black">{selectedRoom.number}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">Night Rate</p>
                    <p className="mt-1 text-2xl font-black">TSh {selectedRoom.price.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-col">
                {isDirector ? (
                  <Button variant="outline" onClick={() => setSelectedRoom(null)} className="w-full font-black uppercase text-[10px] tracking-widest">
                    Close
                  </Button>
                ) : (
                  <div className="grid w-full grid-cols-2 gap-2">
                    <Button
                      variant={selectedRoom.status === "occupied" ? "default" : "outline"}
                      className="font-black uppercase text-[10px] tracking-widest"
                      disabled={!hasActiveBookingForRoom(selectedRoom.number)}
                      onClick={() => void handleRoomStatusUpdate(selectedRoom, "occupied")}
                    >
                      Occ
                    </Button>
                    <Button
                      variant={selectedRoom.status === "cleaning" ? "default" : "outline"}
                      className="font-black uppercase text-[10px] tracking-widest"
                      onClick={() => void handleRoomStatusUpdate(selectedRoom, "cleaning")}
                    >
                      Clean
                    </Button>
                    <Button
                      variant={selectedRoom.status === "available" ? "default" : "outline"}
                      className="font-black uppercase text-[10px] tracking-widest"
                      onClick={() => void handleRoomStatusUpdate(selectedRoom, "available")}
                    >
                      Free
                    </Button>
                    <Button
                      variant={selectedRoom.status === "maintenance" ? "default" : "outline"}
                      className="font-black uppercase text-[10px] tracking-widest"
                      onClick={() => void handleRoomStatusUpdate(selectedRoom, "maintenance")}
                    >
                      Fix
                    </Button>
                  </div>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
