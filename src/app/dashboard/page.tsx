"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { readStoredRole } from "@/app/lib/auth";
import { Role, ROOMS } from "@/app/lib/mock-data";
import { getActiveBaristaStateKey, getActiveKitchenStateKey, readCashierState, readJson, readPosState } from "@/app/lib/storage";
import { LaundryRecord, STORAGE_LAUNDRY_RECORDS } from "@/app/lib/laundry";
import { ExpenseRecord, STORAGE_EXPENSES } from "@/app/lib/expenses";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Users,
  BedDouble,
  DollarSign,
  TrendingUp,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  FileText,
  Package,
} from "lucide-react";
import { deriveRoomsStateFromBookings, readRoomsState } from "@/app/lib/rooms-storage";
import { subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface CashierTransaction {
  roomNumber?: string;
  total: number;
  status?: "completed" | "checked-out" | "credit";
  checkOutDate?: string;
  checkOutTime?: string;
}

interface QueueTicket {
  id: string;
}

interface POSPaymentRecord {
  total: number;
  status?: "completed" | "credit";
  createdAt?: number;
}

export default function OverviewPage() {
  const [role, setRole] = useState<Role>("manager");
  const [shift, setShift] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [reportText, setReportText] = useState("");

  const [bookingRevenue, setBookingRevenue] = useState(0);
  const [activeKitchen, setActiveKitchen] = useState(0);
  const [activeBarista, setActiveBarista] = useState(0);
  const [kitchenRevenue, setKitchenRevenue] = useState(0);
  const [baristaRevenue, setBaristaRevenue] = useState(0);
  const [foodRevenue, setFoodRevenue] = useState(0);
  const [laundryRevenue, setLaundryRevenue] = useState(0);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [creditExposure, setCreditExposure] = useState(0);
  const [settledToday, setSettledToday] = useState(0);
  const [rooms, setRooms] = useState(ROOMS);

  useEffect(() => {
    const collectPaymentMetrics = (records: POSPaymentRecord[]) => {
      const today = new Date().toDateString();
      const paid = records
        .filter((record) => record.status !== "credit")
        .reduce((sum, record) => sum + (record.total || 0), 0);
      const credit = records
        .filter((record) => record.status === "credit")
        .reduce((sum, record) => sum + (record.total || 0), 0);
      const settledCount = records.filter((record) => {
        if (record.status === "credit" || !record.createdAt) return false;
        return new Date(record.createdAt).toDateString() === today;
      }).length;
      return { paid, credit, settledCount };
    };
    const collectRecordTotals = <T extends { total?: number; totalAmount?: number; status?: string }>(
      records: T[],
      amountKey: "total" | "totalAmount",
    ) => {
      const paid = records
        .filter((record) => record.status !== "credit")
        .reduce((sum, record) => sum + (Number(record[amountKey]) || 0), 0);
      const credit = records
        .filter((record) => record.status === "credit")
        .reduce((sum, record) => sum + (Number(record[amountKey]) || 0), 0);
      return { paid, credit };
    };

    const activeKitchenKey = getActiveKitchenStateKey();
    const activeBaristaKey = getActiveBaristaStateKey();

    const refreshOverview = () => {
      const savedRole = readStoredRole();
      const savedShift = localStorage.getItem("orange-hotel-shift");
      const cashierSnapshot = readCashierState<CashierTransaction>("orange-hotel-cashier-transactions", "orange-hotel-cashier-seq", 84920);
      const kitchenSnapshot = readPosState<QueueTicket, POSPaymentRecord, unknown>(activeKitchenKey, "orange-hotel-kitchen-tickets", "orange-hotel-kitchen-seq", "orange-hotel-kitchen-payments", "orange-hotel-kitchen-menu", 300);
      const baristaSnapshot = readPosState<QueueTicket, POSPaymentRecord, unknown>(activeBaristaKey, "orange-hotel-barista-orders", "orange-hotel-barista-seq", "orange-hotel-barista-payments", "orange-hotel-barista-menu", 490);
      const laundry = readJson<LaundryRecord[]>(STORAGE_LAUNDRY_RECORDS) ?? [];
      const expenses = readJson<ExpenseRecord[]>(STORAGE_EXPENSES) ?? [];
      setRooms(
        deriveRoomsStateFromBookings(
          cashierSnapshot.transactions.filter((tx): tx is CashierTransaction & { roomNumber: string } => Boolean(tx.roomNumber)),
          readRoomsState(),
        ),
      );

      if (savedRole) setRole(savedRole);
      if (savedShift) setShift(savedShift);

      const bookingMetrics = collectRecordTotals(cashierSnapshot.transactions, "total");
      const laundryMetrics = collectRecordTotals(laundry, "totalAmount");

      setBookingRevenue(bookingMetrics.paid);
      setActiveKitchen(kitchenSnapshot.tickets.length);
      setActiveBarista(baristaSnapshot.tickets.length);

      const kitchenMetrics = collectPaymentMetrics(kitchenSnapshot.payments);
      const baristaMetrics = collectPaymentMetrics(baristaSnapshot.payments);

      setKitchenRevenue(kitchenMetrics.paid);
      setBaristaRevenue(baristaMetrics.paid);
      setFoodRevenue(kitchenMetrics.paid + baristaMetrics.paid);
      setLaundryRevenue(laundryMetrics.paid);
      setExpensesTotal(expenses.reduce((sum, expense) => sum + (expense.amount || 0), 0));
      setCreditExposure(bookingMetrics.credit + kitchenMetrics.credit + baristaMetrics.credit + laundryMetrics.credit);
      setSettledToday(kitchenMetrics.settledCount + baristaMetrics.settledCount);
      setMounted(true);
    };

    refreshOverview();

    const unsubscribeCashier = subscribeToSyncedStorageKey("orange-hotel-cashier-state", refreshOverview);
    const unsubscribeKitchen = subscribeToSyncedStorageKey(activeKitchenKey, refreshOverview);
    const unsubscribeBarista = subscribeToSyncedStorageKey(activeBaristaKey, refreshOverview);
    const unsubscribeLaundry = subscribeToSyncedStorageKey(STORAGE_LAUNDRY_RECORDS, refreshOverview);
    const unsubscribeExpenses = subscribeToSyncedStorageKey(STORAGE_EXPENSES, refreshOverview);
    const unsubscribeRooms = subscribeToSyncedStorageKey("orange-hotel-rooms-state", refreshOverview);

    return () => {
      unsubscribeCashier();
      unsubscribeKitchen();
      unsubscribeBarista();
      unsubscribeLaundry();
      unsubscribeExpenses();
      unsubscribeRooms();
    };
  }, []);

  const occupiedRooms = useMemo(() => rooms.filter((room) => room.status === "occupied").length, [rooms]);
  const recentRooms = useMemo(() => rooms.slice(0, 4), [rooms]);
  const isDirector = role === "director";
  const occupancyPct = Math.round((occupiedRooms / Math.max(rooms.length, 1)) * 100);
  const totalRevenue = bookingRevenue + foodRevenue + laundryRevenue;
  const actualNetRevenue = totalRevenue - expensesTotal;
  const revPar = Math.round(totalRevenue / Math.max(rooms.length, 1));
  const netRevenueChartData = useMemo(
    () => [
      { name: "Booking", value: bookingRevenue, fill: "#F57C00" },
      { name: "Kitchen", value: kitchenRevenue, fill: "#111111" },
      { name: "Barista", value: baristaRevenue, fill: "#00A676" },
      { name: "Laundry", value: laundryRevenue, fill: "#2F80ED" },
      { name: "Expenses", value: expensesTotal, fill: "#D92D20" },
      { name: "Net", value: actualNetRevenue, fill: actualNetRevenue >= 0 ? "#15803D" : "#B42318" },
    ],
    [actualNetRevenue, baristaRevenue, bookingRevenue, expensesTotal, kitchenRevenue, laundryRevenue],
  );

  const stats = useMemo(
    () => [
      { label: "Booking Revenue", value: `TSh ${bookingRevenue.toLocaleString()}`, icon: DollarSign, trend: "+12%", trendUp: true, color: "text-green-500" },
      { label: "Room Occupancy", value: `${occupancyPct}%`, icon: BedDouble, trend: "+5%", trendUp: true, color: "text-blue-500" },
      { label: "Kitchen Queue", value: `${activeKitchen}`, icon: TrendingUp, trend: activeKitchen > 5 ? "High" : "Stable", trendUp: activeKitchen <= 5, color: "text-orange-500" },
      { label: "Barista Queue", value: `${activeBarista}`, icon: Users, trend: activeBarista > 5 ? "High" : "Stable", trendUp: activeBarista <= 5, color: "text-purple-500" },
    ],
    [activeBarista, activeKitchen, bookingRevenue, occupancyPct],
  );

  const executiveStats = useMemo(
    () => [
      { label: "Total Revenue", value: `TSh ${totalRevenue.toLocaleString()}`, note: "Rooms + F&B + laundry collections" },
      { label: "Actual Net Revenue", value: `TSh ${actualNetRevenue.toLocaleString()}`, note: "All income minus all expenses" },
      { label: "Total Expenses", value: `TSh ${expensesTotal.toLocaleString()}`, note: "Every saved expense record" },
      { label: "F&B Revenue", value: `TSh ${foodRevenue.toLocaleString()}`, note: "Kitchen and Barista settlements" },
      { label: "Laundry Revenue", value: `TSh ${laundryRevenue.toLocaleString()}`, note: "Completed laundry collections" },
      { label: "Credit Exposure", value: `TSh ${creditExposure.toLocaleString()}`, note: "Outstanding unsettled balances" },
      { label: "RevPAR", value: `TSh ${revPar.toLocaleString()}`, note: "Revenue per available room" },
      { label: "Occupancy", value: `${occupancyPct}%`, note: `${occupiedRooms}/${rooms.length} occupied rooms` },
      { label: "Settled Today", value: `${settledToday}`, note: "Completed POS settlements today" },
    ],
    [actualNetRevenue, creditExposure, expensesTotal, foodRevenue, laundryRevenue, occupancyPct, occupiedRooms, revPar, rooms.length, settledToday, totalRevenue],
  );

  const generateReport = () => {
    const text = [
      `Operations Report (${new Date().toLocaleString()})`,
      `Role: ${role}${shift ? ` (${shift} shift)` : ""}`,
      `Booking Revenue: TSh ${bookingRevenue.toLocaleString()}`,
      `Laundry Revenue: TSh ${laundryRevenue.toLocaleString()}`,
      `Occupied Rooms: ${occupiedRooms}/${rooms.length}`,
      `Active Kitchen Tickets: ${activeKitchen}`,
      `Active Barista Tickets: ${activeBarista}`,
    ].join("\n");

    setReportText(text);
  };

  if (!mounted) return null;

  return (
    <div className={cn("space-y-8", isDirector && "space-y-5 md:space-y-8")}>
      <header className={cn("flex flex-col md:flex-row md:items-end justify-between gap-4", isDirector && "rounded-lg border border-black/5 bg-white p-4 shadow-sm md:border-0 md:bg-transparent md:p-0 md:shadow-none")}>
        <div>
          <h1 className={cn("text-3xl font-black tracking-tight uppercase", isDirector && "text-2xl md:text-3xl")}>
            {isDirector ? "Executive Overview" : "Operations Overview"}
          </h1>
          <p className={cn("text-muted-foreground uppercase font-bold text-xs tracking-wider", isDirector && "mt-1 text-[10px] leading-5")}>
            {isDirector ? "Read-only strategic dashboard for managing director" : `Active performance tracking for ${role}`}
          </p>
        </div>
        <div className="flex gap-2">
          {shift && (
            <Badge variant="outline" className="bg-white border-primary text-primary px-3 py-1 font-bold uppercase tracking-tight">
              <Clock className="w-3 h-3 mr-2" />
              {shift} Shift
            </Badge>
          )}
          {!isDirector && (
            <Button size="sm" className="bg-primary hover:bg-primary/90 font-bold px-6 uppercase tracking-widest text-[10px]" onClick={generateReport}>
              <FileText className="w-3.5 h-3.5 mr-2" /> Generate Report
            </Button>
          )}
        </div>
      </header>

      {reportText && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <pre className="text-xs whitespace-pre-wrap font-semibold text-muted-foreground">{reportText}</pre>
          </CardContent>
        </Card>
      )}

      {!isDirector && (
        <section className="space-y-3">
          <div>
            <h2 className="text-2xl font-black tracking-tight uppercase">Stock Review</h2>
            <p className="text-muted-foreground uppercase font-bold text-[10px] tracking-wider">
              Open compact read-only kitchen and barista stock pages without loading the full tables here.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[
              { label: "Kitchen Stock", href: "/dashboard/inventory/kitchen-stock" },
              { label: "Barista Stock", href: "/dashboard/inventory/barista-stock" },
              { label: "Laundry", href: "/dashboard/laundry" },
              { label: "Finances", href: "/dashboard/finances" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center justify-between rounded-lg border bg-white p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Read Only</p>
                  <p className="mt-1 text-lg font-black uppercase tracking-tight">{item.label}</p>
                </div>
                <Package className="h-5 w-5 text-primary" />
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6", isDirector && "grid-cols-2 gap-3 md:gap-6")}>
        {stats.map((stat) => (
          <Card key={stat.label} className={cn("border-none shadow-sm hover:shadow-md transition-shadow bg-white overflow-hidden group", isDirector && "rounded-lg border border-black/5 shadow-sm")}>
            <CardContent className={cn("p-6", isDirector && "p-4")}>
              <div className={cn("flex items-center justify-between mb-4", isDirector && "mb-3")}>
                <div className={cn("p-2 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors", isDirector && "bg-[#eef4ed]")}>
                  <stat.icon className={cn("w-5 h-5", stat.color)} />
                </div>
                <div className={cn("flex items-center text-xs font-bold", stat.trendUp ? "text-green-500" : "text-destructive")}>
                  {stat.trendUp ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
                  {stat.trend}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-black text-muted-foreground uppercase tracking-wider">{stat.label}</p>
                <h3 className={cn("text-2xl font-black mt-1 tracking-tight", isDirector && "break-words text-lg leading-tight md:text-2xl")}>{stat.value}</h3>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {isDirector && (
        <div className="space-y-4">
          <Card className="rounded-lg border border-black/5 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg font-black uppercase tracking-tight">Managing Director Snapshot</CardTitle>
              <CardDescription>Strategic indicators across revenue, occupancy, and receivables</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-3">
                {executiveStats.map((metric) => (
                  <div key={metric.label} className="rounded-lg border bg-[#f7faf6] p-3 md:p-4">
                    <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground md:text-[10px]">{metric.label}</p>
                    <p className="mt-2 break-words text-lg font-black leading-tight md:text-2xl">{metric.value}</p>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground md:text-xs">{metric.note}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-lg border border-black/5 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg font-black uppercase tracking-tight">Actual Net Revenue</CardTitle>
              <CardDescription>
                Booking + kitchen + barista + laundry income minus all saved expenses
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-3">
                <div className="rounded-lg border bg-[#f7faf6] p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">All Income</p>
                  <p className="mt-2 text-2xl font-black">TSh {totalRevenue.toLocaleString()}</p>
                  <p className="mt-2 text-xs font-bold text-muted-foreground">
                    Booking {bookingRevenue.toLocaleString()} + Kitchen {kitchenRevenue.toLocaleString()} + Barista {baristaRevenue.toLocaleString()} + Laundry {laundryRevenue.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-lg border bg-red-50 p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-red-700">All Expenses</p>
                  <p className="mt-2 text-2xl font-black text-red-700">TSh {expensesTotal.toLocaleString()}</p>
                  <p className="mt-2 text-xs font-bold text-red-700/80">Every saved expense record is deducted here.</p>
                </div>
                <div className={`rounded-lg border p-4 ${actualNetRevenue >= 0 ? "bg-green-50" : "bg-red-50"}`}>
                  <p className={`text-[10px] font-black uppercase tracking-widest ${actualNetRevenue >= 0 ? "text-green-700" : "text-red-700"}`}>Net Revenue</p>
                  <p className={`mt-2 text-3xl font-black ${actualNetRevenue >= 0 ? "text-green-700" : "text-red-700"}`}>
                    TSh {actualNetRevenue.toLocaleString()}
                  </p>
                  <p className={`mt-2 text-xs font-bold ${actualNetRevenue >= 0 ? "text-green-700/80" : "text-red-700/80"}`}>
                    Actual net = all income minus all expenses.
                  </p>
                </div>
              </div>
              <div className="min-h-[320px] rounded-lg border p-3">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={netRevenueChartData} margin={{ top: 10, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fontWeight: 800 }} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 10, fontWeight: 700 }}
                      tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`}
                    />
                    <Tooltip
                      formatter={(value) => [`TSh ${Number(value).toLocaleString()}`, "Amount"]}
                      labelStyle={{ fontWeight: 800, textTransform: "uppercase" }}
                    />
                    <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                      {netRevenueChartData.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { label: "Booking", href: "/dashboard/cashier", note: "Reception bookings" },
              { label: "Staff", href: "/dashboard/staff", note: "Actual system users" },
              { label: "Reports", href: "/dashboard/analytics", note: "Daily, weekly, monthly" },
              { label: "Payments", href: "/dashboard/payments", note: "Collections and credits" },
              { label: "Kitchen Stock", href: "/dashboard/kitchen", note: "Stock, purchases, entries" },
              { label: "Barista Stock", href: "/dashboard/barista", note: "Inventory, finances, purchases" },
              { label: "Finances", href: "/dashboard/finances", note: "Income and expenses" },
              { label: "Rooms", href: "/dashboard/rooms", note: "Occupancy status" },
              { label: "Expenses", href: "/dashboard/expenses", note: "Grouped spending" },
            ].map((item) => (
              <Link key={item.href} href={item.href} className="rounded-lg border border-black/5 bg-white p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{item.note}</p>
                <p className="mt-2 text-sm font-black uppercase tracking-tight">{item.label}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className={cn("grid grid-cols-1 gap-8", !isDirector && "lg:grid-cols-3")}>
        <div className={cn("space-y-8", !isDirector && "lg:col-span-2")}>
          <div className="grid grid-cols-1 md:grid-cols-1 gap-8">
            <Card className={cn("shadow-sm border-none bg-white", isDirector && "rounded-lg border border-black/5")}>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-black uppercase tracking-tight">Room Status</CardTitle>
                  <CardDescription>Real-time housekeeping update</CardDescription>
                </div>
                <BedDouble className="w-5 h-5 text-primary" />
              </CardHeader>
              <CardContent className="space-y-4">
                {recentRooms.map((room) => (
                  <div key={room.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center font-black text-sm">
                        {room.number}
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-none font-black uppercase tracking-tighter">{room.type}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] capitalize font-black uppercase tracking-tighter",
                        room.status === "available" && "bg-green-50 text-green-700 border-green-200",
                        room.status === "occupied" && "bg-blue-50 text-blue-700 border-blue-200",
                        room.status === "cleaning" && "bg-orange-50 text-orange-700 border-orange-200",
                        room.status === "maintenance" && "bg-gray-50 text-gray-700 border-gray-200",
                      )}
                    >
                      {room.status}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {!isDirector && (
        <Card className="bg-black text-white shadow-lg overflow-hidden relative border-none rounded-lg">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2 font-black uppercase tracking-tight">Activity Log</CardTitle>
            <CardDescription className="text-muted-foreground text-[10px] uppercase tracking-widest font-bold">Internal Updates</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {[
                { user: "Reception", action: "Room status updated", time: `${occupiedRooms}/${rooms.length} occupied rooms` },
                { user: "Kitchen", action: "Prep pipeline updated", time: `${activeKitchen} open orders` },
                { user: "Barista", action: "Beverage queue updated", time: `${activeBarista} open orders` },
                { user: "Inventory", action: "Stock control updated", time: "Inventory module active" },
              ].map((log, index) => (
                <div key={index} className="flex gap-3 relative">
                  {index !== 3 && <div className="absolute left-4 top-8 bottom-[-24px] w-0.5 bg-sidebar-accent" />}
                  <div className="w-8 h-8 rounded-full bg-sidebar-accent shrink-0 flex items-center justify-center border border-white/10 z-10">
                    <span className="text-[10px] font-black">{log.user[0]}</span>
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase tracking-tighter">{log.user}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 font-medium">{log.action}</p>
                    <p className="text-[9px] text-primary mt-1 flex items-center gap-1 uppercase tracking-widest font-black">
                      <Clock className="w-2 h-2" /> {log.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}
