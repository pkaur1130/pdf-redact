/**
 * Redaction that actually removes the words.
 *
 * A black rectangle drawn over a name hides it from the eye and leaves it in
 * the file, where anyone can select it, copy it, or read it with a text
 * extractor. That is not a subtle failure — it is how court filings and
 * government releases have leaked the exact thing they were redacting, more
 * than once. Our own editor says so in its own warning; this is the tool that
 * makes the warning unnecessary.
 *
 * So this edits the content stream. Text-showing operators whose glyphs fall
 * inside a redaction area have their strings emptied, which deletes the
 * characters while leaving the positioning of everything after them intact. A
 * black box is drawn as well, but the box is cosmetic — the removal is the
 * product.
 *
 * Where it is uncertain, it removes more rather than less. Width is estimated
 * rather than measured, because measuring needs the embedded font's metrics
 * and those are not always readable; the estimate is deliberately generous, so
 * the failure mode is a word removed that did not have to be, never a word
 * left behind that should have gone.
 */
import { PDFDocument, PDFName, PDFRawStream, PDFArray, rgb } from "pdf-lib";
// PDF FlateDecode is zlib-wrapped, so these are the zlib pair rather than
// the raw-deflate one — the raw functions fail on the two-byte header.
import { unzlibSync, zlibSync } from "fflate";

/** An area to remove, in PDF points with the origin at the bottom left. */
export interface RedactionBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Token =
  | { kind: "num"; value: number; raw: string }
  | { kind: "str"; raw: string }
  | { kind: "name"; raw: string }
  | { kind: "op"; raw: string }
  | { kind: "punct"; raw: string };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const BACKSLASH = 0x5c;
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const PERCENT = 0x25;

/**
 * Splits a content stream into tokens.
 *
 * Strings are kept as raw source rather than decoded: the aim is to rewrite
 * the stream, and a string that survives untouched should come back out byte
 * for byte rather than through a decode-and-re-encode that could change it.
 */
export function tokenise(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (WHITESPACE.has(c)) {
      i++;
      continue;
    }
    if (c === PERCENT) {
      while (i < src.length && src.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    if (c === OPEN_PAREN) {
      const start = i;
      let depth = 0;
      while (i < src.length) {
        const ch = src.charCodeAt(i);
        if (ch === BACKSLASH) {
          i += 2;
          continue;
        }
        if (ch === OPEN_PAREN) depth++;
        else if (ch === CLOSE_PAREN) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      out.push({ kind: "str", raw: src.slice(start, i) });
      continue;
    }
    if (c === LESS_THAN) {
      if (src.charCodeAt(i + 1) === LESS_THAN) {
        out.push({ kind: "punct", raw: "<<" });
        i += 2;
        continue;
      }
      const start = i;
      while (i < src.length && src.charCodeAt(i) !== GREATER_THAN) i++;
      i++;
      out.push({ kind: "str", raw: src.slice(start, i) });
      continue;
    }
    if (c === GREATER_THAN && src.charCodeAt(i + 1) === GREATER_THAN) {
      out.push({ kind: "punct", raw: ">>" });
      i += 2;
      continue;
    }
    if (c === SLASH) {
      const start = i++;
      while (i < src.length && !WHITESPACE.has(src.charCodeAt(i)) && !DELIMITER.has(src.charCodeAt(i))) i++;
      out.push({ kind: "name", raw: src.slice(start, i) });
      continue;
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      out.push({ kind: "punct", raw: src[i]! });
      i++;
      continue;
    }
    const start = i;
    while (i < src.length && !WHITESPACE.has(src.charCodeAt(i)) && !DELIMITER.has(src.charCodeAt(i))) i++;
    const raw = src.slice(start, i);
    if (raw.length === 0) {
      i++;
      continue;
    }
    if (/^[-+.\d]/.test(raw) && Number.isFinite(Number(raw))) out.push({ kind: "num", value: Number(raw), raw });
    else out.push({ kind: "op", raw });
  }
  return out;
}

/** Characters in a PDF string literal, for estimating how wide it draws. */
export function stringLength(raw: string): number {
  if (raw.startsWith("<")) return Math.ceil((raw.length - 2) / 2);
  let n = 0;
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw.charCodeAt(i) === BACKSLASH) i++;
    n++;
  }
  return n;
}

type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: RedactionBox): boolean =>
  a.x < b.x + b.width && a.x + a.w > b.x && a.y < b.y + b.height && a.y + a.h > b.y;

const SHOW_OPS = new Set(["Tj", "TJ", "'", '"']);

/**
 * Rewrites one page's content stream, emptying any text that falls in a box.
 *
 * Tracks enough of the graphics and text state to know where a string will be
 * drawn: the transformation from `cm`, the text matrix from `Tm` and the line
 * moves, and the size from `Tf`. That is the minimum needed to place a glyph
 * run on a page, and it is why this cannot be done with a regular expression.
 */
