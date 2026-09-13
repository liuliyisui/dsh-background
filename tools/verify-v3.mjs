// dsh-background v3 — end-to-end panel verification against a live DSH GUI.
//
// Drives the real panel through CDP and asserts the v3 behaviours that the v2
// build got wrong: the wallpaper layer actually becoming visible, batched
// settings writes, one-op reset, a working media library, and no localStorage.
//
// Usage: node tools/verify-v3.mjs [--url http://127.0.0.1:3099] [--token <token>]
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./cdp.mjs";
import { authenticatedUrl } from "./web-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, "shots");
mkdirSync(shots, { recursive: true });

const argOf = (flag) => {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
};
const base = argOf("--url") ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
if (argOf("--token") !== undefined) process.env.DSH_WEB_TOKEN = argOf("--token");
const { url } = await authenticatedUrl(base);

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n        ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal PNG encoder, so the uploaded wallpaper is unmistakably distinctive. */
function makePng(width, height) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const rowStart = y * (width * 4 + 1);
		raw[rowStart] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = rowStart + 1 + x * 4;
			raw[offset] = 40 + Math.round((x / width) * 180);
			raw[offset + 1] = 200 - Math.round((y / height) * 160);
			raw[offset + 2] = 120;
			raw[offset + 3] = 255;
		}
	}
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const uploadPath = join(shots, "v3-upload.png");
writeFileSync(uploadPath, makePng(240, 160));

