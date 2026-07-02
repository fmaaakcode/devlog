import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "../src/md-render";

describe("renderMarkdown", () => {
  test("headings render with dl-h{n} class", () => {
    expect(renderMarkdown("# title")).toContain('<h1 class="dl-h1">title</h1>');
    expect(renderMarkdown("### sub")).toContain('<h3 class="dl-h3">sub</h3>');
  });

  test("inline formatting: bold, italic, code, link", () => {
    const out = renderMarkdown("normal **bold** _and_ `code` and [text](https://x.co)");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('<code class="dl-code-inline">code</code>');
    expect(out).toContain('<a href="https://x.co">text</a>');
  });

  test("fenced code block escapes content", () => {
    const out = renderMarkdown("```js\nconsole.log('<x>')\n```");
    expect(out).toContain('<pre class="dl-code" data-lang="js">');
    expect(out).toContain("&lt;x&gt;");
    expect(out).not.toContain("<x>");
  });

  test("GFM table renders thead/tbody", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const out = renderMarkdown(md);
    expect(out).toContain('<table class="dl-table">');
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>1</td>");
  });

  test("GFM checkbox unchecked → input + dl-task", () => {
    const out = renderMarkdown("- [ ] todo item");
    expect(out).toContain('class="dl-task" data-checked="false"');
    expect(out).toContain('<input type="checkbox" disabled>');
    expect(out).toContain("<span>todo item</span>");
  });

  test("GFM checkbox checked → input checked + data-checked=true", () => {
    const out = renderMarkdown("- [x] done item");
    expect(out).toContain('data-checked="true"');
    expect(out).toContain('<input type="checkbox" disabled checked>');
  });

  test("typed callout > [!warning] picks the kind", () => {
    const out = renderMarkdown("> [!warning] danger ahead");
    expect(out).toContain("dl-callout-warning");
    expect(out).toContain("danger ahead");
  });

  test("plain blockquote (no [!kind]) renders as default callout (regression)", () => {
    // Before the fix this caused an infinite loop because parseCallout rejected
    // the line and parseParagraph broke on it without consuming.
    const out = renderMarkdown("> just a quote line");
    expect(out).toContain("dl-callout");
    expect(out).toContain("just a quote line");
  });

  test("safety net: completes for input that no parser handles cleanly", () => {
    // Same input shape that broke v2-roadmap rendering live.
    const md = "# title\n\n> **note**\n\n## section\n";
    const out = renderMarkdown(md);
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).toContain("dl-callout");
  });

  test("sanitization: <script> tag is stripped", () => {
    const out = renderMarkdown("safe\n<script>alert(1)</script>\nmore");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert(1)");
  });

  test("sanitization: javascript: URL becomes #", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).toContain('href="#"');
    expect(out).not.toContain("javascript:");
  });

  test("sanitization: data: URL becomes #", () => {
    const out = renderMarkdown("[x](data:text/html,<x>)");
    expect(out).toContain('href="#"');
  });

  test("horizontal rule", () => {
    expect(renderMarkdown("---")).toContain('<hr class="dl-hr">');
  });

  test("ordered list renders as ol", () => {
    const out = renderMarkdown("1. first\n2. second");
    expect(out).toContain('<ol class="dl-list">');
    expect(out).toContain("<li>first</li>");
  });
});
