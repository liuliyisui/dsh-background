// Temporary acceptance check for the dsh-background 0.1.7-rc.1 port.
// Loads the real web GUI from the temporary 0.1.7 instance and asks the page:
//   1. did the client plugin activate at all?
//   2. did the wallpaper actually paint?
//   3. does the settings UI list a row for this plugin?
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { openBrowser } from "./cdp.mjs";

const URL = process.argv[2];
if (!URL) {
	console.error("usage: node verify-port.mjs <url>");
	process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await openBrowser({ port: 9333, url: "about:blank", width: 1600, height: 1000 });
await browser.navigate(URL, 10000);

const snapshot = () =>
	browser.evaluate(`(() => {
		const dbg = window.__dshBackgroundDebug ?? null;
		const body = document.body;
		const layer = document.querySelector("[data-dsh-bg-layer], [class*=dsh-bg], div[style*='z-index: -1']");
		const tokens = getComputedStyle(document.documentElement);
		return {
			version: window.__dshBackgroundVersion ?? null,
			build: window.__dshBackgroundBuild ?? null,
			debug: dbg,
			glass: body ? body.hasAttribute("data-dsh-glass") : null,
			sidebarTranslucent: body ? body.hasAttribute("data-dsh-sidebar-translucent") : null,
			sidebarBlurLayer: !!document.querySelector("[data-dsh-bg-sidebar-blur]"),
			panelToggle: !!document.querySelector("[data-dsh-background-toggle], [data-dsh-bg-toggle]"),
			glassTag: (document.querySelector("[data-dsh-background-glass]") || {}).textContent ?? null,
			bgBase: tokens.getPropertyValue("--dsw-alias-bg-base").trim(),
			anyLayer: !!layer,
		};
	})()`);

// Wait for the plugin to finish its first settings read.
let first = null;
for (let i = 0; i < 30; i++) {
	first = await snapshot();
	if (first.debug && first.debug.namespace && first.debug.namespace !== "loading") break;
	await sleep(1000);
}

// Ask the Host directly which settings namespaces it serves. The page already
// holds the session cookie the root token exchange minted, so the RPC must be
// issued from inside the page.
let describe = null;
try {
	describe = await browser.evaluate(`(async () => {
		const rpcId = "probe-" + Math.random().toString(36).slice(2);
		const message = { type: "client-request", rpcId, method: "settings.describe", payload: { args: [] } };
		const attempts = [];
		for (const attempt of [
			{ path: "/api", body: message },
			{ path: "/api/settings.describe", body: message },
			{ path: "/api/settings.describe", body: { args: [] } },
		]) {
			try {
				const res = await fetch(attempt.path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(attempt.body),
				});
				const text = await res.text();
				attempts.push({ path: attempt.path, status: res.status, body: text.slice(0, 500) });
				if (res.ok) {
					const full = JSON.parse(text);
					const value = full && full.result && (full.result.value ?? full.result);
					const namespaces = value && Array.isArray(value.namespaces) ? value.namespaces : [];
					return {
						okPath: attempt.path,
						nsIds: namespaces.map((row) => row.ns),
						hasUiBackground: namespaces.some((row) => row.ns === "ui-background"),
						attempts,
					};
				}
			} catch (error) {
				attempts.push({ path: attempt.path, error: String(error && error.message ? error.message : error) });
			}
		}
		return { attempts };
	})()`);
} catch (error) {
	describe = { error: String(error && error.message ? error.message : error) };
}

// Open Settings through the sidebar and enumerate what the page lists.
let settings = null;
try {
	const clicked = await browser.evaluate(`(() => {
		const nodes = [...document.querySelectorAll("button, a, [role=button], li, div")];
		const hits = nodes.filter((n) => {
			const t = (n.innerText || "").trim();
			return (t === "设置" || t === "Settings") && n.getBoundingClientRect().width > 0;
		});
		if (hits.length === 0) return "not-found";
		const target = hits[hits.length - 1];
		target.click();
		const btn = target.closest("button, [role=button], a");
		if (btn && btn !== target) btn.click();
		return "clicked:" + target.tagName + ":" + String(target.className || "").slice(0, 60);
	})()`);
	await sleep(5000);
	settings = {
		clicked,
		probe: await browser.evaluate(`(() => {
			const text = (document.body && document.body.innerText) || "";
			const labels = [...document.querySelectorAll("button, [role=tab], li, a, span")]
				.map((n) => (n.innerText || "").trim())
				.filter((t) => t.length > 0 && t.length < 24);
			return {
				hasBackdropWord: /背景|壁纸|Background|Wallpaper/.test(text),
				uniqueLabels: [...new Set(labels)].slice(0, 80),
			};
		})()`),
	};
} catch (error) {
	settings = { error: String(error && error.message ? error.message : error) };
}

const shot = join(tmpdir(), "dsh-bg-017-verify.png");
await browser.screenshot(shot);
console.log(JSON.stringify({ url: URL, first, describe, settings, screenshot: shot }, null, 2));
await browser.close();
