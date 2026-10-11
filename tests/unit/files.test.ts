import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../apps/node/src/app.js";
import { extractText, readable } from "../../apps/node/src/extract.js";
import { viewMessage } from "../../apps/node/src/http/views.js";
import { testApp } from "./helpers.js";

let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) {
    await app.runner.idle();
    await app.browser.shutdown();
    app.db.close();
  }
  apps = [];
});

/** A zip archive with deflated entries, as Word writes them. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
    const body = deflateRawSync(raw);
    const fname = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(fname.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, fname, body);
    central.push(dir, fname);
    offset += 30 + fname.length + body.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

/** A one-page PDF saying `text`, with a correct cross-reference table. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("attached documents", () => {
  it("reads text, PDFs and Word documents, and nothing else", async () => {
    expect(readable("text/plain", "a.txt")).toBe(true);
    expect(readable("application/octet-stream", "notes.md")).toBe(true);
    expect(readable("application/pdf", "a.pdf")).toBe(true);
    expect(readable("application/octet-stream", "report.docx")).toBe(true);
    expect(readable("image/png", "a.png")).toBe(false);
    expect(readable("application/zip", "a.zip")).toBe(false);

    expect(await extractText(pdf("Quarterly packing plan"), "application/pdf", "plan.pdf")).toContain("Quarterly packing plan");

    const doc = zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Trip to Lisbon</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Fly out </w:t></w:r><w:r><w:t>Friday &amp; back Monday</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(await extractText(doc, "application/octet-stream", "trip.docx")).toBe("Trip to Lisbon\nFly out Friday & back Monday");
  });

  it("tells the model about attachments but shows them to the owner as files", async () => {
    const app = testApp();
    apps.push(app);
    const thread = app.threads.create({});
    const f = app.files.save({ threadId: thread.id, name: "plan, v2.pdf", mime: "application/pdf", data: pdf("Day one"), origin: "upload" });
    const stored = app.runner.send(thread.id, "Here is the plan", { fileIds: [f.id] });
    app.runner.stop(thread.id);

    const body = JSON.stringify(stored.body);
    expect(body).toContain(`id ${f.id}) — read it with read_file`);
    const view = viewMessage(stored);
    expect(view.role === "user" && view.text).toBe("Here is the plan");
    expect(view.role === "user" && view.fileIds).toEqual([f.id]);

    const read = await app.tools.get("read_file")!.run({ file_id: f.id } as never, { app, thread: app.threads.get(thread.id)!, agent: "general" });
    expect(read.text).toContain("Day one");
  });
});
