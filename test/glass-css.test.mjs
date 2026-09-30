// dsh-background — static checks on the generated glass CSS.
//
// Every frosted surface in this plugin has, at some point, shipped a
// `backdrop-filter` that was invisible because the element underneath it stayed
// opaque: the composer card, the sidebar, and now the official settings dialog.
// The live-GUI probe cannot always run (the packaged desktop build gates its page
// behind a per-boot token that is never written to disk), so the invariants are
// pinned here instead, by evaluating the real `glassCss()` out of the shipped file.
//
// Usage: node test/glass-css.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** Pull `function glassCss(...) { ... }` out of the bundle by brace matching. */
function extractFunction(text, name) {
	const start = text.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`function ${name} not found`);
	const open = text.indexOf("{", start);
	let depth = 0;
	for (let at = open; at < text.length; at += 1) {
		if (text[at] === "{") depth += 1;
		else if (text[at] === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, at + 1);
		}
	}
	throw new Error(`unbalanced braces in ${name}`);
}

const clamp = (value, min, max) => Math.min(Math.max(Number(value), min), max);
const glassCss = new Function("clamp", `return (${extractFunction(source, "glassCss")})`)(clamp);

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n        ${detail}`}`);
}

const css = glassCss(14, 0.45);

/** The declarations of one selector block within a stylesheet, or null when absent. */
function ruleIn(stylesheet, selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(stylesheet);
	return block === null ? null : block[1];
}
const ruleFor = (selector) => ruleIn(css, selector);

// 1. The official settings dialog: the shell paints its ONLY background on
//    `[role="dialog"]`, so that rule must both blur AND tint. A backdrop-filter
//    alone over an opaque background is invisible.
const dialogRule = ruleFor('[data-dsh-glass] [role="dialog"]');
check("glass CSS has a dialog rule", dialogRule !== null);
check("the dialog rule blurs", /backdrop-filter:\s*blur\(/.test(dialogRule ?? ""), dialogRule);
check(
	"the dialog rule also makes the surface translucent",
	/background:\s*color-mix\(|background:\s*rgba\(/.test(dialogRule ?? ""),
	`a backdrop-filter with no translucent background renders nothing — ${dialogRule}`,
);

// 2. The composer card: same requirement, plus a blur floor so the wallpaper behind
//    the input reads as a wash rather than a hard shape.
const cardRule = ruleFor("[data-dsh-glass] [data-composer-card]");
check("the composer card blurs", /backdrop-filter:\s*blur\(/.test(cardRule ?? ""), cardRule);
const cardBlur = Number((/blur\((\d+(?:\.\d+)?)px\)/.exec(cardRule ?? "") ?? [])[1] ?? 0);
check("the composer card keeps a blur floor", cardBlur >= 16, `blur=${cardBlur}`);
check("the composer card stays flat", !/background-image:\s*linear-gradient/.test(cardRule ?? ""), cardRule);

// 3. The sidebar: tinted from the theme, never plain `transparent` (which read as a
//    flat washed panel) and never a hardcoded foreign colour.
const sideRule = ruleFor('[data-dsh-glass] [class*="sidebarCol"]');
check("the sidebar is tinted, not transparent", /background:\s*rgba\(/.test(sideRule ?? "") && !/transparent/.test(sideRule ?? ""), sideRule);
check("the sidebar tint follows the opacity knob", /0\.45/.test(sideRule ?? ""), sideRule);

// 4. The opacity knob must actually drive the tints.
const denser = glassCss(20, 0.9);
const denseCard = ruleIn(denser, "[data-dsh-glass] [data-composer-card]");
const denseSide = ruleIn(denser, '[data-dsh-glass] [class*="sidebarCol"]');
check("raising opacity raises the card tint", /0\.9/.test(denseCard ?? ""), denseCard);
check("raising opacity raises the sidebar tint", /0\.9/.test(denseSide ?? ""), denseSide);
check("the blur radius is parametrised", /blur\(20px\)/.test(denser), "expected blur(20px)");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