const browser = await openBrowser({ url });
try {
	await sleep(4500);

	// 0. The bundle under test must be v3.
	const identity = await browser.evaluate(`({
		version: window.__dshBackgroundVersion ?? null,
		debug: window.__dshBackgroundDebug ?? null,
		panel: document.querySelector('[data-dsh-bg="panel"]') !== null,
	})`);
	check("client bundle reports v3", identity.version === "3.0.0", JSON.stringify(identity.version));
	check("settings namespace loaded", identity.debug?.loaded === true, JSON.stringify(identity.debug));

	// 1. The opaque app shell is pierced, so the layer behind it is visible.
	const surface = await browser.evaluate(`(() => {
		const frame = document.querySelector('[class*="frame"]');
		return {
			frameBg: frame === null ? null : getComputedStyle(frame).backgroundColor,
			layer: document.getElementById("dsh-bg-layer") !== null,
			scene: window.__dshBackgroundDebug.scene,
			tokenKey: window.__dshBackgroundDebug.tokenKey,
		};
	})()`);
	check("app shell is no longer opaque", surface.frameBg === "rgba(0, 0, 0, 0)" || /,\s*0?\.\d+\)$/.test(surface.frameBg), `frame=${surface.frameBg}`);
	// Either paint is a valid starting point; which one depends on whether the
	// settings under test already carry a wallpaper.
	check("background layer is mounted", surface.layer === true && (surface.scene === "gradient" || surface.scene === "image"), JSON.stringify(surface));

	// 2. Open the panel and audit its structure.
	await browser.evaluate(`document.querySelector('[data-dsh-bg="toggle"]').click()`);
	await sleep(400);
	const panel = await browser.evaluate(`(() => {
		const root = document.querySelector('[data-dsh-bg="panel"]');
		const sections = [...root.querySelectorAll("summary")].map((s) => s.textContent);
		// A label is associated either explicitly (for=) or implicitly (wrapping the
		// control). Both are valid; an unrelated label is what would be a defect.
		const labels = [...root.querySelectorAll("label")];
		const associated = labels.filter((l) =>
			l.htmlFor ? document.getElementById(l.htmlFor) !== null : l.querySelector("input,select,textarea") !== null
		).length;
		const noLocalStorage = !Object.keys(localStorage).some((k) => k.startsWith("dsh-background"));
		const status = root.querySelector('[role="status"]').textContent;
		return { open: getComputedStyle(root).display, sections, associated, labels: labels.length, noLocalStorage, status, title: root.querySelector("span").textContent };
	})()`);
	check("panel opens on the toggle", panel.open === "flex", panel.open);
	check("panel is sectioned and collapsible", panel.sections.length === 6, panel.sections.join(" | "));
	check("every label is associated with a control", panel.associated === panel.labels, `${panel.associated}/${panel.labels}`);
	// A start-up `loading` mirror must not be reported as a broken namespace.
	check("panel status is healthy, not a false alarm", panel.status.includes("就绪") && !panel.status.includes("不可用"), panel.status);
	check("panel title carries the version", panel.title.includes("3.0.0"), panel.title);
	check("no wallpaper data in localStorage", panel.noLocalStorage === true);

	// 3. The media library lists what is already on disk.
	const libraryBefore = await browser.evaluate(`[...document.querySelectorAll('[data-dsh-bg="panel"] button')].map((b) => b.textContent)`);
	check("media library rendered its controls", libraryBefore.includes("刷新媒体库"), libraryBefore.join(","));

	// 3b. The URL text box is gone; only file selection remains.
	const wall = await browser.evaluate(`(() => {
		const panel = document.querySelector('[data-dsh-bg="panel"]');
		const selects = [...panel.querySelectorAll("select")];
		return {
			hasMediaInput: panel.querySelector('[data-dsh-bg="media"]') !== null,
			textInputs: [...panel.querySelectorAll('input[type="text"]')].length,
			fileInputs: panel.querySelectorAll('input[type="file"]').length,
			currentMedia: panel.querySelector('[data-dsh-bg="currentMedia"]').textContent,
			clearMedia: panel.querySelector('[data-dsh-bg="clearMedia"]') !== null,
			selectSchemes: selects.map((s) => s.style.colorScheme),
			// The reported v2 bug: a non-highlighted option was light-on-light.
			optionColors: selects.flatMap((s) =>
				[...s.options].map((o) => ({
					text: o.textContent,
					color: getComputedStyle(o).color,
					background: getComputedStyle(o).backgroundColor,
				})),
			),
		};
	})()`);
	check("the wallpaper URL text box is gone", wall.hasMediaInput === false && wall.textInputs === 0, JSON.stringify(wall));
	check("file selection is the only way to set a wallpaper", wall.fileInputs === 1 && wall.clearMedia === true, JSON.stringify(wall));
	check("current wallpaper is reported read-only", typeof wall.currentMedia === "string" && wall.currentMedia.length > 0, wall.currentMedia);
	check("selects follow the colour scheme", wall.selectSchemes.every((s) => s === "dark" || s === "light"), wall.selectSchemes.join(","));
	check(
		"every option has a readable colour pair",
		wall.optionColors.length > 0 &&
			wall.optionColors.every((o) => o.color !== o.background && o.background !== "rgba(0, 0, 0, 0)" && o.color !== "rgba(0, 0, 0, 0)"),
		JSON.stringify(wall.optionColors),
	);

	// 4. Upload a real file through the real file input.
	const document_ = await browser.send("DOM.getDocument");
	const fileNode = await browser.send("DOM.querySelector", { nodeId: document_.root.nodeId, selector: '[data-dsh-bg="uploadFile"]' });
	await browser.send("DOM.setFileInputFiles", { nodeId: fileNode.nodeId, files: [uploadPath] });
	// Choosing a file IS the action now, so make sure the change event ran even if
	// the protocol call did not dispatch one.
	await browser.evaluate(`document.querySelector('[data-dsh-bg="uploadFile"]').dispatchEvent(new Event("change", { bubbles: true }))`);
	await sleep(1800);

	const afterUpload = await browser.evaluate(`({
		status: document.querySelector('[data-dsh-bg="panel"] [role="status"]').textContent,
		scene: window.__dshBackgroundDebug.scene,
		media: window.__dshBackgroundDebug.media,
		currentMedia: document.querySelector('[data-dsh-bg="currentMedia"]').textContent,
		bgImage: document.getElementById("dsh-bg-layer") === null ? null : document.getElementById("dsh-bg-layer").style.backgroundImage,
	})`);
	check("upload reports success", afterUpload.status.includes("已上传"), afterUpload.status);
	check("uploaded file becomes the wallpaper", afterUpload.scene === "image" && afterUpload.media.includes("/api/dsh-background/media/"), JSON.stringify(afterUpload));
	check("wallpaper URL is the uploaded media", String(afterUpload.bgImage).includes("/api/dsh-background/media/"), String(afterUpload.bgImage));
	check("the read-only line names the media file", afterUpload.currentMedia.endsWith(".png"), afterUpload.currentMedia);

	// The media route must serve the bytes back, so the wallpaper can actually paint.
	const served = await browser.evaluate(`(async () => {
		const url = window.__dshBackgroundDebug.media;
		const response = await fetch(url);
		return { status: response.status, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
	})()`);
	check("media route serves the uploaded image", served.status === 200 && served.bytes > 0, JSON.stringify(served));

	await browser.setColorScheme("dark");
	await browser.screenshot(join(shots, "v3-wallpaper-dark.png"));
	await browser.screenshot(join(shots, "v3-panel.png"));

	// 5. A slider drag must produce ONE batched write, not one write per event.
	const batched = await browser.evaluate(`(async () => {
		const before = window.__dshBackgroundDebug.writeBatches;
		const slider = document.querySelector('[data-dsh-bg="blur"]');
		for (let i = 0; i < 25; i += 1) {
			slider.value = String(i);
			slider.dispatchEvent(new Event("input", { bubbles: true }));
		}
		slider.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1200));
		return { before, after: window.__dshBackgroundDebug.writeBatches, failures: window.__dshBackgroundDebug.writeFailures, blur: document.querySelector('[data-dsh-bg="blur"]').value };
	})()`);
	check(
		"25 slider events collapse into a single write",
		batched.after - batched.before === 1 && batched.failures === 0,
		`batches ${batched.before} -> ${batched.after}, failures=${batched.failures}`,
	);
	check("blur value staged locally", Number(batched.blur) === 24, batched.blur);

	// 6. The independent glass blur must not follow the wallpaper blur.
	const glass = await browser.evaluate(`(async () => {
		const before = window.__dshBackgroundDebug.writeBatches;
		// Glass must be ON for its stylesheet to exist at all.
		const box = document.querySelector('[data-dsh-bg="glass"]');
		box.checked = true;
		box.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 900));
		const slider = document.querySelector('[data-dsh-bg="glassBlur"]');
		slider.value = "26";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
		slider.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1200));
		const css = document.querySelector("style[data-dsh-background-glass]").textContent;
		return { added: window.__dshBackgroundDebug.writeBatches - before, css };
	})()`);
	check("glass blur is written on its own", glass.added === 2, `batches added=${glass.added}`);
	check("glass CSS uses the independent radius", glass.css.includes("blur(26px)"), glass.css.match(/blur\(\d+px\)/g)?.join(","));

	// 6a. Glass must land on the VISIBLE input box. That box is [data-composer-card],
	//     which paints an opaque theme colour; backdrop-filter on the inner editable
	//     only blurred the card's own colour, so the effect was invisible.
	const glassTargets = await browser.evaluate(`(() => {
		const card = document.querySelector("[data-composer-card]");
		const input = document.querySelector("[data-composer-input]");
		const read = (el) => el === null ? null : {
			background: getComputedStyle(el).backgroundColor,
			backdrop: getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
			radius: getComputedStyle(el).borderRadius,
		};
		return { cardPresent: card !== null, card: read(card), input: read(input) };
	})()`);
	const cardBlur = Number((/blur\((\d+(?:\.\d+)?)px\)/.exec(glassTargets.card?.backdrop ?? "") ?? [])[1] ?? 0);
	check(
		"the composer card is the glass surface, with a blur floor",
		glassTargets.cardPresent && cardBlur >= 16,
		`backdrop=${glassTargets.card?.backdrop} blur=${cardBlur}`,
	);
	// The card must stay genuinely translucent — a heavy tint removed the blotch but
	// left a solid slab, which is not glass at all. The blotch is handled by the blur
	// floor above, not by opacity.
	const cardAlpha = Number((/rgba\([^)]*,\s*([\d.]+)\)/.exec(glassTargets.card?.background ?? "") ?? [])[1] ?? 1);
	check(
		"the composer card stays translucent, not a slab",
		cardAlpha > 0.3 && cardAlpha < 0.85,
		`background=${glassTargets.card?.background} alpha=${cardAlpha}`,
	);

	// 6a2. ONE knob drives both glass surfaces: the sidebar must be tinted by the same
	//      opacity the card uses, so "make the glass stronger" stays a single decision.
	const glassKnob = await browser.evaluate(`(async () => {
		const slider = document.querySelector('[data-dsh-bg="glassOpacity"]');
		if (slider === null) return { missing: true };
		const readStyles = () => {
			const card = document.querySelector("[data-composer-card]");
			const col = document.querySelector('[class*="sidebarCol"]');
			return {
				card: card === null ? null : getComputedStyle(card).backgroundColor,
				sidebar: col === null ? null : getComputedStyle(col).backgroundColor,
			};
		};
		const before = readStyles();
		slider.value = "0.8";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
		slider.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1300));
		return { before, after: readStyles() };
	})()`);
	const alphaOf = (value) => Number((/rgba\([^)]*,\s*([\d.]+)\)/.exec(value ?? "") ?? [])[1] ?? -1);
	check("the glass opacity slider exists", glassKnob.missing !== true, JSON.stringify(glassKnob.before ?? glassKnob));
	check(
		"one opacity knob drives card and sidebar together",
		Math.abs(alphaOf(glassKnob.after?.card) - 0.8) < 0.01 && Math.abs(alphaOf(glassKnob.after?.sidebar) - 0.8) < 0.01,
		`card=${glassKnob.after?.card} sidebar=${glassKnob.after?.sidebar}`,
	);

	// 6a3. The plugin's OWN panel must be frosted too: it is part of the interface, so
	//      it follows the glass setting it controls instead of sitting on the wallpaper
	//      as an opaque slab.
	const panelGlass = await browser.evaluate(`(() => {
		const panel = document.querySelector('[data-dsh-bg="panel"]');
		if (panel === null) return { missing: true };
		const style = getComputedStyle(panel);
		return {
			backdrop: style.backdropFilter || style.webkitBackdropFilter,
			background: style.backgroundColor,
			backgroundImage: style.backgroundImage,
		};
	})()`);
	check(
		"the control panel itself is frosted",
		panelGlass.missing !== true && /blur\(/.test(panelGlass.backdrop ?? ""),
		JSON.stringify(panelGlass),
	);
	// color-mix resolves to `color(srgb r g b / a)`, not `rgba(...)`, so read the alpha
	// from either serialisation.
	const panelAlpha = Number(
		(/\/\s*([\d.]+)\s*\)/.exec(panelGlass.background ?? "") ?? /rgba\([^)]*,\s*([\d.]+)\)/.exec(panelGlass.background ?? "") ?? [])[1] ?? 1,
	);
	check(
		"the control panel tint stays readable, not clear",
		panelAlpha >= 0.6,
		`background=${panelGlass.background} alpha=${panelAlpha}`,
	);
	check(
		"the editable paints no second surface",
		glassTargets.input === null || glassTargets.input.background === "rgba(0, 0, 0, 0)",
		String(glassTargets.input?.background),
	);

	// 6b. The sidebar must fade by exactly the SAME amount as the wallpaper canvas.
	//     It used to be set fully transparent, so with glass off the sidebar showed the
	//     raw wallpaper while the content column showed the faded one.
	const sidebarFade = await browser.evaluate(`(async () => {
		const glassBox = document.querySelector('[data-dsh-bg="glass"]');
		glassBox.checked = false;
		glassBox.dispatchEvent(new Event("change", { bubbles: true }));
		const sidebarBox = document.querySelector('[data-dsh-bg="sidebar"]');
		sidebarBox.checked = true;
		sidebarBox.dispatchEvent(new Event("change", { bubbles: true }));
		const slider = document.querySelector('[data-dsh-bg="fade"]');
		slider.value = "0.45";
		slider.dispatchEvent(new Event("input", { bubbles: true }));
		slider.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1400));
		const read = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
		const frame = document.querySelector('[class*="frame"]');
		// The sidebar's bottom scroll fade fades content into the surface token; with
		// that token translucent it stacks into a visible dark band unless cleared.
		const fadeElement = document.querySelector('[class*="sidebarCol"] [class*="fade"]');
		return {
			glassOn: document.body.hasAttribute("data-dsh-glass"),
			sidebarTranslucentAttr: document.body.hasAttribute("data-dsh-sidebar-translucent"),
			canvas: read("--dsw-alias-bg-base"),
			sidebar: read("--dsw-specific-sidebar-fill"),
			frameBg: frame === null ? null : getComputedStyle(frame).backgroundColor,
			fadePresent: fadeElement !== null,
			fadeBackgroundImage: fadeElement === null ? null : getComputedStyle(fadeElement).backgroundImage,
			surfaceCss: document.querySelector("style[data-dsh-background-surface]")?.textContent.length ?? -1,
			fadeSliderValue: document.querySelector('[data-dsh-bg="fade"]').value,
			fadeSliderTag: document.querySelector('[data-dsh-bg="fade"]').tagName + "/" + document.querySelector('[data-dsh-bg="fade"]').type,
			fadeMatchCount: document.querySelectorAll('[data-dsh-bg="fade"]').length,
			panelCount: document.querySelectorAll('[data-dsh-bg="panel"]').length,
			lastOps: window.__dshBackgroundDebug.lastOps,
			debugFade: window.__dshBackgroundDebug.fade,
			debugSidebar: window.__dshBackgroundDebug.sidebar,
			writeFailures: window.__dshBackgroundDebug.writeFailures,
			debugError: window.__dshBackgroundDebug.error,
		};
	})()`);
	console.log("DEBUG sidebarFade:", JSON.stringify(sidebarFade));
	check("glass is off for the sidebar-fade check", sidebarFade.glassOn === false, `data-dsh-glass=${sidebarFade.glassOn}`);
	// The requirement is the INVARIANT — the sidebar is veiled exactly as much as the
	// canvas — so assert that rather than one hard-coded alpha, which depends on how
	// many writes were still queued when the slider was driven.
	check(
		"sidebar fades exactly as much as the wallpaper canvas",
		sidebarFade.sidebar === sidebarFade.canvas && /^rgba\(21, 21, 23, 0?\.\d+\)$/.test(sidebarFade.sidebar),
		`canvas=${sidebarFade.sidebar} sidebar=${sidebarFade.sidebar} slider=${sidebarFade.fadeSliderValue} lastOps=${JSON.stringify(sidebarFade.lastOps)}`,
	);
	check(
		"the faded canvas reaches the app shell",
		/^rgba\(21, 21, 23, 0?\.\d+\)$/.test(sidebarFade.frameBg ?? ""),
		String(sidebarFade.frameBg),
	);
	check("sidebar translucency is flagged on <body>", sidebarFade.sidebarTranslucentAttr === true, String(sidebarFade.sidebarTranslucentAttr));
	check(
		"the sidebar scroll fade is neutralised (no dark band)",
		sidebarFade.fadePresent === true && sidebarFade.fadeBackgroundImage === "none",
		`present=${sidebarFade.fadePresent} backgroundImage=${sidebarFade.fadeBackgroundImage}`,
	);

	// Turning the sidebar fade off must restore the theme's own fill instead.
	const sidebarOff = await browser.evaluate(`(async () => {
		const box = document.querySelector('[data-dsh-bg="sidebar"]');
		box.checked = false;
		box.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1400));
		const read = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
		return { canvas: read("--dsw-alias-bg-base"), sidebar: read("--dsw-specific-sidebar-fill") };
	})()`);
	check(
		"sidebar fade off restores the theme fill",
		sidebarOff.sidebar !== sidebarOff.canvas && sidebarOff.sidebar !== "transparent" && /^rgba\(21, 21, 23, 0?\.\d+\)$/.test(sidebarOff.canvas),
		`canvas=${sidebarOff.canvas} sidebar=${sidebarOff.sidebar}`,
	);

	// 7. Reset must be ONE atomic op that clears the whole namespace.
	const reset = await browser.evaluate(`(async () => {
		const before = window.__dshBackgroundDebug.writeBatches;
		document.querySelector('[data-dsh-bg="reset"]').click();
		await new Promise((r) => setTimeout(r, 1500));
		return {
			added: window.__dshBackgroundDebug.writeBatches - before,
			status: document.querySelector('[data-dsh-bg="panel"] [role="status"]').textContent,
			scene: window.__dshBackgroundDebug.scene,
			enabled: document.querySelector('[data-dsh-bg="enabled"]').checked,
			media: window.__dshBackgroundDebug.media,
			currentMedia: document.querySelector('[data-dsh-bg="currentMedia"]').textContent,
			blur: document.querySelector('[data-dsh-bg="blur"]').value,
			glassBlur: document.querySelector('[data-dsh-bg="glassBlur"]').value,
		};
	})()`);
	check("reset is a single atomic write", reset.added === 1, `batches added=${reset.added}`);
	check("reset clears every field back to defaults", reset.enabled === false && reset.media === "" && Number(reset.blur) === 0 && Number(reset.glassBlur) === 14, JSON.stringify(reset));
	check("reset reports no wallpaper", reset.currentMedia.includes("未设置"), reset.currentMedia);
	check("reset turns the background off", reset.scene === "none" && reset.enabled === false, `scene=${reset.scene}`);

	await browser.setColorScheme("light");
	await browser.screenshot(join(shots, "v3-after-reset-light.png"));
} finally {
	await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
	console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.name}${f.detail === undefined ? "" : `: ${f.detail}`}`).join("\n")}`);
	process.exit(1);
}
