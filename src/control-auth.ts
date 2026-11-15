import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type http from "node:http";

const tokenPath = path.resolve(process.cwd(), "data", "control-token.txt");
export function controlToken(): string {
  const configured = process.env.WORKER_CONTROL_TOKEN?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error("WORKER_CONTROL_TOKEN requiere 32 caracteres como mínimo");
    return configured;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  if (!fs.existsSync(tokenPath)) {
    try { fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (e: any) { if (e.code !== "EEXIST") throw e; }
  }
  const value = fs.readFileSync(tokenPath, "utf8").trim();
  if (value.length < 32) throw new Error("Clave de control no válida; acceso bloqueado");
  return value;
}
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(value: string): string { return crypto.createHmac("sha256", controlToken()).update(value).digest("hex"); }
export function allowedControlOrigin(req: http.IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
export function isControlAuthorized(req: http.IncomingMessage): boolean {
  if (!allowedControlOrigin(req)) return false;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && equal(auth.slice(7), controlToken())) return true;
  const cookie = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith("forja_control="))?.slice(14);
  if (!cookie) return false;
  const [expires, signature] = cookie.split(".");
  return Number(expires) > Date.now() && !!signature && equal(signature, sign(expires));
}
export function requireControl(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isControlAuthorized(req)) return true;
  res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "Identifícate con la clave de control local.", code: "CONTROL_AUTH_REQUIRED" }));
  return false;
}
export async function handleControlLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST" || !allowedControlOrigin(req)) { res.writeHead(403); res.end(); return; }
  let raw = "";
  try {
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) throw new Error("Cuerpo excesivo"); }
    const token = JSON.parse(raw).token;
    if (typeof token !== "string" || !equal(token, controlToken())) { res.writeHead(401); res.end(); return; }
    const expiry = String(Date.now() + 8 * 60 * 60 * 1000);
    const secure = (req.socket as any).encrypted ? "; Secure" : "";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store",
      "Set-Cookie": `forja_control=${expiry}.${sign(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}` });
    res.end(JSON.stringify({ success: true }));
  } catch { res.writeHead(400); res.end(); }
}
