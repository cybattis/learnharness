"use client";
import { useEffect, useState } from "react";
import { parseLocalDictation, type DictationSettings, type LocalDictationSettings } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect } from "./controls";

const inputClass = "h-7 w-full min-w-0 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground";

export function DictationSettingsControl() {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const [provider, setProvider] = useState<"deepgram" | "local">("deepgram");
	const [server, setServer] = useState<LocalDictationSettings["server"]>("llama.cpp");
	const [url, setUrl] = useState("");
	const [model, setModel] = useState("");
	const [language, setLanguage] = useState("auto");
	const [key, setKey] = useState("");
	const [keyPresent, setKeyPresent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [editing, setEditing] = useState(false);
	const disabled = active || busy || preference.saving || preference.language === undefined;
	useEffect(() => {
		const settings = preference.settings;
		if (!settings) return;
		setProvider(settings.provider ?? "deepgram");
		setServer(settings.local?.server ?? "llama.cpp");
		setUrl(settings.local?.url ?? "");
		setModel(settings.local?.model ?? "");
		setLanguage(settings.local?.language ?? "auto");
	}, [preference.settings]);
	useEffect(() => {
		setKeyPresent(false);
		if (!preference.settings?.local?.url) return;
		const controller = new AbortController();
		void fetch("/api/stt/credentials", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
			if (!response.ok) throw new Error();
			const body = await response.json() as { keyPresent?: boolean };
			if (!controller.signal.aborted) setKeyPresent(body.keyPresent === true);
		}).catch(() => {});
		return () => controller.abort();
	}, [preference.settings]);
	const saveCredential = async (endpoint: string, value: string) => {
		const response = await fetch("/api/stt/credentials", {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: endpoint, key: value }),
		});
		if (!response.ok) throw new Error("Could not save the local dictation key");
	};
	const save = async () => {
		setError(null); setSaved(false);
		const local = parseLocalDictation({ server, url, model, language });
		if (provider === "local" && !local) { setError("Enter a full HTTP(S) transcription URL and a language code or auto."); return; }
		setBusy(true);
		try {
			if (provider === "local" && local && key.trim()) await saveCredential(local.url, key);
			const settings: DictationSettings = { ...preference.settings, language: preference.language, provider };
			if (local) settings.local = local;
			if (!await preference.saveSettings(settings)) throw new Error("Could not save dictation settings. Try again.");
			if (key.trim()) setKeyPresent(true);
			setKey(""); setSaved(true); setEditing(false);
		} catch (error) { setError(error instanceof Error ? error.message : "Could not save dictation settings"); }
		finally { setBusy(false); }
	};
	const confirmed = preference.settings?.provider === "local" ? preference.settings.local : undefined;
	const keyForDraft = keyPresent && url === preference.settings?.local?.url;
	const summary = confirmed ? [confirmed.server, confirmed.url, confirmed.model, confirmed.language ?? "auto", keyPresent ? "API key" : "keyless"].filter(Boolean).join(" · ") : "";
	return <div className="space-y-2" data-testid="dictation-provider-settings" onChange={() => setSaved(false)}>
		{confirmed && <button
			type="button"
			data-testid="dictation-local-row"
			aria-expanded={editing}
			disabled={disabled}
			onClick={() => {
				setProvider("local"); setServer(confirmed.server); setUrl(confirmed.url);
				setModel(confirmed.model ?? ""); setLanguage(confirmed.language ?? "auto");
				setKey(""); setError(null); setSaved(false); setEditing(!editing);
			}}
			className="flex w-full items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left cursor-pointer transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
		>
			<span className="font-ui text-xs text-foreground">Local dictation</span>
			<span data-testid="dictation-local-status" title={summary} className="max-w-[60%] truncate font-mono text-[11px] text-muted-foreground">{summary}</span>
		</button>}
		{(!confirmed || editing) && <div data-testid="dictation-settings-editor" className="space-y-2">
		<SettingsRow label="Provider" dimmed={disabled}>
			<ThinSelect ariaLabel="Dictation provider" value={provider} disabled={disabled} onChange={(value) => setProvider(value as typeof provider)}>
				<option value="deepgram">Deepgram</option><option value="local">Local</option>
			</ThinSelect>
		</SettingsRow>
		{provider === "local" && <fieldset disabled={disabled} className="space-y-2">
			<SettingsRow label="Server">
				<ThinSelect ariaLabel="Local dictation server" value={server} onChange={(value) => setServer(value as typeof server)}>
					<option value="llama.cpp">llama.cpp</option><option value="whisper.cpp">whisper.cpp</option>
				</ThinSelect>
			</SettingsRow>
			<label className="block text-xs text-muted-foreground">Transcription URL
				<input type="text" aria-label="Transcription URL" className={inputClass} value={url} onChange={(event) => setUrl(event.target.value)} placeholder={server === "llama.cpp" ? "http://localhost:8080/v1/audio/transcriptions" : "http://localhost:8080/inference"} />
			</label>
			<label className="block text-xs text-muted-foreground">Model ID (optional)
				<input type="text" aria-label="Dictation model ID" className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
			</label>
			<label className="block text-xs text-muted-foreground">Language code (auto for detection)
				<input type="text" aria-label="Local dictation language" className={inputClass} value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="auto" />
			</label>
			<label className="block text-xs text-muted-foreground">Bearer key (optional)
				<input aria-label="Local dictation bearer key" type="password" autoComplete="off" className={inputClass} value={key} onChange={(event) => setKey(event.target.value)} placeholder={keyForDraft ? "Key saved for this endpoint" : "Keyless"} />
			</label>
			{keyForDraft && <Button type="button" variant="outline" size="xs" onClick={async () => {
				setBusy(true); setError(null);
				try { await saveCredential(url, ""); setKeyPresent(false); setKey(""); }
				catch { setError("Could not remove the local dictation key"); }
				finally { setBusy(false); }
			}}>Remove key</Button>}
			<p className="text-[11px] text-muted-foreground/70">Transcribes after you stop. Limit: 10 minutes per recording; 5 minutes for transcription. Keys stay on the app server and apply only to their saved endpoint.</p>
		</fieldset>}
		<Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => void save()}>{busy || preference.saving ? "Saving…" : "Save dictation settings"}</Button>
		</div>}
		{saved && <span role="status" className="ml-2 text-xs text-muted-foreground">Saved</span>}
		{(error || preference.error) && <p role="alert" className="text-xs text-destructive">{error ?? preference.error}</p>}
	</div>;
}
