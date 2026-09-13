// dsh-background dev tool: inspect the REAL composer inside an active session.
//
// Every earlier probe landed on the empty-session "hero" composer, whose editable
// is `[class*="composerSeat"] [contenteditable]`. An active session renders a
// different composer, which is the one users actually type into — so the glass
// selectors have to be checked there, not on the hero.
//
// Usage: node tools/probe-composer.mjs [--url http://127.0.0.1:3080] [--token <t>]
import { mkdirSync, writeFileSync } from "node:fs";
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

/**
 * The wallpaper is painted with background-size: cover, so the window ASPECT RATIO
 * decides which part of the image sits behind the composer. Probing at 16:10 while
 * the user runs 16:9 samples a different region and hides the very artefact under
 * investigation. DSH_PROBE_VIEWPORT=1600x900 reproduces theirs.
 */
function viewportFromEnv() {
	const raw = process.env.DSH_PROBE_VIEWPORT ?? "";
	const match = /^(\d+)x(\d+)$/.exec(raw.trim());
	if (match === null) return {};
	return { width: Number(match[1]), height: Number(match[2]) };
}

const browser = await openBrowser({ url, ...viewportFromEnv() });
try {
	await new Promise((r) => setTimeout(r, 5000));

	// 0. The empty-session hero state, for comparison with the active session: the
	//    fix has to cover whichever of the two actually paints the visible box.
	const hero = await browser.evaluate(`(() => {
		const paint = (el) => el === null ? null : {
			cls: typeof el.className === "string" ? el.className : "",
			background: getComputedStyle(el).backgroundColor,
			backdrop: getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
			radius: getComputedStyle(el).borderRadius,
		};
		return {
			card: paint(document.querySelector("[data-composer-card]")),
			input: paint(document.querySelector("[data-composer-input]")),
			phaseActive: document.querySelectorAll('[data-phase="active"]').length,
		};
	})()`);
	console.log("--- hero (empty session) ---");
	console.log(JSON.stringify(hero, null, 2));

	// 1. List the sidebar's clickable rows so a session can be opened.
	const candidates = await browser.evaluate(`(() => {
		const out = [];
		for (const el of document.querySelectorAll('[class*="sidebarCol"] *')) {
			const text = (el.textContent || "").trim();
			const rect = el.getBoundingClientRect();
			if (text.length < 2 || text.length > 40 || rect.width < 60 || rect.height < 16 || rect.height > 48) continue;
			out.push({
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className : "",
				text,
				rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
			});
			if (out.length > 25) break;
		}
		return out;
	})()`);
	console.log("--- sidebar row candidates ---");
	for (const c of candidates.slice(0, 25)) console.log(`  ${c.tag} .${c.cls.slice(0, 34)} [${c.rect}] ${c.text.slice(0, 30)}`);

	// 2. Open a REAL session row (a `sessionRow`, not the new-session button). The
	//    row's own text is matched so this never depends on list ordering.
	const opened = await browser.evaluate(`(() => {
		const wanted = "小鲸鱼";
		const rows = [...document.querySelectorAll('[class*="sessionRow"]')];
		const row = rows.find((el) => (el.textContent || "").includes(wanted)) ?? rows[rows.length - 1];
		if (row === undefined) return "no session row found";
		const rect = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: rect.left + 10, clientY: rect.top + rect.height / 2 }));
		return "clicked [" + [Math.round(rect.left), Math.round(rect.top)].join(",") + "] " + row.textContent.trim().slice(0, 30);
	})()`);
	console.log("clicked:", opened);
	await new Promise((r) => setTimeout(r, 6000));

	// 3. Inspect every editable / composer-ish node in the now-active session.
	const report = await browser.evaluate(`(() => {
		const describe = (el) => {
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return {
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className : "",
				contenteditable: el.getAttribute("contenteditable"),
				rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
				background: style.backgroundColor,
				backdrop: style.backdropFilter || style.webkitBackdropFilter,
				borderRadius: style.borderRadius,
			};
		};
		const editables = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].map(describe);
		const seats = [...document.querySelectorAll('[class*="composerSeat"]')].map(describe);
		// The visible input box is a CARD that wraps the editable. Glass on the inner
		// editable only blurs whatever the card paints behind it, so the card's own
		// background is what decides whether glass is visible at all.
		const cardChain = [...document.querySelectorAll('[data-composer-card], [data-composer-card] *, [class*="composerSeat"] > *')].slice(0, 14).map((el) => {
			const style = getComputedStyle(el);
			return {
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className : "",
				slot: el.getAttribute("data-slot") ?? null,
				marker: el.getAttribute("data-composer-card") ?? el.getAttribute("data-composer-input") ?? el.getAttribute("data-composer-seat"),
				background: style.backgroundColor,
				backgroundImage: style.backgroundImage.slice(0, 60),
				backdrop: style.backdropFilter || style.webkitBackdropFilter,
				borderRadius: style.borderRadius,
				boxShadow: style.boxShadow.slice(0, 90),
				border: style.border.slice(0, 60),
			};
		});
		// Would the shipped glass rules match anything right now?
		const glassOn = document.body.hasAttribute("data-dsh-glass");
		const ruleMatches = {
			composerSeat: document.querySelectorAll('[class*="composerSeat"]').length,
			seatEditable: document.querySelectorAll('[class*="composerSeat"] [contenteditable]').length,
			seatTextarea: document.querySelectorAll('[class*="composerSeat"] textarea').length,
			phaseActive: document.querySelectorAll('[data-phase="active"]').length,
			anyContenteditable: document.querySelectorAll("[contenteditable]").length,
			anyTextarea: document.querySelectorAll("textarea").length,
		};
		return { glassOn, ruleMatches, editables, seats, cardChain, composerSeatHTML: (document.querySelector('[class*="composerSeat"]') || {}).outerHTML?.slice(0, 600) ?? null };
	})()`);
	console.log("--- composer report ---");
	console.log(JSON.stringify({ ruleMatches: report.ruleMatches, cardChain: report.cardChain.slice(0, 3), editables: report.editables }, null, 2));

	// Confirm the plugin's own rules are actually live before judging pixels: a card
	// showing the app's opaque colour means glass is off or the bundle is stale, and
	// any "band" seen then is the stock composer, not this plugin's doing.
	const glassState = await browser.evaluate(`(() => {
		const seat = document.querySelector("[data-composer-seat], [class*='composerSeat']");
		const card = document.querySelector("[data-composer-card]");
		const style = (el) => el === null ? null : getComputedStyle(el);
		return {
			bodyAttrs: document.body.getAttributeNames().join(","),
			build: window.__dshBackgroundBuild ?? null,
			version: window.__dshBackgroundVersion ?? null,
			panelGlassChecked: (document.querySelector('[data-dsh-bg="glass"]') || {}).checked ?? null,
			glassStyleLength: (document.querySelector("style[data-dsh-background-glass]") || {}).textContent?.length ?? -1,
			seatBackground: seat === null ? null : style(seat).backgroundColor,
			seatBackgroundImage: seat === null ? null : style(seat).backgroundImage.slice(0, 80),
			cardBackground: card === null ? null : style(card).backgroundColor,
			cardBackgroundImage: card === null ? null : style(card).backgroundImage.slice(0, 80),
			cardBackdrop: card === null ? null : (style(card).backdropFilter || style(card).webkitBackdropFilter),
		};
	})()`);
	console.log("--- glass state ---");
	console.log(JSON.stringify(glassState, null, 2));

	// 4. Every descendant of the composer seat that paints something. The user sees a
	//    dark band across the input box; a translucent card lets whatever the seat
	//    paints behind it show through, so the culprit is in this list.
	const painters = await browser.evaluate(`(() => {
		const seat = document.querySelector('[data-composer-seat], [class*="composerSeat"]');
		if (seat === null) return { error: "no composer seat" };
		const out = [];
		for (const el of [seat, ...seat.querySelectorAll("*")]) {
			const style = getComputedStyle(el);
			const bg = style.backgroundColor;
			const alpha = /rgba?\\(([^)]+)\\)/.exec(bg);
			const alphaValue = alpha === null ? 1 : (alpha[1].split(",").length > 3 ? Number(alpha[1].split(",")[3]) : 1);
			const paints = style.backgroundImage !== "none" || alphaValue > 0.05 || style.boxShadow !== "none" || (style.backdropFilter || style.webkitBackdropFilter) !== "none";
			if (!paints) continue;
			const rect = el.getBoundingClientRect();
			out.push({
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className : "",
				marker: el.getAttribute("data-composer-card") ?? el.getAttribute("data-composer-input") ?? el.getAttribute("data-slot") ?? null,
				rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
				background: bg,
				backgroundImage: style.backgroundImage.slice(0, 120),
				boxShadow: style.boxShadow.slice(0, 80),
				backdrop: style.backdropFilter || style.webkitBackdropFilter,
				position: style.position,
				zIndex: style.zIndex,
			});
		}
		out.sort((a, b) => Number(a.rect.split(",")[1]) - Number(b.rect.split(",")[1]));
		return { seatRect: (() => { const r = seat.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(","); })(), painters: out };
	})()`);
	console.log("--- everything that paints inside the composer seat ---");
	console.log("seat rect:", painters.seatRect);	// 5. What sits BEHIND the translucent card. A dark band inside a glass input is
	//    almost always content showing through the backdrop, so scroll the message
	//    list to the bottom first — that is when the last message ends up under the
	//    sticky composer — then identify the stack directly.
	await browser.evaluate(`(() => {
		for (const el of document.querySelectorAll('[class*="scrollBody"], [class*="scroll"]')) {
			if (el.scrollHeight > el.clientHeight + 8) el.scrollTop = el.scrollHeight;
		}
	})()`);
	await new Promise((r) => setTimeout(r, 1500));

	const behind = await browser.evaluate(`(() => {
		const card = document.querySelector("[data-composer-card]");
		if (card === null) return { error: "no card" };
		const rect = card.getBoundingClientRect();
		const stackAt = (x, y) => document.elementsFromPoint(x, y).slice(0, 10).map((el) => {
			const style = getComputedStyle(el);
			return {
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className.slice(0, 46) : "",
				background: style.backgroundColor,
				backgroundImage: style.backgroundImage.slice(0, 70),
			};
		});
		return {
			cardRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
			cardBackground: getComputedStyle(card).backgroundColor,
			centre: stackAt(rect.left + rect.width / 2, rect.top + rect.height / 2),
			lower: stackAt(rect.left + rect.width / 2, rect.bottom - 14),
		};
	})()`);
	console.log("--- stack behind the card (topmost first) ---");
	console.log("card:", behind.cardRect, "bg:", behind.cardBackground);
	console.log("at centre:");
	for (const s of behind.centre ?? []) console.log(`  ${(s.tag + " ." + s.cls).padEnd(52)} bg=${s.background} bgImg=${s.backgroundImage}`);
	console.log("near the bottom edge:");
	for (const s of behind.lower ?? []) console.log(`  ${(s.tag + " ." + s.cls).padEnd(52)} bg=${s.background} bgImg=${s.backgroundImage}`);
	console.log(`screenshot: ${await browser.screenshot(join(shots, "composer-scrolled.png"))}`);

	// 6. Anything ANYWHERE on the page that overlaps the card and paints. The band
	//    may come from an element outside the composer seat, which is why scanning
	//    only the seat's descendants missed it.
	const overlapping = await browser.evaluate(`(() => {
		const card = document.querySelector("[data-composer-card]");
		if (card === null) return { error: "no card" };
		const c = card.getBoundingClientRect();
		const overlaps = (r) => r.width > 0 && r.height > 0 && r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom;
		const out = [];
		for (const el of document.querySelectorAll("body *")) {
			if (el === card || card.contains(el)) continue;
			const rect = el.getBoundingClientRect();
			if (!overlaps(rect)) continue;
			const style = getComputedStyle(el);
			const match = /rgba?\\(([^)]+)\\)/.exec(style.backgroundColor);
			const alpha = match === null ? 1 : (match[1].split(",").length > 3 ? Number(match[1].split(",")[3]) : 1);
			const hasGradient = style.backgroundImage !== "none";
			const hasShadow = style.boxShadow !== "none";
			const hasBackdrop = (style.backdropFilter || style.webkitBackdropFilter) !== "none";
			if (!hasGradient && alpha <= 0.05 && !hasShadow && !hasBackdrop) continue;
			out.push({
				tag: el.tagName,
				cls: typeof el.className === "string" ? el.className.slice(0, 40) : "",
				slot: el.getAttribute("data-slot") ?? null,
				rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(","),
				background: style.backgroundColor,
				backgroundImage: style.backgroundImage.slice(0, 150),
				boxShadow: style.boxShadow.slice(0, 70),
				backdrop: style.backdropFilter || style.webkitBackdropFilter,
				position: style.position,
				zIndex: style.zIndex,
			});
		}
		return { cardRect: [Math.round(c.left), Math.round(c.top), Math.round(c.width), Math.round(c.height)].join(","), out };
	})()`);
	console.log("--- every painter overlapping the card (from anywhere on the page) ---");
	console.log("card rect:", overlapping.cardRect);
	for (const o of overlapping.out ?? []) {
		console.log(`${o.rect.padEnd(20)} ${(o.tag + " ." + o.cls).slice(0, 42).padEnd(44)} slot=${o.slot}`);
		console.log(`    bg=${o.background} bgImg=${o.backgroundImage}`);
		if (o.boxShadow !== "none") console.log(`    shadow=${o.boxShadow}`);
		if (o.backdrop !== "none") console.log(`    backdrop=${o.backdrop}`);
	}

	// 7. A magnified crop of the input box. A screenshot of the whole window is too
	//    small to judge a band inside the composer, and pixel-level judgements about
	//    "there is a dark line" need the region on its own.
	const crop = await browser.evaluate(`(() => {
		const card = document.querySelector("[data-composer-card]");
		if (card === null) return null;
		const r = card.getBoundingClientRect();
		return { x: Math.max(0, Math.round(r.left) - 12), y: Math.max(0, Math.round(r.top) - 12), width: Math.round(r.width) + 24, height: Math.round(r.height) + 24 };
	})()`);
	if (crop !== null) {
		const shot = await browser.send("Page.captureScreenshot", { format: "png", clip: { ...crop, scale: 2 } });
		writeFileSync(join(shots, "composer-crop.png"), Buffer.from(shot.data, "base64"));
		console.log(`composer crop (2x): ${join(shots, "composer-crop.png")} clip=${JSON.stringify(crop)}`);

		// Row-by-row luminance of the crop, measured from the rendered pixels. A smooth
		// drift means the translucent card is sampling an uneven backdrop; a step or a
		// spike means something is PAINTED there. Guessing between the two wasted a lot
		// of time, so measure it.
		const profile = await browser.evaluate(`(async () => {
			const image = new Image();
			image.src = ${JSON.stringify(`data:image/png;base64,${shot.data}`)};
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			const inset = 32;
			const width = image.width - inset * 2;
			const height = image.height - inset * 2;
			const data = context.getImageData(inset, inset, width, height).data;
			const rows = [];
			for (let y = 0; y < height; y += 4) {
				let sum = 0;
				let count = 0;
				for (let x = 0; x < width; x += 2) {
					const at = (y * width + x) * 4;
					sum += 0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2];
					count += 1;
				}
				rows.push(sum / count);
			}
			return { rows, min: Math.min(...rows), max: Math.max(...rows) };
		})()`);
		console.log("--- card row luminance (each bar = 4px of the card, top to bottom) ---");
		const lo = profile.min;
		const hi = profile.max;
		const span = Math.max(1, hi - lo);
		profile.rows.forEach((value, index) => {
			const filled = Math.round(((value - lo) / span) * 40);
			console.log(`  y${String(index * 4).padStart(3)} ${String(Math.round(value)).padStart(3)} ${"#".repeat(filled)}${".".repeat(40 - filled)}`);
		});
		console.log(`  min=${lo.toFixed(1)} max=${hi.toFixed(1)} spread=${(hi - lo).toFixed(1)}`);
	}

	// 8. The sidebar on its own, for the same reason: it is the other surface the
	//    glass rules touch, and a whole-window screenshot is too small to judge it.
	const sidebar = await browser.evaluate(`(() => {
		const col = document.querySelector('[class*="sidebarCol"]');
		if (col === null) return null;
		const r = col.getBoundingClientRect();
		return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.min(Math.round(r.height), 620) };
	})()`);
	if (sidebar !== null) {
		const shot = await browser.send("Page.captureScreenshot", { format: "png", clip: { ...sidebar, scale: 2 } });
		writeFileSync(join(shots, "sidebar-crop.png"), Buffer.from(shot.data, "base64"));
		console.log(`sidebar crop (2x) : ${join(shots, "sidebar-crop.png")} clip=${JSON.stringify(sidebar)}`);
	}

	// 9. The plugin's own control panel. It is part of the interface, so it is expected
	//    to carry the same frosted finish as the chrome it configures.
	await browser.evaluate(`(() => {
		const toggle = document.querySelector('[data-dsh-bg="toggle"]');
		if (toggle !== null) toggle.click();
	})()`);
	await new Promise((r) => setTimeout(r, 400));
	const panelInfo = await browser.evaluate(`(() => {
		const panel = document.querySelector('[data-dsh-bg="panel"]');
		if (panel === null) return null;
		const style = getComputedStyle(panel);
		const rect = panel.getBoundingClientRect();
		return {
			x: Math.round(rect.left) - 8,
			y: Math.round(rect.top) - 8,
			width: Math.round(rect.width) + 16,
			height: Math.round(rect.height) + 16,
			background: style.backgroundColor,
			backdrop: style.backdropFilter || style.webkitBackdropFilter,
		};
	})()`);
	if (panelInfo !== null) {
		const shot = await browser.send("Page.captureScreenshot", { format: "png", clip: { x: panelInfo.x, y: panelInfo.y, width: panelInfo.width, height: panelInfo.height, scale: 2 } });
		writeFileSync(join(shots, "panel-crop.png"), Buffer.from(shot.data, "base64"));
		console.log(`panel crop (2x)   : ${join(shots, "panel-crop.png")}`);
		console.log(`panel background  : ${panelInfo.background} | backdrop: ${panelInfo.backdrop}`);
	}

	for (const p of painters.painters ?? []) {
		console.log(`${p.rect.padEnd(20)} ${(p.tag + " ." + p.cls).slice(0, 40).padEnd(42)} marker=${p.marker}`);
		console.log(`    bg=${p.background} bgImg=${p.backgroundImage}`);
		if (p.boxShadow !== "none") console.log(`    shadow=${p.boxShadow}`);
		if (p.backdrop !== "none") console.log(`    backdrop=${p.backdrop}`);
	}
	console.log(`screenshot: ${await browser.screenshot(join(shots, "composer-active.png"))}`);
} finally {
	await browser.close();
}
