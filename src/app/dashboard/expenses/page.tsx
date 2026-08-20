"use client";

import { useEffect, useMemo, useState } from "react";
import { readStoredRole } from "@/app/lib/auth";
import {
  EXPENSE_AMOUNT_TYPES,
  EXPENSE_DEPARTMENTS,
  ExpenseAmountType,
  ExpenseDepartment,
  ExpenseRecord,
  getExpenseAmountTypeLabel,
  getExpenseDepartmentLabel,
  STORAGE_EXPENSES,
} from "@/app/lib/expenses";
import { Role } from "@/app/lib/mock-data";
import { readJson, writeJson } from "@/app/lib/storage";
import { subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Save, WalletCards } from "lucide-react";

function toDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestampForExpenseDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const now = new Date();
  const timestamp = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );

  if (toDateInputValue(timestamp) !== value || timestamp.getTime() > Date.now()) return null;
  return timestamp.getTime();
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function ExpensesPage() {
  const [role, setRole] = useState<Role>("manager");
  const [department, setDepartment] = useState<ExpenseDepartment>("kitchen");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [amountType, setAmountType] = useState<ExpenseAmountType>("cash");
  const [expenseDate, setExpenseDate] = useState(() => toDateInputValue());
  const [notes, setNotes] = useState("");
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [movingExpense, setMovingExpense] = useState<ExpenseRecord | null>(null);
  const [moveTarget, setMoveTarget] = useState<ExpenseDepartment>("kitchen");

  useEffect(() => {
    const storedRole = readStoredRole();
    if (storedRole) setRole(storedRole);

    const refreshExpenses = () => {
      const saved = readJson<ExpenseRecord[]>(STORAGE_EXPENSES);
      setExpenses(Array.isArray(saved) ? saved : []);
    };

    refreshExpenses();
    return subscribeToSyncedStorageKey(STORAGE_EXPENSES, refreshExpenses);
  }, []);

  const isDirector = role === "director";
  const filteredExpenses = useMemo(
    () =>
      expenses
        .filter((expense) => expense.department === department)
        .sort((left, right) => right.createdAt - left.createdAt),
    [department, expenses],
  );
  const groupedTotals = useMemo(
    () =>
      EXPENSE_DEPARTMENTS.map((item) => ({
        ...item,
        total: expenses
          .filter((expense) => expense.department === item.value)
          .reduce((sum, expense) => sum + expense.amount, 0),
        count: expenses.filter((expense) => expense.department === item.value).length,
      })),
    [expenses],
  );
  const activeTotal = filteredExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const allTotal = expenses.reduce((sum, expense) => sum + expense.amount, 0);

  const saveExpense = () => {
    if (isDirector) return;
    const parsedAmount = Number(amount);
    const createdAt = timestampForExpenseDate(expenseDate);
    if (!title.trim() || Number.isNaN(parsedAmount) || parsedAmount <= 0 || createdAt === null) return;

    const nextExpense: ExpenseRecord = {
      id: `expense-${Date.now()}`,
      department,
      title: title.trim(),
      amount: parsedAmount,
      amountType,
      notes: notes.trim() || undefined,
      expenseDate,
      createdAt,
      createdBy: role,
      payoutStatus: role === "manager" ? "approved" : undefined,
    };

    const nextExpenses = [nextExpense, ...expenses];
    setExpenses(nextExpenses);
    writeJson(STORAGE_EXPENSES, nextExpenses);
    setTitle("");
    setAmount("");
    setAmountType("cash");
    setExpenseDate(toDateInputValue());
    setNotes("");
  };

  const openMoveDialog = (expense: ExpenseRecord) => {
    if (isDirector) return;
    const fallbackTarget = EXPENSE_DEPARTMENTS.find((item) => item.value !== expense.department)?.value ?? "kitchen";
    setMovingExpense(expense);
    setMoveTarget(fallbackTarget);
  };

  const moveExpense = () => {
    if (isDirector) return;
    if (!movingExpense || moveTarget === movingExpense.department) return;
    const nextExpenses = expenses.map((expense) =>
      expense.id === movingExpense.id ? { ...expense, department: moveTarget } : expense,
    );
    setExpenses(nextExpenses);
    writeJson(STORAGE_EXPENSES, nextExpenses);
    setMovingExpense(null);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-black uppercase tracking-tight">Expenses</h1>
          <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Record and review kitchen, barista, rooms, office, managing director, maintenance, and utility expense requests
          </p>
        </div>
        <Badge variant="outline" className="w-fit px-3 py-1 font-black uppercase tracking-widest">
          Total TSh {allTotal.toLocaleString()}
        </Badge>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {groupedTotals.map((item) => (
          <Card key={item.value} className="shadow-sm">
            <CardContent className="p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{item.label}</p>
              <p className="mt-2 text-xl font-black">TSh {item.total.toLocaleString()}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{item.count} records</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs value={department} onValueChange={(value) => setDepartment(value as ExpenseDepartment)}>
        <TabsList className="h-auto min-h-11 flex-wrap justify-start">
          {EXPENSE_DEPARTMENTS.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="font-black uppercase text-[10px] tracking-widest">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!isDirector && (
        <Card className="shadow-sm">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-lg font-black uppercase tracking-tight">
              <WalletCards className="h-5 w-5 text-primary" />
              New {getExpenseDepartmentLabel(department)} Request
            </CardTitle>
            <CardDescription>Save the request with its actual expense date, amount type, and optional notes.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 pt-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Title of Request</Label>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Request title" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Amount Requested</Label>
              <Input type="number" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Type of Amount</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={amountType}
                onChange={(event) => setAmountType(event.target.value as ExpenseAmountType)}
              >
                {EXPENSE_AMOUNT_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Expense Date</Label>
              <Input
                type="date"
                max={toDateInputValue()}
                required
                value={expenseDate}
                onChange={(event) => setExpenseDate(event.target.value)}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Optional Notes</Label>
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Describe this amount" />
            </div>
            <div className="md:col-span-2">
              <Button onClick={saveExpense} className="font-black uppercase tracking-widest text-[10px]">
                <Save className="mr-2 h-4 w-4" />
                Save Expense
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm">
        <CardHeader className="border-b">
          <CardTitle className="text-lg font-black uppercase tracking-tight">
            {getExpenseDepartmentLabel(department)} Expense History
          </CardTitle>
          <CardDescription>
            {filteredExpenses.length} records, TSh {activeTotal.toLocaleString()} total
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest">Date</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest">Title</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest">Type</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest">Notes</TableHead>
                <TableHead className="text-right font-black uppercase text-[10px] tracking-widest">Amount</TableHead>
                {!isDirector && <TableHead className="text-right font-black uppercase text-[10px] tracking-widest">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredExpenses.map((expense) => (
                <TableRow key={expense.id}>
                  <TableCell className="font-bold">{formatDate(expense.createdAt)}</TableCell>
                  <TableCell className="font-bold">{expense.title}</TableCell>
                  <TableCell className="font-bold">{getExpenseAmountTypeLabel(expense.amountType)}</TableCell>
                  <TableCell className="max-w-xs font-medium text-muted-foreground">{expense.notes ?? "-"}</TableCell>
                  <TableCell className="text-right font-black">TSh {expense.amount.toLocaleString()}</TableCell>
                  {!isDirector && (
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => openMoveDialog(expense)} className="font-black uppercase tracking-widest text-[10px]">
                        Move
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {filteredExpenses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isDirector ? 5 : 6} className="py-10 text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    No expenses saved for this group
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {!isDirector && (
      <Dialog open={!!movingExpense} onOpenChange={(open) => !open && setMovingExpense(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-black uppercase tracking-tight">Move Expense</DialogTitle>
            <DialogDescription>
              Move {movingExpense?.title ?? "this entry"} from {movingExpense ? getExpenseDepartmentLabel(movingExpense.department) : ""} to another lane.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Move To</Label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={moveTarget}
              onChange={(event) => setMoveTarget(event.target.value as ExpenseDepartment)}
            >
              {EXPENSE_DEPARTMENTS.filter((item) => item.value !== movingExpense?.department).map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovingExpense(null)} className="font-black uppercase tracking-widest text-[10px]">
              Cancel
            </Button>
            <Button onClick={moveExpense} className="font-black uppercase tracking-widest text-[10px]">
              Move Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}
    </div>
  );
}
