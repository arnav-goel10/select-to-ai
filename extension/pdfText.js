/**
 * Select to AI - the text of a PDF the browser is showing.
 *
 * The browser draws a PDF in its own viewer, and nothing of that viewer's
 * text is in the page an extension can read: the agent saw an empty page on
 * every PDF (a tax form, a research paper). So the document is fetched again
 * from inside its own tab (the same address, from the browser's cache, with
 * the tab's own cookies; no new permission) and its text is taken from the
 * file itself, page by page. The engine then uses that text as the page's
 * text, so reading, find and quoting work on a PDF as on any page.
 *
 * Written here, not vendored: it reads what PDFs are made of (objects,
 * object and cross-reference streams, Flate, ASCII85, ASCIIHex and LZW data,
 * fonts with ToUnicode maps, named and Differences encodings, the standard
 * security handler with an empty user password: RC4, AES-128 and AES-256),
 * and draws nothing. A PDF that is only pictures of print has no text to
 * give, and says so.
 *
 * Loaded into a PDF tab by the engine (chrome.scripting, files), into the
 * service worker (importScripts) for the pure helpers, and by Node via
 * require() for tests; all paths expose SELECT_TO_AI_PDF.
 */
(function initPdfText(root) {
  "use strict";

  const LIMITS = { bytes: 40 * 1024 * 1024, pages: 300, chars: 400000, ms: 20000, depth: 6 };

  // ------------------------------------------------------------ objects

  class Name { constructor(n) { this.n = n; } }
  class Str { constructor(s) { this.s = s; } } // bytes, one char per byte
  class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
  class Op { constructor(o) { this.o = o; } }
  class Stream { constructor(dict, start, num, gen) { this.dict = dict; this.start = start; this.num = num; this.gen = gen; this.bytes = null; } }

  const isName = (v, n) => v instanceof Name && (n === undefined || v.n === n);
  const isDict = (v) => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Name) && !(v instanceof Str) && !(v instanceof Ref) && !(v instanceof Op) && !(v instanceof Stream);

  const latin1 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return s;
  };
  const bytesOf = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
  const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

  /** Reads PDF objects out of a byte string, from `pos` on. */
  class Lexer {
    constructor(src, pos) { this.src = src; this.pos = pos || 0; }

    skip() {
      const s = this.src;
      for (;;) {
        const c = s.charCodeAt(this.pos);
        if (WS.has(c)) { this.pos++; continue; }
        if (c === 0x25) { while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++; continue; }
        return;
      }
    }

    /** The next object, or an Op for a bare word; undefined at the end. */
    next() {
      this.skip();
      const s = this.src;
      if (this.pos >= s.length) return undefined;
      const ch = s[this.pos];
      if (ch === "/") {
        let j = this.pos + 1;
        while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
        const raw = s.slice(this.pos + 1, j);
        this.pos = j;
        return new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))));
      }
      if (ch === "(") return new Str(this.literal());
      if (ch === "<") {
        if (s[this.pos + 1] === "<") { this.pos += 2; return this.dict(); }
        const end = s.indexOf(">", this.pos);
        const hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, "");
        this.pos = end < 0 ? s.length : end + 1;
        const even = hex.length % 2 ? `${hex}0` : hex;
        let out = "";
        for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
        return new Str(out);
      }
      if (ch === "[") {
        this.pos++;
        const arr = [];
        for (;;) {
          this.skip();
          if (this.pos >= s.length) return arr;
          if (s[this.pos] === "]") { this.pos++; return arr; }
          const v = this.value();
          if (v === undefined) return arr;
          arr.push(v);
        }
      }
      if (ch === "]" || ch === ">" || ch === ")" || ch === "{" || ch === "}") { this.pos++; return new Op(ch); }
      let j = this.pos;
      while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
      if (j === this.pos) j++;
      const word = s.slice(this.pos, j);
      this.pos = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return parseFloat(word);
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null") return null;
      return new Op(word);
    }

    /** The next value, with "N G R" read as a reference. */
    value() {
      const v = this.next();
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
        const save = this.pos;
        const g = this.next();
        if (typeof g === "number" && Number.isInteger(g) && g >= 0) {
          const r = this.next();
          if (r instanceof Op && r.o === "R") return new Ref(v, g);
        }
        this.pos = save;
      }
      return v;
    }

    dict() {
      const s = this.src;
      const d = Object.create(null);
      for (;;) {
        this.skip();
        if (this.pos >= s.length) return d;
        if (s[this.pos] === ">" && s[this.pos + 1] === ">") { this.pos += 2; return d; }
        const k = this.next();
        if (!(k instanceof Name)) { if (k === undefined) return d; continue; }
        this.skip();
        if (s[this.pos] === ">" && s[this.pos + 1] === ">") { d[k.n] = null; continue; }
        d[k.n] = this.value();
      }
    }

    literal() {
      const s = this.src;
      let depth = 1;
      let out = "";
      this.pos++;
      while (this.pos < s.length) {
        const ch = s[this.pos++];
        if (ch === "\\") {
          const e = s[this.pos++];
          if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "\r") { if (s[this.pos] === "\n") this.pos++; }
          else if (e === "\n") { /* a line continued */ }
          else if (e >= "0" && e <= "7") {
            let oct = e;
            while (oct.length < 3 && s[this.pos] >= "0" && s[this.pos] <= "7") oct += s[this.pos++];
            out += String.fromCharCode(parseInt(oct, 8) & 255);
          } else if (e !== undefined) out += e;
        } else if (ch === "(") { depth++; out += ch; }
        else if (ch === ")") { if (--depth === 0) break; out += ch; }
        else out += ch;
      }
      return out;
    }
  }

  // ------------------------------------------------------------ crypto

  function md5(bytes) {
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const len = bytes.length;
    const padded = new Uint8Array(((len + 72) >>> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    const bits = len * 8;
    padded[padded.length - 8] = bits & 255; padded[padded.length - 7] = (bits >>> 8) & 255;
    padded[padded.length - 6] = (bits >>> 16) & 255; padded[padded.length - 5] = (bits >>> 24) & 255;
    padded[padded.length - 4] = Math.floor(bits / 4294967296) & 255;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) | (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const t = D; D = C; C = B;
        const x = (A + F + K[i] + M[g]) | 0;
        const r = S[(i >> 4) * 4 + (i % 4)];
        B = (B + ((x << r) | (x >>> (32 - r)))) | 0;
        A = t;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => { for (let k = 0; k < 4; k++) out[i * 4 + k] = (v >>> (8 * k)) & 255; });
    return out;
  }

  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + S[i]) & 255;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  }

  const subtle = () => (root.crypto && root.crypto.subtle) || null;

  /** AES-CBC decryption of whole blocks, with no padding taken off. */
  async function aesRaw(key, iv, data) {
    const c = subtle();
    if (!c || !data.length || data.length % 16) return new Uint8Array(0);
    const k = await c.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
    // WebCrypto checks the padding of the last block. A block that decrypts
    // to a whole block of padding is made and put after the data, so the
    // data's own last block is given back as it is.
    const last = data.subarray(data.length - 16);
    const pad = new Uint8Array(16).fill(16);
    const extra = new Uint8Array(await c.encrypt({ name: "AES-CBC", iv: last }, k, pad)).subarray(0, 16);
    return new Uint8Array(await c.decrypt({ name: "AES-CBC", iv }, k, concat([data, extra])));
  }

  /** AES-CBC encryption of whole blocks, with no padding added. */
  async function aesEncryptRaw(key, iv, data) {
    const c = subtle();
    const k = await c.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    return new Uint8Array(await c.encrypt({ name: "AES-CBC", iv }, k, data)).subarray(0, data.length);
  }

  /** Data encrypted as PDF does with AES: the first block is the IV, PKCS#7 padding. */
  async function aesData(key, data) {
    if (data.length < 32) return new Uint8Array(0);
    const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
    const out = await aesRaw(key, data.subarray(0, 16), body);
    const p = out[out.length - 1];
    return p >= 1 && p <= 16 ? out.subarray(0, out.length - p) : out;
  }

  const sha = async (name, data) => new Uint8Array(await subtle().digest(name, data));

  /** The hash of ISO 32000-2 algorithm 2.B (revision 6). */
  async function hash2B(password, salt, udata) {
    let K = await sha("SHA-256", concat([password, salt, udata]));
    for (let round = 0; ; round++) {
      const one = concat([password, K, udata]);
      const K1 = new Uint8Array(one.length * 64);
      for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
      const E = await aesEncryptRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
      let sum = 0;
      for (let i = 0; i < 16; i++) sum += E[i];
      K = await sha(["SHA-256", "SHA-384", "SHA-512"][sum % 3], E);
      if (round >= 63 && E[E.length - 1] <= round - 32) break;
    }
    return K.subarray(0, 32);
  }

  const PAD = bytesOf("\x28\xbf\x4e\x5e\x4e\x75\x8a\x41\x64\x00\x4e\x56\xff\xfa\x01\x08\x2e\x2e\x00\xb6\xd0\x68\x3e\x80\x2f\x0c\xa9\xfe\x64\x53\x69\x7a");

  /**
   * The decryption for a document with the standard security handler and an
   * empty user password (a PDF a browser opens without asking for one).
   * null when it cannot be opened that way.
   */
  async function securityOf(enc, id) {
    if (!isDict(enc) || !isName(enc.Filter, "Standard")) return null;
    const V = enc.V || 0;
    const R = enc.R || 0;
    const O = bytesOf((enc.O && enc.O.s) || "");
    const U = bytesOf((enc.U && enc.U.s) || "");
    const cfm = (name) => {
      if (V < 4) return "V2";
      if (!name || isName(name, "Identity")) return "Identity";
      const cf = enc.CF && enc.CF[name.n];
      return cf && cf.CFM instanceof Name ? cf.CFM.n : "None";
    };
    const stmf = cfm(enc.StmF);
    if (R >= 5) {
      const vsalt = U.subarray(32, 40);
      const ksalt = U.subarray(40, 48);
      const empty = new Uint8Array(0);
      const h = R >= 6 ? (pw, salt) => hash2B(pw, salt, empty) : (pw, salt) => sha("SHA-256", concat([pw, salt]));
      const check = await h(empty, vsalt);
      if (!check.every((b, i) => b === U[i])) return null;
      const ue = bytesOf((enc.UE && enc.UE.s) || "");
      const key = await aesRaw(await h(empty, ksalt), new Uint8Array(16), ue.subarray(0, 32));
      return { stream: (data) => (stmf === "Identity" ? data : aesData(key, data)) };
    }
    const n = R === 2 ? 5 : Math.min(16, Math.max(5, (enc.Length || 40) / 8));
    const P = (enc.P | 0) >>> 0;
    const parts = [PAD, O.subarray(0, 32), new Uint8Array([P & 255, (P >>> 8) & 255, (P >>> 16) & 255, P >>> 24]), bytesOf(id || "")];
    if (R >= 4 && enc.EncryptMetadata === false) parts.push(new Uint8Array([255, 255, 255, 255]));
    let key = md5(concat(parts));
    if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
    key = key.subarray(0, n);
    const objKey = (num, gen, aes) => md5(concat([key, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), aes ? bytesOf("sAlT") : new Uint8Array(0)])).subarray(0, Math.min(16, n + 5));
    return {
      stream: (data, num, gen) => {
        if (stmf === "Identity" || stmf === "None") return data;
        if (stmf === "AESV2") return aesData(objKey(num, gen, true), data);
        return rc4(objKey(num, gen, false), data);
      },
    };
  }

  // ------------------------------------------------------------ filters

  async function inflate(data) {
    if (typeof DecompressionStream !== "function" || !data.length) return new Uint8Array(0);
    // A stream with junk after its end, or cut short, still gives what came
    // before the fault, as a PDF reader shows it.
    const tryWith = async (kind) => {
      const ds = new DecompressionStream(kind);
      const writer = ds.writable.getWriter();
      writer.write(data).catch(() => {});
      writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const parts = [];
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
      } catch (_e) { /* keep what came before the fault */ }
      return concat(parts);
    };
    const out = await tryWith("deflate");
    return out.length ? out : tryWith("deflate-raw");
  }

  function ascii85(data) {
    const s = latin1(data).replace(/\s+/g, "");
    const end = s.indexOf("~>");
    const body = (end >= 0 ? s.slice(0, end) : s).replace(/^<~/, "");
    const out = [];
    let group = [];
    const flush = (n) => {
      let v = 0;
      for (let i = 0; i < 5; i++) v = v * 85 + (i < group.length ? group[i] : 84);
      const b = [Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256];
      for (let i = 0; i < n - 1; i++) out.push(b[i]);
    };
    for (const ch of body) {
      if (ch === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
      const c = ch.charCodeAt(0) - 33;
      if (c < 0 || c > 84) continue;
      group.push(c);
      if (group.length === 5) { flush(5); group = []; }
    }
    if (group.length > 1) flush(group.length);
    return new Uint8Array(out);
  }

  function asciiHex(data) {
    const s = latin1(data).replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
    const even = s.length % 2 ? `${s}0` : s;
    const out = new Uint8Array(even.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function lzw(data, early) {
    const out = [];
    let dict = [];
    const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); };
    reset();
    let bits = 9, buf = 0, nbuf = 0, prev = null;
    for (let i = 0; i < data.length; i++) {
      buf = (buf << 8) | data[i]; nbuf += 8;
      while (nbuf >= bits) {
        const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
        nbuf -= bits;
        if (code === 256) { reset(); bits = 9; prev = null; continue; }
        if (code === 257) return new Uint8Array(out);
        let entry = dict[code];
        if (!entry && prev) entry = [...prev, prev[0]];
        if (!entry) return new Uint8Array(out);
        for (const b of entry) out.push(b);
        if (prev) dict.push([...prev, entry[0]]);
        prev = entry;
        const size = dict.length + early;
        if (size >= 4096) bits = 12; else if (size >= 2048) bits = 12; else if (size >= 1024) bits = 11; else if (size >= 512) bits = 10;
      }
      buf &= (1 << nbuf) - 1;
    }
    return new Uint8Array(out);
  }

  /** Undoes a PNG or TIFF predictor (DecodeParms /Predictor). */
  function unpredict(data, parms) {
    const pred = (parms && parms.Predictor) || 1;
    if (pred < 2) return data;
    const colors = parms.Colors || 1, bpc = parms.BitsPerComponent || 8, cols = parms.Columns || 1;
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const row = Math.ceil((colors * bpc * cols) / 8);
    if (pred === 2) {
      const out = new Uint8Array(data);
      if (bpc === 8) for (let r = 0; r < out.length; r += row) for (let i = bpp; i < row && r + i < out.length; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
      return out;
    }
    const rows = Math.floor(data.length / (row + 1));
    const out = new Uint8Array(rows * row);
    let prior = new Uint8Array(row);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (row + 1)];
      const line = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
      const cur = new Uint8Array(row);
      for (let i = 0; i < row; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prior[i], c = i >= bpp ? prior[i - bpp] : 0;
        let v = line[i];
        if (type === 1) v += a;
        else if (type === 2) v += b;
        else if (type === 3) v += (a + b) >> 1;
        else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = v & 255;
      }
      out.set(cur, r * row);
      prior = cur;
    }
    return out;
  }

  // ------------------------------------------------------------ document

  class Doc {
    constructor(bytes) {
      this.bytes = bytes;
      this.src = latin1(bytes);
      this.objects = new Map(); // num -> {pos, gen, value} | {pos, inStream, index}
      this.security = null;
      this.cache = new Map();
    }

    index() {
      const src = this.src;
      const re = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj\b/g;
      let m;
      const trailers = [];
      while ((m = re.exec(src))) {
        const num = +m[1], gen = +m[2];
        const lx = new Lexer(src, m.index + m[0].length);
        let value;
        try { value = lx.value(); } catch (_e) { continue; }
        if (isDict(value)) {
          const save = lx.pos;
          const kw = lx.next();
          if (kw instanceof Op && kw.o === "stream") {
            let start = lx.pos;
            if (src[start] === "\r") start++;
            if (src[start] === "\n") start++;
            const st = new Stream(value, start, num, gen);
            const len = typeof value.Length === "number" ? value.Length : -1;
            const after = len >= 0 ? src.slice(start + len, start + len + 32) : "";
            if (len >= 0 && /^\s*endstream/.test(after)) st.end = start + len;
            else {
              const e = src.indexOf("endstream", start);
              st.end = e < 0 ? src.length : e;
              st.loose = true;
            }
            value = st;
            re.lastIndex = Math.max(re.lastIndex, st.end);
            if (isName(st.dict.Type, "XRef")) trailers.push({ pos: m.index, dict: st.dict });
          } else lx.pos = save;
        }
        const prev = this.objects.get(num);
        if (!prev || prev.pos <= m.index) this.objects.set(num, { pos: m.index, gen, value });
      }
      const tre = /trailer[\0\t\n\f\r ]*<</g;
      while ((m = tre.exec(src))) {
        const lx = new Lexer(src, m.index + 7);
        try { const d = lx.value(); if (isDict(d)) trailers.push({ pos: m.index, dict: d }); } catch (_e) { /* a broken trailer */ }
      }
      trailers.sort((a, b) => a.pos - b.pos);
      this.trailers = trailers;
      const pick = (key) => { for (let i = trailers.length - 1; i >= 0; i--) if (trailers[i].dict[key] !== undefined) return trailers[i].dict[key]; return undefined; };
      this.rootRef = pick("Root");
      this.encrypt = pick("Encrypt");
      const ids = pick("ID");
      this.id = Array.isArray(ids) && ids[0] instanceof Str ? ids[0].s : "";
    }

    async open() {
      this.index();
      if (this.encrypt !== undefined && this.encrypt !== null) {
        const enc = this.get(this.encrypt);
        this.security = await securityOf(enc, this.id);
        if (!this.security) throw Object.assign(new Error("This PDF is locked with a password."), { locked: true });
      }
      // Objects kept inside object streams, read in file order: a later
      // object stream replaces an earlier one's, never an object written after it.
      const streams = [...this.objects.values()].filter((o) => o.value instanceof Stream && isName(o.value.dict.Type, "ObjStm")).sort((a, b) => a.pos - b.pos);
      for (const o of streams) {
        const st = o.value;
        let data;
        try { data = latin1(await this.decode(st)); } catch (_e) { continue; }
        const first = st.dict.First || 0;
        const head = new Lexer(data, 0);
        for (let i = 0; i < (st.dict.N || 0); i++) {
          const num = head.next(), off = head.next();
          if (typeof num !== "number" || typeof off !== "number") break;
          const prev = this.objects.get(num);
          if (prev && prev.pos > o.pos) continue;
          let value;
          try { value = new Lexer(data, first + off).value(); } catch (_e) { continue; }
          this.objects.set(num, { pos: o.pos, gen: 0, value });
        }
      }
      if (!(this.rootRef instanceof Ref) || !isDict(this.get(this.rootRef))) {
        for (const [num, o] of this.objects) if (isDict(o.value) && isName(o.value.Type, "Catalog")) { this.rootRef = new Ref(num, o.gen); break; }
      }
    }

    get(v) {
      for (let hops = 0; v instanceof Ref && hops < 16; hops++) { const o = this.objects.get(v.num); v = o ? o.value : null; }
      return v === undefined ? null : v;
    }

    raw(st) {
      let end = st.end;
      if (st.loose) {
        const len = this.get(st.dict.Length);
        if (typeof len === "number" && len >= 0 && st.start + len <= this.src.length && /^\s*endstream/.test(this.src.slice(st.start + len, st.start + len + 32))) end = st.start + len;
        else { while (end > st.start && (this.src[end - 1] === "\n" || this.src[end - 1] === "\r")) end--; }
      }
      return this.bytes.subarray(st.start, end);
    }

    /** A stream's data with its filters undone. */
    async decode(st) {
      if (st.bytes) return st.bytes;
      let data = this.raw(st);
      if (this.security && !isName(st.dict.Type, "XRef")) data = await this.security.stream(data, st.num, st.gen);
      const filters = [].concat(this.get(st.dict.Filter) || []).map((f) => this.get(f));
      const parms = [].concat(this.get(st.dict.DecodeParms) || []).map((p) => this.get(p));
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i] instanceof Name ? filters[i].n : "";
        const p = parms[i] || null;
        if (f === "FlateDecode" || f === "Fl") data = unpredict(await inflate(data), p);
        else if (f === "ASCII85Decode" || f === "A85") data = ascii85(data);
        else if (f === "ASCIIHexDecode" || f === "AHx") data = asciiHex(data);
        else if (f === "LZWDecode" || f === "LZW") data = unpredict(lzw(data, p && p.EarlyChange === 0 ? 0 : 1), p);
        else if (f === "Crypt") { /* the document's own crypt filter was used */ }
        else { data = new Uint8Array(0); break; } // a picture: no text in it
      }
      st.bytes = data;
      return data;
    }

    /**
     * The first `cap` pages in order, each {dict, resources}, and how many
     * pages the document has in all: a long file is labelled with its real
     * length, and its text is marked as cut short.
     */
    pages(cap) {
      const limit = cap || LIMITS.pages;
      const out = [];
      let total = 0;
      const seen = new Set();
      const walk = (node, inherited, depth) => {
        const d = this.get(node);
        if (!isDict(d) || depth > 64) return;
        if (node instanceof Ref) { if (seen.has(node.num)) return; seen.add(node.num); }
        const res = d.Resources !== undefined ? d.Resources : inherited;
        const kids = this.get(d.Kids);
        if (Array.isArray(kids)) { for (const k of kids) walk(k, res, depth + 1); return; }
        total += 1;
        if (out.length < limit) out.push({ dict: d, resources: res });
      };
      const cat = this.get(this.rootRef);
      if (isDict(cat)) walk(cat.Pages, null, 0);
      if (!out.length) {
        total = 0;
        for (const o of this.objects.values()) {
          if (!isDict(o.value) || !isName(o.value.Type, "Page")) continue;
          total += 1;
          if (out.length < limit) out.push({ dict: o.value, resources: o.value.Resources });
        }
      }
      return { list: out, total };
    }
  }

  // ------------------------------------------------------------ fonts

  const DECODERS = {};
  const tableFor = (label) => {
    if (DECODERS[label]) return DECODERS[label];
    let t = [];
    try {
      const dec = new TextDecoder(label);
      for (let i = 0; i < 256; i++) t.push(dec.decode(new Uint8Array([i])));
    } catch (_e) { t = []; for (let i = 0; i < 256; i++) t.push(String.fromCharCode(i)); }
    DECODERS[label] = t;
    return t;
  };
  const STANDARD_HIGH = { 0xa1: "¡", 0xa2: "¢", 0xa3: "£", 0xa5: "¥", 0xa7: "§", 0xa9: "'", 0xaa: "“", 0xab: "«", 0xae: "fi", 0xaf: "fl", 0xb1: "–", 0xb2: "†", 0xb3: "‡", 0xb4: "·", 0xb6: "¶", 0xb7: "•", 0xb8: "‚", 0xb9: "„", 0xba: "”", 0xbb: "»", 0xbc: "…", 0xbf: "¿", 0xc1: "`", 0xc2: "´", 0xc3: "ˆ", 0xc4: "˜", 0xc5: "¯", 0xd0: "\u2014", 0xe1: "Æ", 0xe8: "Ł", 0xe9: "Ø", 0xea: "Œ", 0xf1: "æ", 0xf5: "ı", 0xf8: "ł", 0xf9: "ø", 0xfa: "œ", 0xfb: "ß" };
  const standardTable = () => {
    if (DECODERS.standard) return DECODERS.standard;
    const t = [];
    for (let i = 0; i < 256; i++) t.push(i >= 32 && i < 127 ? String.fromCharCode(i) : STANDARD_HIGH[i] || "");
    t[0x27] = "’"; t[0x60] = "‘";
    DECODERS.standard = t;
    return t;
  };
  const baseTable = (name) => (name === "MacRomanEncoding" ? tableFor("macintosh") : name === "StandardEncoding" ? standardTable() : tableFor("windows-1252"));

  const GLYPHS = {
    space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘",
    parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<",
    equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
    braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
    eight: "8", nine: "9", bullet: "•", endash: "–", emdash: "\u2014", quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„",
    ellipsis: "…", dagger: "†", daggerdbl: "‡", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", minus: "−", multiply: "×", divide: "÷", degree: "°",
    copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶", periodcentered: "·", sterling: "£", yen: "¥", Euro: "€", cent: "¢",
    dotlessi: "ı", germandbls: "ß", AE: "Æ", ae: "æ", OE: "Œ", oe: "œ", oslash: "ø", Oslash: "Ø", Lslash: "Ł", lslash: "ł", eth: "ð", Eth: "Ð",
    thorn: "þ", Thorn: "Þ", guillemotleft: "«", guillemotright: "»", guilsinglleft: "‹", guilsinglright: "›", exclamdown: "¡", questiondown: "¿",
    plusminus: "±", mu: "µ", nbspace: " ", sfthyphen: "", logicalnot: "¬", fraction: "⁄", perthousand: "‰", circumflex: "ˆ", tilde: "˜",
    acute: "´", dieresis: "¨", macron: "¯", cedilla: "¸", ordfeminine: "ª", ordmasculine: "º", onehalf: "½", onequarter: "¼", threequarters: "¾",
  };
  const MARKS = { acute: "\u0301", grave: "\u0300", circumflex: "\u0302", dieresis: "\u0308", tilde: "\u0303", ring: "\u030a", cedilla: "\u0327", caron: "\u030c", macron: "\u0304", breve: "\u0306", ogonek: "\u0328", dotaccent: "\u0307", hungarumlaut: "\u030b" };

  /** The text of a glyph name ("eacute", "uni00E9", "f_i", "one.oldstyle"). */
  function glyphText(name) {
    if (!name) return "";
    if (GLYPHS[name] !== undefined) return GLYPHS[name];
    if (/^[A-Za-z]$/.test(name)) return name;
    let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
    if (m) return m[1].match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ""; }
    m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/.exec(name);
    if (m) return (m[1] + MARKS[m[2]]).normalize("NFC");
    if (name.includes(".")) return glyphText(name.slice(0, name.indexOf(".")));
    if (name.includes("_")) return name.split("_").map(glyphText).join("");
    return "";
  }

  /** A UTF-16BE byte string as text. */
  const utf16 = (s) => {
    let out = "";
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  };
  const codeOf = (s) => { let v = 0; for (let i = 0; i < s.length; i++) v = v * 256 + s.charCodeAt(i); return v; };

  /** A ToUnicode CMap: {map: Map(code -> text), spaces: [{len, lo, hi}]}. */
  function parseCMap(text) {
    const map = new Map();
    const spaces = [];
    const lx = new Lexer(text, 0);
    let mode = "";
    const items = [];
    for (let guard = 0; guard < 2000000; guard++) {
      const t = lx.value();
      if (t === undefined) break;
      if (t instanceof Op) {
        if (t.o === "begincodespacerange" || t.o === "beginbfchar" || t.o === "beginbfrange" || t.o === "begincidchar" || t.o === "begincidrange") { mode = t.o; items.length = 0; continue; }
        if (t.o === "endcodespacerange") { for (let i = 0; i + 1 < items.length; i += 2) if (items[i] instanceof Str) spaces.push({ len: items[i].s.length, lo: codeOf(items[i].s), hi: codeOf(items[i + 1].s) }); }
        else if (t.o === "endbfchar") { for (let i = 0; i + 1 < items.length; i += 2) if (items[i] instanceof Str && items[i + 1] instanceof Str) map.set(codeOf(items[i].s), utf16(items[i + 1].s)); }
        else if (t.o === "endbfrange") {
          for (let i = 0; i + 2 < items.length; i += 3) {
            const lo = codeOf(items[i].s || ""), hi = codeOf(items[i + 1].s || ""), dst = items[i + 2];
            for (let c = lo, k = 0; c <= hi && k < 65536; c++, k++) {
              if (Array.isArray(dst)) { if (dst[k] instanceof Str) map.set(c, utf16(dst[k].s)); }
              else if (dst instanceof Str) {
                const u = utf16(dst.s);
                map.set(c, u.slice(0, -1) + String.fromCharCode(u.charCodeAt(u.length - 1) + k));
              }
            }
          }
        }
        mode = t.o.startsWith("end") ? "" : mode;
        items.length = 0;
        continue;
      }
      if (mode) items.push(t);
    }
    return { map, spaces };
  }

  /** The encoding built into an embedded Type 1 font program, by code. */
  function type1Encoding(text) {
    if (/\/Encoding\s+StandardEncoding\s+def/.test(text)) return standardTable().slice();
    const names = [];
    const re = /dup\s+(\d+)\s*\/([^\s/\[\]{}()<>]+)\s+put/g;
    let m;
    let any = false;
    const head = text.slice(0, Math.max(0, text.indexOf("eexec")) || text.length);
    while ((m = re.exec(head))) { const c = +m[1]; if (c < 256) { names[c] = glyphText(m[2]); any = true; } }
    return any ? names : null;
  }

  async function fontOf(doc, ref, cache) {
    const key = ref instanceof Ref ? `r${ref.num}` : null;
    if (key && cache.has(key)) return cache.get(key);
    const d = doc.get(ref);
    const font = { twoByte: false, spaces: null, map: null, table: null, widths: null, firstChar: 0, dw: 1000, wmap: null, ucs2: false, missing: 500 };
    if (!isDict(d)) { if (key) cache.set(key, font); return font; }
    const sub = isName(d.Subtype) ? d.Subtype.n : "";
    if (sub === "Type0") {
      font.twoByte = true;
      const enc = doc.get(d.Encoding);
      if (isName(enc) && /UCS2|UTF16/.test(enc.n)) font.ucs2 = true;
      const desc = doc.get((doc.get(d.DescendantFonts) || [])[0]);
      if (isDict(desc)) {
        font.dw = typeof desc.DW === "number" ? desc.DW : 1000;
        const W = doc.get(desc.W);
        if (Array.isArray(W)) {
          font.wmap = new Map();
          for (let i = 0; i < W.length && font.wmap.size < 70000;) {
            const a = doc.get(W[i]), b = doc.get(W[i + 1]);
            if (Array.isArray(b)) { b.forEach((w, k) => font.wmap.set(a + k, doc.get(w))); i += 2; }
            else { const w = doc.get(W[i + 2]); for (let c = a; c <= b && c - a < 70000; c++) font.wmap.set(c, w); i += 3; }
          }
        }
      }
    } else {
      const fc = doc.get(d.FirstChar), widths = doc.get(d.Widths);
      if (Array.isArray(widths)) { font.firstChar = typeof fc === "number" ? fc : 0; font.widths = widths.map((w) => doc.get(w)); }
      else font.missing = 550; // a standard font that gives no widths: an average guess
      const enc = doc.get(d.Encoding);
      let table = null;
      if (isName(enc)) table = baseTable(enc.n).slice();
      else if (isDict(enc)) {
        table = baseTable(isName(enc.BaseEncoding) ? enc.BaseEncoding.n : "StandardEncoding").slice();
        const diffs = doc.get(enc.Differences);
        if (Array.isArray(diffs)) {
          let code = 0;
          for (const x of diffs) { const v = doc.get(x); if (typeof v === "number") code = v; else if (v instanceof Name) { if (code < 256) table[code] = glyphText(v.n); code++; } }
        }
      }
      const fd = doc.get(d.FontDescriptor);
      if (!table) {
        // With no encoding of its own, a Type 1 font uses the one in its program.
        const ff = isDict(fd) ? doc.get(fd.FontFile) : null;
        if (ff instanceof Stream) {
          try { table = type1Encoding(latin1((await doc.decode(ff)).subarray(0, 200000))); } catch (_e) { /* the program is unreadable */ }
        }
      }
      // A symbolic or TrueType font with no encoding draws by its own codes.
      const symbolic = isDict(fd) && (doc.get(fd.Flags) & 4);
      font.table = table || (sub === "TrueType" || symbolic ? tableFor("windows-1252") : standardTable());
    }
    const tu = doc.get(d.ToUnicode);
    if (tu instanceof Stream) {
      try {
        const cm = parseCMap(latin1(await doc.decode(tu)));
        if (cm.map.size) font.map = cm.map;
        if (cm.spaces.length) font.spaces = cm.spaces;
      } catch (_e) { /* the map is unreadable */ }
    }
    if (key) cache.set(key, font);
    return font;
  }

  /** The glyphs of a string drawn in `font`: [{text, width (in 1/1000 em), single}]. */
  function glyphsOf(font, s) {
    const out = [];
    const lens = font.spaces ? [...new Set(font.spaces.map((x) => x.len))].sort((a, b) => a - b) : [font.twoByte ? 2 : 1];
    for (let i = 0; i < s.length;) {
      let len = lens[lens.length - 1];
      if (font.spaces && lens.length > 1) {
        for (const l of lens) {
          const c = codeOf(s.slice(i, i + l));
          if (font.spaces.some((x) => x.len === l && c >= x.lo && c <= x.hi)) { len = l; break; }
        }
      }
      const raw = s.slice(i, i + len);
      i += len;
      const code = codeOf(raw);
      let text = font.map && font.map.has(code) ? font.map.get(code) : null;
      if (text === null) {
        if (font.ucs2) text = String.fromCharCode(code);
        else if (font.table && len === 1) text = font.table[code] || "";
        else text = "";
      }
      let width;
      if (font.wmap) width = font.wmap.has(code) ? font.wmap.get(code) : font.dw;
      else if (font.twoByte) width = font.dw;
      else if (font.widths) { const w = font.widths[code - font.firstChar]; width = typeof w === "number" ? w : font.missing; }
      else width = font.missing;
      out.push({ text, width: width || 0, single: len === 1 && code === 32 });
    }
    return out;
  }

  // ------------------------------------------------------------ page text

  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];

  /** Turns a page's drawing into lines of text, in the order they are drawn. */
  class TextSink {
    constructor() { this.lines = []; this.line = ""; this.last = null; }

    put(x, y, size, text, endX) {
      if (!text) return;
      const s = Math.max(1, size);
      if (this.last) {
        const dy = Math.abs(y - this.last.y);
        if (dy > 0.5 * Math.max(s, this.last.size)) this.newline();
        else {
          const gap = x - this.last.x;
          if ((gap > 0.18 * s || gap < -1.5 * s) && this.line && !/\s$/.test(this.line) && !/^\s/.test(text)) this.line += " ";
        }
      }
      this.line += text;
      this.last = { x: endX, y, size: s };
    }

    newline() { this.lines.push(this.line); this.line = ""; }

    /** A break that comes from the document's structure (another form, another page part). */
    breakHere() { if (this.line) this.newline(); this.last = null; }

    text() {
      if (this.line) this.newline();
      return this.lines.map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
    }
  }

  const LIGATURES = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st" };
  const clean = (t) => t
    .replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c])
    .replace(/\u00a0/g, " ")
    .replace(/[\u00ad\u200b\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff\ufffd]/g, "");

  async function pageText(doc, page, budget) {
    const sink = new TextSink();
    const fontCache = doc.fontCache || (doc.fontCache = new Map());
    const run = async (content, resources, matrix, depth, seen) => {
      const res = doc.get(resources);
      const fonts = isDict(res) ? doc.get(res.Font) : null;
      const xobjects = isDict(res) ? doc.get(res.XObject) : null;
      const lx = new Lexer(content, 0);
      const stack = [];
      let ctm = matrix;
      let tm = [1, 0, 0, 1, 0, 0], tlm = tm;
      let font = null, fs = 0, tc = 0, tw = 0, th = 1, tl = 0, rise = 0;
      let ops = [];
      const show = (str) => {
        if (!font || !(str instanceof Str)) return;
        const glyphs = glyphsOf(font, str.s);
        const start = mul([fs * th, 0, 0, fs, 0, rise], mul(tm, ctm));
        const size = Math.hypot(start[2], start[3]);
        let text = "";
        for (const g of glyphs) {
          text += g.text;
          const adv = ((g.width / 1000) * fs + tc + (g.single ? tw : 0)) * th;
          tm = mul([1, 0, 0, 1, adv, 0], tm);
        }
        const end = mul(tm, ctm);
        sink.put(start[4], start[5], size, clean(text), end[4]);
      };
      const num = (i) => (typeof ops[i] === "number" ? ops[i] : 0);
      for (let guard = 0; guard < 5000000; guard++) {
        if (sink.lines.length > 20000 || budget.chars <= 0) break;
        const t = lx.value();
        if (t === undefined) break;
        if (!(t instanceof Op)) { ops.push(t); if (ops.length > 64) ops.shift(); continue; }
        switch (t.o) {
          case "q": stack.push({ ctm, font, fs, tc, tw, th, tl, rise }); break;
          case "Q": { const s = stack.pop(); if (s) ({ ctm, font, fs, tc, tw, th, tl, rise } = s); break; }
          case "cm": if (ops.length >= 6) ctm = mul(ops.slice(-6).map((v) => (typeof v === "number" ? v : 0)), ctm); break;
          case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
          case "ET": break;
          case "Tf": {
            const name = ops[ops.length - 2];
            fs = num(ops.length - 1);
            font = isName(name) && isDict(fonts) ? await fontOf(doc, fonts[name.n], fontCache) : null;
            break;
          }
          case "Tc": tc = num(ops.length - 1); break;
          case "Tw": tw = num(ops.length - 1); break;
          case "Tz": th = num(ops.length - 1) / 100; break;
          case "TL": tl = num(ops.length - 1); break;
          case "Ts": rise = num(ops.length - 1); break;
          case "Td": tlm = mul([1, 0, 0, 1, num(ops.length - 2), num(ops.length - 1)], tlm); tm = tlm; break;
          case "TD": tl = -num(ops.length - 1); tlm = mul([1, 0, 0, 1, num(ops.length - 2), num(ops.length - 1)], tlm); tm = tlm; break;
          case "Tm": if (ops.length >= 6) { tlm = ops.slice(-6).map((v) => (typeof v === "number" ? v : 0)); tm = tlm; } break;
          case "T*": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
          case "Tj": show(ops[ops.length - 1]); break;
          case "'": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; show(ops[ops.length - 1]); break;
          case "\"": tw = num(ops.length - 3); tc = num(ops.length - 2); tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; show(ops[ops.length - 1]); break;
          case "TJ": {
            const arr = ops[ops.length - 1];
            if (Array.isArray(arr)) for (const x of arr) { if (typeof x === "number") tm = mul([1, 0, 0, 1, (-x / 1000) * fs * th, 0], tm); else show(x); }
            break;
          }
          case "Do": {
            const name = ops[ops.length - 1];
            const xo = isName(name) && isDict(xobjects) ? xobjects[name.n] : null;
            const st = doc.get(xo);
            const id = xo instanceof Ref ? xo.num : -1;
            if (st instanceof Stream && isName(st.dict.Subtype, "Form") && depth < LIMITS.depth && !seen.has(id)) {
              const m = doc.get(st.dict.Matrix);
              const fm = Array.isArray(m) && m.length === 6 ? m.map((v) => doc.get(v) || 0) : [1, 0, 0, 1, 0, 0];
              sink.breakHere();
              const inner = new Set(seen); inner.add(id);
              try { await run(latin1(await doc.decode(st)), st.dict.Resources !== undefined ? st.dict.Resources : resources, mul(fm, ctm), depth + 1, inner); } catch (_e) { /* a broken form */ }
              sink.breakHere();
            }
            break;
          }
          case "BI": {
            // An image written into the page: its data is skipped whole.
            const at = content.indexOf("ID", lx.pos);
            if (at < 0) { lx.pos = content.length; break; }
            const ei = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
            ei.lastIndex = at + 3;
            const m = ei.exec(content);
            lx.pos = m ? m.index + m[0].length : content.length;
            break;
          }
          default: break;
        }
        ops = [];
      }
    };
    const contents = [].concat(doc.get(page.dict.Contents) || []);
    const parts = [];
    for (const c of contents) { const st = doc.get(c); if (st instanceof Stream) { try { parts.push(await doc.decode(st)); parts.push(new Uint8Array([10])); } catch (_e) { /* a broken part */ } } }
    await run(latin1(concat(parts)), page.resources, [1, 0, 0, 1, 0, 0], 0, new Set());
    const text = sink.text();
    budget.chars -= text.length;
    return text;
  }

  /**
   * The text of a PDF file, page by page.
   * @param {Uint8Array} bytes
   * @returns {Promise<{pages: string[], total: number, text: string, cut: boolean} | {error: string, locked?: boolean}>}
   */
  async function extract(bytes, opts) {
    const o = { ...LIMITS, ...(opts || {}) };
    const began = Date.now();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!/%PDF-/.test(latin1(u8.subarray(0, 1024)))) return { error: "This is not a PDF file." };
    const doc = new Doc(u8);
    try { await doc.open(); } catch (e) { return { error: e && e.locked ? "This PDF is locked with a password, so its text cannot be read." : "This PDF could not be read.", locked: !!(e && e.locked) }; }
    const all = doc.pages(o.pages);
    const pages = [];
    const budget = { chars: o.chars };
    let cut = all.total > all.list.length;
    for (const p of all.list) {
      if (budget.chars <= 0 || Date.now() - began > o.ms) { cut = true; break; }
      let t = "";
      try { t = await pageText(doc, p, budget); } catch (_e) { t = ""; }
      pages.push(t);
    }
    return { pages, total: all.total, cut, text: pages.join("\n\n") };
  }

  /**
   * The text as the page's text: each page under its own heading, so find
   * says which page a passage is on.
   */
  function asPageText(got) {
    const n = got.total || got.pages.length;
    const body = got.pages.map((t, i) => `## Page ${i + 1} of ${n}\n${t || "(no text on this page)"}`).join("\n\n");
    const more = got.cut ? `\n\n[The text stops here: the rest of this ${n}-page PDF was not read.]` : "";
    return `${body}${more}`;
  }

  const isPdfType = (page) => /^application\/pdf\b/i.test(String((page && page.contentType) || ""));
  const isWebAddress = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

  /**
   * True when what a scan of the tab found is a PDF the browser draws: a
   * document of type PDF (the browser's own viewer), or a page that is only
   * one embedded PDF with a web address of its own.
   */
  function isPdfPage(page) {
    if (!page || typeof page !== "object") return false;
    return isPdfType(page) || isWebAddress(page.pdfEmbed);
  }

  /**
   * Where the file of a PDF page is: the document's own address when the
   * document is the PDF, or else the embedded file's. Never the address of
   * an HTML page that only holds the PDF.
   */
  function pdfAddress(page) {
    if (!isPdfPage(page)) return "";
    return isPdfType(page) ? String(page.url || "") : page.pdfEmbed;
  }

  /**
   * The scan's page with the PDF's text as its text. `got` is what readHere
   * gave: the text, or why there is none. The page keeps its controls, and
   * keeps what the scan read when the file gave no text.
   */
  function withPdfText(page, got) {
    const out = { ...page, pdf: true };
    if (got && Array.isArray(got.pages) && got.pages.some((t) => String(t || "").trim())) {
      out.innerText = asPageText(got);
      out.visibleText = String(got.pages[0] || "").slice(0, 1200);
      out.outline = [];
      out.pdfPages = got.total || got.pages.length;
      return out;
    }
    const why = got && got.error ? got.error
      : got && Array.isArray(got.pages) ? `This PDF has ${got.total || got.pages.length} page${(got.total || got.pages.length) === 1 ? "" : "s"} but no text in it: its pages may be pictures of print. look shows the page as drawn.`
        : "The text of this PDF could not be read.";
    const scanned = String(page.innerText || "").trim();
    const had = scanned && !/^\[No text content found\]$/i.test(scanned);
    out.innerText = had ? `${page.innerText}\n\n[${why}]` : `[${why}]`;
    return out;
  }

  // Address -> the reading of it, in this document. One reading per file:
  // a later look while the first is still going waits for that one, and a
  // file that could not be read is not fetched again.
  const kept = new Map();

  async function readOnce(url, opts) {
    try {
      const res = await fetch(url, { credentials: "include", cache: "force-cache" });
      if (!res.ok) return { error: `The PDF could not be fetched again (the site answered ${res.status}).` };
      const len = +(res.headers.get("content-length") || 0);
      if (len > LIMITS.bytes) return { error: "This PDF is too large to read here." };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > LIMITS.bytes) return { error: "This PDF is too large to read here." };
      return await extract(buf, opts);
    } catch (_e) {
      return { error: "The PDF could not be fetched again from its address." };
    }
  }

  /**
   * Run in the PDF's own tab: fetches the file again and reads its text.
   * `url` is the file's address (pdfAddress), the document's own by default.
   */
  function readHere(url, opts) {
    const at = String(url || (root.location && root.location.href) || "");
    if (!kept.has(at)) kept.set(at, readOnce(at, opts));
    return kept.get(at);
  }

  const api = { extract, asPageText, isPdfPage, pdfAddress, withPdfText, readHere, parseCMap, glyphText, md5, rc4, LIMITS };
  root.SELECT_TO_AI_PDF = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