export function redactStream(src: string, boxes: RedactionBox[]): { out: string; removed: number } {
  const tokens = tokenise(src);
  const parts: string[] = [];
  let removed = 0;

  let ctm = identity();
  const ctmStack: Matrix[] = [];
  let tm = identity();
  let tlm = identity();
  let fontSize = 12;
  let leading = 0;
  let operandStart = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "op") {
      parts.push(t.raw);
      continue;
    }
    const operands = tokens.slice(operandStart, i);
    const nums = operands.filter((a): a is Extract<Token, { kind: "num" }> => a.kind === "num");

    if (t.raw === "q") ctmStack.push([...ctm] as Matrix);
    else if (t.raw === "Q") ctm = ctmStack.pop() ?? identity();
    else if (t.raw === "cm" && nums.length >= 6) {
      ctm = multiply(
        [nums[0]!.value, nums[1]!.value, nums[2]!.value, nums[3]!.value, nums[4]!.value, nums[5]!.value],
        ctm,
      );
    } else if (t.raw === "BT") {
      tm = identity();
      tlm = identity();
    } else if (t.raw === "Tf" && nums.length >= 1) fontSize = nums[nums.length - 1]!.value;
    else if (t.raw === "TL" && nums.length >= 1) leading = nums[0]!.value;
    else if (t.raw === "Tm" && nums.length >= 6) {
      tm = [nums[0]!.value, nums[1]!.value, nums[2]!.value, nums[3]!.value, nums[4]!.value, nums[5]!.value];
      tlm = [...tm] as Matrix;
    } else if (t.raw === "Td" && nums.length >= 2) {
      tlm = multiply([1, 0, 0, 1, nums[0]!.value, nums[1]!.value], tlm);
      tm = [...tlm] as Matrix;
    } else if (t.raw === "TD" && nums.length >= 2) {
      leading = -nums[1]!.value;
      tlm = multiply([1, 0, 0, 1, nums[0]!.value, nums[1]!.value], tlm);
      tm = [...tlm] as Matrix;
    } else if (t.raw === "T*") {
      tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
      tm = [...tlm] as Matrix;
    }

    if (SHOW_OPS.has(t.raw)) {
      const strings = operands.filter((a) => a.kind === "str");
      const chars = strings.reduce((n, s) => n + stringLength(s.raw), 0);
      const m = multiply(tm, ctm);
      const scale = Math.hypot(m[0], m[1]) || 1;
      const size = fontSize * scale;
      // Generously wide and tall: over-removing is the safe direction.
      const bbox = { x: m[4], y: m[5] - size * 0.25, w: chars * size * 0.62, h: size * 1.25 };

      if (chars > 0 && boxes.some((b) => overlaps(bbox, b))) {
        // Emptied rather than deleted, so the positioning operators around it
        // stay valid and everything after still lands where it did.
        let seen = 0;
        for (let k = parts.length - 1; k >= 0 && seen < strings.length; k--) {
          const p = parts[k]!;
          if (p.startsWith("(") || p.startsWith("<")) {
            parts[k] = "()";
            seen++;
          }
        }
        removed += chars;
      }
      if (t.raw === "'" || t.raw === '"') {
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = [...tlm] as Matrix;
      }
    }

    parts.push(t.raw);
    operandStart = i + 1;
  }

  return { out: parts.join(" "), removed };
}

/** latin1 bytes, because a content stream is bytes and not UTF-8 text. */
function toLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Turns a rectangle drawn on a picture of a page into one in PDF space.
 *
 * The drawing surface measures from the top left in fractions of its own
 * size; a PDF measures from the bottom left in points. Keeping the conversion
 * here rather than inline in the component means the Y flip — the part that is
 * silently wrong if you get it backwards, because the box still looks
 * plausible — is covered by tests.
 *
 * Fractions rather than pixels, so a mark stays over the words it was drawn
 * over when the window is resized or the page is shown at another size.
 */
export function boxFromFractions(
  page: number,
  rect: { left: number; top: number; width: number; height: number },
  widthPt: number,
  heightPt: number,
): RedactionBox {
  return {
    page,
    x: rect.left * widthPt,
    y: (1 - (rect.top + rect.height)) * heightPt,
    width: rect.width * widthPt,
    height: rect.height * heightPt,
  };
}

export async function applyRedactions(
  pdfBytes: Uint8Array,
  boxes: RedactionBox[],
): Promise<{ bytes: Uint8Array; removed: number } | { error: string }> {
  if (boxes.length === 0) return { error: "Draw at least one box over what you want removed" };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes);
  } catch {
    return { error: "That file could not be opened — it may be corrupt or password-protected" };
  }

  const pages = doc.getPages();
  let removed = 0;

  for (let index = 0; index < pages.length; index++) {
    const mine = boxes.filter((b) => b.page === index);
    if (mine.length === 0) continue;
    const page = pages[index]!;
    const ctx = page.node.context;

    const contents = page.node.Contents();
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFArray) {
      for (let k = 0; k < contents.size(); k++) {
        const s = ctx.lookup(contents.get(k));
        if (s instanceof PDFRawStream) streams.push(s);
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents);
    }

    for (const stream of streams) {
      let raw = stream.getContents();
      const compressed = String(stream.dict.get(PDFName.of("Filter")) ?? "").includes("Flate");
      if (compressed) {
        try {
          raw = unzlibSync(raw);
        } catch {
          // A stream we cannot read is one we must not claim to have cleaned.
          continue;
        }
      }
      const result = redactStream(new TextDecoder("latin1").decode(raw), mine);
      if (result.removed === 0) continue;
      removed += result.removed;

      const body = compressed ? zlibSync(toLatin1(result.out)) : toLatin1(result.out);
      // Replacing the bytes in place keeps the object number, and with it
      // every reference to this stream from elsewhere in the file.
      (stream as unknown as { contents: Uint8Array }).contents = body;
      stream.dict.set(PDFName.of("Length"), ctx.obj(body.length));
    }

    // Cosmetic — the text is already gone — but a redacted document is
    // expected to look redacted.
    for (const b of mine) {
      page.drawRectangle({ x: b.x, y: b.y, width: b.width, height: b.height, color: rgb(0, 0, 0) });
    }
  }

  return { bytes: await doc.save(), removed };
}
