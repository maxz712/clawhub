import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/services/docs-render.js";

describe("renderMarkdown", () => {
  it("renders headings + paragraphs", () => {
    const html = renderMarkdown("# Hello\n\nparagraph\n");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>paragraph</p>");
  });

  it("renders lists", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toContain("<ul>");
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  // GFM constructs the old hand-rolled renderer broke (issue #5).
  it("renders GFM tables", () => {
    const md = "| Package | Stack |\n| --- | --- |\n| api | Hono |\n";
    const html = renderMarkdown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Package</th>");
    expect(html).toContain("<td>Hono</td>");
    expect(html).not.toContain("| Package | Stack |"); // not raw text
  });

  it("renders nested lists with hierarchy", () => {
    const html = renderMarkdown("- top\n  - nested\n  - nested2\n- top2");
    // a <ul> inside an <li> proves nesting survived
    expect(/<li>[\s\S]*<ul>[\s\S]*<li>nested<\/li>/.test(html)).toBe(true);
  });

  it("preserves relative links instead of nuking them to #", () => {
    const html = renderMarkdown("[docs](docs/dogfood.md)");
    expect(html).toContain('href="docs/dogfood.md"');
    expect(html).not.toContain('href="#"');
  });

  it("renders GFM task lists", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
  });

  it("strips <script> tags (XSS)", () => {
    const html = renderMarkdown("ok\n\n<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("ok");
  });

  it("drops dangerous link schemes", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click"); // link text survives, href stripped
  });

  it("adds rel=nofollow to links", () => {
    const html = renderMarkdown("[ext](https://example.com)");
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    expect(html).toContain('href="https://example.com"');
  });
});
