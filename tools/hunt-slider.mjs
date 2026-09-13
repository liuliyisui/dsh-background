// dsh-background dev tool: find every slider-like affordance in the live GUI.
//
// Answers "where did this slider come from" by enumeration instead of guessing:
// range inputs, ARIA sliders, resize splitters, and elements carrying a resize
// cursor, each with its geometry and its owning pane.
//
// Usage: node tools/hunt-slider.mjs [label]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./cdp.mjs";
import { authenticatedUrl } from "./web-token.mjs";

const { url } = await authenticatedUrl();
const label = process.argv[2] ?? "hunt";
const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });

const HUNT = `(() => {
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const chain = [];
    let node = el.parentElement;
    for (let i = 0; i < 4 && node !== null; i += 1) {
      chain.push(typeof node.className === "string" && node.className !== "" ? node.className.split(" ")[0] : node.tagName);
      node = node.parentElement;
    }
    return {
      tag: el.tagName,
      cls: typeof el.className === "string" ? el.className : "",
      bg: el.getAttribute("data-dsh-bg"),
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent?.slice(0, 30) ?? "",
      cursor: style.cursor,
      resize: style.resize,
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
      orientation: rect.height > rect.width * 1.5 ? "vertical" : rect.width > rect.height * 1.5 ? "horizontal" : "square",
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0",
      ancestors: chain.join(" < "),
    };
  };

  const out = { rangeInputs: [], ariaSliders: [], resizeHandles: [], resizeCursors: [], resizable: [], splitNames: [] };
  for (const el of document.querySelectorAll('body input[type="range"]')) out.rangeInputs.push(describe(el));
  for (const el of document.querySelectorAll('body [role="slider"]')) out.ariaSliders.push(describe(el));
  for (const el of document.querySelectorAll('body [class*="ResizeHandle" i], body [class*="resize-handle" i], body [class*="splitter" i]')) out.resizeHandles.push(describe(el));
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (["col-resize", "row-resize", "ns-resize", "ew-resize"].includes(style.cursor)) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) out.resizeCursors.push(describe(el));
    }
    if (style.resize !== "none") out.resizable.push(describe(el));
    if (out.resizeCursors.length > 20 && out.resizable.length > 20) break;
  }
  for (const el of document.querySelectorAll('body [class*="plit" i]')) {
    if (out.splitNames.length < 12) out.splitNames.push(describe(el));
  }
  out.version = window.__dshBackgroundVersion ?? null;
  out.panelMounted = document.querySelector('[data-dsh-bg="panel"]') !== null;
  out.viewport = window.innerWidth + "x" + window.innerHeight;
  return out;
})()`;

const browser = await openBrowser({ url });
try {
	await new Promise((r) => setTimeout(r, 5000));
	const report = await browser.evaluate(HUNT);
	console.log(JSON.stringify(report, null, 2));
	console.log(`screenshot: ${await browser.screenshot(join(shots, `${label}-full.png`))}`);
} finally {
	await browser.close();
}
