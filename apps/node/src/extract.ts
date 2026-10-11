import { inflateRawSync } from "node:zlib";

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-ndjson))/;
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|html?|xml|svg|ics|js|ts|tsx|jsx|py|go|rs|java|rb|sh|sql|toml|ini|css)$/i;
const PDF = (mime: string, name: string) => mime === "application/pdf" || /\.pdf$/i.test(name);
const DOCX = (mime: string, name: string) =>
  mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name);

/** Whether Vireo can read a file's text: plain text and code, PDFs and Word documents. */
export function readable(mime: string, name: string): boolean {
  return TEXT_MIME.test(mime) || TEXT_EXT.test(name) || PDF(mime, name) || DOCX(mime, name);
}

/** The text of a readable file, or undefined when it has none Vireo can get at. */
export async function extractText(data: Buffer, mime: string, name: string): Promise<string | undefined> {
  if (PDF(mime, name)) {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await pdfText(pdf, { mergePages: false });
    return text.map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`).join("\n\n");
  }
  if (DOCX(mime, name)) {
    const xml = unzipEntry(data, "word/document.xml");
    return xml === undefined ? undefined : docxText(xml.toString("utf8"));
  }
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(name)) return data.toString("utf8");
  return undefined;
}

/** Paragraphs of a Word document's body, with tabs and line breaks kept. */
function docxText(xml: string): string {
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      p
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, "\u0000$1\u0000")
        .split("\u0000")
        .filter((_, i) => i % 2 === 1)
        .join(""),
    )
    .map((p) => p.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One entry of a zip archive, found through its central directory. */
function unzipEntry(zip: Buffer, wanted: string): Buffer | undefined {
  // The end-of-central-directory record sits in the last 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return undefined;
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + size);
      return method === 0 ? body : method === 8 ? inflateRawSync(body) : undefined;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}
