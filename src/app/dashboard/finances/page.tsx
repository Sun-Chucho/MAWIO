"use client";

import { useEffect, useMemo, useState } from "react";
import { ExpenseRecord, STORAGE_EXPENSES, getExpenseDepartmentLabel } from "@/app/lib/expenses";
import { LaundryRecord, STORAGE_LAUNDRY_RECORDS } from "@/app/lib/laundry";
import { getActiveBaristaStateKey, getActiveKitchenStateKey, readCashierState, readJson, readPosState } from "@/app/lib/storage";
import { hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface BookingRecord {
  total: number;
  createdAt?: number;
  status?: "completed" | "checked-out" | "credit";
}

interface PosPaymentRecord {
  total: number;
  createdAt?: number;
  status?: "completed" | "credit";
}

function money(value: number) {
  return `TSh ${Math.round(asNumber(value)).toLocaleString()}`;
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getDayKey(value: unknown) {
  const date = new Date(asNumber(value));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function matchesSelectedDate(createdAt: unknown, selectedDate: string) {
  if (!selectedDate) return true;
  return getDayKey(createdAt) === selectedDate;
}

export default function FinancesPage() {
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [kitchenPayments, setKitchenPayments] = useState<PosPaymentRecord[]>([]);
  const [baristaPayments, setBaristaPayments] = useState<PosPaymentRecord[]>([]);
  const [laundryRecords, setLaundryRecords] = useState<LaundryRecord[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState("");

  useEffect(() => {
    const activeKitchenKey = getActiveKitchenStateKey();
    const activeBaristaKey = getActiveBaristaStateKey();

    const refreshFinances = () => {
      const cashierSnapshot = readCashierState<BookingRecord>("orange-hotel-cashier-transactions", "orange-hotel-cashier-seq", 84920);
      const kitchenSnapshot = readPosState<unknown, PosPaymentRecord, unknown>(activeKitchenKey, "orange-hotel-kitchen-tickets", "orange-hotel-kitchen-seq", "orange-hotel-kitchen-payments", "orange-hotel-kitchen-menu", 300);
      const baristaSnapshot = readPosState<unknown, PosPaymentRecord, unknown>(activeBaristaKey, "orange-hotel-barista-orders", "orange-hotel-barista-seq", "orange-hotel-barista-payments", "orange-hotel-barista-menu", 490);
      setBookings(cashierSnapshot.transactions);
      setKitchenPayments(kitchenSnapshot.payments);
      setBaristaPayments(baristaSnapshot.payments);
      setLaundryRecords(readJson<LaundryRecord[]>(STORAGE_LAUNDRY_RECORDS) ?? []);
      setExpenses(readJson<ExpenseRecord[]>(STORAGE_EXPENSES) ?? []);
    };

    refreshFinances();
    void Promise.all([
      hydrateStorageKeyFromFirebase("orange-hotel-cashier-state"),
      hydrateStorageKeyFromFirebase(activeKitchenKey),
      hydrateStorageKeyFromFirebase(activeBaristaKey),
      hydrateStorageKeyFromFirebase(STORAGE_LAUNDRY_RECORDS),
      hydrateStorageKeyFromFirebase(STORAGE_EXPENSES),
    ]).finally(refreshFinances);
    const unsubscribers = [
      subscribeToSyncedStorageKey("orange-hotel-cashier-state", refreshFinances),
      subscribeToSyncedStorageKey(activeKitchenKey, refreshFinances),
      subscribeToSyncedStorageKey(activeBaristaKey, refreshFinances),
      subscribeToSyncedStorageKey(STORAGE_LAUNDRY_RECORDS, refreshFinances),
      subscribeToSyncedStorageKey(STORAGE_EXPENSES, refreshFinances),
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  const totals = useMemo(() => {
    const datedBookings = bookings.filter((item) => matchesSelectedDate(item.createdAt, selectedDate));
    const datedKitchenPayments = kitchenPayments.filter((item) => matchesSelectedDate(item.createdAt, selectedDate));
    const datedBaristaPayments = baristaPayments.filter((item) => matchesSelectedDate(item.createdAt, selectedDate));
    const datedLaundryRecords = laundryRecords.filter((item) => matchesSelectedDate(item.createdAt, selectedDate));
    const datedExpenses = expenses.filter((item) => matchesSelectedDate(item.createdAt, selectedDate));
    const bookingRevenue = datedBookings.filter((item) => item.status !== "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const bookingCredit = datedBookings.filter((item) => item.status === "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const kitchenRevenue = datedKitchenPayments.filter((item) => item.status !== "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const kitchenCredit = datedKitchenPayments.filter((item) => item.status === "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const baristaRevenue = datedBaristaPayments.filter((item) => item.status !== "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const baristaCredit = datedBaristaPayments.filter((item) => item.status === "credit").reduce((sum, item) => sum + asNumber(item.total), 0);
    const laundryRevenue = datedLaundryRecords.filter((item) => item.status !== "credit").reduce((sum, item) => sum + asNumber(item.totalAmount), 0);
    const laundryCredit = datedLaundryRecords.filter((item) => item.status === "credit").reduce((sum, item) => sum + asNumber(item.totalAmount), 0);
    const expenseTotal = datedExpenses.reduce((sum, item) => sum + asNumber(item.amount), 0);
    const incomeTotal = bookingRevenue + kitchenRevenue + baristaRevenue + laundryRevenue;
    const creditTotal = bookingCredit + kitchenCredit + baristaCredit + laundryCredit;

    return {
      bookingRevenue,
      kitchenRevenue,
      baristaRevenue,
      laundryRevenue,
      incomeTotal,
      expenseTotal,
      creditTotal,
      netCash: incomeTotal - expenseTotal,
    };
  }, [baristaPayments, bookings, expenses, kitchenPayments, laundryRecords, selectedDate]);

  const expenseRows = useMemo(() => {
    const grouped = new Map<string, number>();
    expenses.filter((expense) => matchesSelectedDate(expense.createdAt, selectedDate)).forEach((expense) => {
      grouped.set(expense.department, (grouped.get(expense.department) ?? 0) + asNumber(expense.amount));
    });
    return Array.from(grouped.entries()).map(([department, total]) => ({
      label: getExpenseDepartmentLabel(department as ExpenseRecord["department"]),
      total,
    }));
  }, [expenses, selectedDate]);

  const incomeRows = [
    { label: "Booking Revenue", total: totals.bookingRevenue },
    { label: "Kitchen Revenue", total: totals.kitchenRevenue },
    { label: "Barista Revenue", total: totals.baristaRevenue },
    { label: "Laundry Revenue", total: totals.laundryRevenue },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-black uppercase tracking-tight">Finances</h1>
          <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Income, expenses, credit exposure, and actual cash position
          </p>
        </div>
        <div className="w-full md:w-[180px]">
          <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Specific Date</p>
          <Input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="h-10" />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Income</p>
            <p className="mt-2 text-2xl font-black text-green-700">{money(totals.incomeTotal)}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Expenses</p>
            <p className="mt-2 text-2xl font-black text-red-700">{money(totals.expenseTotal)}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Actual Cash</p>
            <p className={`mt-2 text-2xl font-black ${totals.netCash >= 0 ? "text-green-700" : "text-red-700"}`}>{money(totals.netCash)}</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Credit</p>
            <p className="mt-2 text-2xl font-black text-amber-700">{money(totals.creditTotal)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="border-b">
            <CardTitle className="text-lg font-black uppercase tracking-tight">Income Breakdown</CardTitle>
            <CardDescription>Completed collections by department.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest">Lane</TableHead>
                  <TableHead className="text-right font-black uppercase text-[10px] tracking-widest">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incomeRows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="font-bold">{row.label}</TableCell>
                    <TableCell className="text-right font-black">{money(row.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="border-b">
            <CardTitle className="text-lg font-black uppercase tracking-tight">Expense Breakdown</CardTitle>
            <CardDescription>Recorded manager expenses by lane.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-black uppercase text-[10px] tracking-widest">Lane</TableHead>
                  <TableHead className="text-right font-black uppercase text-[10px] tracking-widest">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenseRows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell className="font-bold">{row.label}</TableCell>
                    <TableCell className="text-right font-black">{money(row.total)}</TableCell>
                  </TableRow>
                ))}
                {expenseRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={2} className="py-10 text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      No expenses recorded
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
