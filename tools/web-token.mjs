// Discover the token the running `dsh web` GUI requires.
//
// 0.1.5-rc.1 gates the page itself behind a token: opening the bare
// http://127.0.0.1:<port> answers HTTP 401 and a blank window. The desktop
// shell parses the token out of the service's boot output and logs it to
// Electron's main.log, so that log is the one place it can be recovered from
// outside the app. Re-verified against the live server on every call, because
// the token is regenerated on each restart.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOG = join(process.env.APPDATA ?? "", "dsh-desktop", "logs", "main.log");

/** @returns the most recently logged token, or null when none was logged. */
function latestLoggedToken() {
	let text;
	try {
		text = readFileSync(LOG, "utf8");
	} catch {
		return null;
	}
	const matches = [...text.matchAll(/"token":"([^"]+)"/g)];
	return matches.length === 0 ? null : matches[matches.length - 1][1];
}

/**
 * Resolve an authenticated GUI URL for the running server.
 * @param base - origin, default http://127.0.0.1:3080.
 * @returns `{ url, token }` where the token is proven to open the GUI.
 */
export async function authenticatedUrl(base = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080") {
	const candidates = [latestLoggedToken(), process.env.DSH_WEB_TOKEN ?? null].filter((t) => typeof t === "string" && t.length > 0);
	if (candidates.length === 0) throw new Error(`no token found in ${LOG} and DSH_WEB_TOKEN is unset`);
	const errors = [];
	for (const token of candidates) {
		const url = `${base}/?token=${encodeURIComponent(token)}`;
		try {
			// The exchange is a 303 to "/" carrying the signed session cookie. Node's
			// fetch has no cookie jar, so the redirect must NOT be followed — the
			// 303 itself is the proof that the token is the live one.
			const res = await fetch(url, { redirect: "manual" });
			if (res.status === 303 || res.status === 302 || res.status === 200) {
				const body = res.status === 200 ? await res.text() : "";
				if (!body.includes("authentication required")) return { url, token };
			}
			errors.push(`${token.slice(0, 6)}… -> HTTP ${res.status}`);
		} catch (error) {
			errors.push(`${token.slice(0, 6)}… -> ${error.message}`);
		}
	}
	throw new Error(`no logged token authenticated against ${base} (${errors.join("; ")})`);
}
