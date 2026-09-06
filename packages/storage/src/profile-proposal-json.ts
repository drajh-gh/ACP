/** Parse PostgreSQL JSON text only when every number retains its exact decimal JSON value in JS. */
export function parseExactProfileJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 524288 || Buffer.byteLength(value,"utf8") > 524288) throw new Error("invalid exact profile JSON");
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  let index = 0;
  while (index < value.length) {
    const char = value[index]!;
    if (char === '"') {
      index++; let closed = false;
      while (index < value.length) {
        if (value[index] === "\\") { index += 2; continue; }
        if (value[index++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error("invalid exact profile JSON string");
    } else if (char === "-" || /[0-9]/u.test(char)) {
      number.lastIndex = index;
      const token = number.exec(value)?.[0];
      if (!token || token.length > 1024) throw new Error("invalid exact profile JSON number");
      const parsed = Number(token);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER
        || decimal(token) !== decimal(JSON.stringify(parsed))) throw new Error("profile JSON number loses exact identity");
      index = number.lastIndex;
    } else if (/^[\x20\t\r\n{}\[\],:]$/u.test(char)) index++;
    else {
      const literal = ["true","false","null"].find(word => value.startsWith(word,index));
      if (!literal) throw new Error("invalid exact profile JSON token");
      index += literal.length;
    }
  }
  // Full JSON grammar and escape validation follows lexical numeric identity validation.
  return JSON.parse(value) as unknown;
}

function decimal(value: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(value);
  if (!match || (match[4]?.replace(/^[+-]/u, "").length ?? 0) > 6) throw new Error("invalid exact decimal");
  const fraction = match[3] ?? "";
  let digits = (match[2]! + fraction).replace(/^0+/u, "");
  if (!digits) return "0";
  const trailing = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailing) digits = digits.slice(0,-trailing);
  const exponent = Number(match[4] ?? 0) - fraction.length + trailing;
  return `${match[1]}${digits}e${exponent}`;
}
