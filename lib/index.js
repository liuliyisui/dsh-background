// dsh-background — host (node) half. v4
//
// Responsibilities, deliberately kept to two:
//   1. declare the `background` settings schema as this plugin's Config;
//   2. mount the media library routes (upload / list / serve / delete), which
//      live in media.js so they can be tested without a DSH runtime.
//
// v4 schema notes — the kernel API change that forced this revision:
//   DSH 0.1.7-rc.1 deleted `ctx.settings.register()`. A settings surface is no
//   longer a namespace a plugin pushes into the settings provider; it is the
//   plugin entry's own Config schema, projected as a form by `settings.describe()`
//   (see dsh-settings `SettingsForms.describe()` → `this.schema(entry)`, which
//   reads `entry.fiber.runtime.Config`). Three consequences this file now obeys:
//     - the schema must be EXPORTED as `Config`, not registered imperatively;
//     - the namespace seen by the browser is the PROFILE ENTRY ID, not a
//       free-form string, so it is `ui-background` (the id in
//       cordis.patch.yml) and the client half must ask for that id;
//     - only fields marked `.volatile()` are editable at runtime
//       (`volatileForm()` / `isVolatilePath()` gate every form edit).
//   The old `ctx.inject(["settings"], …)` registration is gone; nothing in this
//   half reads settings any more — the client reads them over the wire.
//
// Field defaults are deliberately NOT declared on the schema. Values are stored
// in the profile patch, and a schema default becomes the composition base for
// every field, which would (a) paint app-level defaults into the patch the first
// time any field is written and (b) leave a user unable to inherit a changed
// default later. The client half already carries a fallback for every field
// (`readOnly(view, key, fallback)`), so an absent field renders identically.
//
// Compatibility: v4 does NOT migrate. Fields left in the removed top-level
// `settings.yaml` (`background:`) are ignored; the values must live in the
// profile patch under `ui-background`. Legacy v2 keys (image/imageDark/color/
// colorDark) were already ignored by v3 and still are.
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { homedir } from "node:os";
import { createMediaRouter } from "./media.js";

/**
 * Settings namespace owned by this plugin.
 *
 * This MUST equal the profile entry id that names this plugin
 * (`- id: ui-background` in the profile's cordis.patch.yml): 0.1.7 derives the
 * namespace from the entry id, so a mismatch is invisible on the host and makes
 * the browser half wait for a form that never appears.
 */
export const BACKGROUND_NS = "ui-background";

/** Route prefix for the media library (upload / list / serve / delete). */
export const MEDIA_API_PREFIX = "/api/dsh-background";

/** Media directory name under DSH_HOME, shared with the aurora skin. */
const MEDIA_DIR_NAME = "skin-aurora-media";

/** Closed set of CSS background-position keywords the panel offers. */
export const BACKGROUND_POSITIONS = [
	"center",
	"top",
	"bottom",
	"left",
	"right",
	"top left",
	"top right",
	"bottom left",
	"bottom right",
];

/**
 * Schema of the `background` settings section, exported as this plugin's Config.
 *
 * `.volatile()` is applied ONCE, to the root object — never to individual fields.
 * Both directions are load-bearing and both were learned the hard way:
 *   - without a volatile marker ANYWHERE, `volatileForm()` returns undefined and
 *     `describe()` skips the entry, so the namespace silently disappears and the
 *     browser half reports `unavailable`;
 *   - with the marker on the root AND on a field, schemastery rejects the schema
 *     outright ("volatile fields require a fixed object path without an enclosing
 *     volatile field"), cordis fails config resolution, and the entry does not
 *     activate at all.
 * Marking the root is the form the kernel's own settings-owning plugins use
 * (`dsh-client-ui-theme` marks its root object and no fields), and it is what
 * `isVolatilePath()` accepts for every leaf under it.
 *
 * Field defaults are deliberately NOT declared. Values are stored in the profile
 * patch, and a schema default becomes the composition base for every field, which
 * would (a) paint app-level defaults into the patch the first time any field is
 * written and (b) leave a user unable to inherit a changed default later. The
 * client half already carries a fallback for every field
 * (`readOnly(view, key, fallback)`), so an absent field renders identically.
 */
