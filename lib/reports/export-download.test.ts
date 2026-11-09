import { describe, expect, it } from "vitest";
import {
  canOfferExport,
  checkBeforeDownload,
  DOWNLOAD_ANYWAY_BUTTON,
  DOWNLOAD_LIMIT_HINT,
  DOWNLOAD_UNSAVED_NEXT,
  downloadUnsavedIntro,
  draftNote,
  exportUrl,
  GO_BACK_BUTTON,
} from "./export-download";

const entry = (key: string, position: number, title = `Section ${key}`) => ({ key, title, position });

describe("canOfferExport", () => {
  it("owner and associate see the button; an admin never does, with or without a grant", () => {
    expect(canOfferExport("owner")).toBe(true);
    expect(canOfferExport("associate")).toBe(true);
    expect(canOfferExport("admin")).toBe(false);
  });
  it("anything unknown is hidden", () => {
    for (const r of ["", "Owner", "superuser", "owner "]) expect(canOfferExport(r)).toBe(false);
  });
});

describe("exportUrl", () => {
  it("is the export route with the one format, nothing else", () => {
    const id = "0d3c7f0e-6d0a-4a58-9d5b-0a1b2c3d4e5f";
    expect(exportUrl(id)).toBe(`/api/reports/${id}/export?format=docx`);
  });
  it("cannot be bent by an odd id (it is encoded)", () => {
    expect(exportUrl("a/b?x=1")).toBe("/api/reports/a%2Fb%3Fx%3D1/export?format=docx");
  });
});

describe("draftNote", () => {
  it("says the file is marked DRAFT for every status but finalized", () => {
    for (const s of ["draft", "generating", "generated", "error"]) expect(draftNote(s)).toMatch(/DRAFT, not finalized/);
    expect(draftNote("finalized")).toBeNull();
  });
});

describe("checkBeforeDownload", () => {
  it("nothing unsaved: the link goes straight ahead", () => {
    expect(checkBeforeDownload([])).toEqual({ action: "download" });
  });
  it("anything unsaved: warn, titles in page order, the first box to go back to", () => {
    expect(checkBeforeDownload([entry("c", 3, "Summary"), entry("a", 1, "Reason for Referral")])).toEqual({
      action: "warn",
      titles: ["Reason for Referral", "Summary"],
      firstKey: "a",
    });
  });
  it("one unsaved section is enough, and two with the same title are both listed", () => {
    expect(checkBeforeDownload([entry("x", 4)]).action).toBe("warn");
    const r = checkBeforeDownload([entry("a", 1, "Notes"), entry("b", 2, "Notes")]);
    expect(r.action === "warn" && r.titles).toEqual(["Notes", "Notes"]);
  });
  it("a warning carries only titles and a key: no text, no draft", () => {
    const r = checkBeforeDownload([{ ...entry("a", 1), text: "secret draft words" } as never]);
    expect(Object.keys(r).sort()).toEqual(["action", "firstKey", "titles"]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("does not change its input", () => {
    const input = [entry("b", 2), entry("a", 1)];
    const copy = structuredClone(input);
    checkBeforeDownload(input);
    expect(input).toEqual(copy);
  });
});

describe("wording", () => {
  it("says the unsaved text is NOT in the file, and never that it is", () => {
    expect(DOWNLOAD_UNSAVED_NEXT).toMatch(/will not be in the file/);
    for (const n of [1, 2]) expect(downloadUnsavedIntro(n)).toMatch(/only includes saved text/);
  });
  it("the intro agrees in number", () => {
    expect(downloadUnsavedIntro(1)).toMatch(/This section has/);
    expect(downloadUnsavedIntro(2)).toMatch(/These sections have/);
  });
  it("the two choices are named, and the safe one is Go back and save", () => {
    expect(GO_BACK_BUTTON).toBe("Go back and save");
    expect(DOWNLOAD_ANYWAY_BUTTON).toBe("Download anyway");
  });
  it("the limit hint names the real limit and promises no wait time", () => {
    expect(DOWNLOAD_LIMIT_HINT).toMatch(/20 downloads in 10 minutes/);
    expect(DOWNLOAD_LIMIT_HINT).not.toMatch(/about \d+ minute/);
  });
});
