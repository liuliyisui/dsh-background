// dsh-background — host (node) half. v3
//
// Responsibilities, deliberately kept to two:
//   1. own the `background` settings namespace (schema + defaults);
//   2. mount the media library routes (upload / list / serve / delete), which
//      live in media.js so they can be tested without a DSH runtime.
//
// v3 schema notes — the surface was cut down to what is actually used:
//   - `color` / `colorDark` are GONE. The panel never wrote them, and their two
//     competing write paths (`styleTag` CSS plus `theme.overrideTokens`) were the
//     source of the token double-writer defect. With them gone the client has
//     exactly one token writer.
//   - `image` / `imageDark` are GONE. The wallpaper is addressed as `media` (a
//     media-library URL or any http(s)/data URL), so the v2 hack of stashing a
//     multi-megabyte data URL in localStorage — and unsetting the settings field
//     behind the user's back — is no longer needed.
//   - `position` is a closed set of CSS keywords rather than free text, because
//     the panel now offers a preset dropdown instead of a text box.
//   - `glassBlur` is NEW: v2 derived the glass blur from the wallpaper blur
//     (`GLASS_CSS(Math.max(8, Number(v.blur) || 14))`), so raising the wallpaper
//     blur silently re-blurred the UI chrome with it.
//
// Compatibility: v3 does NOT migrate. `image`/`imageDark`/`color`/`colorDark`
// left in settings.yaml are simply ignored by the schema; every field the panel
// actually wrote before (enabled/blur/overlay/fade/opacity/size/glass/sidebar/
// mediaType/muted/gradient) keeps its name and meaning.
//
// Note on @deepseek-ai/dsh-settings: 0.1.5-rc.1 removed the top-level
// installSettingsSection / settingsNamespace exports (they became
// SettingsProvider methods and a pure type), so importing them would make this
// module fail to parse on the current kernel. This file therefore does not import
// dsh-settings at all and wires the section through ctx.settings.register(),
// which exists in both 0.1.0-rc.x and 0.1.5-rc.1.
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { homedir } from "node:os";
import { createMediaRouter } from "./media.js";

/** Settings namespace owned by this plugin (lowercase kebab-case). */
const BACKGROUND_NS = "background";

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
 * Schema of the `background` settings section.
 * Defaults are the composition base; a field a user never touches is absent from
 * settings.yaml entirely.
 */
export const BACKGROUND_SCHEMA = z.object({
	/** Master switch. Off restores the stock appearance completely. */
	enabled: z.boolean().default(false),
	/** Wallpaper source: a media-library URL, or any http(s) / data: URL. */
	media: z.string().default(""),
	/** Whether the wallpaper is a still image (or animated image) or a video. */
	mediaType: z.union([z.const("image"), z.const("video")]).default("image"),
	/** CSS background-size behaviour for the wallpaper. */
	size: z.union([z.const("cover"), z.const("contain"), z.const("auto")]).default("cover"),
	/** CSS background-position keyword. */
	position: z.union(BACKGROUND_POSITIONS.map((value) => z.const(value))).default("center"),
	/** Darkening scrim over the wallpaper (0..0.9). */
	overlay: z.number().min(0).max(0.9).default(0),
	/** Wash of the theme's own surface colour over the wallpaper (0..0.9). */
	fade: z.number().min(0).max(0.9).default(0),
	/** Wallpaper blur in px (0 = sharp). */
	blur: z.number().min(0).max(60).default(0),
	/** Wallpaper opacity (0..1). */
	opacity: z.number().min(0).max(1).default(1),
	/** Use the built-in aurora gradient when no wallpaper is set. */
	gradient: z.boolean().default(true),
	/** Mute video wallpapers (autoplay requires it in every current browser). */
	muted: z.boolean().default(true),
	/** Fade the sidebar by the same amount as the canvas, so the wallpaper shows through it. */
	sidebar: z.boolean().default(true),
	/** Frosted-glass chrome (composer + sidebar). */
	glass: z.boolean().default(false),
	/** Frosted-glass blur radius in px — independent of the wallpaper blur. */
	glassBlur: z.number().min(0).max(40).default(14),
	/** Frosted-glass tint strength: low is very see-through, high is nearly solid. */
	glassOpacity: z.number().min(0.2).max(0.95).default(0.45),
});

/** @returns the media directory: DSH_HOME/skin-aurora-media. */
export function mediaDir() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), MEDIA_DIR_NAME);
}

/**
 * Register this plugin's settings section.
 * @param ctx - host cordis context.
 */
function installBackgroundSection(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(BACKGROUND_NS, BACKGROUND_SCHEMA, { base: {} });
	});
}

/**
 * Host plugin body: the settings section plus the media routes.
 * @param ctx - host cordis context.
 */
function apply(ctx) {
	installBackgroundSection(ctx);

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

export { apply };
export default apply;