export const Config = z.object({
	/** Master switch. Off restores the stock appearance completely. */
	enabled: z.boolean(),
	/** Wallpaper source: a media-library URL, or any http(s) / data: URL. */
	media: z.string(),
	/** Whether the wallpaper is a still image (or animated image) or a video. */
	mediaType: z.union([z.const("image"), z.const("video")]),
	/** CSS background-size behaviour for the wallpaper. */
	size: z.union([z.const("cover"), z.const("contain"), z.const("auto")]),
	/** CSS background-position keyword. */
	position: z.union(BACKGROUND_POSITIONS.map((value) => z.const(value))),
	/** Darkening scrim over the wallpaper (0..0.9). */
	overlay: z.number().min(0).max(0.9),
	/** Wash of the theme's own surface colour over the wallpaper (0..0.9). */
	fade: z.number().min(0).max(0.9),
	/** Wallpaper blur in px (0 = sharp). */
	blur: z.number().min(0).max(60),
	/** Wallpaper opacity (0..1). */
	opacity: z.number().min(0).max(1),
	/** Use the built-in aurora gradient when no wallpaper is set. */
	gradient: z.boolean(),
	/** Mute video wallpapers (autoplay requires it in every current browser). */
	muted: z.boolean(),
	/** Fade the sidebar by the same amount as the canvas, so the wallpaper shows through it. */
	sidebar: z.boolean(),
	/** Frosted-glass chrome (composer + sidebar). */
	glass: z.boolean(),
	/** Frosted-glass blur radius in px — independent of the wallpaper blur. */
	glassBlur: z.number().min(0).max(40),
	/** Frosted-glass tint strength: low is very see-through, high is nearly solid. */
	glassOpacity: z.number().min(0.2).max(0.95),
}).volatile();

/** @returns the media directory: DSH_HOME/skin-aurora-media. */
export function mediaDir() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), MEDIA_DIR_NAME);
}

/**
 * Host plugin body: the media routes.
 *
 * The settings half is no longer code: exporting `Config` above is what makes
 * the Host project a form for the `ui-background` entry.
 * @param ctx - host cordis context.
 */
function apply(ctx) {
	// Media routes. The optional injection is required: since 0.1.5 an undeclared
	// service read through ctx.get() yields undefined, and the routes would just
	// never register (uploads fail with no visible reason).
	ctx.inject(["webServer"], (serverCtx) => {
		const webServer = serverCtx.get("webServer");
		if (webServer === null || webServer === undefined || typeof webServer.register !== "function") return;
		const router = createMediaRouter({ dir: mediaDir(), prefix: MEDIA_API_PREFIX });
		const dispose = webServer.register({ kind: "prefix", path: MEDIA_API_PREFIX, handler: router.handle });
		ctx.effect(() => dispose, "dsh-background: media routes");
	});
}

// NOTE: no `export default` here, on purpose.
//
// The loader normalizes a resolved module with
// `unwrapExports(exports) { exports = exports.default ?? exports; ... }`
// (cordis-plugin-loader), and cordis then attaches the settings schema with
// `Config: plugin.Config` (Context.plugin). A default export therefore collapses
// the whole namespace to the bare `apply` function, and the named `Config`
// export is DROPPED — the entry still activates (state 2), but
// `fiber.runtime.Config` is undefined, so `SettingsForms.describe()` skips it and
// the browser half reports the namespace as `unavailable`. Exporting only named
// bindings keeps the module object intact, which is also how the kernel's own
// settings-owning plugins (`dsh-client-ui-theme`) are written.
export { apply };
