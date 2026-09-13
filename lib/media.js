// dsh-background — media store + HTTP router (host half, v3).
//
// Deliberately free of any @deepseek-ai dependency so it can be exercised by a
// plain Node http server (test/media.test.mjs). index.js owns the settings
// namespace and hands this module a directory.
//
// v3 replaces the v2 upload path, which had two real defects:
//   1. it buffered the WHOLE upload in memory (readBody accumulated chunks and
//      Buffer.concat'd them, with a 512 MB ceiling) — a large video upload was a
//      memory spike by construction;
//   2. it located the file inside the multipart body with a lazy regular
//      expression over a latin1 string (`/Content-Type:...\r\n\r\n([\s\S]*?)\r\n--/`),
//      so any binary payload containing `\r\n--` truncated the file silently.
//
// v3 streams instead: a Transform parses the single part header, then holds back
// one delimiter length so a boundary split across chunks can never be written as
// payload, and `pipeline` gives real backpressure to the socket.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extname, join } from "node:path";

/** Extensions this plugin accepts, by media kind. */
const MIME_BY_EXT = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".ogv": "video/ogg",
	".mov": "video/quicktime",
	".m4v": "video/x-m4v",
};

const EXT_BY_MIME = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/ogg": ".ogv",
	"video/quicktime": ".mov",
	"video/x-m4v": ".m4v",
};

/** Upload ceiling. Enforced while streaming, so it never becomes an allocation. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** A multipart part header larger than this is not a header we understand. */
const MAX_PART_HEADER_BYTES = 64 * 1024;

/** An HTTP failure the router turns into a JSON error body with a real status. */
export class HttpError extends Error {
	/**
	 * @param status - HTTP status code.
	 * @param message - user-facing reason.
	 */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	res.end(body);
}

function megabytes(bytes) {
	return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Whether one stored file name is a plain leaf name this router will touch.
 * Rejects traversal, nesting, and the dotted temp names this module writes.
 * @param name - decoded path segment.
 */
export function isSafeLeafName(name) {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= 128 &&
		!name.startsWith(".") &&
		!name.includes("..") &&
		!name.includes("/") &&
		!name.includes("\\")
	);
}

/** @param ext - extension with leading dot. @returns media kind for the client. */
export function kindForExt(ext) {
	return (MIME_BY_EXT[String(ext).toLowerCase()] ?? "").startsWith("video/") ? "video" : "image";
}

/**
 * Parse one `Range` request header against a known length.
 * @param header - raw header value ("" when absent).
 * @param total - total resource length.
 * @returns `null` for no/unsupported range (serve the whole body), `"invalid"`
 * for a unsatisfiable range (416), otherwise the inclusive byte window.
 */
