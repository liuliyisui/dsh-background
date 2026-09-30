// Read files out of a packaged Electron `app.asar` without the `asar` package.
//
// The DSH desktop build ships its whole checkout inside `app.asar`, which Windows
// cannot traverse as a directory — and no token/live-probe route is available for
// that build, so the only way to read the shipped client CSS is to parse the
// archive. The format is a small pickle header followed by a JSON directory and the
// concatenated file bodies.
//
// Usage:
//   node tools/asar-read.mjs <app.asar> --list <dirPrefix>
//   node tools/asar-read.mjs <app.asar> <innerPath> [--grep <regex>] [--limit N]
import { closeSync, openSync, readFileSync, readSync } from "node:fs";

/**
 * Parse the archive header.
 * @param path - path to the .asar file.
 * @returns the JSON directory plus the byte offset where file bodies begin.
 */
function readArchive(path) {
	const fd = openSync(path, "r");
	try {
		const prefix = Buffer.alloc(16);
		readSync(fd, prefix, 0, 16, 0);
		const headerSize = prefix.readUInt32LE(4);
		// Real layout of this build, read off the bytes:
		//   u32 @0  = 4 (pickle payload size of the size field)
		//   u32 @4  = size of the whole header pickle
		//   u32 @8  = header pickle payload size again
		//   u32 @12 = length of the JSON directory
		//   JSON text @16
		// Bodies begin at 8 + headerSize, which equals 16 + jsonLength.
		const candidates = [
			{ start: 16, length: prefix.readUInt32LE(12) },
			{ start: 12, length: prefix.readUInt32LE(8) },
		];
		let directory = null;
		let usedStart = 16;
		const failures = [];
		for (const candidate of candidates) {
			if (!Number.isFinite(candidate.length) || candidate.length <= 0 || candidate.length > 64 * 1024 * 1024) continue;
			try {
				const json = Buffer.alloc(candidate.length);
				readSync(fd, json, 0, candidate.length, candidate.start);
				const parsed = JSON.parse(json.toString("utf8"));
				if (parsed !== null && typeof parsed === "object" && parsed.files !== undefined) {
					directory = parsed;
					usedStart = candidate.start;
					break;
				}
				failures.push(`@${candidate.start}: parsed without a files map`);
			} catch (error) {
				failures.push(`@${candidate.start}: ${error.message}`);
			}
		}
		if (directory === null) throw new Error(`could not parse the asar header (headerSize=${headerSize}) — ${failures.join("; ")}`);
		return { fd, directory, jsonStart: usedStart, contentOffset: 8 + headerSize };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** Walk the directory tree to one entry. */
function resolveEntry(directory, innerPath) {
	const parts = innerPath.split("/").filter((part) => part.length > 0);
	let node = directory;
	for (const part of parts) {
		if (node.files === undefined || node.files[part] === undefined) return null;
		node = node.files[part];
	}
	return node;
}

/** Collect every file path under a prefix. */
function listPaths(directory, prefix, out = [], trail = []) {
	for (const [name, node] of Object.entries(directory.files ?? {})) {
		const here = [...trail, name];
		if (node.files !== undefined) listPaths(node, prefix, out, here);
		else {
			const full = here.join("/");
			if (full.startsWith(prefix)) out.push(full);
		}
	}
	return out;
}

const [archivePath, innerPath] = process.argv.slice(2);
const flag = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
if (archivePath === undefined) {
	console.error("usage: node tools/asar-read.mjs <app.asar> <innerPath|--list <prefix>>");
	process.exit(2);
}

const { fd, directory, contentOffset } = readArchive(archivePath);
try {
	if (innerPath === "--list" || process.argv.includes("--list")) {
		const prefix = process.argv[process.argv.indexOf("--list") + 1] ?? "";
		const paths = listPaths(directory, prefix);
		console.log(`${paths.length} file(s) under "${prefix}"`);
		for (const path of paths.slice(0, Number(flag("--limit") ?? 60))) console.log("  " + path);
		process.exit(0);
	}

	const entry = resolveEntry(directory, innerPath);
	if (entry === null || entry.size === undefined) {
		console.error(`not found in archive: ${innerPath}`);
		process.exit(1);
	}
	// asar stores size/offset as decimal STRINGS; concatenating one silently produces a
	// giant bogus position.
	const size = Number(entry.size);
	const offset = Number(entry.offset);
	const body = Buffer.alloc(size);
	readSync(fd, body, 0, size, contentOffset + offset);
	const text = body.toString("utf8");

	const pattern = flag("--grep");
	if (pattern === undefined) {
		console.log(text);
	} else {
		const regex = new RegExp(pattern, "g");
		const lines = text.split(/\r?\n/);
		let shown = 0;
		const limit = Number(flag("--limit") ?? 40);
		lines.forEach((line, index) => {
			if (shown >= limit) return;
			if (!regex.test(line)) return;
			shown += 1;
			const trimmed = line.trim();
			console.log(`${String(index + 1).padStart(6)}: ${trimmed.length > 400 ? trimmed.slice(0, 400) + " …" : trimmed}`);
		});
		console.log(`-- ${shown} matching line(s) of ${lines.length} in ${innerPath} --`);
	}
} finally {
	closeSync(fd);
}
