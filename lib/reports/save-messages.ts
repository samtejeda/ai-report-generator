/**
 * Every sentence the save flow shows. Fixed text: nothing from the server's body is shown and the
 * person's own text is never repeated in a message. None of this is clinical wording.
 */

export const SAVE_INVALID = "This text cannot be saved. It may be too long or contain unsupported characters. Your text is still in the box.";
export const SAVE_FAILED = "This could not be saved. Your text is still in the box. Try again.";
export const SAVE_UNCHANGED = "This could not be saved just now, and nobody else has changed the section. Your text is still in the box. Try again.";
export const SAVE_CLOSED = "This report can no longer be changed (it was finalized, or a test generation is running). Your text is still in the box; copy it if you need it.";
export const SAVE_GONE = "This section is no longer part of the report. Your text is still in the box; copy it if you need it.";
export const SAVE_UNREADABLE = "Someone else saved this section, but their text could not be loaded. Your text is still in the box. Press Save to try again.";
export const HISTORY_UNAVAILABLE = "The history could not be loaded.";

export const CONFLICT_HEADING = "Someone saved this section after you opened it.";
export const CONFLICT_EXPLAIN = "Nothing has been overwritten. Choose what happens to your text.";
export const CONFLICT_AGAIN = "It changed again while you were deciding. This is the newest text now.";
export const CONFLICT_MINE_LABEL = "Your text (not saved)";
export const CONFLICT_THEIRS_LABEL = "The saved text";
export const KEEP_MINE_BUTTON = "Keep mine as the next version";
export const TAKE_THEIRS_BUTTON = "Take theirs and discard mine";
export const CANCEL_BUTTON = "Cancel";
export const TOOK_THEIRS_NOTE = "Showing the saved text. Your earlier text was discarded.";
export const CANCELLED_NOTE = "Not saved. Your text is still in the box; saving it will ask again.";
