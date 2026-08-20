import {
  DEFAULT_HARDWARE_SETTINGS,
  HardwareLane,
  HardwareSettings,
  STORAGE_HARDWARE_SETTINGS,
} from "@/app/lib/hardware-settings";
import { getStandardScopedLocalKey } from "@/app/lib/firebase-sync";

interface ReceiptLine {
  name: string;
  qty: number;
}

interface ReceiptPayload {
  department: HardwareLane;
  code: string;
  destination: string;
  mode: string;
  method: string;
  status: string;
  total: number;
  createdAt: number;
  lines: ReceiptLine[];
}

interface PrintResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

function padRight(value: string, width: number) {
  return value.length >= width ? value.slice(0, width) : `${value}${" ".repeat(width - value.length)}`;
}

function padLeft(value: string, width: number) {
  return value.length >= width ? value.slice(0, width) : `${" ".repeat(width - value.length)}${value}`;
}

function formatMoney(amount: number) {
  return `TSh ${amount.toLocaleString()}`;
}

function formatItemLine(line: ReceiptLine, width: number) {
  const qtyLabel = `${line.qty}x `;
  const nameWidth = Math.max(8, width - qtyLabel.length);
  return `${qtyLabel}${line.name.length > nameWidth ? `${line.name.slice(0, nameWidth - 1)}.` : line.name}`;
}

function buildReceiptContent(payload: ReceiptPayload, printerName: string, openDrawer: boolean) {
  const width = 42;
  const separator = "-".repeat(width);
  const lines: string[] = [];

  if (openDrawer) {
    lines.push("\u001bp\u0000\u0019\u00fa");
  }

  lines.push("MAWIO ARUSHA");
  lines.push(payload.department === "kitchen" ? "KITCHEN" : "BARISTA");
  lines.push(separator);
  lines.push(`Receipt: ${payload.code}`);
  lines.push(`Date: ${new Date(payload.createdAt).toLocaleString()}`);
  lines.push(`Service: ${payload.mode}`);
  lines.push(`Destination: ${payload.destination}`);
  lines.push(separator);

  for (const line of payload.lines) {
    lines.push(formatItemLine(line, width));
  }

  lines.push(separator);
  lines.push(`${padRight("Payment", 16)}${padLeft(payload.method.toUpperCase(), width - 16)}`);
  lines.push(`${padRight("Status", 16)}${padLeft(payload.status.toUpperCase(), width - 16)}`);
  lines.push(`${padRight("TOTAL", 16)}${padLeft(formatMoney(payload.total), width - 16)}`);
  lines.push(separator);
  lines.push("Thank you");
  lines.push("\n\n\n");

  return lines.join("\n");
}

export async function listSystemPrinters() {
  if (typeof window === "undefined" || !window.orangeHotelHardware?.listPrinters) {
    return [];
  }

  try {
    return await window.orangeHotelHardware.listPrinters();
  } catch {
    return [];
  }
}

function readHardwareSettings(): HardwareSettings {
  if (typeof window === "undefined") return DEFAULT_HARDWARE_SETTINGS;

  const raw = localStorage.getItem(getStandardScopedLocalKey(STORAGE_HARDWARE_SETTINGS));
  if (!raw) return DEFAULT_HARDWARE_SETTINGS;

  try {
    const parsed = JSON.parse(raw) as Partial<HardwareSettings>;
    return {
      kitchen: { ...DEFAULT_HARDWARE_SETTINGS.kitchen, ...parsed.kitchen },
      barista: { ...DEFAULT_HARDWARE_SETTINGS.barista, ...parsed.barista },
    };
  } catch {
    return DEFAULT_HARDWARE_SETTINGS;
  }
}

export async function printDepartmentReceipt(payload: ReceiptPayload): Promise<PrintResult> {
  if (typeof window === "undefined") {
    return { ok: false, skipped: true, reason: "Printing only works in the POS client." };
  }

  const settings = readHardwareSettings()[payload.department];
  if (!settings.autoPrintReceipt) {
    return { ok: true, skipped: true, reason: "Auto print is disabled." };
  }

  if (!settings.printerName.trim()) {
    return { ok: false, skipped: true, reason: "No printer selected in hardware settings." };
  }

  if (!window.orangeHotelHardware?.printRaw) {
    return { ok: false, skipped: true, reason: "No POS hardware bridge detected for raw printing." };
  }

  try {
    const content = buildReceiptContent(payload, settings.printerName, settings.openDrawerOnSale);
    const result = await window.orangeHotelHardware.printRaw({
      printerName: settings.printerName,
      content,
      openDrawer: settings.openDrawerOnSale,
    });

    if (!result.ok) {
      return { ok: false, reason: result.error || "Print failed." };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Print failed." };
  }
}
