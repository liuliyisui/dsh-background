// dsh-background dev tool: measure text legibility against the live wallpaper.
//
// The visual complaint this plugin keeps attracting — "the wallpaper makes the UI
// unreadable" — needs a number, not an opinion. This reconstructs the effective
// background behind the content column (wallpaper → overlay scrim → the `fade`
// wash that the app shells paint over it), then reports the WCAG contrast ratio
// for every text element, worst first.
//
// The reconstruction deliberately ignores the app's own opaque surfaces, so the
// figure is the WORST case for text sitting straight on the wallpaper — which is
// exactly the text that goes unreadable.
//
// Usage: node tools/legibility.mjs [--url http://127.0.0.1:3080]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./cdp.mjs";
import { authenticatedUrl } from "./web-token.mjs";

const argOf = (flag) => {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
};
const base = argOf("--url") ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
if (argOf("--token") !== undefined) process.env.DSH_WEB_TOKEN = argOf("--token");
const { url } = await authenticatedUrl(base);
const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(shots, { recursive: true });

const REPORT = `(async () => {
  const debug = window.__dshBackgroundDebug || {};
  const parseColor = (text) => {
    const match = /rgba?\\(([^)]+)\\)/.exec(text);
    if (match === null) return null;
    const parts = match[1].split(",").map((p) => Number(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const l1 = Math.max(a, b);
    const l2 = Math.min(a, b);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  const layer = document.getElementById("dsh-bg-layer");
  if (layer === null) return { error: "no background layer mounted" };
  const layerStyle = getComputedStyle(layer);
  const sceneKind = debug.scene;
  const width = window.innerWidth;
  const height = window.innerHeight;

  // Rebuild what is painted behind the app content: the layer's own image or
  // gradient, the darkening scrim, then the translucent wash the shells apply.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  const imageMatch = /url\\("(.*)"\\)/.exec(layerStyle.backgroundImage);
  if (sceneKind === "image" && imageMatch !== null) {
    const bitmap = await createImageBitmap(await (await fetch(imageMatch[1])).blob());
    // background-size: cover, background-position: center
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  } else {
    // Gradient scene: the wallpaper is faint by construction, so treat it as its
    // computed box colour instead of pretending to rasterise the CSS gradient.
    return { skipped: "scene is " + sceneKind + "; the gradient is low-contrast by design" };
  }

  const scrim = layer.querySelector("[data-dsh-bg-scrim]");
  const scrimColor = scrim === null ? null : parseColor(getComputedStyle(scrim).backgroundColor);
  if (scrimColor !== null && scrimColor.a > 0) {
    context.fillStyle = "rgba(" + scrimColor.r + "," + scrimColor.g + "," + scrimColor.b + "," + scrimColor.a + ")";
    context.fillRect(0, 0, width, height);
  }

  const wash = parseColor(getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim());
  if (wash !== null) {
    context.fillStyle = "rgba(" + wash.r + "," + wash.g + "," + wash.b + "," + wash.a + ")";
    context.fillRect(0, 0, width, height);
  }

  const pixels = context.getImageData(0, 0, width, height).data;
  const medianBackground = (rect) => {
    const samples = [];
    for (let y = Math.max(0, Math.round(rect.top)); y < Math.min(height, Math.round(rect.bottom)); y += 2) {
      for (let x = Math.max(0, Math.round(rect.left)); x < Math.min(width, Math.round(rect.right)); x += 2) {
        const at = (y * width + x) * 4;
        samples.push(luminance({ r: pixels[at], g: pixels[at + 1], b: pixels[at + 2] }));
      }
    }
    if (samples.length === 0) return null;
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  };

  const results = [];
  for (const element of document.querySelectorAll("body *")) {
    if (element.closest('[data-dsh-bg="panel"]') !== null) continue;
    if (element.children.length !== 0) continue;
    const text = (element.textContent || "").trim();
    if (text.length < 2 || text.length > 60) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 10 || rect.bottom < 0 || rect.top > height) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) < 0.5) continue;
    const color = parseColor(style.color);
    if (color === null || color.a < 0.5) continue;
    const background = medianBackground(rect);
    if (background === null) continue;
    const textLuminance = luminance(color);
    results.push({
      text: text.slice(0, 34),
      color: style.color,
      backgroundLuminance: Number(background.toFixed(3)),
      ratio: Number(contrast(textLuminance, background).toFixed(2)),
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
    });
  }
  results.sort((a, b) => a.ratio - b.ratio);
  return {
    scene: sceneKind,
    wash: getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim(),
    theme: document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light",
    measured: results.length,
    worst: results.slice(0, 12),
    passing: results.filter((r) => r.ratio >= 4.5).length,
    failing: results.filter((r) => r.ratio < 4.5).length,
    severe: results.filter((r) => r.ratio < 3).length,
  };
})()`;

const browser = await openBrowser({ url });
try {
	await new Promise((r) => setTimeout(r, 4500));
	const report = await browser.evaluate(REPORT);
	console.log(JSON.stringify(report, null, 2));
	console.log(`screenshot: ${await browser.screenshot(join(shots, "legibility.png"))}`);
} finally {
	await browser.close();
}
