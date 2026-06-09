const DEMO_STORAGE_KEYS = [
  "orange-hotel-demo-seed-version",
  "orange-hotel-cashier-transactions",
  "orange-hotel-cashier-seq",
  "orange-hotel-kitchen-tickets",
  "orange-hotel-kitchen-seq",
  "orange-hotel-kitchen-menu",
  "orange-hotel-kitchen-payments",
  "orange-hotel-barista-orders",
  "orange-hotel-barista-seq",
  "orange-hotel-barista-menu",
  "orange-hotel-barista-payments",
  "orange-hotel-cancelled-tickets",
] as const;

export function seedDemoDataIfNeeded() {
  clearDemoData();
}

export function clearDemoData() {
  if (typeof window === "undefined") return;

  DEMO_STORAGE_KEYS.forEach((key) => {
    localStorage.removeItem(key);
  });
}
