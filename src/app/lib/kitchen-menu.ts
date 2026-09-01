export type KitchenMenuCategory =
  | "salad"
  | "soup"
  | "snacks"
  | "beef"
  | "fish"
  | "pork"
  | "local-food"
  | "pizza"
  | "burger"
  | "sandwich"
  | "pasta"
  | "dessert"
  | "drinks";

export interface KitchenMenuItem {
  id: string;
  name: string;
  price: number;
  category: KitchenMenuCategory;
  prepMinutes: number;
}

export const KITCHEN_CATEGORY_OPTIONS: Array<{ value: KitchenMenuCategory; label: string }> = [
  { value: "salad", label: "Salads" },
  { value: "soup", label: "Soups" },
  { value: "snacks", label: "Snacks" },
  { value: "beef", label: "Beef" },
  { value: "fish", label: "Fish" },
  { value: "pork", label: "Pork" },
  { value: "local-food", label: "Local Food" },
  { value: "pizza", label: "Pizza" },
  { value: "burger", label: "Burgers" },
  { value: "sandwich", label: "Sandwiches" },
  { value: "pasta", label: "Pasta" },
  { value: "dessert", label: "Desserts" },
  { value: "drinks", label: "Drinks" },
];

export const KITCHEN_CATEGORY_LABELS: Record<KitchenMenuCategory, string> = Object.fromEntries(
  KITCHEN_CATEGORY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<KitchenMenuCategory, string>;

const tsh = (usd: number) => usd * 2600;

export const DEFAULT_KITCHEN_MENU: KitchenMenuItem[] = [
  { id: "km-salad-1", name: "Fresh Garden Salad", price: 15600, category: "salad", prepMinutes: 10 },
  { id: "km-salad-2", name: "Chicken Mayo Salad", price: 15600, category: "salad", prepMinutes: 12 },
  { id: "km-salad-3", name: "Greek Salad", price: 15600, category: "salad", prepMinutes: 10 },
  { id: "km-salad-4", name: "Avocado Salad", price: 15600, category: "salad", prepMinutes: 10 },
  { id: "km-soup-1", name: "Cream of Pumpkin", price: tsh(8), category: "soup", prepMinutes: 15 },
  { id: "km-soup-2", name: "Clear Beef Soup", price: tsh(8), category: "soup", prepMinutes: 15 },
  { id: "km-soup-3", name: "Banana Soup", price: tsh(8), category: "soup", prepMinutes: 18 },
  { id: "km-soup-4", name: "Kitchen Soup", price: tsh(8), category: "soup", prepMinutes: 18 },
  { id: "km-snack-1", name: "Fried Chicken Wings", price: tsh(8), category: "snacks", prepMinutes: 14 },
  { id: "km-snack-2", name: "Fish Fingers", price: tsh(8), category: "snacks", prepMinutes: 14 },
  { id: "km-snack-3", name: "Beef Samosa", price: tsh(8), category: "snacks", prepMinutes: 10 },
  { id: "km-beef-1", name: "Pepper Steak", price: tsh(12), category: "beef", prepMinutes: 22 },
  { id: "km-beef-2", name: "Beef Stroganoff", price: tsh(12), category: "beef", prepMinutes: 20 },
  { id: "km-beef-3", name: "Beef Stir-Fry", price: tsh(12), category: "beef", prepMinutes: 18 },
  { id: "km-fish-1", name: "Grilled Nile Perch", price: tsh(12), category: "fish", prepMinutes: 22 },
  { id: "km-fish-2", name: "Fish Curry", price: tsh(12), category: "fish", prepMinutes: 20 },
  { id: "km-fish-3", name: "Fried Tilapia", price: tsh(12), category: "fish", prepMinutes: 20 },
  { id: "km-pork-1", name: "Grilled Pork Chop", price: tsh(10), category: "pork", prepMinutes: 20 },
  { id: "km-pork-2", name: "Grilled Pork Ribs", price: tsh(10), category: "pork", prepMinutes: 24 },
  { id: "km-local-1", name: "Chicken Trooper", price: tsh(12), category: "local-food", prepMinutes: 18 },
  { id: "km-local-2", name: "Mbuzi Kitunguu", price: tsh(12), category: "local-food", prepMinutes: 22 },
  { id: "km-local-3", name: "Chicken Vunga", price: tsh(12), category: "local-food", prepMinutes: 18 },
  { id: "km-local-4", name: "Mchemsho Samaki", price: tsh(12), category: "local-food", prepMinutes: 22 },
  { id: "km-pizza-1", name: "Margherita", price: tsh(10), category: "pizza", prepMinutes: 18 },
  { id: "km-pizza-2", name: "Hawaiian", price: tsh(10), category: "pizza", prepMinutes: 18 },
  { id: "km-pizza-3", name: "Chicken Pizza", price: tsh(10), category: "pizza", prepMinutes: 18 },
  { id: "km-pizza-4", name: "Orange Special", price: tsh(10), category: "pizza", prepMinutes: 20 },
  { id: "km-burger-1", name: "Chicken Burger", price: tsh(8), category: "burger", prepMinutes: 15 },
  { id: "km-burger-2", name: "Beef Burger", price: tsh(8), category: "burger", prepMinutes: 15 },
  { id: "km-burger-3", name: "Veggie Burger", price: tsh(8), category: "burger", prepMinutes: 12 },
  { id: "km-sandwich-1", name: "Crab Sandwich", price: tsh(10), category: "sandwich", prepMinutes: 10 },
  { id: "km-sandwich-2", name: "Ham & Bacon", price: tsh(10), category: "sandwich", prepMinutes: 10 },
  { id: "km-sandwich-3", name: "Egg Sandwich", price: tsh(10), category: "sandwich", prepMinutes: 8 },
  { id: "km-pasta-1", name: "Spaghetti Napolitana", price: tsh(10), category: "pasta", prepMinutes: 16 },
  { id: "km-pasta-2", name: "Vegetable Pasta", price: tsh(10), category: "pasta", prepMinutes: 16 },
  { id: "km-pasta-3", name: "Bolognese", price: tsh(10), category: "pasta", prepMinutes: 18 },
  { id: "km-pasta-4", name: "Chicken Pasta", price: tsh(10), category: "pasta", prepMinutes: 18 },
  { id: "km-dessert-1", name: "Ice Cream", price: tsh(5), category: "dessert", prepMinutes: 4 },
  { id: "km-dessert-4", name: "Pineapple Cake", price: tsh(5), category: "dessert", prepMinutes: 6 },
  { id: "km-dessert-5", name: "Jam Swiss Roll", price: tsh(5), category: "dessert", prepMinutes: 5 },
  { id: "km-dessert-6", name: "Fruit Platter", price: tsh(5), category: "dessert", prepMinutes: 8 },
  { id: "km-drink-1", name: "Smoothie", price: tsh(3), category: "drinks", prepMinutes: 5 },
  { id: "km-drink-2", name: "Fresh Juice", price: tsh(3), category: "drinks", prepMinutes: 4 },
  { id: "km-drink-3", name: "Milkshake", price: tsh(3), category: "drinks", prepMinutes: 6 },
];

function isKitchenMenuCategory(value: unknown): value is KitchenMenuCategory {
  return KITCHEN_CATEGORY_OPTIONS.some((option) => option.value === value);
}

function isValidKitchenMenuItem(item: unknown): item is KitchenMenuItem {
  if (!item || typeof item !== "object") return false;

  const candidate = item as Partial<KitchenMenuItem>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.trim().length > 0 &&
    typeof candidate.price === "number" &&
    Number.isFinite(candidate.price) &&
    candidate.price > 0 &&
    isKitchenMenuCategory(candidate.category) &&
    typeof candidate.prepMinutes === "number" &&
    Number.isFinite(candidate.prepMinutes) &&
    candidate.prepMinutes > 0
  );
}

