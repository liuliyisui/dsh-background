// dsh-background — browser (client) half. v3
//
// Design rules this file follows, each one paid for by a defect found in v2:
//
//  1. ONE token writer. v2 wrote `--dsw-alias-bg-base` from two places at once:
//     a <style> tag with !important, and theme.overrideTokens(). v3 keeps only
//     overrideTokens(), which is also what actually makes the wallpaper visible:
//     the opaque `pI_x6G_frame` / `pI_x6G_root` shells consume that token and
//     paint ABOVE the z-index:-1 layer, so unless the token is pierced the layer
//     is invisible. v2 only pierced it when a wallpaper image was set, which is
//     why the aurora gradient never showed.
//  2. ONE background layer. No more "image goes on <body> when sharp, in a layer
//     when blurred" split.
//  3. overrideTokens() emits theme/change, so the theme/change handler must never
//     write tokens again — it only repaints the layer (which needs the scheme).
//     That is what keeps this from recursing.
//  4. Persistence is batched through one mutate() call: v2 wrote to settings.yaml
//     on every `input` event, i.e. dozens of disk writes per slider drag. The
//     namespace is `ui-background` (the profile entry id) since 0.1.7-rc.1;
//     see the NS comment below for why.
//  5. Reset is ONE atomic op: mutate([{op:"unset", path:[]}]) clears the whole
//     section instead of firing sixteen individual writes with a nested ternary
//     table of defaults.
//  6. No localStorage. v2 kept wallpaper data URLs there (5 MB quota, settings not
//     portable) and unset the settings field to compensate. The wallpaper is now
//     addressed by media-library URL.
//  7. Glass targets selectors proven against the live DOM. v2's composer rules
//     matched nothing: `inputBar` does not exist, and `[data-phase="active"]` is
//     never present, so only the sidebar half of "毛玻璃" ever worked.
window.__ModuleLoader__.load({
	id: "dsh-background",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Settings namespace owned by the host half.
		 *
		 * In 0.1.7-rc.1 the namespace is the PROFILE ENTRY ID, not a string the
		 * plugin chose: the Host projects a form per entry from its Config, and
		 * `settings.describe()` keys each one by `entry.options.id`. The host half
		 * exports BACKGROUND_NS with the same value; both must match the
		 * `- id: ui-background` row in the profile's cordis.patch.yml, or this
		 * plugin waits forever for a form that never appears.
		 */
		const NS = "ui-background";
		/** Theme-override layer identity (one layer per source). */
		const SOURCE = "dsh-background";
		/** Version marker, so a stale bundle is instantly identifiable. */
		const VERSION = "4.0.0";
		/**
		 * Build stamp: the `rev` the host put on this bundle's script URL.
		 *
		 * Plugin bundles are served content-addressed as
		 * `/plugins/??<id>/client.js&rev=<hash>`, so this changes exactly when the
		 * shipped code changes. Without it there is no way to tell "my change had no
		 * effect" from "this window is still running the previous bundle" — a question
		 * that cost several rounds of debugging.
		 */
		const BUILD = (() => {
			// The plugin bundles are NOT loaded through <script src> tags — the modules
			// loader imports them — so the trustworthy source is the boot payload, which
			// carries the concatenated batch URLs. Take the rev of the batch that lists
			// THIS plugin: that one changes exactly when this file changes, whereas the
			// loader's own rev stays put.
			const boot = JSON.stringify(window.__DSH_BOOT__ ?? {});
			const batch = /\/plugins\/\?\?[^"']*dsh-background[^"']*?[&?]rev=([0-9a-f]{6,})/.exec(boot);
			if (batch !== null) return batch[1].slice(0, 8);
			return "unknown";
		})();
		/** Dark palette marker written by the theme presenter on <body>. */
		const DARK_ATTR = "data-ds-dark-theme";
		/** Canvas token consumed by the opaque app shells. */
		const BG_BASE = "--dsw-alias-bg-base";
		/** Sidebar fill token. */
		const SIDEBAR_FILL = "--dsw-specific-sidebar-fill";
		/** Media library API base. */
		const MEDIA_API = "/api/dsh-background";
		/** Delay before staged edits are persisted as one batched write. */
		const WRITE_DEBOUNCE_MS = 200;
		/** Window in which our own write's settings notification is ignored. */
		const SELF_WRITE_SUPPRESS_MS = 1500;
		/**
		 * Required cordis services (the runner resolves these onto ctx).
		 *
		 * 0.1.7-rc.1 renamed the settings client service: the provider in
		 * `@deepseek-ai/dsh-client-ui-settings` now calls itself `configForms`
		 * (`super(ctx, "configForms")`) and injects `remote` itself. `settingsScope`
		 * no longer exists anywhere in the kernel, which is exactly what used to
		 * leave this entry `pending (waiting for service: settingsScope)` and
		 * painted "Failed to load plugins" over the GUI.
		 * `remote` is declared here because a form's write path crosses that
		 * namespace on THIS plugin's context (see ConfigForms.owner).
		 */
		const inject = ["theme", "remote", "configForms"];
		/** Theme surface colours the `fade` wash mixes toward, per scheme. */
		const SURFACE = { light: "249, 250, 251", dark: "21, 21, 23" };

		window.__dshBackgroundVersion = VERSION;
		window.__dshBackgroundBuild = BUILD;
		window.__dshBackgroundDebug = {
			version: VERSION,
			loaded: false,
			namespace: "loading",
			error: null,
			renderError: null,
			scene: "none",
			tokenKey: "off",
			media: "",
			fade: 0,
			sidebar: true,
			writeBatches: 0,
			writeFailures: 0,
		};

		// ── small helpers ────────────────────────────────────────────────────

		function str(value) {
			return typeof value === "string" ? value.trim() : "";
		}
		function num(value, fallback) {
			const n = Number(value);
			return Number.isFinite(n) ? n : fallback;
		}
		function clamp(value, min, max) {
			return Math.min(Math.max(value, min), max);
		}
		function cssUrl(value) {
			return `url("${String(value).replace(/[\\"]/g, "\\$&")}")`;
		}
		/** `fade` wash: the theme's own surface colour at the given alpha. */
		function wash(scheme, alpha) {
			return alpha <= 0 ? "transparent" : `rgba(${SURFACE[scheme]}, ${alpha})`;
		}
		function readOnly(view, key, fallback) {
			return view === null || view === undefined ? fallback : view[key];
		}

		/** The two built-in aurora gradients (no wallpaper configured). */
		function auroraGradient(dark) {
			return dark
				? [
					"radial-gradient(1200px 800px at 15% 8%, rgba(90,120,255,0.38), transparent 60%)",
					"radial-gradient(1000px 700px at 85% 18%, rgba(0,200,180,0.24), transparent 55%)",
					"linear-gradient(180deg, #05081a 0%, #0c1234 55%, #111736 100%)",
				].join(",")
				: [
					"radial-gradient(1200px 800px at 15% 8%, rgba(90,130,255,0.30), transparent 60%)",
					"radial-gradient(1000px 700px at 85% 18%, rgba(0,180,170,0.20), transparent 55%)",
					"radial-gradient(900px 900px at 60% 100%, rgba(150,90,255,0.22), transparent 60%)",
					"linear-gradient(180deg, #f2f5ff 0%, #e4ebfb 55%, #ece7fb 100%)",
				].join(",");
		}

		// ── the single background layer ──────────────────────────────────────

		/**
		 * Owns one fixed layer that paints the wallpaper or the aurora gradient,
		 * plus the darkening scrim above it. The video element is reused so a
		 * changed setting never restarts playback.
		 * @param body - document body the layer is mounted on.
		 * @returns `{ render, destroy }`; `render` reports the painted kind.
		 */
		function createScene(body) {
			let layer = null;
			let video = null;
			let scrim = null;
			let videoSource = "";

			const ensure = () => {
				if (layer !== null && layer.isConnected) return layer;
				layer = document.createElement("div");
				layer.id = "dsh-bg-layer";
				layer.setAttribute("aria-hidden", "true");
				layer.style.cssText = "position:fixed;inset:0;z-index:-1;pointer-events:none;background-repeat:no-repeat";
				scrim = document.createElement("div");
				scrim.setAttribute("data-dsh-bg-scrim", "");
				scrim.style.cssText = "position:absolute;inset:0;pointer-events:none";
				layer.append(scrim);
				body.append(layer);
				return layer;
			};

			const dropVideo = () => {
				if (video === null) return;
				video.pause();
				video.removeAttribute("src");
				video.remove();
				video = null;
				videoSource = "";
			};

			const destroy = () => {
				dropVideo();
				if (layer !== null) layer.remove();
				layer = null;
				scrim = null;
			};

			/**
			 * @param view - the settings section.
			 * @param dark - whether the dark palette is active.
			 * @returns `{ active, kind }` describing what is painted.
			 */
			const render = (view, dark) => {
				const enabled = view !== null && view !== undefined && view.enabled === true;
				const media = enabled ? str(view.media) : "";
				const isVideo = media.length > 0 && view.mediaType === "video";
				const gradient = enabled && media.length === 0 && view.gradient !== false;
				const active = enabled && (media.length > 0 || gradient);
				if (!active) {
					destroy();
					return { active: false, kind: "none" };
				}

				const blur = clamp(num(view.blur, 0), 0, 60);
				const opacity = clamp(num(view.opacity, 1), 0, 1);
				const overlay = clamp(num(view.overlay, 0), 0, 0.9);
				const size = view.size === "contain" || view.size === "auto" ? view.size : "cover";
				const position = str(view.position) || "center";
				const el = ensure();

				el.style.opacity = String(opacity);
				el.style.filter = blur > 0 ? `blur(${blur}px)` : "none";
				// A blurred layer fades to transparent at its own edges; oversizing it
				// by twice the radius keeps the viewport covered by interior pixels.
				el.style.inset = blur > 0 ? `-${Math.ceil(blur * 2)}px` : "0";
				scrim.style.background = overlay > 0 ? `rgba(0, 0, 0, ${overlay})` : "none";

				if (isVideo) {
					if (video === null) {
						video = document.createElement("video");
						video.autoplay = true;
						video.loop = true;
						video.playsInline = true;
						video.setAttribute("playsinline", "");
						video.setAttribute("aria-hidden", "true");
						video.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
						el.insertBefore(video, scrim);
					}
					video.style.objectFit = size === "contain" ? "contain" : size === "auto" ? "none" : "cover";
					if (videoSource !== media) {
						videoSource = media;
						video.src = media;
					}
					video.muted = view.muted !== false;
					const played = video.play();
					if (played !== undefined && typeof played.catch === "function") played.catch(() => {});
					el.style.backgroundImage = "none";
					return { active: true, kind: "video" };
				}

				dropVideo();
				if (media.length > 0) {
					el.style.backgroundImage = cssUrl(media);
					el.style.backgroundSize = size;
					el.style.backgroundPosition = position;
					return { active: true, kind: "image" };
				}
				el.style.backgroundImage = auroraGradient(dark);
				el.style.backgroundSize = "cover";
				el.style.backgroundPosition = "center";
				return { active: true, kind: "gradient" };
			};

			return { render, destroy };
		}

		// ── theme token channel (the ONE writer) ─────────────────────────────

		/**
		 * Pierce the opaque app shells so the layer behind them is visible.
		 *
		 * `pI_x6G_frame` / `pI_x6G_root` consume `--dsw-alias-bg-base`; overriding it
		 * to a translucent wash both reveals the wallpaper and implements `fade`
		 * (the wallpaper seen through a thin veil of the theme's surface colour).
		 *
		 * The sidebar gets the SAME wash, so with glass off it is faded exactly as much
		 * as the canvas behind it. Making the sidebar fully transparent instead — which
		 * is what this did first — left it showing the raw wallpaper while the content
		 * column showed the faded one: the sidebar read as "more transparent" than the
		 * rest of the app and its labels lost contrast against busy artwork.
		 * @param theme - the theme service.
		 * @returns `apply(view)`, which writes only when the value actually changed.
		 */
		function createSurfaceWriter(theme) {
			let lastKey = null;
			return (view) => {
				const enabled = view !== null && view !== undefined && view.enabled === true;
				const media = enabled ? str(view.media) : "";
				const layerActive = enabled && (media.length > 0 || view.gradient !== false);
				const fade = clamp(num(readOnly(view, "fade", 0), 0), 0, 0.9);
				const sidebar = readOnly(view, "sidebar", true) !== false;
				const key = layerActive ? `${fade}|${sidebar ? "side" : "plain"}` : "off";
				if (key === lastKey) return key;
				const tokens = {};
				if (layerActive) {
					const washLight = wash("light", fade);
					const washDark = wash("dark", fade);
					tokens[BG_BASE] = { light: washLight, dark: washDark };
					if (sidebar) tokens[SIDEBAR_FILL] = { light: washLight, dark: washDark };
				}
				// Re-overriding the same source replaces its whole layer, so an empty
				// token map is how the stock appearance is restored.
				theme.overrideTokens(SOURCE, tokens);
				lastKey = key;
				return key;
			};
		}

		// ── frosted glass ────────────────────────────────────────────────────

		/**
		 * Glass CSS, built from selectors verified against the live DOM.
		 *
		 * The composer input is addressed as `[class*="composerSeat"] [contenteditable]`
		 * The composer input is addressed by the app's own `data-composer-*` hooks
		 * rather than by class: the visible box is `[data-composer-card]`, whose class
		 * name carries a per-build hash (`uV2eYG_card` today).
		 *
		 * The sidebar's backdrop-filter lives on a separate fixed layer rather than
		 * on `sidebarCol` itself: `sidebarCol` must keep `position: relative` +
		 * `z-index: 9` for the content to sit above the blur, and it must NOT carry
		 * backdrop-filter, which would make it a containing block and trap the
		 * fixed-position settings dialog inside the sidebar.
		 * @param radius - glass blur radius in px.
		 */
		function glassCss(radius, opacity) {
			const blur = `${radius}px`;
			// A modest blur floor for the card: below it the wallpaper behind the input
			// still reads as a hard shape rather than a wash.
			const cardBlur = Math.max(radius, 16);
			// One knob drives both surfaces, and both are tinted with the THEME's own
			// surface colour rather than a hardcoded blue — the sidebar keeps its own
			// identity instead of turning into a foreign slab.
			const tint = clamp(Number(opacity), 0.2, 0.95);
			const darkTint = `rgba(20,24,36,${tint.toFixed(2)})`;
			const lightTint = `rgba(252,252,253,${Math.min(0.95, tint + 0.08).toFixed(2)})`;
			const darkSide = `rgba(21,21,23,${tint.toFixed(2)})`;
			const lightSide = `rgba(249,250,251,${tint.toFixed(2)})`;
			return `
[data-dsh-glass] [class*="composerSeat"] {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
}
/* The visible input box is the CARD, not the editable inside it.
   [data-composer-card] paints an OPAQUE theme colour (rgb(44,44,46) in the dark
   palette) behind the editable, so putting backdrop-filter on the inner editable
   blurred the card's own colour and nothing else — the glass was never actually
   visible. Both the empty-session hero and an active session render the same
   card, so this one rule covers both.

   Two opposite failures shaped this rule:
     - a light tint over a BUSY wallpaper let the image's dark areas read as a
       blotch inside the input box;
     - a heavy tint removed the blotch but made the panel a solid slab, leaving no
       glass to see at all.
   Since "how transparent should it be" is a matter of taste, the answer is the
   panel's 玻璃不透明度 slider rather than another guess: this rule only supplies a
   blur floor, a flat surface and a hairline border.
   The panel also stays FLAT: an earlier decorative top-to-bottom gradient measured
   as a 44-to-35 luminance drift and read as a dark band across the input. */
[data-dsh-glass] [data-composer-card] {
  backdrop-filter: blur(${cardBlur}px) saturate(150%);
  -webkit-backdrop-filter: blur(${cardBlur}px) saturate(150%);
  background-color: ${lightTint} !important;
  background-image: none !important;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.34), 0 8px 24px rgba(0,0,0,0.10) !important;
}
body[data-ds-dark-theme][data-dsh-glass] [data-composer-card] {
  background-color: ${darkTint} !important;
  background-image: none !important;
  box-shadow: inset 0 0 0 1px rgba(150,170,255,0.22), 0 8px 24px rgba(0,0,0,0.28) !important;
}
/* The editable must not paint a second surface on top of the card's glass. */
[data-dsh-glass] [data-composer-card] [data-composer-input] {
  background: transparent !important;
  box-shadow: none !important;
}
/* The sidebar column gets the SAME tint at the SAME opacity as the card, on top of
   the dedicated blur layer. Fully transparent read as a flat washed panel; v2's
   hardcoded rgba(20,28,50,0.55) gradient buried the wallpaper and turned the
   sidebar into a foreign slab. A theme-coloured translucent fill plus the blur is
   the frosted look, and it follows the one opacity knob. */
[data-dsh-glass] [class*="sidebarCol"] {
  position: relative !important;
  z-index: 9;
  background: ${lightSide} !important;
}
body[data-ds-dark-theme][data-dsh-glass] [class*="sidebarCol"] {
  background: ${darkSide} !important;
}
[data-dsh-glass] [data-dsh-bg-sidebar-blur] {
  backdrop-filter: blur(${blur}) saturate(150%);
  -webkit-backdrop-filter: blur(${blur}) saturate(150%);
  background: rgba(255,255,255,0.03);
}
body[data-ds-dark-theme][data-dsh-glass] [data-dsh-bg-sidebar-blur] {
  background: rgba(0,0,0,0.06);
}
/* Dialogs get the glass surface only. v2 also forced every DESCENDANT
   transparent, which stripped buttons and lists of their own backgrounds. */
[data-dsh-glass] [role="dialog"] {
  backdrop-filter: blur(${blur}) saturate(150%);
  -webkit-backdrop-filter: blur(${blur}) saturate(150%);
}
`;
		}

		/**
		 * Rules for surfaces that stop being the theme's own opaque colour.
		 *
		 * The app fades content out into `--dsw-alias-bg-base`: the sidebar's bottom
		 * scroll fade, the sticky composer fade, and the "running" row shimmer all do
		 * it. Over an OPAQUE fill those gradients blend invisibly; once the token is a
		 * translucent veil they paint a second veil on top of the first and read as a
		 * hard dark band.
		 *
		 * This lives in its OWN always-available style element rather than inside
		 * glassCss(): the condition is "is the sidebar still the theme's own fill",
		 * which is exactly the case glass is OFF — keeping it in the glass stylesheet
		 * meant the band stayed on screen for every wallpaper user without glass.
		 */
		const SURFACE_CSS = `
[data-dsh-sidebar-translucent] [class*="sidebarCol"] [class*="fade"] {
  background: transparent !important;
  background-image: none !important;
}
`;

		// ── panel building blocks ────────────────────────────────────────────

		let controlSeq = 0;

		function baseInputStyle() {
			return "width:100%;box-sizing:border-box;padding:5px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none";
		}

		/** A panel select, styled like the other inputs. */
		function selectBox() {
			const element = document.createElement("select");
			element.style.cssText = baseInputStyle();
			return element;
		}

		/**
		 * One select option.
		 *
		 * Chromium paints the open select popup with its OWN background (a light one)
		 * while the option text inherits the panel's label colour. In the dark theme
		 * that made every non-highlighted option light-on-light — visibly, the second
		 * entry of every dropdown was unreadable. Pinning both colours (and the
		 * control's `color-scheme`, set per theme in sync) fixes it.
		 * @param text - display text.
		 * @param value - option value.
		 */
		function option(text, value) {
			const element = document.createElement("option");
			element.value = value;
			element.textContent = text;
			element.style.backgroundColor = "var(--dsw-alias-bg-layer-2)";
			element.style.color = "var(--dsw-alias-label-primary)";
			return element;
		}

		/** One labelled control, with the label properly associated for a11y. */
		function field(labelText, control, hint) {
			const wrap = document.createElement("div");
			wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
			// Some rows are composite (an input plus a clear button), so point the label
			// at the first real control inside rather than at a plain container. A row can
			// also be a read-only readout with nothing labelable at all — then the caption
			// is a plain heading, never a <label> pointing at nothing.
			const direct = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
			const target = direct ? control : control.querySelector("input,select,textarea");
			const id = `dsh-bg-control-${++controlSeq}`;
			const caption = document.createElement(target === null ? "div" : "label");
			caption.textContent = labelText;
			caption.style.cssText = "font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary)";
			if (target !== null) {
				target.id = id;
				caption.htmlFor = id;
			}
			wrap.append(caption, control);
			if (hint !== undefined) {
				const tip = document.createElement("div");
				tip.textContent = hint;
				tip.style.cssText = "font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)";
				if (target !== null) {
					tip.id = `${id}-hint`;
					target.setAttribute("aria-describedby", tip.id);
				}
				wrap.append(tip);
			}
			return wrap;
		}

		function ghostButton(text, title) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = text;
			if (title !== undefined) button.title = title;
			button.style.cssText =
				"flex:none;font:inherit;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px";
			return button;
		}

		function checkRow(labelText) {
			const box = document.createElement("input");
			box.type = "checkbox";
			box.style.cssText = "accent-color:var(--dsw-alias-brand-primary);margin:0";
			const wrap = document.createElement("label");
			wrap.style.cssText =
				"display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer";
			wrap.append(box, document.createTextNode(labelText));
			return { wrap, box };
		}

		function sliderRow(labelText, min, max, step, format) {
			const input = document.createElement("input");
			input.type = "range";
			input.min = String(min);
			input.max = String(max);
			input.step = String(step);
			input.style.cssText = "width:100%;accent-color:var(--dsw-alias-brand-primary)";
			const readout = document.createElement("span");
			readout.setAttribute("aria-hidden", "true");
			readout.style.cssText = "color:var(--dsw-alias-label-secondary);font-size:11px;min-width:40px;text-align:right";
			const row = document.createElement("div");
			row.style.cssText = "display:flex;align-items:center;gap:8px";
			row.append(input, readout);
			const wrap = field(labelText, row);
			return {
				wrap,
				input,
				set: (value) => {
					input.value = String(value);
					readout.textContent = format(value);
				},
			};
		}

		/** Collapsible section. Native <details>, so it needs no JS and is keyboard accessible. */
		function section(title, open, ...children) {
			const details = document.createElement("details");
			details.open = open;
			const summary = document.createElement("summary");
			summary.textContent = title;
			summary.style.cssText =
				"cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);padding:2px 0;user-select:none";
			const content = document.createElement("div");
			content.style.cssText = "display:flex;flex-direction:column;gap:10px;padding:6px 0 2px";
			content.append(...children);
			details.append(summary, content);
			return details;
		}

		function formatBytes(bytes) {
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}

		// ── the floating control panel ───────────────────────────────────────

		/**
		 * Mount the control panel and the 🎨 toggle.
		 * @param api - `{ getView, stage, commit, reset, upload, listMedia, deleteMedia, setStatus }`.
		 * @returns `{ sync, setStatus, reportError, dispose }`.
		 */
		function mountPanel(api) {
			const root = document.createElement("div");
			root.setAttribute("data-dsh-background-panel", "");
			root.setAttribute("role", "dialog");
			root.setAttribute("aria-label", "背景定制");
			root.style.cssText =
				"position:fixed;right:16px;bottom:72px;z-index:2147483000;width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18);padding:14px 14px 12px;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);display:none;flex-direction:column;gap:10px;max-height:82vh;overflow-y:auto";

			const header = document.createElement("div");
			header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px";
			const title = document.createElement("span");
			title.textContent = `背景定制 v${VERSION} · ${BUILD}`;
			title.style.cssText = "font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)";
			const close = ghostButton("×", "收起面板");
			close.style.fontSize = "15px";
			close.style.padding = "0 6px";
			header.append(title, close);
			root.append(header);

			const status = document.createElement("div");
			status.setAttribute("role", "status");
			status.setAttribute("aria-live", "polite");
			status.textContent = "状态：加载中…";
			status.style.cssText = "font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)";
			root.append(status);

			const enabledRow = checkRow("启用自定义背景");
			root.append(enabledRow.wrap);

			// ── 壁纸 ──────────────────────────────────────────────────────────
			// There is no URL text box. The wallpaper is only ever produced by an
			// upload, so hand-typing its address was the least useful control on the
			// panel; the current wallpaper is reported as a read-only line instead,
			// and picking one again goes through the media library below.
			const currentMedia = document.createElement("div");
			currentMedia.style.cssText = "font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all";

			const fileInput = document.createElement("input");
			fileInput.type = "file";
			fileInput.accept = "image/*,.gif,.webp,video/mp4,video/webm,video/ogg";
			fileInput.style.cssText = "font-size:11px;color:var(--dsw-alias-label-secondary);max-width:100%";

			const clearMedia = ghostButton("清除壁纸");

			const sizeSelect = selectBox();
			for (const [value, text] of [
				["cover", "cover — 铺满裁剪"],
				["contain", "contain — 完整显示"],
				["auto", "auto — 原始尺寸"],
			]) {
				sizeSelect.append(option(text, value));
			}

			const positionSelect = selectBox();
			for (const value of ["center", "top", "bottom", "left", "right", "top left", "top right", "bottom left", "bottom right"]) {
				positionSelect.append(option(value, value));
			}

			root.append(
				section(
					"壁纸",
					true,
					field("选择本地图片 / 视频", fileInput, "选中即上传到媒体库并立刻生效"),
					field("当前壁纸", currentMedia),
					clearMedia,
					field("填充方式", sizeSelect),
					field("位置", positionSelect),
				),
			);

			// ── 画面调节 ──────────────────────────────────────────────────────
			const overlay = sliderRow("遮罩（变暗）", 0, 0.9, 0.05, (v) => Number(v).toFixed(2));
			const fade = sliderRow("淡化（融入主题底色）", 0, 0.9, 0.05, (v) => Number(v).toFixed(2));
			const blur = sliderRow("壁纸模糊（px）", 0, 60, 1, (v) => String(Math.round(Number(v))));
			const opacity = sliderRow("壁纸透明度", 0, 1, 0.05, (v) => Number(v).toFixed(2));
			root.append(section("画面调节", true, overlay.wrap, fade.wrap, blur.wrap, opacity.wrap));

			// ── 毛玻璃 ────────────────────────────────────────────────────────
			const glassRow = checkRow("毛玻璃效果（输入框 / 侧边栏 / 本面板）");
			const glassBlur = sliderRow("毛玻璃模糊（px）", 0, 40, 1, (v) => String(Math.round(Number(v))));
			const glassOpacity = sliderRow("玻璃不透明度", 0.2, 0.95, 0.05, (v) => Number(v).toFixed(2));
			root.append(section("毛玻璃", true, glassRow.wrap, glassBlur.wrap, glassOpacity.wrap));

			// ── 媒体库 ────────────────────────────────────────────────────────
			const libraryList = document.createElement("div");
			libraryList.style.cssText = "display:flex;flex-direction:column;gap:6px";
			const libraryRefresh = ghostButton("刷新媒体库");
			root.append(section("媒体库", false, libraryRefresh, libraryList));

			// ── 视频 ──────────────────────────────────────────────────────────
			const mediaTypeSelect = selectBox();
			for (const [value, text] of [
				["image", "图片 / 动图"],
				["video", "视频"],
			]) {
				mediaTypeSelect.append(option(text, value));
			}
			const mutedRow = checkRow("视频静音");
			root.append(section("视频", false, field("媒体类型", mediaTypeSelect, "上传视频后会自动切换"), mutedRow.wrap));

			// ── 其他 ──────────────────────────────────────────────────────────
			const gradientRow = checkRow("无壁纸时使用极光渐变");
			const sidebarRow = checkRow("侧边栏与壁纸同步淡化");
			const sidebarHint = document.createElement("div");
			sidebarHint.textContent = "关闭则侧边栏保持主题原色，完全不透出壁纸";
			sidebarHint.style.cssText = "font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);padding-left:22px";
			root.append(section("其他", false, gradientRow.wrap, sidebarRow.wrap, sidebarHint));

			const resetButton = ghostButton("恢复默认");
			root.append(resetButton);

			// ── wiring ────────────────────────────────────────────────────────

			// Stable hooks: field ids are generated, and the class hashes of the host
			// app change per build, so the panel's own controls carry a stable name.
			/** @param element - control to tag. @param name - stable field name. */
			const mark = (element, name) => {
				element.setAttribute("data-dsh-bg", name);
				return element;
			};
			mark(enabledRow.box, "enabled");
			mark(fileInput, "uploadFile");
			mark(currentMedia, "currentMedia");
			mark(clearMedia, "clearMedia");
			mark(sizeSelect, "size");
			mark(positionSelect, "position");
			mark(mediaTypeSelect, "mediaType");
			mark(mutedRow.box, "muted");
			mark(gradientRow.box, "gradient");
			mark(sidebarRow.box, "sidebar");
			mark(glassRow.box, "glass");
			mark(overlay.input, "overlay");
			mark(fade.input, "fade");
			mark(blur.input, "blur");
			mark(opacity.input, "opacity");
			mark(glassBlur.input, "glassBlur");
			mark(glassOpacity.input, "glassOpacity");
			mark(resetButton, "reset");
			mark(libraryRefresh, "libraryRefresh");
			mark(root, "panel");

			const setStatus = (text) => {
				status.textContent = `状态：${text}`;
			};
			const reportError = (text) => {
				status.textContent = `状态：${text}`;
				window.__dshBackgroundDebug.error = text;
			};

			enabledRow.box.addEventListener("change", () => api.commit({ enabled: enabledRow.box.checked }));

			clearMedia.addEventListener("click", () => {
				api.commit({ media: "" });
				setStatus("壁纸已清除");
			});

			// Choosing a file IS the action: no separate upload button, and the chosen
			// file becomes the wallpaper as soon as it lands in the media library.
			fileInput.addEventListener("change", () => {
				const file = fileInput.files !== null && fileInput.files.length > 0 ? fileInput.files[0] : null;
				if (file === null) return;
				setStatus(`上传中… ${file.name}`);
				api.upload(file).catch(() => {});
			});

			sizeSelect.addEventListener("change", () => api.commit({ size: sizeSelect.value }));
			positionSelect.addEventListener("change", () => api.commit({ position: positionSelect.value }));
			mediaTypeSelect.addEventListener("change", () => api.commit({ mediaType: mediaTypeSelect.value }));
			mutedRow.box.addEventListener("change", () => api.commit({ muted: mutedRow.box.checked }));
			gradientRow.box.addEventListener("change", () => api.commit({ gradient: gradientRow.box.checked }));
			sidebarRow.box.addEventListener("change", () => api.commit({ sidebar: sidebarRow.box.checked }));
			glassRow.box.addEventListener("change", () => api.commit({ glass: glassRow.box.checked }));

			// Sliders preview while dragging and persist once the pointer is released.
			for (const [control, fieldName] of [
				[overlay, "overlay"],
				[fade, "fade"],
				[blur, "blur"],
				[opacity, "opacity"],
				[glassBlur, "glassBlur"],
				[glassOpacity, "glassOpacity"],
			]) {
				control.input.addEventListener("input", () => api.stage({ [fieldName]: Number(control.input.value) }));
				control.input.addEventListener("change", () => api.commit({ [fieldName]: Number(control.input.value) }));
			}

			resetButton.addEventListener("click", () => api.reset());

			libraryRefresh.addEventListener("click", () => {
				api.listMedia().catch(() => {});
			});

			/** Render the media library list. */
			const renderLibrary = (items) => {
				libraryList.textContent = "";
				if (items.length === 0) {
					const empty = document.createElement("div");
					empty.textContent = "媒体库为空";
					empty.style.cssText = "font-size:11px;color:var(--dsw-alias-label-tertiary)";
					libraryList.append(empty);
					return;
				}
				const current = str(readOnly(api.getView(), "media", ""));
				for (const item of items) {
					const row = document.createElement("div");
					row.style.cssText =
						"display:flex;align-items:center;gap:8px;padding:4px;border-radius:6px;" +
						(item.url === current ? "outline:1px solid var(--dsw-alias-brand-primary)" : "");

					const thumb = document.createElement("div");
					thumb.style.cssText =
						"flex:none;width:42px;height:30px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);display:flex;align-items:center;justify-content:center;font-size:14px";
					if (item.kind === "image") {
						const image = document.createElement("img");
						image.src = item.url;
						image.alt = "";
						image.loading = "lazy";
						image.style.cssText = "width:100%;height:100%;object-fit:cover";
						thumb.append(image);
					} else {
						thumb.textContent = "🎬";
					}

					const meta = document.createElement("div");
					meta.style.cssText = "flex:1;min-width:0;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)";
					const name = document.createElement("div");
					name.textContent = item.name;
					name.style.cssText =
						"font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
					const facts = document.createElement("div");
					facts.textContent = `${item.kind === "video" ? "视频" : "图片"} · ${formatBytes(item.size)}`;
					meta.append(name, facts);

					const useButton = ghostButton("用作壁纸");
					useButton.addEventListener("click", () => api.useMedia(item));

					const deleteButton = ghostButton("删除");
					deleteButton.addEventListener("click", () => {
						api.deleteMedia(item).catch(() => {});
					});

					row.append(thumb, meta, useButton, deleteButton);
					libraryList.append(row);
				}
			};

			/** Reflect the settings into the controls, leaving focused ones alone. */
			const sync = () => {
				const view = api.getView();
				if (view === null || view === undefined) return;
				const idle = (element, apply) => {
					if (document.activeElement !== element) apply();
				};
				idle(enabledRow.box, () => {
					enabledRow.box.checked = view.enabled === true;
				});
				const media = str(view.media);
				// The read-only line is all the panel shows about the current wallpaper;
				// report the media file name rather than the whole URL.
				currentMedia.textContent = media === "" ? "未设置（使用极光渐变）" : decodeURIComponent(media.split("/").pop() ?? media);
				idle(sizeSelect, () => {
					sizeSelect.value = view.size === "contain" || view.size === "auto" ? view.size : "cover";
				});
				idle(positionSelect, () => {
					positionSelect.value = str(view.position) || "center";
				});
				idle(mediaTypeSelect, () => {
					mediaTypeSelect.value = view.mediaType === "video" ? "video" : "image";
				});
				// The open popup follows the control's color scheme, so keep it in step
				// with the active theme (the option colours are pinned in option()).
				const scheme = document.body.hasAttribute(DARK_ATTR) ? "dark" : "light";
				for (const select of [sizeSelect, positionSelect, mediaTypeSelect]) {
					if (select.style.colorScheme !== scheme) select.style.colorScheme = scheme;
				}
				idle(mutedRow.box, () => {
					mutedRow.box.checked = view.muted !== false;
				});
				idle(gradientRow.box, () => {
					gradientRow.box.checked = view.gradient !== false;
				});
				idle(sidebarRow.box, () => {
					sidebarRow.box.checked = view.sidebar !== false;
				});
				idle(glassRow.box, () => {
					glassRow.box.checked = view.glass === true;
				});
				if (document.activeElement !== overlay.input) overlay.set(clamp(num(view.overlay, 0), 0, 0.9));
				if (document.activeElement !== fade.input) fade.set(clamp(num(view.fade, 0), 0, 0.9));
				if (document.activeElement !== blur.input) blur.set(clamp(num(view.blur, 0), 0, 60));
				if (document.activeElement !== opacity.input) opacity.set(clamp(num(view.opacity, 1), 0, 1));
				if (document.activeElement !== glassBlur.input) glassBlur.set(clamp(num(view.glassBlur, 14), 0, 40));
				if (document.activeElement !== glassOpacity.input) glassOpacity.set(clamp(num(view.glassOpacity, 0.45), 0.2, 0.95));
			};

			// ── toggle button ─────────────────────────────────────────────────
			const toggleButton = document.createElement("button");
			toggleButton.type = "button";
			toggleButton.textContent = "🎨";
			toggleButton.title = "背景定制";
			toggleButton.setAttribute("aria-label", "背景定制");
			toggleButton.setAttribute("aria-expanded", "false");
			toggleButton.style.cssText =
				"position:fixed;right:16px;bottom:20px;z-index:2147483000;width:42px;height:42px;border-radius:50%;cursor:pointer;font-size:19px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 1px 6px rgba(0,0,0,0.08)";
			mark(toggleButton, "toggle");

			const setOpen = (open) => {
				root.style.display = open ? "flex" : "none";
				toggleButton.setAttribute("aria-expanded", open ? "true" : "false");
			};
			toggleButton.addEventListener("click", () => {
				setOpen(root.style.display === "none");
			});
			close.addEventListener("click", () => {
				setOpen(false);
			});

			// Collapse when clicking anywhere outside the panel and the toggle.
			const hideIfOutside = (event) => {
				if (root.style.display === "none") return;
				const target = event.target;
				if (target === null || target === undefined) return;
				if (root.contains(target) || toggleButton.contains(target)) return;
				setOpen(false);
			};
			document.addEventListener("click", hideIfOutside, true);

			document.body.append(root, toggleButton);

			/**
			 * Give the panel itself the frosted look, so the plugin's own interface
			 * follows the glass setting it controls instead of sitting on top of the
			 * wallpaper as an opaque slab.
			 *
			 * The tint stays much stronger than the composer's: this is a settings
			 * surface full of small text and controls, so readability wins over
			 * transparency. `color-mix` keeps it derived from the theme rather than a
			 * hardcoded colour, so it tracks light/dark on its own.
			 * @param on - whether the glass setting is enabled.
			 * @param radius - glass blur radius in px.
			 */
			const applyGlass = (on, radius) => {
				const tint = on ? "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent)" : "var(--dsw-alias-bg-layer-2)";
				root.style.background = tint;
				root.style.backdropFilter = on ? `blur(${radius}px) saturate(150%)` : "";
				root.style.webkitBackdropFilter = on ? `blur(${radius}px) saturate(150%)` : "";
				root.style.boxShadow = on ? "inset 0 0 0 1px rgba(255,255,255,0.10), 0 12px 40px rgba(0,0,0,0.32)" : "0 8px 32px rgba(0,0,0,.18)";
				// The toggle gets the same finish at a much stronger tint: it is a small
				// round target over a dark wallpaper, and a light tint there blurs into a
				// dark blob that swallows the icon.
				toggleButton.style.background = on ? "color-mix(in srgb, var(--dsw-alias-bg-layer-2) 88%, transparent)" : "var(--dsw-alias-bg-layer-2)";
				toggleButton.style.backdropFilter = on ? `blur(${radius}px) saturate(150%)` : "";
				toggleButton.style.webkitBackdropFilter = on ? `blur(${radius}px) saturate(150%)` : "";
			};

			return {
				sync,
				renderLibrary,
				setStatus,
				reportError,
				applyGlass,
				dispose: () => {
					document.removeEventListener("click", hideIfOutside, true);
					root.remove();
					toggleButton.remove();
				},
			};
		}

		// ── client plugin body ───────────────────────────────────────────────

		/**
		 * Read settings, paint the layer, pierce the surface token, drive glass and
		 * the panel.
		 * @param ctx - client cordis context.
		 */
		function apply(ctx) {
			const body = document.body;
			if (body === null) return;

			const glassTag = document.createElement("style");
			glassTag.setAttribute("data-dsh-background-glass", "");
			document.head.append(glassTag);
			const surfaceTag = document.createElement("style");
			surfaceTag.setAttribute("data-dsh-background-surface", "");
			document.head.append(surfaceTag);

			/**
			 * This namespace's derived settings form.
			 *
			 * The 0.1.6 call was `ctx.settingsScope.bind({ namespace: NS })`; the
			 * replacement is a ConfigFormController from the settings provider,
			 * keyed by the profile entry id. Its read/subscribe/mutate surface is
			 * the same shape the rest of this file already used, with one
			 * difference handled below: `mutate` reports refusal by RETURNING false
			 * instead of throwing, and only transport failures reject.
			 */
			const scope = ctx.configForms.get(NS);
			const scene = createScene(body);
			const applySurface = createSurfaceWriter(ctx.theme);

			let view = undefined;
			let suppressUntil = 0;
			let flushTimer = null;
			let pending = new Map();
			let flushing = false;
			let statusSettled = false;

			/** Repaint everything that depends on the settings. */
			const render = () => {
				try {
					const dark = body.hasAttribute(DARK_ATTR);
					window.__dshBackgroundDebug.tokenKey = applySurface(view);
					window.__dshBackgroundDebug.media = str(readOnly(view, "media", ""));
					const painted = scene.render(view, dark);
					window.__dshBackgroundDebug.scene = painted.kind;
					const glassOn = hasView() && view.enabled === true && view.glass === true;
					const glassRadius = clamp(num(readOnly(view, "glassBlur", 14), 14), 0, 40);
					const glassAlpha = clamp(num(readOnly(view, "glassOpacity", 0.45), 0.45), 0.2, 0.95);
					body.toggleAttribute("data-dsh-glass", glassOn);
					glassTag.textContent = glassOn ? glassCss(glassRadius, glassAlpha) : "";
					// The panel is part of the interface, so it follows the same setting.
					panel.applyGlass(glassOn, glassRadius);
					// Whether the sidebar still carries the theme's own opaque fill. Both
					// routes to a translucent sidebar — glass, and the wallpaper wash — need
					// the app's bottom scroll fade cleared; the fade's colour is the pierced
					// surface token and would otherwise stack into a visible dark band.
					const sidebarTranslucent =
						(hasView() && view.enabled === true) &&
						(glassOn || (painted.active && readOnly(view, "sidebar", true) !== false));
					body.toggleAttribute("data-dsh-sidebar-translucent", sidebarTranslucent);
					surfaceTag.textContent = sidebarTranslucent ? SURFACE_CSS : "";
					window.__dshBackgroundDebug.fade = num(readOnly(view, "fade", 0), 0);
					window.__dshBackgroundDebug.sidebar = readOnly(view, "sidebar", true) !== false;
					panel.sync();
					window.__dshBackgroundDebug.renderError = null;
				} catch (error) {
					const message = String((error !== null && error !== undefined && error.message) || error);
					window.__dshBackgroundDebug.renderError = message;
					panel.reportError(`渲染失败：${message}`);
				}
			};

			/** Replace the local view (optimistic) and repaint immediately. */
			const localize = (patch) => {
				view = { ...(view || {}), ...patch };
				render();
			};

			/**
			 * Whether the settings section is known yet.
			 *
			 * 0.1.6's scope returned `null` before the first read; the 0.1.7 form
			 * reports `value: undefined` while it is loading or unavailable, so every
			 * place that dereferenced `view` after the old null guard needs this.
			 */
			const hasView = () => view !== null && view !== undefined;

			/**
			 * Run one atomic namespace mutation and turn a REFUSAL into a throw.
			 *
			 * 0.1.6's scope.mutate rejected on failure. The 0.1.7 form resolves
			 * `false` when the Host refuses the write (or skips it in memory mode)
			 * and rejects only on a transport failure, so without this the panel
			 * would report success for a write that never landed.
			 * @param ops - ordered field operations.
			 */
			const commitOps = async (ops) => {
				const accepted = await scope.mutate(ops);
				if (accepted !== true) throw new Error("设置服务拒绝了这次写入");
			};

			/** Persist the accumulated patch as ONE atomic namespace mutation. */
			const flush = async () => {
				if (flushTimer !== null) {
					clearTimeout(flushTimer);
					flushTimer = null;
				}
				// A write is already crossing the wire: keep the patch queued and come
				// back, otherwise changes staged during it would never be persisted.
				if (flushing) {
					flushTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
					return;
				}
				if (pending.size === 0) return;
				const ops = [];
				for (const [fieldName, value] of pending) {
					if (value === "") ops.push({ op: "unset", path: [fieldName] });
					else ops.push({ op: "set", path: [fieldName], value });
				}
				pending = new Map();
				flushing = true;
				// Recording the exact ops makes "the write did not take effect" and "the
				// write was never made" distinguishable from the outside.
				window.__dshBackgroundDebug.lastOps = ops.map((op) => `${op.op} ${op.path.join(".") || "<root>"}${op.op === "set" ? `=${JSON.stringify(op.value)}` : ""}`);
				try {
					await commitOps(ops);
					suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS;
					window.__dshBackgroundDebug.writeBatches += 1;
					window.__dshBackgroundDebug.error = null;
				} catch (error) {
					window.__dshBackgroundDebug.writeFailures += 1;
					const message = String((error !== null && error !== undefined && error.message) || error);
					panel.reportError(`写入失败：${message}`);
					await load();
				} finally {
					flushing = false;
				}
			};

			/** Preview a change locally; persistence is debounced. */
			const stage = (patch) => {
				localize(patch);
				for (const [fieldName, value] of Object.entries(patch)) pending.set(fieldName, value);
				if (flushTimer !== null) clearTimeout(flushTimer);
				flushTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
			};

			/** Preview and persist now (discrete controls). */
			const commit = (patch) => {
				localize(patch);
				for (const [fieldName, value] of Object.entries(patch)) pending.set(fieldName, value);
				flush();
			};

			/** Clear the whole section in one op and re-read the result. */
			const reset = async () => {
				pending = new Map();
				try {
					// An empty path addresses the section root: this single op is the whole
					// reset. v2 wrote sixteen fields individually with a nested ternary of
					// defaults, which also made "the defaults" a second source of truth.
					await commitOps([{ op: "unset", path: [] }]);
					suppressUntil = Date.now() + SELF_WRITE_SUPPRESS_MS;
					window.__dshBackgroundDebug.writeBatches += 1;
					window.__dshBackgroundDebug.lastOps = ["unset <root>"];
					panel.setStatus("已恢复默认");
				} catch (error) {
					window.__dshBackgroundDebug.writeFailures += 1;
					panel.reportError(`恢复默认失败：${String((error && error.message) || error)}`);
				}
				await load();
			};

			/** Upload a file and adopt it as the wallpaper. */
			const upload = async (file) => {
				const form = new FormData();
				form.append("media", file);
				const response = await fetch(`${MEDIA_API}/upload`, { method: "POST", body: form });
				const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
				if (data.ok !== true) {
					panel.reportError(`上传失败：${data.error || "未知错误"}`);
					return;
				}
				const isVideo = str(data.mime).startsWith("video/");
				commit({ media: data.url, mediaType: isVideo ? "video" : "image" });
				panel.setStatus(`已上传 ${data.name}（${formatBytes(data.size)}）`);
				await listMedia();
			};

			/** Re-read the media library into the panel. */
			const listMedia = async () => {
				const response = await fetch(`${MEDIA_API}/media`);
				const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
				if (data.ok !== true) {
					panel.reportError(`媒体库读取失败：${data.error || "未知错误"}`);
					return;
				}
				panel.renderLibrary(data.items);
			};

			/** Adopt one library item as the wallpaper. */
			const useMedia = async (item) => {
				commit({ media: item.url, mediaType: item.kind === "video" ? "video" : "image" });
				panel.setStatus(`已选用 ${item.name}`);
				await listMedia();
			};

			/** Delete one library item, clearing the wallpaper if it was in use. */
			const deleteMedia = async (item) => {
				const response = await fetch(item.url, { method: "DELETE" });
				const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
				if (data.ok !== true) {
					panel.reportError(`删除失败：${data.error || "未知错误"}`);
					return;
				}
				if (str(readOnly(view, "media", "")) === item.url) commit({ media: "" });
				panel.setStatus(`已删除 ${item.name}`);
				await listMedia();
			};

			const panel = mountPanel({
				getView: () => view,
				stage,
				commit,
				reset,
				upload,
				listMedia,
				deleteMedia,
				useMedia,
			});

			/**
			 * Read the section from the settings mirror.
			 *
			 * At plugin start the mirror is still `loading`: the namespace has not been
			 * delivered yet, so a missing value means "not here yet", NOT "unavailable".
			 * Reporting the latter (and doing it once, at start-up) left the panel
			 * permanently claiming the settings namespace was broken while the wallpaper
			 * rendered correctly from those very settings.
			 */
			async function load() {
				try {
					const snapshot = scope.getSnapshot();
					if (snapshot.value !== undefined) view = snapshot.value;
					window.__dshBackgroundDebug.namespace = snapshot.status;
					window.__dshBackgroundDebug.loaded = snapshot.status === "ready";
					window.__dshBackgroundDebug.error = snapshot.status === "unavailable" ? "settings 命名空间不可用" : null;
					if (!statusSettled && snapshot.status !== "loading") {
						statusSettled = true;
						panel.setStatus(snapshot.status === "unavailable" ? "settings 命名空间不可用" : "就绪");
					}
				} catch (error) {
					const message = String((error !== null && error !== undefined && error.message) || error);
					window.__dshBackgroundDebug.error = message;
					panel.reportError(message);
				}
				render();
			}

			render();
			load();

			// Sidebar blur layer: a body-level fixed layer behind the sidebar, so the
			// sidebar itself never becomes a containing block for fixed modals.
			const sidebarBlur = document.createElement("div");
			sidebarBlur.setAttribute("data-dsh-bg-sidebar-blur", "");
			sidebarBlur.setAttribute("aria-hidden", "true");
			sidebarBlur.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:0;pointer-events:none";
			body.append(sidebarBlur);
			let resizeObserver = null;
			const syncSidebarBlur = () => {
				const column = document.querySelector('[class*="sidebarCol"]');
				if (column === null) return;
				const rect = column.getBoundingClientRect();
				sidebarBlur.style.left = `${rect.left}px`;
				sidebarBlur.style.top = `${rect.top}px`;
				sidebarBlur.style.width = `${rect.width}px`;
				sidebarBlur.style.height = `${rect.height}px`;
				if (resizeObserver === null && typeof ResizeObserver !== "undefined") {
					resizeObserver = new ResizeObserver(syncSidebarBlur);
					resizeObserver.observe(column);
				}
			};
			const waitObserver =
				typeof MutationObserver === "function" ? new MutationObserver(() => syncSidebarBlur()) : null;
			if (waitObserver !== null) {
				waitObserver.observe(body, { childList: true, subtree: true });
				ctx.effect(() => () => waitObserver.disconnect(), "dsh-background: sidebar geometry watch");
			}
			syncSidebarBlur();

			ctx.effect(
				() =>
					scope.subscribe(() => {
						if (Date.now() < suppressUntil) return;
						load();
					}),
				"dsh-background: settings invalidations",
			);

			// Deliberately repaints the LAYER only: applySurface() would call
			// overrideTokens(), which itself emits theme/change, and this listener
			// would run again — an unbounded write loop. The override layer already
			// carries both schemes, so the token needs no re-application here.
			ctx.on("theme/change", () => {
				try {
					const dark = body.hasAttribute(DARK_ATTR);
					window.__dshBackgroundDebug.scene = scene.render(view, dark).kind;
					// Keep the panel's select popups in the new colour scheme.
					panel.sync();
				} catch (error) {
					window.__dshBackgroundDebug.renderError = String((error && error.message) || error);
				}
			});

			// Fire-and-forget: ctx.effect would treat the returned promise as a disposer.
			listMedia().catch(() => {});

			return () => {
				if (flushTimer !== null) clearTimeout(flushTimer);
				if (waitObserver !== null) waitObserver.disconnect();
				if (resizeObserver !== null) resizeObserver.disconnect();
				sidebarBlur.remove();
				panel.dispose();
				scene.destroy();
				glassTag.remove();
				surfaceTag.remove();
				try {
					ctx.theme.overrideTokens(SOURCE, {});
				} catch (_releaseFailure) {
					/* nothing left to release */
				}
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
