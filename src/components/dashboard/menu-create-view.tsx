"use client";

import { useEffect, useState } from "react";
import { readJson, readPosState, STORAGE_BARISTA_STATE, STORAGE_KITCHEN_STATE, writeJson } from "@/app/lib/storage";
import { commitBaristaCatalogAndStockMutation, commitPosCatalogMutation, hydrateStorageKeyFromFirebase, subscribeToSyncedStorageKey } from "@/app/lib/firebase-sync";
import { buildInitialBaristaMenuItems, findStoreItemForMenuName, normalizeBaristaMenuItems } from "@/app/lib/barista-stock";
import { type MainStoreItem, STORAGE_INVENTORY_ITEMS, STORAGE_MAIN_STORE_ITEMS } from "@/app/lib/inventory-transfer";
import type { InventoryItem } from "@/app/lib/mock-data";
import {
  KITCHEN_CATEGORY_LABELS,
  KITCHEN_CATEGORY_OPTIONS,
  KitchenMenuCategory,
  KitchenMenuItem,
  mergeKitchenMenuItems,
} from "@/app/lib/kitchen-menu";
import { useIsDirector } from "@/hooks/use-is-director";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

type BaristaCategory = "espresso" | "coffee" | "tea" | "cold" | "snacks";

interface BaristaMenuItem {
  id: string;
  name: string;
  price: number;
  category: BaristaCategory;
  prepMinutes: number;
  barcode?: string;
  buyingPrice?: number;
  inventoryItemId?: string;
  storeItemId?: string;
}

interface QueueTicket {
  id: string;
}

interface PaymentRecord {
  id: string;
}

interface MenuAuditEntry {
  id: string;
  menu: "kitchen" | "barista";
  itemId: string;
  itemName: string;
  changedAt: number;
  changedBy: string;
  changes: string[];
}

const KITCHEN_LEGACY = {
  tickets: "orange-hotel-kitchen-tickets",
  seq: "orange-hotel-kitchen-seq",
  payments: "orange-hotel-kitchen-payments",
  menu: "orange-hotel-kitchen-menu",
  defaultSeq: 300,
} as const;

const BARISTA_LEGACY = {
  tickets: "orange-hotel-barista-orders",
  seq: "orange-hotel-barista-seq",
  payments: "orange-hotel-barista-payments",
  menu: "orange-hotel-barista-menu",
  defaultSeq: 490,
} as const;

const STORAGE_MENU_AUDIT = "orange-hotel-menu-audit-trail";