export function parseRange(header, total) {
	if (header.length === 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return null;
	const rawStart = match[1];
	const rawEnd = match[2];
	if (rawStart === "" && rawEnd === "") return "invalid";
	let start;
	let end;
	if (rawStart === "") {
		// Suffix form: the LAST n bytes.
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix === 0) return "invalid";
		start = Math.max(total - suffix, 0);
		end = total - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return "invalid";
	return { start, end };
}

/**
 * Streams one upload body into payload bytes.
 *
 * Handles both shapes the panel sends: `multipart/form-data` with a single file
 * part, and a bare body whose type comes from the request's own Content-Type.
 * The part header is parsed once from the first `\r\n\r\n`; the payload is then
 * forwarded with one delimiter length held back, which is what makes a boundary
 * split across TCP chunks safe.
 */
class MediaExtractor extends Transform {
	/**
	 * @param options - multipart flag, boundary marker, byte ceiling.
	 */
	constructor({ multipart, marker, maxBytes }) {
		super();
		this.multipart = multipart;
		this.marker = Buffer.from(multipart ? `\r\n--${marker}` : "");
		this.maxBytes = maxBytes;
		this.hash = createHash("sha1");
		this.bytes = 0;
		this.ext = "";
		this.head = Buffer.alloc(0);
		this.tail = Buffer.alloc(0);
		this.headDone = !multipart;
		this.terminated = false;
	}

	/** Hash, count, and forward one payload slice. */
	#payload(buf) {
		if (buf.length === 0) return;
		this.bytes += buf.length;
		if (this.bytes > this.maxBytes) throw new HttpError(413, `上传超过 ${megabytes(this.maxBytes)} 上限`);
		this.hash.update(buf);
		this.push(buf);
	}

	_transform(chunk, _encoding, callback) {
		try {
			let buf = chunk;
			if (!this.headDone) {
				this.head = this.head.length === 0 ? buf : Buffer.concat([this.head, buf]);
				const split = this.head.indexOf("\r\n\r\n");
				if (split < 0) {
					if (this.head.length > MAX_PART_HEADER_BYTES) throw new HttpError(400, "multipart 分片头部过大");
					callback();
					return;
				}
				const headerText = this.head.subarray(0, split).toString("latin1");
				const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
				const partType = typeMatch === null ? "" : typeMatch[1].trim().toLowerCase();
				const ext = EXT_BY_MIME[partType] ?? "";
				if (ext === "") throw new HttpError(415, `不支持的媒体类型：${partType === "" ? "未声明" : partType}`);
				this.ext = ext;
				this.headDone = true;
				buf = this.head.subarray(split + 4);
				this.head = Buffer.alloc(0);
			}
			if (!this.multipart) {
				this.#payload(buf);
				callback();
				return;
			}
			this.tail = this.tail.length === 0 ? buf : Buffer.concat([this.tail, buf]);
			const at = this.tail.indexOf(this.marker);
			if (at >= 0) {
				this.#payload(this.tail.subarray(0, at));
				this.tail = Buffer.alloc(0);
				this.terminated = true;
				callback();
				return;
			}
			if (this.tail.length > this.marker.length) {
				this.#payload(this.tail.subarray(0, this.tail.length - this.marker.length));
				this.tail = this.tail.subarray(this.tail.length - this.marker.length);
			}
			callback();
		} catch (error) {
			callback(error);
		}
	}

	_flush(callback) {
		try {
			// A body that never carried its terminator still has real bytes; keep
			// them rather than losing the tail to a truncated request.
			if (this.multipart && !this.terminated) this.#payload(this.tail);
			this.tail = Buffer.alloc(0);
			callback();
		} catch (error) {
			callback(error);
		}
	}
}

/**
 * Receive one upload and persist it under a content-addressed name.
 * @param req - the incoming request stream.
 * @param dir - media directory (created when missing).
 * @param maxBytes - byte ceiling.
 * @returns the stored file's name, size, and mime type.
 */
