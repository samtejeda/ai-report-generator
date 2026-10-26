import { describe, expect, it } from "vitest";
import { REPORT_STATUSES } from "@/lib/db/schema/reports";
import { canOfferGenerate, isTestModelText } from "./generate-control";
import { isEditable } from "./status";

describe("canOfferGenerate", () => {
  const base = { canWrite: true, status: "draft", type: "prose", version: 0 } as const;

  it("is offered on an empty prose section of a draft or error report, for a person who can write", () => {
    expect(canOfferGenerate(base)).toBe(true);
    expect(canOfferGenerate({ ...base, status: "error" })).toBe(true);
  });

  it("is never offered to a person who cannot write (an admin reads only)", () => {
    for (const status of REPORT_STATUSES) expect(canOfferGenerate({ ...base, canWrite: false, status })).toBe(false);
  });

  it("is not offered in generating, generated or finalized", () => {
    for (const status of ["generating", "generated", "finalized"] as const) expect(canOfferGenerate({ ...base, status })).toBe(false);
  });

  it("is not offered on a structured section or one that already has text", () => {
    expect(canOfferGenerate({ ...base, type: "structured" })).toBe(false);
    expect(canOfferGenerate({ ...base, version: 1 })).toBe(false);
    expect(canOfferGenerate({ ...base, version: 7 })).toBe(false);
  });

  it("whole table: true for exactly the one combination, never where the section is read-only", () => {
    let offered = 0;
    for (const canWrite of [true, false])
      for (const status of REPORT_STATUSES)
        for (const type of ["prose", "structured"] as const)
          for (const version of [0, 1, 2]) {
            const result = canOfferGenerate({ canWrite, status, type, version });
            if (result) {
              offered += 1;
              // Whatever is offered must also be a place the person can edit.
              expect(canWrite && isEditable(status)).toBe(true);
            }
          }
    // 2 statuses (draft, error) x prose x version 0 x canWrite.
    expect(offered).toBe(2);
  });
});

describe("isTestModelText", () => {
  it("is true only while the current version is the model's, not after a person edited it", () => {
    expect(isTestModelText("ai_generated")).toBe(true);
    expect(isTestModelText("human_edit")).toBe(false);
    expect(isTestModelText("ai_regenerated_section")).toBe(false);
    expect(isTestModelText(null)).toBe(false);
  });
});
