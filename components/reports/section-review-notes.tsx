import { REVIEW_FLAGS } from "@/lib/reports/generate-call";
import { REVIEW_HEADING, REVIEW_PROMPT } from "@/lib/reports/generate-messages";

// The review prompts for a section: one fixed sentence per flag the pipeline attached to the
// current version. A flag only adds a prompt; it never blocks anything. The flags come with the
// report read, so this survives a reload, and it goes away when a person saves the section (a
// person's own save is a new version without flags: saving is the review). Names outside the closed
// list are ignored. The sentences are placeholders until the practice owner's wording arrives.
export function SectionReviewNotes({ flags }: { flags: readonly string[] }) {
  const shown = REVIEW_FLAGS.filter((f) => flags.includes(f));
  if (shown.length === 0) return null;
  return (
    <div role="note" className="flex flex-col gap-1 rounded-md border border-zinc-400 p-2">
      <p className="font-medium">{REVIEW_HEADING}</p>
      <ul className="list-inside list-disc">
        {shown.map((f) => (
          <li key={f}>{REVIEW_PROMPT[f]}</li>
        ))}
      </ul>
    </div>
  );
}
