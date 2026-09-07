import { describe, it, expect } from "vitest";
import { PDFDocument, PDFArray, StandardFonts } from "pdf-lib";
import { unzlibSync } from "fflate";
import { applyRedactions, redactStream, tokenise, stringLength, boxFromFractions } from "../src/redact";

/**
 * Redaction.
 *
 * The only test that matters here is the adversarial one: after redacting,
 * read the text back out of the file and check the secret is absent. A tool
 * that draws a black box passes a visual inspection and fails this, which is
 * exactly how real documents have leaked what they were hiding.
 */
/**
 * The text a reader, a copy-paste, or an extractor would get out of the file.
 *
 * Two things have to be undone to see it. The content streams are deflated,
 * and pdf-lib writes the glyphs as hex strings, so both a raw byte search and
 * a decompressed-but-undecoded one come back empty against a file that still
 * holds every character — which is the exact false pass this test exists to
 * avoid.
 */
async function extractedText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let source = "";
  for (const page of doc.getPages()) {
    const ctx = page.node.context;
    const contents = page.node.Contents();
    const list = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => ctx.lookup(contents.get(i)))
      : [contents];
    for (const stream of list as Array<{ getContents?: () => Uint8Array }>) {
      const raw = stream?.getContents?.();
      if (!raw) continue;
      let body = raw;
      try {
        body = unzlibSync(raw);
      } catch {
        /* stored uncompressed */
      }
      source += new TextDecoder("latin1").decode(body);
    }
  }
  return tokenise(source)
    .filter((t) => t.kind === "str")
    .map((t) => decodePdfString(t.raw))
    .join(" ");
}

/** Turns one PDF string literal back into the characters it draws. */
function decodePdfString(raw: string): string {
  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, "");
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  return raw.slice(1, -1).replace(/\\(.)/g, "$1");
}

describe("PDF redaction", () => {
  /** A page with two lines: one to remove, one that must survive. */
  async function twoLines(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("ACCOUNT 9876543210", { x: 40, y: 150, size: 14, font });
    page.drawText("Keep this line", { x: 40, y: 60, size: 14, font });
    return doc.save();
  }

  it("removes the characters, not just the view of them", async () => {
    const original = await twoLines();
    expect(await extractedText(original)).toContain("9876543210");

    const out = await applyRedactions(original, [{ page: 0, x: 30, y: 140, width: 250, height: 30 }]);
    if ("error" in out) throw new Error(out.error);
    expect(out.removed).toBeGreaterThan(0);

    // The point of the whole tool.
    expect(await extractedText(out.bytes)).not.toContain("9876543210");
    expect(await extractedText(out.bytes)).not.toContain("ACCOUNT");
  });

  it("leaves text outside the box alone", async () => {
    const out = await applyRedactions(await twoLines(), [{ page: 0, x: 30, y: 140, width: 250, height: 30 }]);
    if ("error" in out) throw new Error(out.error);
    expect(await extractedText(out.bytes)).toContain("Keep this line");
  });

  it("still produces a document that opens", async () => {
    const out = await applyRedactions(await twoLines(), [{ page: 0, x: 30, y: 140, width: 250, height: 30 }]);
    if ("error" in out) throw new Error(out.error);
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("refuses to pretend when given nothing to remove", async () => {
    const out = await applyRedactions(await twoLines(), []);
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("at least one box");
  });

  it("ignores a box aimed at a page that is not there", async () => {
    const out = await applyRedactions(await twoLines(), [{ page: 5, x: 0, y: 0, width: 99, height: 99 }]);
    if ("error" in out) throw new Error(out.error);
    expect(out.removed).toBe(0);
    expect(await extractedText(out.bytes)).toContain("9876543210");
  });

  it("tokenises strings, names, numbers and operators", () => {
    const toks = tokenise("BT /F1 12 Tf 40 150 Td (Hello \(there\)) Tj ET");
    expect(toks.filter((t) => t.kind === "str").map((t) => t.raw)).toEqual(["(Hello \(there\))"]);
    expect(toks.filter((t) => t.kind === "op").map((t) => t.raw)).toEqual(["BT", "Tf", "Td", "Tj", "ET"]);
    expect(toks.filter((t) => t.kind === "name").map((t) => t.raw)).toEqual(["/F1"]);
  });

  it("counts escaped characters as one, so widths are not overstated", () => {
    // "Hello (there)" is 13 characters even though the source is longer.
    expect(stringLength("(Hello \(there\))")).toBe(13);
    expect(stringLength("<48656C6C6F>")).toBe(5);
  });

  it("empties only the run that falls inside the box", () => {
    const src = "BT /F1 12 Tf 40 150 Td (SECRET) Tj 40 60 Td (public) Tj ET";
    const { out, removed } = redactStream(src, [{ page: 0, x: 30, y: 140, width: 200, height: 30 }]);
    expect(removed).toBe(6);
    expect(out).not.toContain("SECRET");
    expect(out).toContain("(public)");
  });
});


/**
 * The bridge between what somebody draws and what gets removed.
 *
 * The browser could not be driven end to end here, so the part that would
 * fail silently is tested directly: a box drawn over the account number has to
 * land on the account number and not, say, on the line below it. Getting the Y
 * flip backwards produces a box that still looks reasonable on screen and
 * redacts the wrong line, which is the worst possible failure for this tool.
 */
describe("redaction marks drawn on a page", () => {
  const W = 420;
  const H = 260;

  it("flips the origin from the top left to the bottom left", () => {
    // A band across the top fifth of the page.
    const box = boxFromFractions(0, { left: 0.1, top: 0, width: 0.8, height: 0.2 }, W, H);
    expect(box.x).toBeCloseTo(42);
    expect(box.width).toBeCloseTo(336);
    // Top of the page in PDF terms is the high y, and y is the bottom edge.
    expect(box.y).toBeCloseTo(208);
    expect(box.height).toBeCloseTo(52);
    expect(box.y + box.height).toBeCloseTo(H);
  });

  it("puts a band across the bottom at y = 0", () => {
    const box = boxFromFractions(0, { left: 0, top: 0.8, width: 1, height: 0.2 }, W, H);
    expect(box.y).toBeCloseTo(0);
  });

  it("removes the line it was drawn over, and not its neighbour", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // y = 170 and y = 145 — close enough together that a sloppy box catches both.
    page.drawText("Account number: 9876543210", { x: 40, y: 170, size: 13, font });
    page.drawText("Holder: Asha Ramanathan", { x: 40, y: 145, size: 13, font });
    const bytes = await doc.save();

    // Drawn from the top: the account line sits at (260 - 170 - 13) / 260 down.
    const top = (H - 170 - 13) / H;
    const box = boxFromFractions(0, { left: 0.05, top, width: 0.9, height: 20 / H }, W, H);

    const out = await applyRedactions(bytes, [box]);
    if ("error" in out) throw new Error(out.error);

    const text = await extractedText(out.bytes);
    expect(text).not.toContain("9876543210");
    expect(text).toContain("Asha Ramanathan");
  });
});
