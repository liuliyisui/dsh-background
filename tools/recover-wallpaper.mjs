// Recover the v2 wallpaper out of the desktop app's Local Storage.
//
// v2 kept the wallpaper as an inline `data:image/...;base64,...` string in
// localStorage (key `dsh-background.image`) and unset the settings field to
// compensate. v3 addresses wallpapers by media-library URL and no longer reads
// localStorage, so that image would be lost on the first refresh. This tool
// extracts it from the Chromium LevelDB on disk (read-only), validates it, and
// installs it into the media library under v3's content-addressed name.
//
// Usage: node tools/recover-wallpaper.mjs [--install]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOCAL_STORAGE = join(process.env.APPDATA ?? "", "dsh-desktop", "Local Storage", "leveldb");
const KEY = "dsh-background.image";
const INSTALL = process.argv.includes("--install");

/** Every byte offset of `needle` inside `haystack`. */
function offsets(haystack, needle) {
	const out = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		out.push(at);
		at = haystack.indexOf(needle, at + 1);
	}
	return out;
}

/**
 * Read the value that follows one LevelDB Local Storage key.
 *
 * Chromium frames an entry as `_<origin>\x00\x01<user key>` + a value type tag
 * (0x00 UTF-16 / 0x01 Latin-1) + a short header, and the Latin-1 payload is then
 * a contiguous printable run. Rather than decode that framing, start at the
 * `data:` payload and take the maximal printable run — the run ends exactly
 * where LevelDB's block framing resumes.
 * @param buffer - whole .ldb/.log file.
 * @param start - byte offset just past the key.
 * @returns the payload text, or "" when no data URL follows.
 */
function readDataUrlValue(buffer, start) {
	const limit = Math.min(buffer.length, start + 256);
	let at = -1;
	for (let i = start; i < limit; i += 1) {
		if (buffer[i] === 0x64 && buffer.toString("latin1", i, i + 5) === "data:") {
			at = i;
			break;
		}
	}
	if (at === -1) return "";
	let text = "";
	for (let i = at; i < buffer.length; i += 1) {
		const byte = buffer[i];
		if (byte < 0x20 || byte > 0x7e) break;
		text += String.fromCharCode(byte);
	}
	return text;
}

if (!existsSync(LOCAL_STORAGE)) {
	console.error(`no Local Storage directory at ${LOCAL_STORAGE}`);
	process.exit(1);
}

const found = [];
for (const name of readdirSync(LOCAL_STORAGE)) {
	if (!name.endsWith(".ldb") && !name.endsWith(".log")) continue;
	const buffer = readFileSync(join(LOCAL_STORAGE, name));
	for (const at of offsets(buffer, Buffer.from(KEY, "latin1"))) {
		const value = readDataUrlValue(buffer, at + KEY.length);
		found.push({ file: name, value });
	}
}

if (found.length === 0) {
	console.error(`key ${KEY} not found in ${LOCAL_STORAGE}`);
	process.exit(1);
}

for (const entry of found) {
	console.log(`file            : ${entry.file}`);
	console.log(`value length    : ${entry.value.length} chars`);
	const match = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(entry.value);
	if (match === null) {
		console.log(`value           : not a base64 data URL -> ${entry.value.slice(0, 80)}`);
		continue;
	}
	const mime = match[1];
	const base64 = match[2];
	console.log(`mime            : ${mime}`);
	console.log(`base64 chars    : ${base64.length}`);
	// The run may stop at a compressed LevelDB block boundary; a truncated base64
	// payload is exactly what that looks like, so report it rather than guess.
	const padding = base64.endsWith("==") || base64.endsWith("=");
	const bytes = Buffer.from(base64, "base64");
	console.log(`decoded bytes   : ${bytes.length}`);
	console.log(`base64 complete : ${padding && base64.length % 4 === 0}`);
	console.log(`JPEG SOI        : ${bytes[0] === 0xff && bytes[1] === 0xd8}`);
	console.log(`JPEG EOI        : ${bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9}`);

	const extension = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".jpg";
	const name = `${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}${extension}`;
	console.log(`content name    : ${name}`);

	const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
	const dir = join(home, "skin-aurora-media");
	const existing = existsSync(join(dir, name));
	console.log(`already in media: ${existing}`);

	if (INSTALL && padding) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), bytes);
		console.log(`installed       : ${join(dir, name)}`);
	} else if (!INSTALL) {
		console.log("dry run — pass --install to write it into the media library");
	}
}
