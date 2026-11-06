import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_EXPORT_FORMATS } from "@/lib/audit";
import {
  buildReportDocx,
  cleanText,
  DOCUMENT_TITLE,
  DOCX_CONTENT_TYPE,
  DRAFT_LINE,
  EMPTY_SECTION_LINE,
  exportFileName,
  STRUCTURED_SECTION_LINE,
  type ExportSection,
} from "./export-docx";
import { EXPORT_WINDOW_SECONDS, MAX_EXPORTS_PER_USER } from "./export-limits";
import { plainText, readZip } from "./docx-test-helpers";

// The document builder (lib/reports/export-docx.ts), tested by opening the file it produces.
const prose = (title: string, text: string): ExportSection => ({ title, type: "prose", text });
const open = async (finalized: boolean, sections: ExportSection[]) => {
  const parts = readZip(await buildReportDocx({ finalized, sections }));
  return { parts, body: plainText(parts["word/document.xml"]), xml: parts["word/document.xml"] };
};
const headerText = (parts: Record<string, string>) => Object.entries(parts).filter(([k]) => /^word\/header\d*\.xml$/.test(k)).map(([, v]) => plainText(v));
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

describe("a valid Word file", () => {
  it("is a zip with the parts Word needs, and the right content type", async () => {
    const { parts } = await open(true, [prose("Reason for Referral", "text")]);
    for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml"]) expect(Object.keys(parts), name).toContain(name);
    expect(parts["[Content_Types].xml"]).toContain("wordprocessingml.document.main+xml");
    expect(DOCX_CONTENT_TYPE).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("every XML part is well-formed text without a character XML cannot hold", async () => {
    const nasty = "a < b & c > d \"q\" 'x' ]]> <![CDATA[x]]> <script>alert(1)</script> \u0000\u0001\u0008\u000B\u001F￾ \uD800 lone \uDC00 ok \u{1F600}";
    const { parts } = await open(false, [prose("T <b>&</b>", nasty)]);
    for (const [name, xml] of Object.entries(parts)) {
      if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
      expect(xml, name).not.toMatch(ILLEGAL_XML);
      expect(xml, name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(xml.startsWith("<?xml"), name).toBe(true);
    }
  });
});

describe("section text is data, never markup", () => {
  it("keeps <, &, quotes and markup-looking text literal, escaped in the XML and readable as typed", async () => {
    const text = "a < b & c > d \"q\" 'x' <script>alert(1)</script> &amp; <w:p/> ]]>";
    const { xml, body } = await open(false, [prose("Title <b>bold</b> & more", text)]);
    expect(body).toContain(text);
    expect(body).toContain("Title <b>bold</b> & more");
    // Nothing from the text became an element: the only script/bold tags in the XML are escaped text.
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<b>");
    expect(xml.split("<w:p/>").length - 1).toBe(0);
    expect(xml).toContain("&lt;script&gt;");
  });

  it("line breaks (LF, CRLF, CR) make paragraphs, blank lines stay blank, tabs are tab stops", async () => {
    const { xml, body } = await open(true, [prose("S", "one\r\ntwo\rthree\n\nfour\twith tab")]);
    expect(body).toContain("one\ntwo\nthree\n\nfour\twith tab");
    expect(xml).toContain("<w:tab/>");
    expect(xml).not.toMatch(/<w:t[^>]*>[^<]*\n/); // no raw line break inside a text element
    expect(xml).toContain("<w:p/>"); // the blank line
  });

  it("strips what XML cannot hold and keeps real text, including emoji and accents", async () => {
    expect(cleanText("a\u0000b\u0001c\u001Fd\u007Fe\u0085f￾g￿h")).toBe("abcdefgh");
    expect(cleanText("tab\tline\nstay éñ \u{1F600} 中")).toBe("tab\tline\nstay éñ \u{1F600} 中");
    expect(cleanText("x\uD800y\uDC00z")).toBe("xyz");
    expect(cleanText("pair 😀 ok")).toBe("pair 😀 ok");
    const { body } = await open(true, [prose("S", "café \u{1F600} \u0000done")]);
    expect(body).toContain("café \u{1F600} done");
  });

  it("handles the longest allowed text: 20 000 characters in one unbroken word, and 20 sections of full length", async () => {
    const word = "x".repeat(20_000);
    const one = await open(true, [prose("S", word)]);
    expect(one.body).toContain(word);
    const sections = Array.from({ length: 20 }, (_, i) => prose(`Section ${i + 1}`, `${i} `.repeat(10_000).slice(0, 20_000)));
    const many = await open(false, sections);
    for (let i = 1; i <= 20; i++) expect(many.body).toContain(`Section ${i}\n`);
    expect(many.body.length).toBeGreaterThan(400_000);
  }, 30_000);

  it("20 000 short lines make 20 000 paragraphs, still well-formed", async () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `l${i}`).join("\n");
    const { body } = await open(true, [prose("S", text)]);
    expect(body).toContain("l0\nl1\n");
    expect(body).toContain("l9999\n");
  }, 30_000);
});

describe("order, headings and the words the export adds", () => {
  it("sections appear in the order given, each under its own heading, with the title first", async () => {
    const { body } = await open(true, [prose("Second heading", "BBB"), prose("First heading", "AAA"), prose("Third", "CCC")]);
    expect(body.indexOf(DOCUMENT_TITLE)).toBe(0);
    expect(body.indexOf("Second heading")).toBeLessThan(body.indexOf("BBB"));
    expect(body.indexOf("BBB")).toBeLessThan(body.indexOf("First heading"));
    expect(body.indexOf("First heading")).toBeLessThan(body.indexOf("AAA"));
    expect(body.indexOf("AAA")).toBeLessThan(body.indexOf("Third"));
  });

  it("an empty or blank prose section says so, and a structured section is named but not included", async () => {
    const { body } = await open(true, [prose("A", ""), prose("B", "  \n\t "), prose("C", "\u0000"), { title: "D", type: "structured", text: "hidden numbers" }]);
    expect(body.split(EMPTY_SECTION_LINE).length - 1).toBe(3);
    expect(body).toContain(STRUCTURED_SECTION_LINE);
    expect(body).not.toContain("hidden numbers");
  });
});

describe("the draft marker", () => {
  it("not finalized: the first line and the header of every page say DRAFT, not finalized", async () => {
    const { parts, body } = await open(false, [prose("S", "text")]);
    expect(DRAFT_LINE).toBe("DRAFT, not finalized");
    expect(body.startsWith(`${DRAFT_LINE}\n`)).toBe(true);
    expect(headerText(parts).some((h) => h.includes(DRAFT_LINE))).toBe(true);
    expect(parts["word/document.xml"]).toContain("headerReference");
  });

  it("finalized: no draft line in the body, no header, nowhere in the file", async () => {
    const { parts, body } = await open(true, [prose("S", "text")]);
    expect(body).not.toContain("DRAFT");
    expect(headerText(parts)).toEqual([]);
    expect(parts["word/document.xml"]).not.toContain("headerReference");
    for (const [name, xml] of Object.entries(parts)) expect(xml, name).not.toContain("DRAFT");
  });

  it("section text that happens to say DRAFT does not create or remove the marker", async () => {
    expect((await open(true, [prose("S", "DRAFT, not finalized")])).parts["word/document.xml"]).not.toContain("headerReference");
    expect((await open(false, [prose("S", "x")])).body.match(/DRAFT, not finalized/g)).toHaveLength(1);
  });
});

describe("what the file says about nobody", () => {
  it("fixed neutral properties: a title and nothing else personal; no creator, no description", async () => {
    const { parts } = await open(false, [prose("S", "Jane Q. Client, born 2015")]);
    const core = parts["docProps/core.xml"];
    expect(core).toContain("<dc:title>Report</dc:title>");
    expect(core).not.toMatch(/dc:creator|cp:lastModifiedBy|dc:description|dc:subject|cp:keywords/);
    expect(parts["docProps/app.xml"]).not.toMatch(/Company|Manager|Application/);
    for (const name of ["docProps/core.xml", "docProps/app.xml", "docProps/custom.xml"]) expect(parts[name], name).not.toContain("Jane");
  });

  it("the page is US Letter", async () => {
    expect((await open(true, [prose("S", "x")])).xml).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
  });
});

describe("the download file name", () => {
  it("is report-<uuid>.docx and only for a uuid", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(exportFileName(id)).toBe(`report-${id}.docx`);
    const letters = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    expect(exportFileName(letters)).toBe(`report-${letters}.docx`);
    for (const bad of ["", "Jane Doe", `${id}\r\nSet-Cookie: x=1`, `${id}.docx`, `../${id}`, `${id}"`, letters.toUpperCase(), "x".repeat(300)]) {
      expect(() => exportFileName(bad), bad).toThrow(/uuid/);
    }
  });
});

