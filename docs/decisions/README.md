# Decisions

Choices we made that constrain future work, one short file each, numbered in order. Where
`docs/deferred.md` holds what we chose **not** to do yet, this folder holds what we **chose**.

**Write one when** a choice would surprise a new reader, or a future session would undo it
without knowing why: a layer rule, a library picked over another, a data shape, a carve-out,
or a reversal of an earlier decision.

**Don't write one for** anything the code or a rule already says plainly.

**Shape:** copy `_template.md` to `NNNN-<slug>.md` (next number, kebab-case slug). Keep it
under a screen. Never edit a decided file's Decision to say something else. Write a new
decision that supersedes it, and set the old one's status to `superseded by NNNN`.

**Find one:** `grep -ril <topic> docs/decisions/`. Plans cite the decisions a phase must respect.
