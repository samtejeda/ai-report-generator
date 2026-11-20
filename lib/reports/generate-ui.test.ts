import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// There is no component-test tooling, so the rules that must not regress are read from the source,
// like download-button.test.ts: the session notes never leave memory, they survive a switch to
// another browser tab, the page hides the controls from an admin, and the two confirmations are
// only ever sent from the person's own click on a dialog's second button.
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

const NOTES_FILES = [
  "components/reports/generation-context.tsx",
  "components/reports/generate-notes-box.tsx",
  "components/reports/generate-section-button.tsx",
  "components/reports/generate-choice-dialog.tsx",
  "components/reports/generate-dialog-body.tsx",
  "lib/reports/generate-call.ts",
  "lib/reports/generate-flow.ts",
];

const provider = read("components/reports/generation-context.tsx");
const box = read("components/reports/generate-notes-box.tsx");
const button = read("components/reports/generate-section-button.tsx");
const dialog = read("components/reports/generate-choice-dialog.tsx");
const page = read("app/(app)/reports/[id]/page.tsx");
const editor = read("components/reports/section-editor.tsx");
const finalize = read("components/reports/finalize-button.tsx");

/** The source of one function, from its signature to the closing brace at the same indent. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.search(/\n  \}\n/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe("the session notes never leave memory", () => {
  it("nothing here writes to storage, an address, a cookie or a log", () => {
    for (const file of NOTES_FILES) {
      const src = read(file);
      expect(src, file).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\.|pushState|replaceState|router\.(push|replace)|window\.location|location\.(href|assign|search|hash)|URLSearchParams|BroadcastChannel|postMessage|navigator\.sendBeacon/);
    }
  });
  it("the box is not in a form, has no name and no autofill, so nothing can submit or remember it", () => {
    expect(box).not.toMatch(/<form|\sname=/);
    expect(box).toMatch(/autoComplete="off"/);
  });
  it("the notes reach the request through the body builder only, and the call sends one JSON body", () => {
    expect(button.match(/gen\.notes/g)?.length).toBe(2); // one to build the body, one to check they are not blank
    expect(button).toMatch(/buildGenerateBody\(\{ realMode, notes: gen\.notes,/);
    expect(read("lib/reports/generate-call.ts")).toMatch(/body: JSON\.stringify\(body\)/);
  });
  it("the page never puts the notes anywhere: only a boolean about the mode crosses to the browser", () => {
    expect(page).toMatch(/const realMode = getEnv\(\)\.INFERENCE_MODE === "real";/);
    expect(page).not.toMatch(/inferenceEndpoint|inference_endpoint|model_config|OLLAMA/i);
  });
});

describe("hidden means Next's route-level hidden page, never the browser tab losing focus", () => {
  it("the provider lets go of the notes with useResetWhenHidden (a layout-effect cleanup run when <Activity> hides the page)", () => {
    expect(provider).toMatch(/useResetWhenHidden\(\(\) => setNotes\(""\)\)/);
    expect(read("lib/ui/reset-when-hidden.ts")).toMatch(/useLayoutEffect\(\(\) => \(\) => latest\.current\(\), \[\]\)/);
  });
  it("no listener or check for the tab's visibility or focus exists in the notes code, so switching tabs keeps them", () => {
    for (const file of NOTES_FILES) {
      expect(read(file), file).not.toMatch(/visibilitychange|visibilityState|document\.hidden|pagehide|pageshow|onBlur|onFocus|focusout|"blur"|'blur'|window\.onblur|addEventListener\(\s*["'](?:blur|focus)/);
    }
  });
  it("the notes are also let go of when nothing is left to generate, and by Clear notes", () => {
    expect(provider).toMatch(/if \(!anyOffer && notes !== ""\) setNotes\(""\)/);
    expect(box).toMatch(/onClick=\{clearNotes\}/);
  });
});

describe("who sees the controls", () => {
  it("the provider, and so the box and every run, exist only for a person who can write", () => {
    expect(page).toMatch(/\{canWrite \? \(\s*<GenerationProvider/);
    expect((page.match(/<GenerationProvider/g) ?? []).length).toBe(1);
    expect(page).toMatch(/generateOffer\(\{ canWrite,/);
  });
  it("the box shows only in real mode and only when something can be generated", () => {
    expect(page).toMatch(/\{realMode && anyOffer \? <GenerateNotesBox \/> : null\}/);
  });
  it("a section shows the button only while it is editable and an offer exists", () => {
    expect(editor).toMatch(/\{editable && offer \? <GenerateSectionButton/);
  });
});

describe("a confirmation is only ever the person's own click", () => {
  it("no component writes confirm or replaceEdited itself; the body builder does, from a run", () => {
    for (const file of ["components/reports/generate-section-button.tsx", "components/reports/generate-dialog-body.tsx", "components/reports/generate-choice-dialog.tsx"]) {
      expect(read(file), file).not.toMatch(/confirm:\s*true|replaceEdited:\s*true|confirm=|replaceEdited=/);
    }
  });
  it("withThinConfirmed and withReplaceConfirmed are called once each, inside the dialog's second-button handler", () => {
    expect(button.match(/withThinConfirmed\(/g)?.length).toBe(1);
    expect(button.match(/withReplaceConfirmed\(/g)?.length).toBe(1);
    const onOther = body(button, "function onOther()");
    expect(onOther).toMatch(/withThinConfirmed\(dialog\.run\)/);
    expect(onOther).toMatch(/withReplaceConfirmed\(dialog\.run\)/);
  });
  it("a plain press and the unsaved dialog's second button start a NEW run with no confirmation", () => {
    const onClick = body(button, "function onClick()");
    expect(onClick).toMatch(/execute\(newRun\(\)\)/);
    expect(onClick).not.toMatch(/Confirmed/);
    expect(body(button, "function onOther()")).toMatch(/dialog\.kind === "warn"\) void execute\(newRun\(\)\)/);
  });
  it("unsaved text is checked before anything is sent", () => {
    expect(body(button, "function onClick()")).toMatch(/checkBeforeGenerate\(unsavedStore\.getSnapshot\(\), sectionId\)/);
  });
});

describe("the dialog", () => {
  it("opens with the safe button focused, and Esc does what the safe button does", () => {
    expect(dialog).toMatch(/dialog\.showModal\(\);\s*safeRef\.current\?\.focus\(\)/);
    expect(dialog).toMatch(/onCancel=\{\(event\) => \{\s*event\.preventDefault\(\);\s*safe\(\);/);
  });
  it("the safe button comes first and the other choice is the second, outline button", () => {
    expect(dialog.indexOf("{safeLabel}")).toBeGreaterThan(0);
    expect(dialog.indexOf("{safeLabel}")).toBeLessThan(dialog.indexOf("{otherLabel}"));
    expect(dialog).toMatch(/variant="outline" onClick=\{onOther\}/);
  });
  it('"Add more notes" puts the cursor in the notes box and the unsaved choices in the first unsaved box, after the dialog closed', () => {
    expect(body(button, "function onSafe()")).toMatch(/document\.getElementById\(NOTES_BOX_ID\)\?\.focus\(\)/);
    expect(body(button, "function onSafe()")).toMatch(/focusSectionBox\(key\)/);
    expect(dialog).toMatch(/dialog\.close\(\);\s*if \(safeChosen\.current\) latestAfter\.current\?\.\(\)/);
  });
});

describe("while a run is in flight", () => {
  it("Save and Finalize are paused, and every Generate button is locked", () => {
    expect(editor).toMatch(/disabled=\{pending \|\| generationRunning\}/);
    expect(finalize).toMatch(/disabled=\{pending \|\| generationRunning\}/);
    expect(button).toMatch(/disabled=\{busy \|\| needsEmptyBox \|\| !notesOk\}/);
  });
  it("only one run at a time per page", () => {
    expect(provider).toMatch(/if \(runningRef\.current\) return false/);
    expect(body(button, "async function execute(run: Run)")).toMatch(/if \(!gen\.startRun\(\)\) return;/);
  });
  it("the working message is announced and has no progress bar", () => {
    expect(button).toMatch(/<p role="status">\{generateWorkingStatus\(realMode\)\}<\/p>/);
    expect(button).not.toMatch(/<progress|role="progressbar"/);
  });
  it("a success is announced and takes the cursor; a failure is an alert", () => {
    expect(button).toMatch(/resultRef\.current\?\.focus\(\)/);
    expect(button).toMatch(/\{message \? <p role="alert">\{message\}<\/p> : null\}/);
  });
});