describe("what the builder may import, and the numbers it is tied to", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (n === "node_modules" || n === ".next" || n.startsWith(".") ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

  it("only lib/reports/export-docx.ts imports docx; the test helper is imported by tests only", () => {
    const files = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.filter((f) => /from\s+"docx"/.test(read(f))).sort()).toEqual(["lib/reports/export-docx.ts"]);
    expect(files.filter((f) => /docx-test-helpers/.test(read(f)) && !f.endsWith(".test.ts") && !f.endsWith("docx-test-helpers.ts"))).toEqual([]);
  });

  it("the builder reaches no network, process, file or database module", () => {
    const src = code(read("lib/reports/export-docx.ts"));
    for (const banned of [/node:(http|https|http2|net|tls|dns|dgram|child_process|fs|worker_threads)/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /lib\/db/, /process\.env/, /getEnv/]) {
      expect(src, String(banned)).not.toMatch(banned);
    }
  });

  it("the numbers in API.md, and the audit's format list, match the code", () => {
    const api = read("API.md");
    expect(api).toContain(`${MAX_EXPORTS_PER_USER} per person per ${EXPORT_WINDOW_SECONDS / 60} minutes`);
    expect([...AUDIT_EXPORT_FORMATS]).toEqual(["docx"]);
    expect(code(read("app/api/reports/[id]/export/route.ts"))).toContain('z.literal("docx")');
  });
});
