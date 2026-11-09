import { Document, Header, HeadingLevel, Packer, Paragraph, Tab, TextRun } from "docx";

/**
 * Builds the Word file for a report export. Pure: it takes the report's status and its sections'
 * current text and returns bytes. It reads no database, makes no network call and imports no
 * module that could (a test checks), and this is the only file in the app that imports `docx`.
 *
 * Section text is DATA, never markup. It is turned into text runs and tabs only, so `<`, `&`,
 * quotes and line breaks stay literal text; the library escapes them when it writes the XML. What
 * the XML format itself cannot hold (control characters, lone surrogates) is removed first, because
 * stored text is only length-checked on its way out and Word refuses a file with invalid XML.
 *
 * Nothing about a person goes in on its own: no client name, no author, no practice, no date of
 * birth. The title is a neutral word; the file's properties are fixed neutral strings.
 */

/** The words this module adds to the document itself. Layout words only, no clinical content. */
export const DRAFT_LINE = "DRAFT, not finalized";
export const DOCUMENT_TITLE = "Report";
export const EMPTY_SECTION_LINE = "[Not yet written]";
export const STRUCTURED_SECTION_LINE = "[Structured section, not included in this export]";

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type ExportSection = { title: string; type: "prose" | "structured"; text: string };
export type ExportInput = { finalized: boolean; sections: ExportSection[] };

// Characters XML 1.0 cannot carry (C0 controls except tab and line break, DEL and C1 controls,
// U+FFFE and U+FFFF) and surrogate halves that are not part of a pair.
const NOT_ALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(value: string): string {
  return value.replace(NOT_ALLOWED, "");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The download name: a neutral word and the report id, nothing from the report or the client. Throws unless given a uuid. */
export function exportFileName(reportId: string): string {
  if (!UUID.test(reportId)) throw new Error("export file names are built from a report uuid only");
  return `report-${reportId}.docx`;
}

/** One paragraph per line; a tab is a tab stop, never kept as raw whitespace. */
function paragraphsFor(text: string): Paragraph[] {
  return cleanText(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const children: (string | Tab)[] = [];
      line.split("\t").forEach((part, i) => {
        if (i > 0) children.push(new Tab());
        if (part) children.push(part);
      });
      return new Paragraph({ children: children.length ? [new TextRun({ children })] : [] });
    });
}

const line = (text: string, options: { bold?: boolean } = {}) => new Paragraph({ children: [new TextRun({ text, bold: options.bold })] });

export async function buildReportDocx(input: ExportInput): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  if (!input.finalized) children.push(line(DRAFT_LINE, { bold: true }));
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: DOCUMENT_TITLE })] }));

  for (const section of input.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: cleanText(section.title) })] }));
    if (section.type === "structured") children.push(line(STRUCTURED_SECTION_LINE));
    else if (cleanText(section.text).trim() === "") children.push(line(EMPTY_SECTION_LINE));
    else children.push(...paragraphsFor(section.text));
  }

  const doc = new Document({
    // Fixed, neutral properties: no client, no person, no content.
    title: DOCUMENT_TITLE,
    creator: "",
    lastModifiedBy: "",
    description: "",
    sections: [
      {
        // US Letter (twips): the practice is in the United States.
        properties: { page: { size: { width: 12240, height: 15840 } } },
        // While the report is not finalized every page says so, not just the first line.
        headers: input.finalized ? undefined : { default: new Header({ children: [line(DRAFT_LINE, { bold: true })] }) },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
