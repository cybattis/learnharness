import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { dictationWav, parseLocalDictation, validDictationWav, LOCAL_DICTATION_AUTH, LOCAL_DICTATION_MAX_BYTES } from "../src/core/local-dictation.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

const directory = mkdtempSync(path.join(tmpdir(), "lh-local-dictation-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
after(() => rmSync(directory, { recursive: true, force: true }));
const { transcribeLocal, localDictationPost, dictationCredentialsGet, dictationCredentialsPut } = await import("../src/server/local-dictation.ts");
const { readDictationAuth } = await import("../src/store/auth.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { resolveKeyStatuses } = await import("../src/server/keys.ts");
const local = { server: "llama.cpp" as const, url: "http://localhost:8080/v1/audio/transcriptions", model: "lfm3" };
const wav = dictationWav([new Int16Array([0, -32768, 32767]).buffer]);

test("WAV encoding preserves PCM samples and validates the exact upload contract", () => {
	assert(validDictationWav(wav));
	assert.equal(new DataView(wav.buffer).getInt16(46, true), -32768);
	const broken = wav.slice(); broken[24] = 1;
	assert(!validDictationWav(broken));
	assert(!validDictationWav(new Uint8Array(44)));
	assert.throws(() => dictationWav([]), /empty/);
	assert.throws(() => dictationWav([new ArrayBuffer(LOCAL_DICTATION_MAX_BYTES)]), /limit/);
});

test("local settings validate independently of cloud language and survive sanitization", () => {
	const dictation = { provider: "local", language: "multi", local };
	assert.deepEqual(parseDictationSettingsBody(dictation), { ok: true, settings: dictation });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation })?.dictation, dictation);
	assert.equal(parseDictationSettingsBody({ provider: "local" }).ok, false);
	for (const url of ["file:///tmp/test", "http://user:password@localhost/inference", "http://localhost/inference?key=secret"]) assert.equal(parseLocalDictation({ ...local, url }), undefined);
	assert.equal(parseLocalDictation({ ...local, language: "multi" }), undefined);
});

for (const server of ["llama.cpp", "whisper.cpp"] as const) test(`${server} receives WAV multipart with correct language and model`, async () => {
	const url = server === "llama.cpp" ? local.url : "http://localhost:8081/inference";
	for (const language of [undefined, "auto", "fr"]) {
		const text = await transcribeLocal(wav, { server, url, model: "speech", language }, "secret", new AbortController().signal, async (input, init) => {
			assert.equal(input, url); assert.equal(init?.redirect, "manual");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
			assert(init?.body instanceof FormData);
			assert.equal(init.body.get("model"), "speech");
			assert.equal(init.body.get("response_format"), "json");
			assert.equal(init.body.get("language"), language === "fr" ? "fr" : server === "whisper.cpp" ? "auto" : null);
			const file = init.body.get("file"); assert(file instanceof Blob);
			assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wav);
			return Response.json({ type: "transcript.text.done", text: " Bonjour " });
		});
		assert.equal(text, "Bonjour");
	}
});

test("endpoint failures, redirects, invalid and oversized responses remain explicit", async () => {
	for (const response of [new Response("secret error", { status: 401 }), new Response(null, { status: 302 }), Response.json({ unrelated: "bad" }), new Response("x", { headers: { "content-length": String(2 * 1024 * 1024) } })]) {
		await assert.rejects(transcribeLocal(wav, local, undefined, new AbortController().signal, async () => response));
	}
});

test("private bearer credentials are endpoint-bound, redacted, and excluded from key inventory", async () => {
	writeSettings({ version: 1, dictation: { provider: "local", local } });
	const put = (origin: string) => dictationCredentialsPut(new Request("http://localhost/api/stt/credentials", {
		method: "PUT", headers: { origin, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ url: local.url, key: "secret-key" }),
	}));
	assert.equal((await put("http://foreign.invalid")).status, 403);
	assert.equal((await put("http://localhost")).status, 200);
	assert.deepEqual(readDictationAuth(), { url: local.url, key: "secret-key" });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: true });
	assert(!resolveKeyStatuses({ [LOCAL_DICTATION_AUTH]: "secret-key" }, {}, new Set()).some((row) => row.id === LOCAL_DICTATION_AUTH));
	writeSettings({ version: 1, dictation: { provider: "local", local: { ...local, url: "http://localhost:9999/inference" } } });
	assert.deepEqual(await dictationCredentialsGet().json(), { keyPresent: false });
});

test("upload rejects changed configuration, oversized bodies, invalid WAV, and foreign origins", async () => {
	writeSettings({ version: 1, dictation: { provider: "local", local } });
	const request = (config: unknown, data = wav, extra: Record<string, string> = {}) => new Request("http://localhost/api/stt/transcribe", {
		method: "POST", body: data, headers: { host: "localhost", origin: "http://localhost", "x-dictation-config": encodeURIComponent(JSON.stringify(config)), ...extra },
	});
	assert.equal((await localDictationPost(request({ ...local, model: "different" }))).status, 409);
	assert.equal((await localDictationPost(request(local, wav, { "content-length": String(LOCAL_DICTATION_MAX_BYTES + 1) }))).status, 413);
	assert.equal((await localDictationPost(request(local, new Uint8Array(44)))).status, 400);
	assert.equal((await localDictationPost(request(local, wav, { origin: "http://foreign.invalid" }))).status, 403);
});
