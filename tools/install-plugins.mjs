// Port the three self-built plugins from the `web` profile into a target profile.
//
// Usage: node install-plugins.mjs <target-profile-dir>
//
// Steps, each idempotent:
//   1. copy dsh-background / dsh-master / deepseek-balance into <target>/node_modules
//   2. add the three names to package.json's dsh.profile.bundles
//   3. append the dsh-background `ui-background` settings entry (with the user's
//      wallpaper values) to cordis.patch.yml, unless it is already present
//
// Sources are the copies already installed and verified in the `web` profile:
// the dsh-background there is the 0.1.7-rc.1 port (configForms + exported Config),
// not the original 0.1.6 build.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
	console.error("usage: node install-plugins.mjs <target-profile-dir>");
	process.exit(2);
}

const WEB = "C:/Users/电脑/.dsh/profiles/web/node_modules";
const PLUGINS = ["dsh-background", "dsh-master", "deepseek-balance"];
const BACKGROUND_NS = "ui-background";

/** Wallpaper values carried over from the web profile's verified configuration. */
const BACKGROUND_CONFIG = `- id: ${BACKGROUND_NS}
  name: dsh-background
  config:
    enabled: true
    glass: true
    opacity: 0.35
    media: /api/dsh-background/media/7cbb847ebc36a728.jpg
    mediaType: image`;

const report = { target, copied: [], bundles: null, patchAppended: false, notes: [] };

// ── 1. copy plugin trees ────────────────────────────────────────────────────
const modules = join(target, "node_modules");
mkdirSync(modules, { recursive: true });
for (const name of PLUGINS) {
	const from = join(WEB, name);
	const to = join(modules, name);
	if (!existsSync(from)) {
		report.notes.push(`SOURCE MISSING: ${from}`);
		continue;
	}
	rmSync(to, { recursive: true, force: true });
	cpSync(from, to, { recursive: true });
	report.copied.push(name);
}

// ── 2. register the bundles ─────────────────────────────────────────────────
const pkgPath = join(target, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
for (const name of PLUGINS) {
	if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
	// A file: path keeps a later `pnpm install` from deleting the tree while
	// leaving our copies in place; the trees above are the actual artifacts.
	pkg.dependencies[name] ??= `file:${join(modules, name).replace(/\\/g, "/")}`;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
report.bundles = pkg.dsh.profile.bundles;

// ── 3. append the settings entry ────────────────────────────────────────────
const patchPath = join(target, "cordis.patch.yml");
let patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
if (patch.includes(`- id: ${BACKGROUND_NS}`)) {
	report.notes.push("ui-background entry already present, left as is");
} else {
	const header = [
		"",
		"# dsh-background settings. Since 0.1.7-rc.1 a settings surface is the profile",
		"# entry's own config, and the entry id IS the namespace the browser half asks",
		"# for (ui-background). Values carried over from the web profile.",
	].join("\n");
	patch = `${patch.replace(/\s*$/, "")}\n${header}\n${BACKGROUND_CONFIG}\n`;
	writeFileSync(patchPath, patch, "utf8");
	report.patchAppended = true;
}

console.log(JSON.stringify(report, null, 2));
