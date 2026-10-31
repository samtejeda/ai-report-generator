import { describe, expect, it } from "vitest";
import { classifyLink, isPlainLeftClick } from "./link-guard";

const HERE = "https://app.example.test/reports/abc?x=1";

describe("classifyLink", () => {
  it.each(["/clients", "/clients/123?tab=reports", "https://app.example.test/account", "/reports/abc?x=2", "/reports/abc#other"])("%s is a page of this site in this tab", (href) => {
    expect(classifyLink(href, HERE)).toBe("in-site");
  });

  it("the page you are already on is still asked about: a plain link to it would reload it and lose the text", () => {
    expect(classifyLink("/reports/abc?x=1", HERE)).toBe("in-site");
  });

  it("a jump within the current page is ignored", () => {
    expect(classifyLink("#section-box-1", HERE)).toBe("ignore");
    expect(classifyLink("/reports/abc?x=1#section-box-1", HERE)).toBe("ignore");
    expect(classifyLink("https://app.example.test/reports/abc?x=1#top", HERE)).toBe("ignore");
  });

  it("another site is ignored (the browser's own box covers it)", () => {
    expect(classifyLink("https://elsewhere.example.test/", HERE)).toBe("ignore");
    expect(classifyLink("http://app.example.test/clients", HERE)).toBe("ignore"); // other scheme = other origin
    expect(classifyLink("//elsewhere.example.test/x", HERE)).toBe("ignore");
  });

  it("a new tab, a download and non-web schemes are ignored", () => {
    expect(classifyLink("/clients", HERE, { target: "_blank" })).toBe("ignore");
    expect(classifyLink("/clients", HERE, { target: "other-window" })).toBe("ignore");
    expect(classifyLink("/clients", HERE, { target: "_self" })).toBe("in-site");
    expect(classifyLink("/clients", HERE, { target: "" })).toBe("in-site");
    expect(classifyLink("/export.csv", HERE, { download: true })).toBe("ignore");
    expect(classifyLink("mailto:someone@example.test", HERE)).toBe("ignore");
    expect(classifyLink("tel:+15555550100", HERE)).toBe("ignore");
    expect(classifyLink("javascript:void(0)", HERE)).toBe("ignore");
  });

  it("nonsense is ignored, never thrown", () => {
    expect(classifyLink("http://", HERE)).toBe("ignore");
    expect(classifyLink("/clients", "not a url")).toBe("ignore");
  });
});

describe("isPlainLeftClick", () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  it("a plain left click counts", () => expect(isPlainLeftClick(base)).toBe(true));
  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }])("%j does not", (change) => {
    expect(isPlainLeftClick({ ...base, ...change })).toBe(false);
  });
});
