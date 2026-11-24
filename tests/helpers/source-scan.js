"use strict";
// Reads a JavaScript source into its parts: code, comments, strings
// (quoted and template) and regular expression literals. Enough of a
// tokenizer to tell a host name in a string from a property access in
// code, for the hygiene tests; not a parser.

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|in|of|void|delete|throw|new|else|do)$/;

/** [{kind: "code"|"comment"|"string"|"regex", text, line}] */
function partsOf(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let code = "";
  let codeLine = 1;
  const flush = () => { if (code) out.push({ kind: "code", text: code, line: codeLine }); code = ""; };
  const take = (kind, start, end) => {
    flush();
    const text = src.slice(start, end);
    out.push({ kind, text, line });
    line += (text.match(/\n/g) || []).length;
    codeLine = line;
    i = end;
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { const end = src.indexOf("\n", i); take("comment", i, end < 0 ? src.length : end); continue; }
    if (c === "/" && d === "*") { const end = src.indexOf("*/", i + 2); take("comment", i, end < 0 ? src.length : end + 2); continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (c === "`" && depth && src[j] === "}") { depth--; j++; continue; }
        if (src[j] === c && !depth) break;
        if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      take("string", i, j + 1);
      continue;
    }
    if (c === "/") {
      const before = code.replace(/\s+$/, "");
      if (REGEX_BEFORE.test(before.slice(-8)) || REGEX_BEFORE.test(before.slice(-1))) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          j++;
        }
        if (src[j] === "/") {
          j++;
          while (/[a-z]/i.test(src[j] || "")) j++;
          take("regex", i, j);
          continue;
        }
      }
    }
    if (!code) codeLine = line;
    if (c === "\n") line++;
    code += c;
    i++;
  }
  flush();
  return out;
}

module.exports = { partsOf };
