/**
 * Utilidades puras para normalización lingüística y telefónica en español.
 * Este módulo NO tiene dependencias externas, CRM, web ni Baileys.
 */

export function normalizeSpanish(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:_()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSpanishPhone(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.replace(/[\s\-\(\)\.]/g, "").trim();

  if (cleaned.startsWith("0034")) {
    cleaned = "+34" + cleaned.substring(4);
  }

  if (!cleaned.startsWith("+")) {
    if (/^[6789]\d{8}$/.test(cleaned)) {
      cleaned = "+34" + cleaned;
    } else {
      return null;
    }
  }

  if (/^\+34[6789]\d{8}$/.test(cleaned)) {
    return cleaned;
  }

  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

export function normalizeSpokenSpanishDigits(text: string): string {
  if (!text || typeof text !== "string") return "";
  let s = text.toLowerCase();

  s = s.replace(/(\d)[\.\-](\d)/g, "$1$2");

  s = s.replace(/\b(un|una)\s+(pregunta|momento|momentito|segundo|segundito|minuto|minutito|cosa|cosita|duda|consulta|web|p[aá]gina|muestra|enlace|mensaje|whatsapp|correo|saludo|poco|poquito|par|favor)\b/gi, "$2");

  s = s.replace(/\b(dos\s+veces|doble)\b/gi, "__TWICE__");
  s = s.replace(/\b(tres\s+veces|triple)\b/gi, "__THRICE__");
  s = s.replace(/\b(una\s+vez)\b/gi, "");

  const wordMap: [RegExp, string][] = [
    [/\b(treinta\s+y\s+uno)\b/g, "31"],
    [/\b(treinta\s+y\s+dos)\b/g, "32"],
    [/\b(treinta\s+y\s+tres)\b/g, "33"],
    [/\b(treinta\s+y\s+cuatro)\b/g, "34"],
    [/\b(treinta\s+y\s+cinco)\b/g, "35"],
    [/\b(treinta\s+y\s+seis)\b/g, "36"],
    [/\b(treinta\s+y\s+siete)\b/g, "37"],
    [/\b(treinta\s+y\s+ocho)\b/g, "38"],
    [/\b(treinta\s+y\s+nueve)\b/g, "39"],
    [/\b(treinta)\b/g, "30"],
    [/\b(cuarenta\s+y\s+uno)\b/g, "41"],
    [/\b(cuarenta\s+y\s+dos)\b/g, "42"],
    [/\b(cuarenta\s+y\s+tres)\b/g, "43"],
    [/\b(cuarenta\s+y\s+cuatro)\b/g, "44"],
    [/\b(cuarenta\s+y\s+cinco)\b/g, "45"],
    [/\b(cuarenta\s+y\s+seis)\b/g, "46"],
    [/\b(cuarenta\s+y\s+siete)\b/g, "47"],
    [/\b(cuarenta\s+y\s+ocho)\b/g, "48"],
    [/\b(cuarenta\s+y\s+nueve)\b/g, "49"],
    [/\b(cuarenta)\b/g, "40"],
    [/\b(cincuenta\s+y\s+uno)\b/g, "51"],
    [/\b(cincuenta\s+y\s+dos)\b/g, "52"],
    [/\b(cincuenta\s+y\s+tres)\b/g, "53"],
    [/\b(cincuenta\s+y\s+cuatro)\b/g, "54"],
    [/\b(cincuenta\s+y\s+cinco)\b/g, "55"],
    [/\b(cincuenta\s+y\s+seis)\b/g, "56"],
    [/\b(cincuenta\s+y\s+siete)\b/g, "57"],
    [/\b(cincuenta\s+y\s+ocho)\b/g, "58"],
    [/\b(cincuenta\s+y\s+nueve)\b/g, "59"],
    [/\b(cincuenta)\b/g, "50"],
    [/\b(sesenta\s+y\s+uno)\b/g, "61"],
    [/\b(sesenta\s+y\s+dos)\b/g, "62"],
    [/\b(sesenta\s+y\s+tres)\b/g, "63"],
    [/\b(sesenta\s+y\s+cuatro)\b/g, "64"],
    [/\b(sesenta\s+y\s+cinco)\b/g, "65"],
    [/\b(sesenta\s+y\s+seis)\b/g, "66"],
    [/\b(sesenta\s+y\s+siete)\b/g, "67"],
    [/\b(sesenta\s+y\s+ocho)\b/g, "68"],
    [/\b(sesenta\s+y\s+nueve)\b/g, "69"],
    [/\b(sesenta)\b/g, "60"],
    [/\b(setenta\s+y\s+uno)\b/g, "71"],
    [/\b(setenta\s+y\s+dos)\b/g, "72"],
    [/\b(setenta\s+y\s+tres)\b/g, "73"],
    [/\b(setenta\s+y\s+cuatro)\b/g, "74"],
    [/\b(setenta\s+y\s+cinco)\b/g, "75"],
    [/\b(setenta\s+y\s+seis)\b/g, "76"],
    [/\b(setenta\s+y\s+siete)\b/g, "77"],
    [/\b(setenta\s+y\s+ocho)\b/g, "78"],
    [/\b(setenta\s+y\s+nueve)\b/g, "79"],
    [/\b(setenta)\b/g, "70"],
    [/\b(ochenta\s+y\s+uno)\b/g, "81"],
    [/\b(ochenta\s+y\s+dos)\b/g, "82"],
    [/\b(ochenta\s+y\s+tres)\b/g, "83"],
    [/\b(ochenta\s+y\s+cuatro)\b/g, "84"],
    [/\b(ochenta\s+y\s+cinco)\b/g, "85"],
    [/\b(ochenta\s+y\s+seis)\b/g, "86"],
    [/\b(ochenta\s+y\s+siete)\b/g, "87"],
    [/\b(ochenta\s+y\s+ocho)\b/g, "88"],
    [/\b(ochenta\s+y\s+nueve)\b/g, "89"],
    [/\b(ochenta)\b/g, "80"],
    [/\b(noventa\s+y\s+uno)\b/g, "91"],
    [/\b(noventa\s+y\s+dos)\b/g, "92"],
    [/\b(noventa\s+y\s+tres)\b/g, "93"],
    [/\b(noventa\s+y\s+cuatro)\b/g, "94"],
    [/\b(noventa\s+y\s+cinco)\b/g, "95"],
    [/\b(noventa\s+y\s+seis)\b/g, "96"],
    [/\b(noventa\s+y\s+siete)\b/g, "97"],
    [/\b(noventa\s+y\s+ocho)\b/g, "98"],
    [/\b(noventa\s+y\s+nueve)\b/g, "99"],
    [/\b(noventa)\b/g, "90"],
    [/\b(diez)\b/g, "10"],
    [/\b(once)\b/g, "11"],
    [/\b(doce)\b/g, "12"],
    [/\b(trece)\b/g, "13"],
    [/\b(catorce)\b/g, "14"],
    [/\b(quince)\b/g, "15"],
    [/\b(diecis[eé]is)\b/g, "16"],
    [/\b(diecisiete)\b/g, "17"],
    [/\b(dieciocho)\b/g, "18"],
    [/\b(diecinueve)\b/g, "19"],
    [/\b(veinte)\b/g, "20"],
    [/\b(veintiuno)\b/g, "21"],
    [/\b(veintid[oó]s)\b/g, "22"],
    [/\b(veintitr[eé]s)\b/g, "23"],
    [/\b(veinticuatro)\b/g, "24"],
    [/\b(veinticinco)\b/g, "25"],
    [/\b(veintis[eé]is)\b/g, "26"],
    [/\b(veintisiete)\b/g, "27"],
    [/\b(veintiocho)\b/g, "28"],
    [/\b(veintinueve)\b/g, "29"],
    [/\b(cero)\b/g, "0"],
    [/\b(uno)\b/g, "1"],
    [/\b(dos)\b/g, "2"],
    [/\b(tres)\b/g, "3"],
    [/\b(cuatro)\b/g, "4"],
    [/\b(cinco)\b/g, "5"],
    [/\b(seis|séis|stay|say)\b/g, "6"],
    [/\b(siete)\b/g, "7"],
    [/\b(ocho)\b/g, "8"],
    [/\b(nueve)\b/g, "9"],
  ];

  for (const [pattern, repl] of wordMap) {
    s = s.replace(pattern, repl);
  }

  const hundredsPrefixMap: [RegExp, string][] = [
    [/\b(ciento)\s+(\d{2})\b/g, "1$2"],
    [/\b(ciento)\s+(\d)\b/g, "10$2"],
    [/\b(doscientos|doscientas)\s+(\d{2})\b/g, "2$2"],
    [/\b(doscientos|doscientas)\s+(\d)\b/g, "20$2"],
    [/\b(trescientos|trescientas)\s+(\d{2})\b/g, "3$2"],
    [/\b(trescientos|trescientas)\s+(\d)\b/g, "30$2"],
    [/\b(cuatrocientos|cuatrocientas)\s+(\d{2})\b/g, "4$2"],
    [/\b(cuatrocientos|cuatrocientas)\s+(\d)\b/g, "40$2"],
    [/\b(quinientos|quinientas)\s+(\d{2})\b/g, "5$2"],
    [/\b(quinientos|quinientas)\s+(\d)\b/g, "50$2"],
    [/\b(seiscientos|seiscientas)\s+(\d{2})\b/g, "6$2"],
    [/\b(seiscientos|seiscientas)\s+(\d)\b/g, "60$2"],
    [/\b(setecientos|setecientas)\s+(\d{2})\b/g, "7$2"],
    [/\b(setecientos|setecientas)\s+(\d)\b/g, "70$2"],
    [/\b(ochocientos|ochocientas)\s+(\d{2})\b/g, "8$2"],
    [/\b(ochocientos|ochocientas)\s+(\d)\b/g, "80$2"],
    [/\b(novecientos|novecientas)\s+(\d{2})\b/g, "9$2"],
    [/\b(novecientos|novecientas)\s+(\d)\b/g, "90$2"],
    [/\b(cien|ciento)\b/g, "100"],
    [/\b(doscientos|doscientas)\b/g, "200"],
    [/\b(trescientos|trescientas)\b/g, "300"],
    [/\b(cuatrocientos|cuatrocientas)\b/g, "400"],
    [/\b(quinientos|quinientas)\b/g, "500"],
    [/\b(seiscientos|seiscientas)\b/g, "600"],
    [/\b(setecientos|setecientas)\b/g, "700"],
    [/\b(ochocientos|ochocientas)\b/g, "800"],
    [/\b(novecientos|novecientas)\b/g, "900"],
  ];

  for (const [pattern, repl] of hundredsPrefixMap) {
    s = s.replace(pattern, repl);
  }

  s = s.replace(/__TWICE__\s*(?:el\s+)?(\d\s+\d{2}|\d{1,3})\b/g, (_, grp) => {
    const cleanGrp = grp.replace(/\s+/g, "");
    return `${cleanGrp} ${cleanGrp}`;
  });
  s = s.replace(/__THRICE__\s*(?:el\s+)?(\d\s+\d{2}|\d{1,3})\b/g, (_, grp) => {
    const cleanGrp = grp.replace(/\s+/g, "");
    return `${cleanGrp} ${cleanGrp} ${cleanGrp}`;
  });
  s = s.replace(/__(?:TWICE|THRICE)__/g, "");

  return s;
}

export function isExplicitWhatsAppAuthorization(text: string): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  const norm = normalizeSpanish(text);

  if (/\b(no\s+hay\s+problema|sin\s+problema)\b/i.test(norm)) {
    return true;
  }
  if (/\b(no|nunca|jamas|tampoco|ni\s+hablar|ningun|ninguno|ninguna|para\s+nada|de\s+ninguna\s+manera|rechazo|rechazar|cancela|cancelar|deja|dejadme|borra|borrar|no\s+quiero|no\s+me\s+interesa)\b/i.test(norm)) {
    return false;
  }

  if (/(cuanto\s+cuesta|que\s+precio|cuanto\s+vale|precio|coste|tarifa|cobra|explica|que\s+es|de\s+que|depende|pensar|duda)/i.test(norm)) {
    if (!/\b(envia|manda|pasa|vale|bueno|de\s+acuerdo|si)\b/i.test(norm)) {
      return false;
    }
  }

  if (/\b(si|vale|bueno|de\s+acuerdo|perfecto|claro|por\s+supuesto|adelante|estupendo|genial|ok|okay|apuntamelo|apunta|enviamelo|enviamela|envialo|enviala|mandamelo|mandamela|mandalo|mandala|pasamelo|pasamela|puedes\s+enviar|mandame|enviame|pasame|venga|dale|hazlo|quiero|me\s+parece\s+bien|bien|esta\s+bien|por\s+mi\s+bien|al\s+mismo|este\s+numero|este\s+mismo|a\s+este|autorizado|confirmado|acepto|aceptado|hecho|trato\s+hecho|cuando\s+quieras|cuando\s+este|pruebalo|probar|verla)\b/i.test(norm)) {
    return true;
  }

  if (/\b[6789]\d{2}[\s\-]?\d{3}[\s\-]?\d{3}\b/.test(lower)) {
    return true;
  }

  return false;
}
