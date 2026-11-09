// The red list of sections with changes that are not saved, with the sentence before it. Shared by
// the leave dialog (unsaved-guard.tsx) and the Finalize dialog, so they show the same thing. Titles
// only: a section's text never reaches here.
export function UnsavedList({ intro, titles }: { intro: string; titles: readonly string[] }) {
  return (
    <>
      <p>{intro}</p>
      <ul className="list-inside list-disc text-red-700">
        {titles.map((title, i) => (
          <li key={i}>{title}</li>
        ))}
      </ul>
    </>
  );
}
