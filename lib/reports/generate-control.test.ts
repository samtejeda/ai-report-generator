import { describe, expect, it } from "vitest";
import { REPORT_STATUSES } from "@/lib/db/schema/reports";
import { generateOffer, isModelText } from "./generate-control";
import { isEditable } from "./status";

describe("generateOffer", () => {
  const base = { canWrite: true, status: "draft", type: "prose", version: 0 } as const;

  it("an empty prose section on a draft, error or generated report is a first generation", () => {
    for (const status of ["draft", "error", "generated"] as const) expect(generateOffer({ ...base, status })).toBe("generate");
  });

  it("a section with text is regenerated on a generated report only", () => {
    expect(generateOffer({ ...base, status: "generated", version: 1 })).toBe("regenerate");
    expect(generateOffer({ ...base, status: "generated", version: 7 })).toBe("regenerate");
    for (const status of ["draft", "error", "generating", "finalized"] as const) expect(generateOffer({ ...base, status, version: 1 })).toBeNull();
  });

  it("is never offered to a person who cannot write (an admin reads only)", () => {
    for (const status of REPORT_STATUSES) for (const version of [0, 1]) expect(generateOffer({ ...base, canWrite: false, status, version })).toBeNull();
  });

  it("is not offered while generating or finalized, or on a structured section", () => {
    for (const status of ["generating", "finalized"] as const) for (const version of [0, 1]) expect(generateOffer({ ...base, status, version })).toBeNull();
    for (const status of REPORT_STATUSES) for (const version of [0, 1]) expect(generateOffer({ ...base, status, type: "structured", version })).toBeNull();
  });

  it("whole table: only where the section is editable, and only the documented combinations", () => {
    let generate = 0;
    let regenerate = 0;
    for (const canWrite of [true, false])
      for (const status of REPORT_STATUSES)
        for (const type of ["prose", "structured"] as const)
          for (const version of [0, 1, 2]) {
            const offer = generateOffer({ canWrite, status, type, version });
            if (offer === null) continue;
            expect(canWrite && type === "prose" && isEditable(status)).toBe(true);
            if (offer === "generate") generate += 1;
            else regenerate += 1;
          }
    // generate: 3 statuses x version 0. regenerate: generated x versions 1 and 2.
    expect(generate).toBe(3);
    expect(regenerate).toBe(2);
  });
});

describe("isModelText", () => {
  it("is true while the current version is the model's (generated or regenerated), not after a person edited it", () => {
    expect(isModelText("ai_generated")).toBe(true);
    expect(isModelText("ai_regenerated_section")).toBe(true);
    expect(isModelText("human_edit")).toBe(false);
    expect(isModelText(null)).toBe(false);
  });
});
