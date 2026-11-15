import fs from "fs";
import path from "path";

const PROMPTS_DIR = path.resolve(process.cwd(), "brain", "prompts");

interface CachedPrompt {
  mtimeMs: number;
  content: string;
}

const fileCache = new Map<string, CachedPrompt>();

function loadPromptFile(filename: string): string {
  const filePath = path.join(PROMPTS_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch (err: any) {
    console.error(`[PromptsLoader] Error cargando prompt ${filename}:`, err.message);
    return fileCache.get(filePath)?.content || "";
  }
}

export function getCatalogPrices(): { installPrice: string; monthlyPriceBasic: string; monthlyPriceFull: string } {
  try {
    const raw = loadPromptFile("precios.json");
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        installPrice: parsed.installPrice || "99",
        monthlyPriceBasic: parsed.monthlyPriceBasic || "10",
        monthlyPriceFull: parsed.monthlyPriceFull || "15",
      };
    }
  } catch {}
  return {
    installPrice: "99",
    monthlyPriceBasic: "10",
    monthlyPriceFull: "15",
  };
}

export function renderInboundPrompt(params: {
  agentName: string;
  timeGreeting: string;
  wishClosing: string;
}): string {
  const template = loadPromptFile("entrante.md");
  if (!template) return "";
  return template
    .replace(/\{\{AGENT_NAME\}\}/g, params.agentName)
    .replace(/\{\{TIME_GREETING\}\}/g, params.timeGreeting)
    .replace(/\{\{WISH_CLOSING\}\}/g, params.wishClosing);
}

export function renderCommercialPrompt(params: {
  variant: "cercano" | "formal";
  agentName: string;
  bizRef: string;
  installPrice: string;
  monthlyPrice: string;
}): string {
  const filename = params.variant === "formal" ? "saliente_formal.md" : "saliente_cercano.md";
  const template = loadPromptFile(filename);
  if (!template) return "";
  return template
    .replace(/\{\{AGENT_NAME\}\}/g, params.agentName)
    .replace(/\{\{BIZ_REF\}\}/g, params.bizRef)
    .replace(/\{\{INSTALL_PRICE\}\}/g, params.installPrice)
    .replace(/\{\{MONTHLY_PRICE\}\}/g, params.monthlyPrice);
}

export function renderTechnicalPrompt(params: {
  agentName: string;
  bizName: string;
  trade: string;
  exactQuestion: string;
  facts: string;
  installPrice: string;
  monthlyPrice: string;
}): string {
  const template = loadPromptFile("tecnico.md");
  if (!template) return "";
  return template
    .replace(/\{\{AGENT_NAME\}\}/g, params.agentName)
    .replace(/\{\{BIZ_NAME\}\}/g, params.bizName)
    .replace(/\{\{TRADE\}\}/g, params.trade)
    .replace(/\{\{EXACT_QUESTION\}\}/g, params.exactQuestion)
    .replace(/\{\{FACTS\}\}/g, params.facts)
    .replace(/\{\{INSTALL_PRICE\}\}/g, params.installPrice)
    .replace(/\{\{MONTHLY_PRICE\}\}/g, params.monthlyPrice);
}
