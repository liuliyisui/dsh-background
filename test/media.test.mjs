// dsh-background v3 — media router tests.
//
// Runs the router on a plain Node http server, with no DSH runtime involved, so
// the two v2 upload defects can be pinned down directly:
//   - the old reader buffered the whole body in memory;
//   - the old multipart reader cut the payload at the first `\r\n--` it found,
//     which silently truncated any binary file that happened to contain it.
//
// Usage: node test/media.test.mjs
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaRouter } from "../lib/media.js";

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n        ${detail}`}`);
}

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function pseudoRandom(size, seed = 1) {
	const out = Buffer.alloc(size);
	let state = seed >>> 0;
	for (let i = 0; i < size; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = (state >>> 24) & 0xff;
	}
	return out;
}

/** Build a single-file multipart body the way a browser FormData would. */
function multipart(boundary, { filename, contentType, data }) {
	const head = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
		"latin1",
	);
	return Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`, "latin1")]);
}

/** POST a body in small chunks so any boundary spans several TCP writes. */
function postChunked(base, pathname, body, contentType, chunkSize) {
	return new Promise((resolve, reject) => {
		const target = new URL(pathname, base);
		const request = fetch(target, {
			method: "POST",
			headers: { "content-type": contentType, "content-length": String(body.length) },
			body: new ReadableStream({
				start(controller) {
					for (let offset = 0; offset < body.length; offset += chunkSize) {
						controller.enqueue(body.subarray(offset, offset + chunkSize));
					}
					controller.close();
				},
			}),
			duplex: "half",
		});
		request.then(
			async (response) => resolve({ status: response.status, body: await response.json() }),
			reject,
		);
	});
}

async function post(base, pathname, body, contentType) {
	const response = await fetch(new URL(pathname, base), {
		method: "POST",
		headers: { "content-type": contentType, "content-length": String(body.length) },
		body,
	});
	return { status: response.status, body: await response.json() };
}

const sha1 = (buffer) => createHash("sha1").update(buffer).digest("hex");

const dir = mkdtempSync(join(tmpdir(), "dsh-bg-media-"));
const router = createMediaRouter({ dir, prefix: "/api/dsh-background" });
const server = createServer(router.handle);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
	// 1. Multipart upload whose payload contains a near-boundary sequence.
	//    The v2 reader truncated at the first `\r\n--`; a correct reader keeps it.
	const boundary = "----dshTestBoundaryXyZ123";
	const tricky = Buffer.concat([
		Buffer.from("PNG-HEADER", "latin1"),
		Buffer.from("\r\n--XyZ", "latin1"),
		pseudoRandom(64 * 1024, 7),
		Buffer.from("\r\n--dshTest", "latin1"),
		pseudoRandom(32 * 1024, 11),
	]);
	const trickyBody = multipart(boundary, { filename: "tricky.png", contentType: "image/png", data: tricky });
	const uploaded = await postChunked(base, "/api/dsh-background/upload", trickyBody, `multipart/form-data; boundary=${boundary}`, 997);
	check("multipart upload accepted", uploaded.status === 200 && uploaded.body.ok === true, JSON.stringify(uploaded.body));
	check(
		"payload containing CRLF-- is not truncated",
		uploaded.body.size === tricky.length && uploaded.body.name.startsWith(sha1(tricky).slice(0, 16)),
		`size=${uploaded.body.size} expected=${tricky.length} name=${uploaded.body.name}`,
	);

	const fetched = await fetch(new URL(uploaded.body.url, base));
	const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
	check(
		"served bytes are byte-identical to the upload",
		fetchedBytes.length === tricky.length && sha1(fetchedBytes) === sha1(tricky),
		`len=${fetchedBytes.length}/${tricky.length}`,
	);

	// 2. Bare-body upload with the type on the request itself.
	const rawPng = pseudoRandom(4096, 21);
	const rawUpload = await post(base, "/api/dsh-background/upload", rawPng, "image/png");
	check("raw-body upload accepted", rawUpload.status === 200 && rawUpload.body.ok === true, JSON.stringify(rawUpload.body));
	check("raw-body upload keeps its size", rawUpload.body.size === rawPng.length, `size=${rawUpload.body.size}`);

	// 3. Content addressing: the same bytes must not create a second file.
	const repeat = await post(base, "/api/dsh-background/upload", rawPng, "image/png");
	check("identical bytes reuse the same stored file", repeat.body.name === rawUpload.body.name, `${repeat.body.name} vs ${rawUpload.body.name}`);

	// 4. A large upload, to prove it streams rather than buffering.
	const big = pseudoRandom(8 * 1024 * 1024, 99);
	const bigBody = multipart(boundary, { filename: "big.mp4", contentType: "video/mp4", data: big });
	const bigUpload = await postChunked(base, "/api/dsh-background/upload", bigBody, `multipart/form-data; boundary=${boundary}`, 64 * 1024);
	check("8MB multipart upload accepted", bigUpload.status === 200 && bigUpload.body.ok === true, JSON.stringify(bigUpload.body));
	check("8MB upload is complete and correctly hashed", bigUpload.body.size === big.length && bigUpload.body.name.startsWith(sha1(big).slice(0, 16)), `size=${bigUpload.body.size} expected=${big.length}`);
	check("video mime detected from the part header", bigUpload.body.mime === "video/mp4", bigUpload.body.mime);

	// 5. Range requests, which is what lets a video wallpaper seek.
	const ranged = await fetch(new URL(uploaded.body.url, base), { headers: { range: "bytes=10-19" } });
	const rangedBytes = Buffer.from(await ranged.arrayBuffer());
	check("range request answers 206", ranged.status === 206, `status=${ranged.status}`);
	check("range request returns the exact window", rangedBytes.equals(tricky.subarray(10, 20)), rangedBytes.toString("latin1"));
	check("range request reports content-range", ranged.headers.get("content-range") === `bytes 10-19/${tricky.length}`, String(ranged.headers.get("content-range")));

	const suffix = await fetch(new URL(uploaded.body.url, base), { headers: { range: "bytes=-4" } });
	check("suffix range returns the last bytes", Buffer.from(await suffix.arrayBuffer()).equals(tricky.subarray(tricky.length - 4)), "");

	const beyond = await fetch(new URL(uploaded.body.url, base), { headers: { range: `bytes=${tricky.length + 10}-` } });
	check("unsatisfiable range answers 416", beyond.status === 416, `status=${beyond.status}`);
	await beyond.arrayBuffer();

	// 6. Listing.
	const listResponse = await fetch(new URL("/api/dsh-background/media", base));
	const list = await listResponse.json();
	const names = list.items.map((item) => item.name);
	check("library lists every stored file", list.ok === true && names.includes(uploaded.body.name) && names.includes(bigUpload.body.name), names.join(","));
	check("library reports kinds", list.items.find((i) => i.name === bigUpload.body.name)?.kind === "video" && list.items.find((i) => i.name === uploaded.body.name)?.kind === "image", JSON.stringify(list.items.map((i) => [i.name, i.kind])));
	check("temp upload files are hidden from the library", !names.some((name) => name.startsWith(".")), names.join(","));

	// 7. Unsupported and malformed uploads.
	const badType = await post(base, "/api/dsh-background/upload", Buffer.from("hello"), "text/plain");
	check("unsupported raw type answers 415", badType.status === 415, `status=${badType.status} ${JSON.stringify(badType.body)}`);

	const badPart = multipart(boundary, { filename: "note.txt", contentType: "text/plain", data: Buffer.from("hello") });
	const badPartResponse = await post(base, "/api/dsh-background/upload", badPart, `multipart/form-data; boundary=${boundary}`);
	check("unsupported part type answers 415", badPartResponse.status === 415, `status=${badPartResponse.status} ${JSON.stringify(badPartResponse.body)}`);

	const noBoundary = await post(base, "/api/dsh-background/upload", Buffer.from("x"), "multipart/form-data");
	check("multipart without a boundary answers 400", noBoundary.status === 400, `status=${noBoundary.status}`);

	const empty = await post(base, "/api/dsh-background/upload", Buffer.alloc(0), "image/png");
	check("empty upload answers 400", empty.status === 400, `status=${empty.status} ${JSON.stringify(empty.body)}`);

	// 8. Path traversal must never reach the filesystem.
	for (const attack of ["..%2F..%2Fsettings.yaml", "%2e%2e%2f%2e%2e%2fsettings.yaml", "..%5C..%5Csettings.yaml"]) {
		const response = await fetch(new URL(`/api/dsh-background/media/${attack}`, base));
		check(`traversal blocked: ${attack}`, response.status === 400, `status=${response.status}`);
		await response.arrayBuffer();
	}

	// 9. Delete, then confirm it is gone.
	const removed = await fetch(new URL(rawUpload.body.url, base), { method: "DELETE" });
	const removedBody = await removed.json();
	check("delete succeeds", removed.status === 200 && removedBody.ok === true, JSON.stringify(removedBody));
	const gone = await fetch(new URL(rawUpload.body.url, base));
	check("deleted media answers 404", gone.status === 404, `status=${gone.status}`);
	await gone.arrayBuffer();

	const deleteMissing = await fetch(new URL("/api/dsh-background/media/deadbeef00.png", base), { method: "DELETE" });
	check("deleting a missing file answers 404", deleteMissing.status === 404, `status=${deleteMissing.status}`);
	await deleteMissing.arrayBuffer();

	// 10. No temp files left behind.
	const leftovers = readdirSync(dir).filter((name) => name.startsWith(".upload-"));
	check("no temp upload files left behind", leftovers.length === 0, leftovers.join(","));
} finally {
	server.close();
	rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
	console.error(`\nFAILED:\n${failed.map((f) => `  - ${f.name}${f.detail === undefined ? "" : `: ${f.detail}`}`).join("\n")}`);
	process.exit(1);
}
