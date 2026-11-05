import type { UserSettings } from "../core/settings.ts";
import { LOCAL_DICTATION_MAX_BYTES, LOCAL_DICTATION_TIMEOUT_MS, normalizeDictationUrl, parseLocalDictation, validDictationWav, type LocalDictationSettings } from "../core/local-dictation.ts";
import { readDictationAuth, writeDictationAuth } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const failure = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

function authorized(request: Request): boolean {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	try {
		return request.headers.get("origin") === subscriptionRequestOrigin(request) &&
			(!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	} catch { return false; }
}

export function dictationCredentialsGet(): Response {
	try {
		const auth = readDictationAuth();
		return Response.json({ keyPresent: Boolean(auth?.key && auth.url === readSettings()?.dictation?.local?.url) }, { headers: { "cache-control": "no-store" } });
	} catch { return failure("Local dictation credential storage unavailable", 503); }
}

export async function dictationCredentialsPut(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Use the LearnHarness settings window", 403);
	try {
		const body = await readBoundedJson(request, 16_384);
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid credential request");
		const { url: rawUrl, key } = body as Record<string, unknown>;
		const url = normalizeDictationUrl(rawUrl);
		if (!url || typeof key !== "string" || key.length > 8192 || /[\r\n\x00-\x1f\x7f-\uffff]/.test(key)) return failure("Invalid endpoint or bearer key");
		writeDictationAuth(url, key.trim());
		return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return failure(error instanceof CustomBodyLimitError ? "Credential request too large" : "Could not save local dictation key", error instanceof CustomBodyLimitError ? 413 : 400);
	}
}

const deletionStore = { readSettings, writeSettings, readAuth: readDictationAuth, writeAuth: writeDictationAuth };

/** Remove the saved configuration and its key without selecting another engine. */
export async function localDictationDelete(request: Request, store: {
	readSettings: typeof readSettings;
	writeSettings: (record: UserSettings) => UserSettings;
	readAuth: typeof readDictationAuth;
	writeAuth: typeof writeDictationAuth;
} = deletionStore): Promise<Response> {
	if (!authorized(request)) return failure("Use the LearnHarness settings window", 403);
	try {
		const body = await readBoundedJson(request, 16_384);
		const expected = body && typeof body === "object" && !Array.isArray(body)
			? parseLocalDictation((body as { local?: unknown }).local) : undefined;
		if (!expected) return failure("Expected the saved local dictation configuration");
		const record = store.readSettings();
		const current = record?.dictation?.local;
		if (!record || !current || JSON.stringify(parseLocalDictation(current)) !== JSON.stringify(expected)) return failure("Local dictation settings changed. Reopen the editor and retry.", 409);
		// Read private storage before writing either file; corruption fails closed.
		store.readAuth();
		const { local: _local, ...dictation } = record.dictation!;
		const stored = store.writeSettings({ ...record, dictation });
		try { store.writeAuth(current.url, ""); }
		catch {
			// The key write is atomic. Restore the configuration if it cannot be removed.
			store.writeSettings(record);
			throw new Error("Credential removal failed");
		}
		return Response.json({ settings: stored }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return failure(error instanceof CustomBodyLimitError ? "Delete request too large" : "Could not delete local dictation settings. Try again.", error instanceof CustomBodyLimitError ? 413 : 500);
	}
}

/** Shared multipart upload; server type only changes auto-language semantics. */
export async function transcribeLocal(
	wav: Uint8Array<ArrayBuffer>, config: LocalDictationSettings, key: string | undefined,
	signal: AbortSignal, request: typeof fetch = fetch,
): Promise<string> {
	const form = new FormData();
	form.set("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
	form.set("response_format", "json");
	if (config.model) form.set("model", config.model);
	if (config.language && config.language !== "auto") form.set("language", config.language);
	else if (config.server === "whisper.cpp") form.set("language", "auto");
	const response = await request(config.url, {
		method: "POST", body: form, signal, redirect: "manual",
		headers: key ? { Authorization: `Bearer ${key}` } : {},
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Local transcription endpoint returned HTTP ${response.status}`);
	}
	const result = await readBoundedJson(response, 1024 * 1024);
	if (!result || typeof result !== "object" || typeof (result as { text?: unknown }).text !== "string") throw new Error("Local endpoint returned no transcript text");
	return (result as { text: string }).text.trim();
}

async function readWav(request: Request): Promise<Uint8Array<ArrayBuffer>> {
	if (Number(request.headers.get("content-length")) > LOCAL_DICTATION_MAX_BYTES) throw new CustomBodyLimitError();
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing recording");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > LOCAL_DICTATION_MAX_BYTES) throw new CustomBodyLimitError();
			chunks.push(value);
		}
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	const wav = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) { wav.set(chunk, at); at += chunk.length; }
	return wav;
}

export async function localDictationPost(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Use the LearnHarness dictation controls", 403);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), LOCAL_DICTATION_TIMEOUT_MS);
	try {
		const settings = readSettings()?.dictation;
		const config = parseLocalDictation(JSON.parse(decodeURIComponent(request.headers.get("x-dictation-config") ?? "")));
		if (!config || settings?.provider !== "local" || JSON.stringify(config) !== JSON.stringify(parseLocalDictation(settings.local))) return failure("Dictation configuration changed. Start a new recording.", 409);
		const wav = await readWav(request);
		if (!validDictationWav(wav)) return failure("Expected a nonempty 16 kHz mono PCM16 WAV recording");
		if (request.signal.aborted) return failure("Dictation cancelled", 499);
		const auth = readDictationAuth();
		const text = await transcribeLocal(wav, config, auth?.url === config.url ? auth.key : undefined, AbortSignal.any([request.signal, timeout.signal]));
		return Response.json({ text }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (timeout.signal.aborted) return failure("Local transcription timed out after 5 minutes", 504);
		if (request.signal.aborted) return failure("Dictation cancelled", 499);
		if (error instanceof CustomBodyLimitError) return failure("Recording or transcript exceeds the allowed size", 413);
		return failure(error instanceof Error && /^Local (transcription endpoint returned HTTP|endpoint returned no transcript)/.test(error.message) ? error.message : "Local transcription failed. Check the endpoint and model.", 502);
	} finally { clearTimeout(timer); }
}
