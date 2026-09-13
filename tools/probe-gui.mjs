// dsh-background V3 dev tool: probe the live GUI.
//
// Answers the questions that decide the V3 painting strategy:
//   - is the background layer (#dsh-bg-layer, z-index:-1) actually visible, or is
//     it covered by an opaque in-flow container?
//   - what real class names does the sidebar / composer carry (so the glass CSS
//     stops guessing at `inputBar`, which matched nothing in the v2 build)?
//   - which version marker is the loaded bundle reporting?
// Also writes screenshots so the look can be compared before/after.
//
// Usage: node tools/probe-gui.mjs [label]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./cdp.mjs";
import { authenticatedUrl } from "./web-token.mjs";

const { url: URL_ } = await authenticatedUrl();
const label = process.argv[2] ?? "probe";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(outDir, { recursive: true });

const PROBE = `(() => {
  const cs = (el) => (el === null ? null : getComputedStyle(el));
  const bg = (el) => {
    const s = cs(el);
    if (s === null) return null;
    return { color: s.backgroundColor, image: s.backgroundImage.slice(0, 100) };
  };
  const layer = document.getElementById("dsh-bg-layer");
  const rootEl = document.getElementById("root");

  // Every element stacked between the canvas and the element painted at a point:
  // an opaque background anywhere in this chain would hide the z-index:-1 layer.
  const covering = (x, y) => {
    const chain = [];
    let el = document.elementFromPoint(x, y);
    while (el !== null && el !== document.documentElement) {
      chain.push({
        tag: el.tagName,
        cls: typeof el.className === "string" ? el.className : "",
        bg: bg(el).color,
        pos: cs(el).position,
        z: cs(el).zIndex,
      });
      el = el.parentElement;
    }
    return chain;
  };

  const describe = (el) => ({
    tag: el.tagName,
    cls: typeof el.className === "string" ? el.className : "",
    bg: bg(el).color,
    pos: cs(el).position,
    bf: cs(el).backdropFilter || cs(el).webkitBackdropFilter,
    box: Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height),
  });

  const matches = (sub, limit = 6) => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (typeof el.className === "string" && el.className.includes(sub)) {
        out.push(describe(el));
        if (out.length >= limit) break;
      }
    }
    return out;
  };

  // The composer subtree: the real targets for the input glass.
  const seat = document.querySelector('[class*="composerSeat"]');
  const composer = seat === null ? null : {
    seat: describe(seat),
    descendants: [...seat.querySelectorAll("*")].slice(0, 22).map(describe),
    editable: [...seat.querySelectorAll('textarea,[contenteditable="true"],[contenteditable=""]')].map(describe),
  };

  return {
    versionMarker: window.__dshBackgroundVersion ?? null,
    debug: window.__dshBackgroundDebug ?? null,
    tokenProbe: (() => {
      // Decisive experiment: the opaque frame/root shells paint AFTER the
      // z-index:-1 layer, so the wallpaper is only visible if the token they
      // consume is made translucent. Prove causality by flipping it in place.
      //
      // The theme override arrives as an INLINE custom property on <body>, so this
      // experiment must put back exactly what it found: removing the property
      // deletes the override, and every later measurement (and the screenshots)
      // would then describe a state the app is never actually in. That mistake is
      // why an earlier run reported an opaque shell and a missing wallpaper.
      const frame = document.querySelector('[class*="frame"]');
      if (frame === null) return null;
      const read = () => getComputedStyle(frame).backgroundColor;
      const before = read();
      const bgBase = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
      const sidebarFill = getComputedStyle(document.body).getPropertyValue("--dsw-specific-sidebar-fill").trim();
      const savedInline = document.body.style.getPropertyValue("--dsw-alias-bg-base");
      const savedPriority = document.body.style.getPropertyPriority("--dsw-alias-bg-base");
      document.body.style.setProperty("--dsw-alias-bg-base", "transparent");
      const afterTransparent = read();
      document.body.style.setProperty("--dsw-alias-bg-base", "rgba(21,21,23,0.25)");
      const afterScrim = read();
      if (savedInline === "") document.body.style.removeProperty("--dsw-alias-bg-base");
      else document.body.style.setProperty("--dsw-alias-bg-base", savedInline, savedPriority);
      return {
        frameClass: frame.className,
        bgBase,
        sidebarFill,
        inlineOnBody: savedInline,
        before,
        afterTransparent,
        afterScrim,
        restored: read(),
      };
    })(),
    bodyAttrs: document.body.getAttributeNames().join(","),
    chain: [document.documentElement, document.body, rootEl]
      .filter((el) => el !== null)
      .map((el) => ({ tag: el.tagName, id: el.id, bg: bg(el), opacity: cs(el).opacity })),
    layer: layer === null ? null : {
      z: cs(layer).zIndex,
      opacity: cs(layer).opacity,
      filter: cs(layer).filter,
      bgImage: cs(layer).backgroundImage.slice(0, 130),
      hasVideo: layer.querySelector("video") !== null,
    },
    panelMounted: document.querySelector("[data-dsh-background-panel]") !== null,
    panelGeometry: (() => {
      // The panel is bottom-anchored; if its content overflowed without a scroll
      // container, the later sections would be unreachable.
      const toggle = document.querySelector('[data-dsh-bg="toggle"]');
      if (toggle === null) return null;
      toggle.click();
      const root = document.querySelector('[data-dsh-bg="panel"]');
      const rect = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      const sectionNames = [...root.querySelectorAll("summary")].map((s) => s.textContent);
      const lastSection = root.querySelector("details:last-of-type");
      const lastRect = lastSection === null ? null : lastSection.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
        bottomInset: Math.round(window.innerHeight - rect.bottom),
        display: style.display,
        overflowY: style.overflowY,
        clientHeight: root.clientHeight,
        scrollHeight: root.scrollHeight,
        scrollable: root.scrollHeight > root.clientHeight,
        sectionNames,
        lastSectionBottom: lastRect === null ? null : Math.round(lastRect.bottom),
        lastSectionReachable:
          lastRect === null ? null : lastRect.bottom <= rect.bottom + 1 || root.scrollHeight > root.clientHeight,
      };
    })(),
    styleTags: document.querySelectorAll("style[data-dsh-background-style], style[data-dsh-background-glass]").length,
    sidebarCol: matches("sidebarCol", 3),
    glassAudit: (() => {
      // Which shipped v2 glass selectors actually match anything right now.
      // A rule that matches nothing is dead CSS shipped as if it worked.
      const rules = {
        'phaseComposerSeat': '[data-dsh-glass] [data-phase="active"] [class*="composerSeat"]',
        'phaseInputBar': '[data-dsh-glass] [data-phase="active"] [class*="inputBar"]',
        'phaseComposerSeatAny': '[data-phase="active"]',
        'sidebarCol': '[data-dsh-glass] [class*="sidebarCol"]',
        'dialog': '[data-dsh-glass] [role="dialog"]',
        'sidebarFade': '[data-dsh-glass] [class*="sidebarCol"] [class*="fade"]',
        'sidebarBlurLayer': '[data-dsh-bg-sidebar-blur]',
      };
      const counts = {};
      for (const [name, sel] of Object.entries(rules)) counts[name] = document.querySelectorAll(sel).length;
      const col = document.querySelector('[class*="sidebarCol"]');
      const blurLayer = document.querySelector('[data-dsh-bg-sidebar-blur]');
      const rect = (el) => (el === null ? null : [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)].join(","));
      // The sidebar's bottom scroll fade is a transparent-to-fill gradient. Over an
      // opaque fill it is invisible; over a translucent one it paints a hard band.
      const fade = document.querySelector('[class*="sidebarCol"] [class*="fade"]');
      const fadeStyle = fade === null ? null : getComputedStyle(fade);
      return {
        counts,
        sidebarColBgImage: col === null ? null : getComputedStyle(col).backgroundImage.slice(0, 90),
        sidebarColRect: rect(col),
        blurLayerRect: rect(blurLayer),
        blurLayerBackdrop: blurLayer === null ? null : getComputedStyle(blurLayer).backdropFilter,
        sidebarFade: fadeStyle === null ? null : {
          cls: fade.className,
          rect: rect(fade),
          background: fadeStyle.background.slice(0, 100),
          backgroundImage: fadeStyle.backgroundImage.slice(0, 160),
          opacity: fadeStyle.opacity,
          zIndex: fadeStyle.zIndex,
          position: fadeStyle.position,
        },
      };
    })(),
    sidebarBlurLayer: matches("dsh-bg-sidebar-blur", 2),
    composer,
    coveringCanvas: covering(720, 300),
    coveringSidebar: covering(60, 400),
  };
})()`;

