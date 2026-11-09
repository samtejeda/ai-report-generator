import { describe, expect, it } from "vitest";
import { loadActivePrompt, loadPromptById } from "./prompt-loader";

// A database that fails the test if anything touches it: bad ids must be refused before any read.
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;

const ORG = { organizationId: "11111111-1111-4111-8111-111111111111" };
const UUID = "22222222-2222-4222-8222-222222222222";

describe("the loaders refuse a malformed id without reading anything", () => {
  const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ name: "PipelineError", code: "methodology_unavailable" });

  it("loadActivePrompt", async () => {
    await refused(loadActivePrompt(ORG, "not-a-uuid", untouchable));
    await refused(loadActivePrompt(ORG, "", untouchable));
  });

  it("loadPromptById: either id", async () => {
    await refused(loadPromptById(ORG, "not-a-uuid", UUID, untouchable));
    await refused(loadPromptById(ORG, UUID, "not-a-uuid", untouchable));
    await refused(loadPromptById(ORG, UUID, "' or 1=1 --", untouchable));
    await refused(loadPromptById(ORG, UUID, "", untouchable));
  });
});
