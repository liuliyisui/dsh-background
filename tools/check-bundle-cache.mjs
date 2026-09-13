// Decide whether "nothing changed" is a stale bundle or a real regression.
//
// The GUI serves client plugins as one concatenated request of the form
// /plugins/??a/client.js,b/client.js&rev=<hash>. If that rev is derived from the
// bundle contents, a page reload picks up new code; if the server caches the
// bundle in memory, only a server restart does. This script fetches the exact URL
// the boot payload advertises and looks for a known marker in it.
//
// Usage: node tools/check-bundle-cache.mjs [--url http://127.0.0.1:3080]
import { openBrowser } from "./cdp.mjs";
import { authenticatedUrl } from "./web-token.mjs";

const argOf = (flag) => {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
};
const base = argOf("--url") ?? process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
if (argOf("--token") !== undefined) process.env.DSH_WEB_TOKEN = argOf("--token");
const { url } = await authenticatedUrl(base);

const browser = await openBrowser({ url });
try {
	await new Promise((r) => setTimeout(r, 4500));

	// Node side reads the boot payload; the page only hands it over.
	const boot = await browser.evaluate(`(() => {
		const toggle = document.querySelector('[data-dsh-bg="toggle"]');
		if (toggle !== null) toggle.click();
		const panel = document.querySelector('[data-dsh-bg="panel"]');
		const card = document.querySelector("[data-composer-card]");
		return {
			payload: window.__DSH_BOOT__ ?? null,
			version: window.__dshBackgroundVersion ?? null,
			build: window.__dshBackgroundBuild ?? null,
			panelTitle: panel === null ? null : panel.querySelector("span").textContent,
			cardBackground: card === null ? null : getComputedStyle(card).backgroundColor,
			hasWallpaperUrlBox: panel !== null && panel.querySelector('[data-dsh-bg="media"]') !== null,
		};
	})()`);

	const text = JSON.stringify(boot.payload ?? {});
	const match = /\/plugins\/\?\?[^"']*dsh-background[^"']*/.exec(text);
	const bundleUrl = match === null ? null : match[0];
	console.log("boot rev          :", boot.payload?.rev ?? null);
	console.log("bundle url        :", bundleUrl === null ? "(not found)" : bundleUrl.slice(0, 70) + "…");
	console.log("loaded version    :", boot.version, "| build stamp:", boot.build);
	console.log("panel title       :", boot.panelTitle);
	console.log("card background   :", boot.cardBackground);
	console.log("panel has URL box :", boot.hasWallpaperUrlBox, "(false = current bundle)");

	if (bundleUrl !== null) {
		// Fetch it from inside the page: the request must carry the session cookie.
		const probe = await browser.evaluate(
			`(async () => {
				const response = await fetch(${JSON.stringify(bundleUrl)}, { cache: "no-store" });
				const body = await response.text();
				return {
					status: response.status,
					cacheControl: response.headers.get("cache-control"),
					etag: response.headers.get("etag"),
					bytes: body.length,
					hasNewTint: body.includes("rgba(20,24,36,0.88)"),
					hasPreviousTint: body.includes("rgba(20,24,36,0.72)"),
					hasOldestTint: body.includes("rgba(20,24,36,0.34)"),
					hasComposerCardRule: body.includes("data-composer-card"),
					versionLine: (body.match(/const VERSION = "[^"]+"/) ?? [null])[0],
				};
			})()`,
		);
		console.log("fetch status      :", probe.status, "| bytes:", probe.bytes);
		console.log("cache-control     :", probe.cacheControl);
		console.log("etag              :", probe.etag);
		console.log("VERSION in bundle :", probe.versionLine);
		console.log("has card rule     :", probe.hasComposerCardRule);
		console.log("tint 0.88 (newest):", probe.hasNewTint);
		console.log("tint 0.72         :", probe.hasPreviousTint);
		console.log("tint 0.34 (oldest):", probe.hasOldestTint);
	}
} finally {
	await browser.close();
}