const browser = await openBrowser({ url: URL_ });
try {
	await new Promise((r) => setTimeout(r, 4500));
	console.log(JSON.stringify(await browser.evaluate(PROBE), null, 2));

	// Is the wallpaper actually loading, and is it light or dark? A dark image under a
	// dark `fade` wash is nearly invisible by design, which is easy to misread as "the
	// background layer is not painting".
	const wallpaper = await browser.evaluate(`(async () => {
		const source = (window.__dshBackgroundDebug || {}).media || "";
		if (source === "") return { skipped: "no media set" };
		try {
			const response = await fetch(source);
			const blob = await response.blob();
			const bitmap = await createImageBitmap(blob);
			const width = Math.min(bitmap.width, 160);
			const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			context.drawImage(bitmap, 0, 0, width, height);
			const data = context.getImageData(0, 0, width, height).data;
			let sum = 0;
			let min = 1;
			let max = 0;
			let count = 0;
			for (let i = 0; i < data.length; i += 4) {
				const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
				sum += l;
				count += 1;
				if (l < min) min = l;
				if (l > max) max = l;
			}
			return {
				status: response.status,
				bytes: blob.size,
				natural: bitmap.width + "x" + bitmap.height,
				meanLuminance: Number((sum / count).toFixed(3)),
				min: Number(min.toFixed(3)),
				max: Number(max.toFixed(3)),
			};
		} catch (error) {
			return { error: String((error && error.message) || error) };
		}
	})()`);
	console.log("wallpaper:", JSON.stringify(wallpaper));

	for (const scheme of ["dark", "light"]) {
		await browser.setColorScheme(scheme);
		console.log(`screenshot: ${await browser.screenshot(join(outDir, `${label}-${scheme}.png`))}`);
	}
} finally {
	await browser.close();
}
