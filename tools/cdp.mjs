// Minimal zero-dependency Chrome DevTools Protocol client for the dsh-background
// dev tooling. Uses Node's built-in global WebSocket (Node >= 22) and fetch, so
// no puppeteer/playwright install is required.
//
// Launches its own headless Edge with a throwaway --user-data-dir, so it never
// touches the user's real browser profile.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return await res.json();
		} catch (error) {
			lastError = error;
		}
		await sleep(250);
	}
	throw new Error(`CDP port ${port} never became ready: ${lastError?.message ?? "timeout"}`);
}

/**
 * Launch headless Edge and attach to a fresh page target.
 * @param options - `port` (default 9333) and `url` to open.
 * @returns a session with `evaluate`, `screenshot`, `setColorScheme`, `close`.
 */
export async function openBrowser({ port = 9333, url = "about:blank", width = 1440, height = 900 } = {}) {
	const userDataDir = mkdtempSync(join(tmpdir(), "dsh-bg-probe-"));
	const child = spawn(
		EDGE,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${userDataDir}`,
			`--window-size=${width},${height}`,
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	await waitForPort(port);

	const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", reject, { once: true });
	});

	let nextId = 1;
	const pending = new Map();
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id === undefined) return;
		const entry = pending.get(msg.id);
		if (entry === undefined) return;
		pending.delete(msg.id);
		if (msg.error) entry.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`));
		else entry.resolve(msg.result);
	});

	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

	/** Evaluate an expression in the page and return its JSON value. */
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) {
			throw new Error(`page evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
		}
		return result.result.value;
	};

	return {
		send,
		evaluate,
		async navigate(target_, waitMs = 5000) {
			await send("Page.navigate", { url: target_ });
			await sleep(waitMs);
		},
		async setColorScheme(value) {
			await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
			await sleep(600);
		},
		async screenshot(path) {
			const { data } = await send("Page.captureScreenshot", { format: "png" });
			writeFileSync(path, Buffer.from(data, "base64"));
			return path;
		},
		async close() {
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			child.kill();
		},
	};
}
