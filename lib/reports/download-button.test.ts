import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// There is no component-test tooling, so the rules that must not regress are read from the source:
// the download is a plain link (no fetch, no blob, nothing stored), it opens in a new tab so an
// error never replaces the report page, and the page offers it only through canOfferExport.
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

describe("the Word download button", () => {
  const button = read("components/reports/download-button.tsx");
  const dialog = read("components/reports/download-unsaved-dialog.tsx");

  it("is a plain link to the export route in a new tab, with no opener", () => {
    expect(button).toMatch(/<a\s[^>]*href=\{exportUrl\(reportId\)\}/);
    expect(button).toMatch(/target="_blank"/);
    expect(button).toMatch(/rel="noopener"/);
  });
  it("never fetches the file into JavaScript and stores nothing", () => {
    for (const [name, src] of [["button", button], ["dialog", dialog]] as const) {
      expect(src, name).not.toMatch(/\bfetch\(|\bblob\b|URL\.createObjectURL|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|indexedDB|console\./i);
    }
  });
  it("asks about unsaved text before the link goes, and holds a middle click for the same question", () => {
    expect(button).toMatch(/checkBeforeDownload\(unsavedStore\.getSnapshot\(\)\)/);
    expect(button).toMatch(/onAuxClick=\{onAuxClick\}/);
    expect(button).toMatch(/event\.preventDefault\(\)/);
  });
  it('"Download anyway" uses the same link, so there is one path to the file', () => {
    expect(button).toMatch(/linkRef\.current\?\.click\(\)/);
  });
  it("the dialog has Go back and save as the default (focus and Esc) and Download anyway as the second choice", () => {
    expect(dialog).toMatch(/goBackRef\.current\?\.focus\(\)/);
    expect(dialog).toMatch(/onCancel=\{\(event\) => \{\s*event\.preventDefault\(\);\s*goBack\(\);/);
    expect(dialog.indexOf("{GO_BACK_BUTTON}")).toBeGreaterThan(0);
    expect(dialog.indexOf("{GO_BACK_BUTTON}")).toBeLessThan(dialog.indexOf("{DOWNLOAD_ANYWAY_BUTTON}"));
  });
  it("the report page shows it only through canOfferExport (never to an admin)", () => {
    const page = read("app/(app)/reports/[id]/page.tsx");
    expect(page).toMatch(/canOfferExport\(session\.role\) \? <DownloadButton/);
  });
});
