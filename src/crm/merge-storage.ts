export function dataEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v: any, i: number) => dataEqual(v, b[i]));
  const keys = Object.keys(a).filter(k => a[k] !== undefined);
  return keys.length === Object.keys(b).filter(k => b[k] !== undefined).length && keys.every(k => dataEqual(a[k], b[k]));
}

/** Merge only locally edited fields. Concurrent edits of the same field fail visibly. */
export function mergeChanges(base: any, local: any, current: any, at = "crm"): any {
  const equal = dataEqual;
  if (equal(base, local)) return current;
  if (equal(base, current) || equal(local, current)) return local;
  const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  if (object(base) && object(local) && object(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      const value = mergeChanges(base[key], local[key], current[key], `${at}.${key}`);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  if ([base, local, current].every(Array.isArray)) {
    const key = (v: any) => v?.id ?? v?.telefono;
    if ([...base, ...local, ...current].every(v => object(v) && typeof key(v) === "string")) {
      const b = new Map(base.map((v: any) => [key(v), v]));
      const l = new Map(local.map((v: any) => [key(v), v]));
      const c = new Map(current.map((v: any) => [key(v), v]));
      const ids = new Set([...c.keys(), ...l.keys(), ...b.keys()]);
      return [...ids].map(id => mergeChanges(b.get(id), l.get(id), c.get(id), `${at}[${id}]`)).filter(v => v !== undefined);
    }
  }
  throw new Error(`Conflicto de actualización en ${at}. Recarga los datos antes de repetir la operación.`);
}

/** Keep existing record references used by synchronous CRM operations. */
export function reconcileInPlace(target: any, next: any): any {
  if (Array.isArray(target) && Array.isArray(next)) {
    const byKey = new Map(target.map(v => [v?.id ?? v?.telefono, v]));
    target.splice(0, target.length, ...next.map(v => {
      const key = v?.id ?? v?.telefono;
      return key ? reconcileInPlace(byKey.get(key), v) : v;
    }));
    return target;
  }
  if (target && next && typeof target === "object" && typeof next === "object" && !Array.isArray(target) && !Array.isArray(next)) {
    for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
    for (const key of Object.keys(next)) target[key] = reconcileInPlace(target[key], next[key]);
    return target;
  }
  return next;
}
