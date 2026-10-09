/*
  Tests the one renderer for untrusted text: markup stays text, unsafe links go inert, safe ones work.
  In the app: nothing at runtime; guards the Security model's "Untrusted text is never markup".
  Used by: pnpm test.
*/
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, MarkdownInline } from "./Markdown";

describe("Markdown renderer", () => {
  it("shows a <script> tag as text and never creates the element", () => {
    const { container } = render(<Markdown source={"Hello <script>window.__pwned = true</script> world"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container).toHaveTextContent("<script>window.__pwned = true</script>");
    expect(Reflect.get(window, "__pwned")).toBeUndefined();
  });

  it("keeps onerror= as plain text, with no attribute on any element", () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container).toHaveTextContent('onerror="alert(1)"');
  });

  it("renders a javascript: link as its label, with no anchor", () => {
    const { container } = render(<Markdown source={"[click me](javascript:alert(1))"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("click me")).toBeInTheDocument();
  });

  it("drops data: and vbscript: links the same way", () => {
    const { container } = render(<MarkdownInline source={"[a](data:text/html,x) [b](VBScript:x) [c](  javascript:x)"} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps http, https, mailto and tel links, opening web links safely", () => {
    const { container } = render(<Markdown source={"[web](https://example.com) [mail](mailto:a@example.com) [call](tel:+15550100)"} />);
    const hrefs = [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com", "mailto:a@example.com", "tel:+15550100"]);
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders the markdown subset: bold, lists, tables", () => {
    const { container } = render(<Markdown source={"**strong**\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector("strong")).toHaveTextContent("strong");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table")).not.toBeNull();
  });
});
