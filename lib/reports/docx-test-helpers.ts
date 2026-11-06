import { inflateRawSync } from "node:zlib";

/**
 * Test-only: reads the parts of a .docx (a zip file) so tests can look at the XML the export
 * really wrote. Handles stored and deflated entries via the central directory; nothing else.
 * Not imported by app code (lib/reports/export-docx.test.ts checks that no app file does).
 */
export function readZip(bytes: Uint8Array): Record<string, string> {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const parts: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buf.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip method ${method}`);
    parts[name] = (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

/** The text of a WordprocessingML part as a person would read it: tags gone, the five XML entities decoded. */
export function plainText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:p\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