function buildKitchenMenuSignature(item: KitchenMenuItem) {
  return `${item.name}|${item.price}|${item.category}|${item.prepMinutes}`;
}

const DEFAULT_KITCHEN_MENU_SIGNATURES = new Map(
  DEFAULT_KITCHEN_MENU.map((item) => [item.id, buildKitchenMenuSignature(item)]),
);
const DEFAULT_KITCHEN_MENU_BY_ID = new Map(DEFAULT_KITCHEN_MENU.map((item) => [item.id, item]));
const OBSOLETE_DEFAULT_KITCHEN_MENU_IDS = new Set(["km-dessert-2", "km-dessert-3"]);
const APPROVED_KITCHEN_MENU_NAME_ALIASES: Record<string, string> = {
  "fresh garden salad": "km-salad-1",
  "chicken mayonnaise salad": "km-salad-2",
  "chicken mayo salad": "km-salad-2",
  "greek salad": "km-salad-3",
  "fresh avocado salad": "km-salad-4",
  "avocado salad": "km-salad-4",
  "cream of pumpkin soup": "km-soup-1",
  "cream of pumpkin": "km-soup-1",
  "clear beef soup": "km-soup-2",
  "local banana soup": "km-soup-3",
  "banana soup": "km-soup-3",
  "local kitchen soup": "km-soup-4",
  "kitchen soup": "km-soup-4",
  "fried chicken wings": "km-snack-1",
  "marinated fish fingers": "km-snack-2",
  "fish fingers": "km-snack-2",
  "beef samosa": "km-snack-3",
  "marinated pepper steak": "km-beef-1",
  "pepper steak": "km-beef-1",
  "beef stroganoff": "km-beef-2",
  "beef stir-fry": "km-beef-3",
  "grilled lemon nile perch": "km-fish-1",
  "grilled nile perch": "km-fish-1",
  "fish curry": "km-fish-2",
  "fried tilapia": "km-fish-3",
  "grilled pork chop": "km-pork-1",
  "grilled pork ribs": "km-pork-2",
  "chicken trooper": "km-local-1",
  "mbuzi kitunguu": "km-local-2",
  "chicken vurga": "km-local-3",
  "chicken vunga": "km-local-3",
  "mchemsho wa samaki": "km-local-4",
  "mchemsho samaki": "km-local-4",
  "margherita pizza": "km-pizza-1",
  "margherita": "km-pizza-1",
  "hawaiian pizza": "km-pizza-2",
  "hawaiian": "km-pizza-2",
  "chicken pizza": "km-pizza-3",
  "orange special pizza": "km-pizza-4",
  "orange special": "km-pizza-4",
  "chicken burger": "km-burger-1",
  "beef burger": "km-burger-2",
  "vegetable burger": "km-burger-3",
  "veggie burger": "km-burger-3",
  "crab sandwich": "km-sandwich-1",
  "ham and bacon sandwich": "km-sandwich-2",
  "ham & bacon": "km-sandwich-2",
  "egg sandwich": "km-sandwich-3",
  "spaghetti napolitana": "km-pasta-1",
  "vegetable pasta": "km-pasta-2",
  "spaghetti bolognese": "km-pasta-3",
  "bolognese": "km-pasta-3",
  "chicken pasta": "km-pasta-4",
  "ice cream - vanilla": "km-dessert-1",
  "ice cream - strawberry": "km-dessert-1",
  "ice cream - chocolate": "km-dessert-1",
  "ice cream": "km-dessert-1",
  "pineapple cake": "km-dessert-4",
  "jam swiss roll": "km-dessert-5",
  "fresh fruit platter": "km-dessert-6",
  "fruit platter": "km-dessert-6",
  "smoothie": "km-drink-1",
  "fresh juice": "km-drink-2",
  "milkshake": "km-drink-3",
};