export async function storeUpload(req, dir, maxBytes = MAX_UPLOAD_BYTES) {
	const contentType = String(req.headers["content-type"] ?? "");
	const multipart = contentType.includes("multipart/form-data");
	const rawType = contentType.split(";")[0].trim().toLowerCase();

	const declared = Number(req.headers["content-length"] ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new HttpError(413, `上传超过 ${megabytes(maxBytes)} 上限`);
	}

	let marker = "";
	let rawExt = "";
	if (multipart) {
		const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
		if (match === null) throw new HttpError(400, "multipart 缺少 boundary");
		marker = (match[1] ?? match[2]).trim();
		if (marker === "") throw new HttpError(400, "multipart boundary 为空");
	} else {
		rawExt = EXT_BY_MIME[rawType] ?? "";
		if (rawExt === "") throw new HttpError(415, `不支持的媒体类型：${rawType === "" ? "未声明" : rawType}`);
	}

	await mkdir(dir, { recursive: true });
	const tempPath = join(dir, `.upload-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
	const extractor = new MediaExtractor({ multipart, marker, maxBytes });
	if (!multipart) extractor.ext = rawExt;

	try {
		await pipeline(req, extractor, createWriteStream(tempPath));
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
	if (extractor.bytes === 0) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw new HttpError(400, "上传内容为空");
	}
	// Content addressing makes a repeat upload of the same bytes a no-op instead
	// of a duplicate file, so the library does not grow on every retry.
	const name = `${extractor.hash.digest("hex").slice(0, 16)}${extractor.ext}`;
	await rename(tempPath, join(dir, name));
	return { name, size: extractor.bytes, mime: MIME_BY_EXT[extractor.ext] ?? "application/octet-stream" };
}

/**
 * Build the media library router.
 * @param options - `dir` (media directory), `prefix` (route prefix), `maxUploadBytes`.
 * @returns `{ handle, list }`; `handle` is the `(req, res)` webServer route.
 */
export function createMediaRouter({ dir, prefix = "/api/dsh-background", maxUploadBytes = MAX_UPLOAD_BYTES }) {
	const mediaUrl = (name) => `${prefix}/media/${encodeURIComponent(name)}`;

	/** Every stored media file, newest first. */
	async function list() {
		await mkdir(dir, { recursive: true });
		const names = await readdir(dir);
		const items = [];
		for (const name of names) {
			if (!isSafeLeafName(name)) continue;
			const info = await stat(join(dir, name)).catch(() => null);
			if (info === null || !info.isFile()) continue;
			const ext = extname(name).toLowerCase();
			items.push({
				name,
				url: mediaUrl(name),
				size: info.size,
				mtime: info.mtimeMs,
				kind: kindForExt(ext),
				mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
			});
		}
		items.sort((a, b) => b.mtime - a.mtime);
		return items;
	}

	/** Serve one stored file, honouring Range so video can seek. */
	async function serve(req, res, name) {
		const full = join(dir, name);
		const info = await stat(full).catch(() => null);
		if (info === null || !info.isFile()) {
			sendJson(res, 404, { ok: false, error: "媒体不存在" });
			return;
		}
		const total = info.size;
		const headers = {
			"content-type": MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream",
			"accept-ranges": "bytes",
			"cache-control": "public, max-age=31536000, immutable",
		};
		const range = parseRange(String(req.headers.range ?? ""), total);
		if (range === "invalid") {
			res.writeHead(416, { "content-range": `bytes */${total}`, "content-type": "text/plain; charset=utf-8" });
			res.end();
			return;
		}
		if (req.method === "HEAD") {
			res.writeHead(200, { ...headers, "content-length": total });
			res.end();
			return;
		}
		if (range === null) {
			res.writeHead(200, { ...headers, "content-length": total });
			await pipeline(createReadStream(full), res);
			return;
		}
		res.writeHead(206, {
			...headers,
			"content-length": range.end - range.start + 1,
			"content-range": `bytes ${range.start}-${range.end}/${total}`,
		});
		await pipeline(createReadStream(full, { start: range.start, end: range.end }), res);
	}

	/** Remove one stored file. */
	async function remove(name) {
		const full = join(dir, name);
		const info = await stat(full).catch(() => null);
		if (info === null || !info.isFile()) throw new HttpError(404, "媒体不存在");
		await rm(full, { force: true });
		return { name };
	}

	async function route(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = decodeURIComponent(url.pathname);
		const mediaPrefix = `${prefix}/media/`;

		if (pathname === `${prefix}/media` && req.method === "GET") {
			sendJson(res, 200, { ok: true, items: await list() });
			return;
		}
		if (pathname === `${prefix}/upload` && req.method === "POST") {
			const stored = await storeUpload(req, dir, maxUploadBytes);
			sendJson(res, 200, { ok: true, ...stored, url: mediaUrl(stored.name) });
			return;
		}
		if (pathname.startsWith(mediaPrefix)) {
			const name = pathname.slice(mediaPrefix.length);
			if (!isSafeLeafName(name)) {
				sendJson(res, 400, { ok: false, error: "非法的媒体名" });
				return;
			}
			if (req.method === "GET" || req.method === "HEAD") {
				await serve(req, res, name);
				return;
			}
			if (req.method === "DELETE") {
				sendJson(res, 200, { ok: true, ...(await remove(name)) });
				return;
			}
		}
		sendJson(res, 404, { ok: false, error: "not found" });
	}

	/** webServer route handler: never rejects, always answers. */
	const handle = (req, res) => {
		route(req, res).catch((error) => {
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : String(error);
			if (res.headersSent) res.destroy();
			else sendJson(res, status, { ok: false, error: message });
		});
	};

	return { handle, list, dir, mediaUrl };
}
