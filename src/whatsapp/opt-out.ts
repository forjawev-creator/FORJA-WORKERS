import fs from "fs";
import path from "path";
import { normalizeSpanishPhone } from "../utils/phone-utils.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OPT_OUT_FILE = path.join(DATA_DIR, "opt-out-list.json");

export function getOptOutList(): Set<string> {
  if (fs.existsSync(OPT_OUT_FILE)) {
    try {
      const list = JSON.parse(fs.readFileSync(OPT_OUT_FILE, "utf-8"));
      if (Array.isArray(list)) return new Set(list);
    } catch {}
  }
  return new Set();
}

export function addToOptOut(phone: string): void {
  if (!phone) return;
  const list = getOptOutList();
  list.add(phone);
  const normalized = normalizeSpanishPhone(phone);
  if (normalized) list.add(normalized);
  const cleanDigits = phone.replace(/\D/g, "");
  if (cleanDigits) list.add(cleanDigits);

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(OPT_OUT_FILE, JSON.stringify(Array.from(list), null, 2), "utf-8");
    console.log(`[OptOut] ⛔ Número agregado a lista de exclusión: ${phone}`);
  } catch (err: any) {
    console.warn(`[OptOut] Error guardando lista de exclusión:`, err.message);
  }
}

export function isOptedOut(phone: string): boolean {
  if (!phone) return false;
  const list = getOptOutList();
  if (list.has(phone)) return true;
  const normalized = normalizeSpanishPhone(phone);
  if (normalized && list.has(normalized)) return true;
  const cleanDigits = phone.replace(/\D/g, "");
  if (cleanDigits && list.has(cleanDigits)) return true;
  return false;
}