function formatAuditDate(value: number) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function MenuCreateView() {
  const isDirector = useIsDirector();
  const { confirm, dialog } = useConfirmDialog();
  const [tab, setTab] = useState<"kitchen" | "barista">("kitchen");

  const [kitchenMenuItems, setKitchenMenuItems] = useState<KitchenMenuItem[]>([]);
  const [kitchenName, setKitchenName] = useState("");
  const [kitchenPrice, setKitchenPrice] = useState("");
  const [kitchenPrepMinutes, setKitchenPrepMinutes] = useState("15");
  const [kitchenCategory, setKitchenCategory] = useState<KitchenMenuCategory>("salad");
  const [editingKitchenId, setEditingKitchenId] = useState<string | null>(null);
  const [editingKitchenName, setEditingKitchenName] = useState("");
  const [editingKitchenPrice, setEditingKitchenPrice] = useState("");

  const [baristaMenuItems, setBaristaMenuItems] = useState<BaristaMenuItem[]>([]);
  const [baristaName, setBaristaName] = useState("");
  const [baristaPrice, setBaristaPrice] = useState("");
  const [baristaPrepMinutes, setBaristaPrepMinutes] = useState("10");
  const [baristaCategory, setBaristaCategory] = useState<BaristaCategory>("coffee");
  const [editingBaristaId, setEditingBaristaId] = useState<string | null>(null);
  const [editingBaristaName, setEditingBaristaName] = useState("");
  const [editingBaristaPrice, setEditingBaristaPrice] = useState("");
  const [auditTrail, setAuditTrail] = useState<MenuAuditEntry[]>([]);
  const [catalogHydrated, setCatalogHydrated] = useState(false);
  const [catalogSyncError, setCatalogSyncError] = useState("");

  useEffect(() => {
    let disposed = false;

    const applyKitchenSnapshot = () => {
      if (disposed) return;
      const kitchenSnapshot = readPosState<QueueTicket, PaymentRecord, KitchenMenuItem>(
        STORAGE_KITCHEN_STATE,
        KITCHEN_LEGACY.tickets,
        KITCHEN_LEGACY.seq,
        KITCHEN_LEGACY.payments,
        KITCHEN_LEGACY.menu,
        KITCHEN_LEGACY.defaultSeq,
      );
      setKitchenMenuItems(mergeKitchenMenuItems(kitchenSnapshot.menuItems, {
        includeDefaultMenu: (kitchenSnapshot.catalogRevision ?? 0) === 0,
      }));
    };

    const applyBaristaSnapshot = () => {
      if (disposed) return;
      const baristaSnapshot = readPosState<QueueTicket, PaymentRecord, BaristaMenuItem>(
        STORAGE_BARISTA_STATE,
        BARISTA_LEGACY.tickets,
        BARISTA_LEGACY.seq,
        BARISTA_LEGACY.payments,
        BARISTA_LEGACY.menu,
        BARISTA_LEGACY.defaultSeq,
      );
      const nextMenuItems =
        (baristaSnapshot.catalogRevision ?? 0) === 0 && baristaSnapshot.menuItems.length === 0
          ? buildInitialBaristaMenuItems(readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [])
          : baristaSnapshot.menuItems;
      setBaristaMenuItems(normalizeBaristaMenuItems(
        nextMenuItems,
        (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []).filter((item) => item.lane === "barista"),
      ));
    };

    applyKitchenSnapshot();
    applyBaristaSnapshot();
    setAuditTrail(readJson<MenuAuditEntry[]>(STORAGE_MENU_AUDIT) ?? []);

    const unsubscribers = [
      subscribeToSyncedStorageKey(STORAGE_KITCHEN_STATE, applyKitchenSnapshot),
      subscribeToSyncedStorageKey(STORAGE_BARISTA_STATE, applyBaristaSnapshot),
      subscribeToSyncedStorageKey(STORAGE_INVENTORY_ITEMS, applyBaristaSnapshot),
      subscribeToSyncedStorageKey(STORAGE_MAIN_STORE_ITEMS, applyBaristaSnapshot),
      subscribeToSyncedStorageKey<MenuAuditEntry[]>(STORAGE_MENU_AUDIT, (value) => {
        setAuditTrail(Array.isArray(value) ? value : readJson<MenuAuditEntry[]>(STORAGE_MENU_AUDIT) ?? []);
      }),
    ];

    const finishCatalogHydration = () => {
      if (disposed) return;
      applyKitchenSnapshot();
      applyBaristaSnapshot();
      setCatalogSyncError("");
      setCatalogHydrated(true);
    };
    let retryTimer: number | null = null;
    const hydrateCatalogs = async () => {
      const results = await Promise.all([
        hydrateStorageKeyFromFirebase(STORAGE_KITCHEN_STATE),
        hydrateStorageKeyFromFirebase(STORAGE_BARISTA_STATE),
        hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
        hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
      ]);
      if (disposed) return;
      if (results.every((result) => result.ok)) {
        finishCatalogHydration();
        return;
      }
      // Cached menus may be shown read-only, but never grant a stale browser a
      // fresh catalog revision that could overwrite a manager's newer edits.
      setCatalogHydrated(false);
      setCatalogSyncError("Menu editing is locked until the shared catalog reconnects.");
      retryTimer = window.setTimeout(hydrateCatalogs, 5000);
    };

    void hydrateCatalogs();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const saveAuditEntry = (entry: MenuAuditEntry) => {
    const currentAuditTrail = readJson<MenuAuditEntry[]>(STORAGE_MENU_AUDIT) ?? auditTrail;
    const nextAuditTrail = [entry, ...currentAuditTrail].slice(0, 100);
    setAuditTrail(nextAuditTrail);
    writeJson(STORAGE_MENU_AUDIT, nextAuditTrail);
  };

  const addKitchenMenuItem = async () => {
    if (isDirector || !catalogHydrated) return;
    const price = Number(kitchenPrice);
    const prepMinutes = Number(kitchenPrepMinutes);
    if (!kitchenName.trim() || Number.isNaN(price) || price <= 0 || Number.isNaN(prepMinutes) || prepMinutes <= 0) return;
    const approved = await confirm({
      title: "Create Kitchen Menu Item",
      description: `Are you sure you want to add ${kitchenName.trim()} at TSh ${price.toLocaleString()}?`,
      actionLabel: "Add Menu Item",
    });
    if (!approved) return;
    const hydration = await hydrateStorageKeyFromFirebase(STORAGE_KITCHEN_STATE);
    if (!hydration.ok) {
      window.alert("The shared Kitchen menu could not be refreshed. No menu change was saved; reconnect and try again.");
      return;
    }

    const latestSnapshot = readPosState<QueueTicket, PaymentRecord, KitchenMenuItem>(
      STORAGE_KITCHEN_STATE,
      KITCHEN_LEGACY.tickets,
      KITCHEN_LEGACY.seq,
      KITCHEN_LEGACY.payments,
      KITCHEN_LEGACY.menu,
      KITCHEN_LEGACY.defaultSeq,
    );
    const nextMenuItems = [
      {
        id: `km-${Date.now()}`,
        name: kitchenName.trim(),
        price,
        prepMinutes,
        category: kitchenCategory,
      },
      ...mergeKitchenMenuItems(latestSnapshot.menuItems, {
        includeDefaultMenu: (latestSnapshot.catalogRevision ?? 0) === 0,
      }),
    ];
    const commitResult = await commitPosCatalogMutation(STORAGE_KITCHEN_STATE, latestSnapshot, nextMenuItems);
    if (!commitResult.ok) {
      window.alert(commitResult.reason === "catalog-changed"
        ? "Another manager changed the Kitchen menu first. The latest menu was loaded; review it and try again."
        : "The Kitchen menu could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setKitchenMenuItems(commitResult.value.menuItems);
    setKitchenName("");
    setKitchenPrice("");
    setKitchenPrepMinutes("15");
    setKitchenCategory("salad");
  };

  const startKitchenEdit = (item: KitchenMenuItem) => {
    setEditingKitchenId(item.id);
    setEditingKitchenName(item.name);
    setEditingKitchenPrice(String(item.price));
  };

  const cancelKitchenEdit = () => {
    setEditingKitchenId(null);
    setEditingKitchenName("");
    setEditingKitchenPrice("");
  };

  const saveKitchenEdit = async (item: KitchenMenuItem) => {
    if (isDirector || !catalogHydrated) return;
    const nextName = editingKitchenName.trim();
    const nextPrice = Number(editingKitchenPrice);
    if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) return;

    const changes = [
      item.name !== nextName ? `Name: ${item.name} -> ${nextName}` : "",
      item.price !== nextPrice ? `Price: TSh ${item.price.toLocaleString()} -> TSh ${nextPrice.toLocaleString()}` : "",
    ].filter(Boolean);
    if (changes.length === 0) {
      cancelKitchenEdit();
      return;
    }

    const approved = await confirm({
      title: "Update Kitchen Menu Item",
      description: `Save changes to ${item.name}?`,
      actionLabel: "Save Changes",
    });
    if (!approved) return;
    const hydration = await hydrateStorageKeyFromFirebase(STORAGE_KITCHEN_STATE);
    if (!hydration.ok) {
      window.alert("The shared Kitchen menu could not be refreshed. No menu change was saved; reconnect and try again.");
      return;
    }

    const latestSnapshot = readPosState<QueueTicket, PaymentRecord, KitchenMenuItem>(
      STORAGE_KITCHEN_STATE,
      KITCHEN_LEGACY.tickets,
      KITCHEN_LEGACY.seq,
      KITCHEN_LEGACY.payments,
      KITCHEN_LEGACY.menu,
      KITCHEN_LEGACY.defaultSeq,
    );
    const currentMenuItems = mergeKitchenMenuItems(latestSnapshot.menuItems, {
      includeDefaultMenu: (latestSnapshot.catalogRevision ?? 0) === 0,
    });
    if (!currentMenuItems.some((entry) => entry.id === item.id)) {
      window.alert("This Kitchen item was removed by another manager. The latest menu was loaded; nothing was changed.");
      cancelKitchenEdit();
      return;
    }
    const nextMenuItems = currentMenuItems.map((entry) =>
      entry.id === item.id ? { ...entry, name: nextName, price: nextPrice } : entry,
    );
    const commitResult = await commitPosCatalogMutation(STORAGE_KITCHEN_STATE, latestSnapshot, nextMenuItems);
    if (!commitResult.ok) {
      window.alert(commitResult.reason === "catalog-changed"
        ? "Another manager changed the Kitchen menu first. The latest menu was loaded; review it and try again."
        : "The Kitchen menu could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setKitchenMenuItems(commitResult.value.menuItems);
    saveAuditEntry({
      id: `audit-${Date.now()}`,
      menu: "kitchen",
      itemId: item.id,
      itemName: nextName,
      changedAt: Date.now(),
      changedBy: "manager",
      changes,
    });
    cancelKitchenEdit();
  };

  const addBaristaMenuItem = async () => {
    if (isDirector || !catalogHydrated) return;
    const price = Number(baristaPrice);
    const prepMinutes = Number(baristaPrepMinutes);
    if (!baristaName.trim() || Number.isNaN(price) || price <= 0 || Number.isNaN(prepMinutes) || prepMinutes <= 0) return;
    const approved = await confirm({
      title: "Create Barista Menu Item",
      description: `Are you sure you want to add ${baristaName.trim()} at TSh ${price.toLocaleString()}?`,
      actionLabel: "Add Menu Item",
    });
    if (!approved) return;
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(STORAGE_BARISTA_STATE),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The shared Barista menu could not be refreshed. No menu change was saved; reconnect and try again.");
      return;
    }

    const latestSnapshot = readPosState<QueueTicket, PaymentRecord, BaristaMenuItem>(
      STORAGE_BARISTA_STATE,
      BARISTA_LEGACY.tickets,
      BARISTA_LEGACY.seq,
      BARISTA_LEGACY.payments,
      BARISTA_LEGACY.menu,
      BARISTA_LEGACY.defaultSeq,
    );
    const sourceMenuItems =
      (latestSnapshot.catalogRevision ?? 0) === 0 && latestSnapshot.menuItems.length === 0
        ? normalizeBaristaMenuItems(
            buildInitialBaristaMenuItems(readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? []),
            (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []).filter((item) => item.lane === "barista"),
          )
        : latestSnapshot.menuItems;
    const nextMenuItems = [
      {
        id: `bm-${Date.now()}`,
        name: baristaName.trim(),
        price,
        prepMinutes,
        category: baristaCategory,
      },
      ...sourceMenuItems,
    ];
    const inventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const commitResult = await commitBaristaCatalogAndStockMutation(
      latestSnapshot,
      nextMenuItems,
      storeItems,
      storeItems,
      inventoryItems,
      inventoryItems,
    );
    if (!commitResult.ok) {
      window.alert(commitResult.reason === "catalog-changed" || commitResult.reason === "stock-changed"
        ? "Another manager or sale changed the Barista menu or stock first. Nothing was overwritten; review the latest values and try again."
        : "The Barista menu could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setBaristaMenuItems(commitResult.value.menuItems);
    setBaristaName("");
    setBaristaPrice("");
    setBaristaPrepMinutes("10");
    setBaristaCategory("coffee");
  };

  const startBaristaEdit = (item: BaristaMenuItem) => {
    setEditingBaristaId(item.id);
    setEditingBaristaName(item.name);
    setEditingBaristaPrice(String(item.price));
  };

  const cancelBaristaEdit = () => {
    setEditingBaristaId(null);
    setEditingBaristaName("");
    setEditingBaristaPrice("");
  };

  const saveBaristaEdit = async (item: BaristaMenuItem) => {
    if (isDirector || !catalogHydrated) return;
    const nextName = editingBaristaName.trim();
    const nextPrice = Number(editingBaristaPrice);
    if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) return;

    const changes = [
      item.name !== nextName ? `Name: ${item.name} -> ${nextName}` : "",
      item.price !== nextPrice ? `Price: TSh ${item.price.toLocaleString()} -> TSh ${nextPrice.toLocaleString()}` : "",
    ].filter(Boolean);
    if (changes.length === 0) {
      cancelBaristaEdit();
      return;
    }

    const approved = await confirm({
      title: "Update Barista Menu Item",
      description: `Save changes to ${item.name}?`,
      actionLabel: "Save Changes",
    });
    if (!approved) return;
    const hydration = await Promise.all([
      hydrateStorageKeyFromFirebase(STORAGE_BARISTA_STATE),
      hydrateStorageKeyFromFirebase(STORAGE_INVENTORY_ITEMS),
      hydrateStorageKeyFromFirebase(STORAGE_MAIN_STORE_ITEMS),
    ]);
    if (!hydration.every((result) => result.ok)) {
      window.alert("The shared Barista menu could not be refreshed. No menu change was saved; reconnect and try again.");
      return;
    }

    const latestSnapshot = readPosState<QueueTicket, PaymentRecord, BaristaMenuItem>(
      STORAGE_BARISTA_STATE,
      BARISTA_LEGACY.tickets,
      BARISTA_LEGACY.seq,
      BARISTA_LEGACY.payments,
      BARISTA_LEGACY.menu,
      BARISTA_LEGACY.defaultSeq,
    );
    const sourceMenuItems = normalizeBaristaMenuItems(
      (latestSnapshot.catalogRevision ?? 0) === 0 && latestSnapshot.menuItems.length === 0
        ? buildInitialBaristaMenuItems(readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [])
        : latestSnapshot.menuItems,
      (readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? []).filter((entry) => entry.lane === "barista"),
    );
    const currentItem = sourceMenuItems.find((entry) => entry.id === item.id);
    if (!currentItem) {
      window.alert("This Barista item was removed by another manager. The latest menu was loaded; nothing was changed.");
      cancelBaristaEdit();
      return;
    }
    const storeItems = readJson<MainStoreItem[]>(STORAGE_MAIN_STORE_ITEMS) ?? [];
    const linkedStoreItem = storeItems.find((entry) => entry.id === currentItem?.storeItemId)
      ?? findStoreItemForMenuName(storeItems.filter((entry) => entry.lane === "barista"), currentItem?.name ?? item.name);
    const linkedInventoryId = currentItem.inventoryItemId ?? currentItem.id;
    const inventoryItems = readJson<InventoryItem[]>(STORAGE_INVENTORY_ITEMS) ?? [];
    const nextMenuItems = sourceMenuItems.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            name: nextName,
            price: nextPrice,
            ...(linkedStoreItem ? { storeItemId: linkedStoreItem.id } : {}),
        }
        : entry,
    );
    const nextStoreItems = storeItems.map((entry) =>
      linkedStoreItem && entry.id === linkedStoreItem.id
        ? { ...entry, sellingPrice: nextPrice }
        : entry,
    );
    const nextInventoryItems = inventoryItems.map((entry) =>
      entry.id === linkedInventoryId
        ? { ...entry, sellingPrice: nextPrice, price: nextPrice }
        : entry,
    );
    const commitResult = await commitBaristaCatalogAndStockMutation(
      latestSnapshot,
      nextMenuItems,
      storeItems,
      nextStoreItems,
      inventoryItems,
      nextInventoryItems,
    );
    if (!commitResult.ok) {
      window.alert(commitResult.reason === "catalog-changed" || commitResult.reason === "stock-changed"
        ? "Another manager or sale changed the Barista menu or stock first. Nothing was overwritten; review the latest values and try again."
        : "The Barista menu could not be confirmed in shared storage. Nothing was saved; reconnect and try again.");
      return;
    }
    setBaristaMenuItems(commitResult.value.menuItems as BaristaMenuItem[]);
    saveAuditEntry({
      id: `audit-${Date.now()}`,
      menu: "barista",
      itemId: item.id,
      itemName: nextName,
      changedAt: Date.now(),
      changedBy: "manager",
      changes,
    });
    cancelBaristaEdit();
  };

  const visibleAuditTrail = auditTrail.filter((entry) => entry.menu === tab);

  return (
    <div className="space-y-6">
      {dialog}
      <header>
        <h1 className="text-3xl font-black tracking-tight uppercase">Menu Create</h1>
        <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Create and manage kitchen and barista menu items from one place
        </p>
      </header>

      {!catalogHydrated && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
          {catalogSyncError || "Synchronizing the shared Kitchen and Barista menus before editing..."}
        </p>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as "kitchen" | "barista")}>
        <TabsList className="h-11">
          <TabsTrigger value="kitchen" className="font-black uppercase text-[10px] tracking-widest">Kitchen POS</TabsTrigger>
          <TabsTrigger value="barista" className="font-black uppercase text-[10px] tracking-widest">Barista POS</TabsTrigger>
        </TabsList>

        <TabsContent value="kitchen" className="space-y-6">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Create Kitchen Menu Item</CardTitle>
              <CardDescription>Set dish name, section, preparation time, and selling price.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Input value={kitchenName} onChange={(event) => setKitchenName(event.target.value)} placeholder="Dish name" disabled={isDirector || !catalogHydrated} />
              <select
                className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={kitchenCategory}
                onChange={(event) => setKitchenCategory(event.target.value as KitchenMenuCategory)}
                disabled={isDirector || !catalogHydrated}
              >
                {KITCHEN_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <Input type="number" min="1" value={kitchenPrepMinutes} onChange={(event) => setKitchenPrepMinutes(event.target.value)} placeholder="Prep minutes" disabled={isDirector || !catalogHydrated} />
              <Input type="number" min="1" value={kitchenPrice} onChange={(event) => setKitchenPrice(event.target.value)} placeholder="Price" disabled={isDirector || !catalogHydrated} />
              <div className="md:col-span-4">
                <Button className="h-10 font-black uppercase text-[10px] tracking-widest" onClick={addKitchenMenuItem} disabled={isDirector || !catalogHydrated}>
                  Add Menu Item
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Kitchen Menu</CardTitle>
              <CardDescription>Current kitchen menu items and selling prices.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/10">
                  <TableRow>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Category</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Prep</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Price</TableHead>
                    <TableHead className="text-right font-black uppercase text-[10px] tracking-widest h-12">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kitchenMenuItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-bold">
                        {editingKitchenId === item.id ? (
                          <Input value={editingKitchenName} onChange={(event) => setEditingKitchenName(event.target.value)} disabled={isDirector || !catalogHydrated} />
                        ) : (
                          item.name
                        )}
                      </TableCell>
                      <TableCell className="font-bold uppercase text-[10px] tracking-widest">{KITCHEN_CATEGORY_LABELS[item.category]}</TableCell>
                      <TableCell className="font-bold">{item.prepMinutes} min</TableCell>
                      <TableCell className="font-bold">
                        {editingKitchenId === item.id ? (
                          <Input type="number" min="1" value={editingKitchenPrice} onChange={(event) => setEditingKitchenPrice(event.target.value)} disabled={isDirector || !catalogHydrated} />
                        ) : (
                          `TSh ${item.price.toLocaleString()}`
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {editingKitchenId === item.id ? (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => saveKitchenEdit(item)} disabled={isDirector || !catalogHydrated} className="font-black uppercase text-[10px] tracking-widest">
                              Save
                            </Button>
                            <Button size="sm" variant="outline" onClick={cancelKitchenEdit} className="font-black uppercase text-[10px] tracking-widest">
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => startKitchenEdit(item)} disabled={isDirector || !catalogHydrated} className="font-black uppercase text-[10px] tracking-widest">
                            Edit
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {kitchenMenuItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                        No kitchen menu items yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="barista" className="space-y-6">
          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Create Barista Menu Item</CardTitle>
              <CardDescription>Set item name, category, preparation time, and price.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Input value={baristaName} onChange={(event) => setBaristaName(event.target.value)} placeholder="Drink or snack name" disabled={isDirector || !catalogHydrated} />
              <select
                className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={baristaCategory}
                onChange={(event) => setBaristaCategory(event.target.value as BaristaCategory)}
                disabled={isDirector || !catalogHydrated}
              >
                <option value="espresso">Espresso</option>
                <option value="coffee">Coffee</option>
                <option value="tea">Tea</option>
                <option value="cold">Cold</option>
                <option value="snacks">Snacks</option>
              </select>
              <Input type="number" min="1" value={baristaPrepMinutes} onChange={(event) => setBaristaPrepMinutes(event.target.value)} placeholder="Prep minutes" disabled={isDirector || !catalogHydrated} />
              <Input type="number" min="1" value={baristaPrice} onChange={(event) => setBaristaPrice(event.target.value)} placeholder="Price" disabled={isDirector || !catalogHydrated} />
              <div className="md:col-span-4">
                <Button className="h-10 font-black uppercase text-[10px] tracking-widest" onClick={addBaristaMenuItem} disabled={isDirector || !catalogHydrated}>
                  Add Menu Item
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl font-black uppercase tracking-tight">Barista Menu</CardTitle>
              <CardDescription>Current barista menu items and selling prices.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="bg-muted/10">
                  <TableRow>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Category</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Prep</TableHead>
                    <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Price</TableHead>
                    <TableHead className="text-right font-black uppercase text-[10px] tracking-widest h-12">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {baristaMenuItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-bold">
                        {editingBaristaId === item.id ? (
                          <Input value={editingBaristaName} onChange={(event) => setEditingBaristaName(event.target.value)} disabled={isDirector || !catalogHydrated} />
                        ) : (
                          item.name
                        )}
                      </TableCell>
                      <TableCell className="font-bold uppercase text-[10px] tracking-widest">{item.category}</TableCell>
                      <TableCell className="font-bold">{item.prepMinutes} min</TableCell>
                      <TableCell className="font-bold">
                        {editingBaristaId === item.id ? (
                          <Input type="number" min="1" value={editingBaristaPrice} onChange={(event) => setEditingBaristaPrice(event.target.value)} disabled={isDirector || !catalogHydrated} />
                        ) : (
                          `TSh ${item.price.toLocaleString()}`
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {editingBaristaId === item.id ? (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => saveBaristaEdit(item)} disabled={isDirector || !catalogHydrated} className="font-black uppercase text-[10px] tracking-widest">
                              Save
                            </Button>
                            <Button size="sm" variant="outline" onClick={cancelBaristaEdit} className="font-black uppercase text-[10px] tracking-widest">
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => startBaristaEdit(item)} disabled={isDirector || !catalogHydrated} className="font-black uppercase text-[10px] tracking-widest">
                            Edit
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {baristaMenuItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                        No barista menu items yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl font-black uppercase tracking-tight">Menu Edit Audit Trail</CardTitle>
          <CardDescription>Recent {tab === "kitchen" ? "kitchen" : "barista"} menu changes with timestamp and details.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/10">
              <TableRow>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">When</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Item</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Changed By</TableHead>
                <TableHead className="font-black uppercase text-[10px] tracking-widest h-12">Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAuditTrail.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-bold">{formatAuditDate(entry.changedAt)}</TableCell>
                  <TableCell className="font-bold">{entry.itemName}</TableCell>
                  <TableCell className="font-bold capitalize">{entry.changedBy}</TableCell>
                  <TableCell className="font-medium text-muted-foreground">{entry.changes.join(" | ")}</TableCell>
                </TableRow>
              ))}
              {visibleAuditTrail.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center font-black uppercase text-[10px] tracking-widest text-muted-foreground">
                    No menu edits recorded yet
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
