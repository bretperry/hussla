/*
  Word counts, speaking time and a word-level diff for pitches.
  In the app: the Pitches page's writer (count as you type) and its side-by-side compare.
  Used by: src/features/pitches/PitchesPage.tsx, src/features/pitches/PitchCompare.tsx.

  The diff is a longest-common-subsequence over words (pitches are a few dozen words, so the
  O(n·m) table is tiny). Whitespace is not a word: the diff compares words only, and each side is
  shown with single spaces, so re-wrapping a line never reads as a change.
*/

// Words are runs of non-space characters, so "don't" and "e-mail" are one word each.
export const splitWords = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

export const countWords = (text: string): number => splitWords(text).length;

// Seconds to say `words` at `wordsPerMinute`, rounded to the nearest second.
export const speakingSeconds = (words: number, wordsPerMinute: number): number =>
  wordsPerMinute <= 0 ? 0 : Math.round((words / wordsPerMinute) * 60);

// "45 s" under a minute, "1 min 05 s" from there.
export const formatSpeakingTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} min ${String(rest).padStart(2, "0")} s`;
};

export type DiffPart = { kind: "same" | "removed" | "added"; text: string };

// Merges neighbours of the same kind, so the page renders runs, not single words.
const pushPart = (parts: DiffPart[], kind: DiffPart["kind"], word: string): void => {
  const last = parts.at(-1);
  if (last !== undefined && last.kind === kind) last.text = `${last.text} ${word}`;
  else parts.push({ kind, text: word });
};

// The word-level diff from `before` to `after`: same, removed (only in before) and added (only in after) runs, in reading order.
export const diffWords = (before: string, after: string): DiffPart[] => {
  const left = splitWords(before);
  const right = splitWords(after);
  // longest[i][j] is the LCS length of left[i..] and right[j..].
  const longest: number[][] = Array.from({ length: left.length + 1 }, () => Array.from({ length: right.length + 1 }, () => 0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const row = longest[i] ?? [];
      row[j] = left[i] === right[j] ? (longest[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(longest[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const leftWord = left[i];
    const rightWord = right[j];
    if (leftWord !== undefined && leftWord === rightWord) {
      pushPart(parts, "same", leftWord);
      i += 1;
      j += 1;
    } else if (rightWord === undefined || (leftWord !== undefined && (longest[i + 1]?.[j] ?? 0) >= (longest[i]?.[j + 1] ?? 0))) {
      pushPart(parts, "removed", leftWord ?? "");
      i += 1;
    } else {
      pushPart(parts, "added", rightWord);
      j += 1;
    }
  }
  return parts;
};

// One side of the compare view: what `diffWords` says that side shows (before drops "added", after drops "removed").
export const sideOf = (parts: readonly DiffPart[], side: "before" | "after"): DiffPart[] =>
  parts.filter((part) => part.kind === "same" || part.kind === (side === "before" ? "removed" : "added"));