function normalizeKitchenMenuName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function getApprovedKitchenMenuItem(item: KitchenMenuItem) {
  const byId = DEFAULT_KITCHEN_MENU_BY_ID.get(item.id);
  if (byId) return byId;

  const aliasId = APPROVED_KITCHEN_MENU_NAME_ALIASES[normalizeKitchenMenuName(item.name)];
  return aliasId ? DEFAULT_KITCHEN_MENU_BY_ID.get(aliasId) : undefined;
}

export function isDefaultKitchenMenuItem(item: KitchenMenuItem): boolean {
  return DEFAULT_KITCHEN_MENU_SIGNATURES.get(item.id) === buildKitchenMenuSignature(item);
}

export function mergeKitchenMenuItems(
  menuItems: KitchenMenuItem[],
  options?: { includeDefaultMenu?: boolean; stripDefaultMenu?: boolean },
): KitchenMenuItem[] {
  // Adding a missing built-in is a catalog mutation, not ordinary
  // normalization. Callers may opt into it only after confirming that the
  // canonical catalog is still the first/legacy revision. Keeping the default
  // false also prevents sync sanitization from recreating a manager-deleted
  // built-in item in an already-published catalog.
  const includeDefaultMenu = options?.includeDefaultMenu ?? false;
  const stripDefaultMenu = options?.stripDefaultMenu ?? false;

  const merged = new Map<string, KitchenMenuItem>();

  for (const item of menuItems) {
    if (!isValidKitchenMenuItem(item)) continue;
    if (OBSOLETE_DEFAULT_KITCHEN_MENU_IDS.has(item.id)) continue;

    const approvedItem = getApprovedKitchenMenuItem(item);
    if (stripDefaultMenu && approvedItem) continue;
    // Canonicalize legacy aliases to the shipped ID, but keep persisted
    // fields authoritative. Replacing the whole item with `approvedItem` here
    // silently undid every manager name/price edit on a built-in dish.
    merged.set(approvedItem?.id ?? item.id, approvedItem ? { ...item, id: approvedItem.id } : item);
  }

  if (includeDefaultMenu) {
    for (const item of DEFAULT_KITCHEN_MENU) {
      // Defaults seed only missing dishes. A valid stored item (including a
      // manager-edited built-in dish) must always win.
      if (!merged.has(item.id)) merged.set(item.id, item);
    }
  }

  return Array.from(merged.values());
}
