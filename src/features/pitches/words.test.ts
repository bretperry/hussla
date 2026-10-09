/*
  Tests for the pitch word tools: counting, speaking time, and the word diff's laws.
*/
import { array, assert, constantFrom, property } from "fast-check";
import { describe, expect, it } from "vitest";
import { countWords, diffWords, formatSpeakingTime, sideOf, speakingSeconds, splitWords } from "./words";

const join = (parts: readonly { text: string }[]): string => parts.map((part) => part.text).join(" ");

describe("countWords and speaking time", () => {
  it("counts runs of non-space characters", () => {
    expect(countWords("  I don't  ship\nslides. ")).toBe(4);
    expect(countWords("")).toBe(0);
  });
  it("turns words into seconds at the given pace", () => {
    expect(speakingSeconds(150, 150)).toBe(60);
    expect(speakingSeconds(75, 150)).toBe(30);
    expect(formatSpeakingTime(45)).toBe("45 s");
    expect(formatSpeakingTime(65)).toBe("1 min 05 s");
  });
});

describe("diffWords", () => {
  it("marks what was cut and what was added, in order", () => {
    expect(diffWords("I build calm tools for busy people.", "I build calm, fast tools for people.")).toEqual([
      { kind: "same", text: "I build" },
      { kind: "removed", text: "calm" },
      { kind: "added", text: "calm, fast" },
      { kind: "same", text: "tools for" },
      { kind: "removed", text: "busy" },
      { kind: "same", text: "people." },
    ]);
  });

  it("reads re-wrapped text as unchanged", () => {
    expect(diffWords("one two\nthree", "one  two three")).toEqual([{ kind: "same", text: "one two three" }]);
  });

  const words = array(constantFrom("we", "ship", "calm", "tools", "fast", "for", "people", "now"), { maxLength: 30 }).map((list) => list.join(" "));

  it("each side rebuilds its own text exactly (property)", () => {
    assert(
      property(words, words, (before, after) => {
        const parts = diffWords(before, after);
        expect(join(sideOf(parts, "before"))).toBe(splitWords(before).join(" "));
        expect(join(sideOf(parts, "after"))).toBe(splitWords(after).join(" "));
      }),
    );
  });

  it("keeps a longest common run of words as unchanged (property)", () => {
    assert(
      property(words, (text) => {
        expect(diffWords(text, text).every((part) => part.kind === "same")).toBe(true);
      }),
    );
  });
});
