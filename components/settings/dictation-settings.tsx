"use client";
import { useEffect, useState } from "react";
import { DICTATION_LANGUAGES, parseLocalDictation, type AuthKeyStatus, type LocalDictationSettings } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { DictationLanguageSetting } from "@/components/dictation-language";
import { Button } from "@/components/ui/button";
import { SettingsRow, ThinSelect } from "./controls";
import { AddProviderRow, KeyTableRow, keyStatusLine } from "./provider-controls";

const inputClass = "h-7 w-full min-w-0 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground";
type Provider = "deepgram" | "local";

export function DictationSettingsControl({ deepgram, onSaveDeepgram, onDeleteDeepgram, initialRow }: {
	deepgram: AuthKeyStatus;
	onSaveDeepgram: (value: string) => Promise<string | null>;
	onDeleteDeepgram: () => Promise<void>;
	initialRow?: string;
}) {
	const preference = useDictationLanguage();
	const active = useDictationActive();
	const [editing, setEditing] = useState<Provider | null>(null);
	const [server, setServer] = useState<LocalDictationSettings["server"]>("llama.cpp");
	const [url, setUrl] = useState("");
	const [model, setModel] = useState("");
	const [language, setLanguage] = useState("auto");
	const [key, setKey] = useState("");
	const [keyPresent, setKeyPresent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const disabled = active || busy || preference.saving || preference.language === undefined;
	const confirmed = preference.settings?.local;
	const activeProvider = preference.settings?.provider ?? "deepgram";
	const closeEditor = () => { setEditing(null); setKey(""); setError(null); };
	useEffect(() => { if (initialRow === "DEEPGRAM_API_KEY") setEditing("deepgram"); }, [initialRow]);
	useEffect(() => {
		if (!editing) return;
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || document.querySelector('[data-testid="dictation-language-menu"], [data-testid="dictation-add-provider-menu"]')) return;
			event.preventDefault(); event.stopPropagation();
			setEditing(null); setKey(""); setError(null);
		};
		document.addEventListener("keydown", escape, true);
		return () => document.removeEventListener("keydown", escape, true);
	}, [editing]);
	useEffect(() => {
		setKeyPresent(false);
		if (!confirmed?.url) return;
		const controller = new AbortController();
		void fetch("/api/stt/credentials", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
			if (!response.ok) throw new Error();
			const body = await response.json() as { keyPresent?: boolean };
			if (!controller.signal.aborted) setKeyPresent(body.keyPresent === true);
		}).catch(() => {});
		return () => controller.abort();
	}, [confirmed]);
	const openEditor = (provider: Provider) => {
		setServer(confirmed?.server ?? "llama.cpp"); setUrl(confirmed?.url ?? "");
		setModel(confirmed?.model ?? ""); setLanguage(confirmed?.language ?? "auto");
		setKey(""); setError(null); setSaved(false);
		setEditing(provider);
	};
	const saveCredential = async (endpoint: string, value: string) => {
		const response = await fetch("/api/stt/credentials", {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: endpoint, key: value }),
		});
		if (!response.ok) throw new Error("Could not save the local dictation key");
	};
	const saveLocal = async () => {
		setError(null); setSaved(false);
		const local = parseLocalDictation({ server, url, model, language });
		if (!local) { setError("Enter a full HTTP(S) transcription URL and a language code or auto."); return; }
		setBusy(true);
		try {
			if (key.trim()) await saveCredential(local.url, key);
			// Setup never selects an engine: only the saved-row Active radios do.
			if (!await preference.saveSettings({ ...preference.settings, language: preference.language, local })) throw new Error("Could not save dictation settings. Try again.");
			if (key.trim()) setKeyPresent(true);
			setKey(""); setSaved(true); setEditing(null);
		} catch (error) { setError(error instanceof Error ? error.message : "Could not save dictation settings"); }
		finally { setBusy(false); }
	};
	const activate = async (provider: Provider) => {
		setError(null); setSaved(false);
		if (!await preference.saveSettings({ ...preference.settings, language: preference.language, provider })) setError("Could not change the active dictation provider. Try again.");
	};
	const keyForDraft = keyPresent && url === confirmed?.url;
	const summary = confirmed ? [confirmed.server, confirmed.url, confirmed.model, confirmed.language ?? "auto", keyPresent ? "API key" : "keyless"].filter(Boolean).join(" · ") : "";
	const row = (provider: Provider, label: string, status: string) => <div className="flex items-center gap-3" key={provider}>
		<button type="button" data-testid={`dictation-${provider}-row`} aria-expanded={editing === provider} disabled={disabled}
			onClick={() => editing === provider ? closeEditor() : openEditor(provider)}
			className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left cursor-pointer transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-40">
			<span className="font-ui text-xs text-foreground">{label}</span>
			<span data-testid={`dictation-${provider}-status`} title={status} className="max-w-[60%] truncate font-mono text-[11px] text-muted-foreground">{status}</span>
		</button>
		<label className="flex shrink-0 items-center gap-1.5 font-ui text-xs text-muted-foreground">
			<input type="radio" name="dictation-active-provider" aria-label={`Use ${label} for dictation`} data-testid={`dictation-active-${provider}`}
				checked={activeProvider === provider} disabled={disabled} onChange={() => void activate(provider)} />Active
		</label>
	</div>;
	return <div className="space-y-2" data-testid="dictation-provider-settings" onChange={() => setSaved(false)}>
		{deepgram.present && row("deepgram", "Deepgram", `${keyStatusLine(deepgram)} · ${DICTATION_LANGUAGES.find((item) => item.code === preference.language)?.label ?? preference.language ?? ""}`)}
		{editing === "deepgram" && <fieldset disabled={disabled} className="space-y-2" data-testid="dictation-deepgram-editor">
			<KeyTableRow label="Deepgram" docsUrl={deepgram.info?.docsUrl} status={deepgram} expanded onToggle={() => {}}
				onSave={async (value) => {
					setBusy(true);
					try { const error = await onSaveDeepgram(value); if (!error) { closeEditor(); setSaved(true); } return error; }
					catch { return "Could not save the Deepgram key. Try again."; }
					finally { setBusy(false); }
				}}
				onDelete={async () => { setBusy(true); try { await onDeleteDeepgram(); closeEditor(); } catch { setError("Could not remove the Deepgram key"); } finally { setBusy(false); } }}
				onCancel={closeEditor} testid="key-deepgram_api_key" />
			<DictationLanguageSetting onSaved={() => { closeEditor(); setSaved(true); }} />
			<p data-testid="dictation-setup-hint" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">Create a <a href="https://console.deepgram.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Deepgram API key</a> with the Member role or higher, then add it above.</p>
			{deepgram.source === "env" && <Button type="button" variant="ghost" size="xs" onClick={closeEditor}>Cancel</Button>}
		</fieldset>}
		{confirmed && row("local", "Local", summary)}
		{editing === "local" && <div data-testid="dictation-settings-editor" className="space-y-2">
		<fieldset disabled={disabled} className="space-y-2">
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
		</fieldset>
		<Button type="button" variant="outline" size="xs" disabled={disabled} onClick={() => void saveLocal()}>{busy || preference.saving ? "Saving…" : "Save dictation settings"}</Button>
		<Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={closeEditor}>Cancel</Button>
		</div>}
		<AddProviderRow testid="dictation-add-provider" disabled={disabled}
			addable={[
				...(!deepgram.present ? [{ id: "deepgram", label: "Deepgram", envVar: "DEEPGRAM_API_KEY" }] : []),
				...(!confirmed ? [{ id: "local", label: "Local", envVar: "Server configuration" }] : []),
			]}
			onPick={(provider) => openEditor(provider.id as Provider)} />
		{saved && <span role="status" className="ml-2 text-xs text-muted-foreground">Saved</span>}
		{(error || preference.error) && <p role="alert" className="text-xs text-destructive">{error ?? preference.error}</p>}
	</div>;
}
