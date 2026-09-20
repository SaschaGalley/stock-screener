import { useEffect, useState } from 'react';
import { api, type ModelInfo } from '../api';
import type { AnalysisListEntry, SearchChoice, Settings } from '../types';
import { searchesKey } from '../types';
import { formatAge } from '../format';
import { CloseIcon } from './icons';
import { DEFAULT_MODEL_ID, type ModelProvider, providerFor, resolveModelId } from '../../../src/models';

interface Props {
  symbol: string;
  settings: Settings;
  onChange: (next: Settings) => void;
  /** Start a run with the current settings. `force` bypasses the LLM cache. */
  onRun: (force: boolean) => void;
  loading: boolean;
  onClose: () => void;
}

interface SearchOption {
  value: SearchChoice;
  label: string;
  help: string;
  /** Native searches require a specific model provider. */
  requires?: ModelProvider;
}

const SEARCH_OPTIONS: SearchOption[] = [
  { value: 'brave',  label: 'Brave',           help: 'Brave Search API (extern)' },
  { value: 'tavily', label: 'Tavily',          help: 'Tavily API (extern)' },
  { value: 'claude', label: 'Claude (nativ)',  help: 'Claudes eingebaute Suche', requires: 'claude' },
  { value: 'openai', label: 'OpenAI (nativ)',  help: 'OpenAIs eingebaute Suche', requires: 'openai' },
];

const PPLX_OPTIONS: { value: 'none' | 'sonar' | 'sonar-pro'; label: string }[] = [
  { value: 'none',      label: 'Keine' },
  { value: 'sonar',     label: 'Sonar (günstig)' },
  { value: 'sonar-pro', label: 'Sonar Pro' },
];

const CUSTOM_MODELS_KEY = 'stockcli:custom-models';

function flagsMatch(a: AnalysisListEntry, settings: Settings): boolean {
  return (
    a.flags.model === resolveModelId(settings.model)
    && a.flags.search === searchesKey(settings.searches)
    && (a.flags.pplx ?? null) === (settings.pplx ?? null)
  );
}

function loadCustomModels(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MODELS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch { return []; }
}

function saveCustomModels(list: string[]): void {
  try { localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** The label the verdict card wears, so both say the same thing. */
export function flagsLabel(settings: Settings): string {
  return [
    resolveModelId(settings.model),
    settings.searches.length === 0 ? 'ohne Suche' : settings.searches.join('+'),
    settings.pplx ?? null,
  ].filter(Boolean).join(' · ');
}

/**
 * Which analysis you are reading, and how to produce another one.
 *
 * This was a permanent third column, which gave a panel you touch a few times
 * a day the same standing as the analysis itself — and took a fifth of the
 * window to do it. Both of its jobs are moments, not states: *switch to that
 * cached verdict* and *spend money on a new one*. So it opens from the verdict
 * card, which is where the question „which one am I looking at?" comes up, and
 * from the stale banner, which is where „run it again" does.
 */
export default function AnalysisModal({ symbol, settings, onChange, onRun, loading, onClose }: Props) {
  const [analyses, setAnalyses]           = useState<AnalysisListEntry[]>([]);
  const [models, setModels]               = useState<ModelInfo | null>(null);
  const [customModels, setCustomModels]   = useState<string[]>(loadCustomModels);
  const [refreshKey, setRefreshKey]       = useState(0);
  const [adding, setAdding]               = useState(false);
  const [newModelInput, setNewModelInput] = useState('');

  useEffect(() => { saveCustomModels(customModels); }, [customModels]);
  useEffect(() => { api.listModels().then(setModels).catch(() => setModels(null)); }, [refreshKey]);

  useEffect(() => {
    api.listAnalyses(symbol)
      .then((r) => setAnalyses(r.analyses))
      .catch(() => setAnalyses([]));
  }, [symbol, refreshKey]);

  // Esc closes this and nothing else — the app's own Esc handler stands down
  // while it is open, so the analysis underneath is not closed along with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Settings normally already hold a real model ID; resolving covers an alias
  // typed into the custom-model box ('opus' → 'claude-opus-5').
  const activeModel = resolveModelId(settings.model);
  const cachedMatch = analyses.find((a) => flagsMatch(a, settings));

  /**
   * Switch the model — and drop any native search options that no longer match
   * the new provider (e.g. removing 'claude' when switching to a GPT model,
   * otherwise the request would fail validation).
   */
  function setModel(modelId: string) {
    const newProvider = providerFor(modelId);
    const filtered = settings.searches.filter((s) => {
      if (s === 'claude' && newProvider !== 'claude') return false;
      if (s === 'openai' && newProvider !== 'openai') return false;
      return true;
    });
    onChange({ ...settings, model: modelId, searches: filtered });
  }

  const allModelOptions: { value: string; label: string; sublabel?: string; deletable: boolean }[] = [];
  if (models) {
    const listed = new Set<string>();
    // 1. The registry (src/models.ts), in the order it defines.
    for (const m of models.models) {
      listed.add(m.id);
      allModelOptions.push({ value: m.id, label: m.label, sublabel: m.id, deletable: false });
    }
    // 2. User-saved custom IDs (LocalStorage, deletable from list)
    for (const c of customModels) {
      if (listed.has(c)) continue;
      listed.add(c);
      allModelOptions.push({ value: c, label: c, sublabel: 'custom', deletable: true });
    }
    // 3. The active model when it is neither — i.e. a retired model reached by
    //    opening one of its cached analyses. Listed so the picker still shows a
    //    selection, but never offered on its own: a model that left the registry
    //    must not come back through the cache.
    if (!listed.has(activeModel)) {
      const cached = models.used.find((u) => u.modelId === activeModel);
      allModelOptions.push({
        value: activeModel,
        label: activeModel,
        sublabel: cached ? `retired · ${cached.count} cached` : 'retired',
        deletable: false,
      });
    }
  }

  function addCustomModel() {
    // Normalise aliases so the saved entry is a real model ID like every other.
    const id = resolveModelId(newModelInput.trim());
    if (!id) return;
    if (!customModels.includes(id)) setCustomModels([...customModels, id]);
    setModel(id);
    setNewModelInput('');
    setAdding(false);
  }

  function deleteCustomModel(id: string) {
    setCustomModels(customModels.filter((m) => m !== id));
    if (settings.model === id) setModel(DEFAULT_MODEL_ID);
  }

  async function deleteCachedAnalysis(hash: string) {
    if (!confirm(`Gespeicherte Analyse ${hash} löschen?`)) return;
    try {
      await api.deleteAnalysis(symbol, hash);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Analyse für ${symbol}`}
    >
      <div
        // Clicks inside must not reach the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">
            Analyse <span className="font-mono text-ink-400">{symbol}</span>
          </h2>
          <button
            onClick={onClose}
            className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
            title="Schließen (Esc)"
            aria-label="Schließen"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <Section
            title="Gespeichert"
            hint="Ein Klick zeigt diese Fassung an — kostet nichts."
          >
            {analyses.length === 0 ? (
              <div className="text-xs text-ink-500">Noch keine.</div>
            ) : (
              <ul className="space-y-1">
                {analyses.map((a) => {
                  const isCurrent = cachedMatch?.hash === a.hash;
                  return (
                    <li key={a.hash} className="group relative">
                      <button
                        onClick={() => {
                          onChange({
                            model: a.flags.model,
                            searches: a.flags.search === 'none'
                              ? []
                              : (a.flags.search.split(',') as SearchChoice[]),
                            pplx: a.flags.pplx,
                          });
                          onClose();
                        }}
                        className={`block w-full overflow-hidden rounded border py-1.5 pl-2 pr-9 text-left text-[11px] transition ${
                          isCurrent
                            ? 'border-accent bg-accent-soft text-ink-100'
                            : a.olderThanData
                              ? 'border-amber-700/60 bg-ink-950 text-ink-300 hover:bg-ink-800'
                              : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
                        }`}
                        title={
                          (a.olderThanData
                            ? '⚠ Vor der letzten Datenaktualisierung erzeugt — neu rechnen, um sie einzubeziehen.\n'
                            : '')
                          + `${a.flags.model} · search=${a.flags.search} · pplx=${a.flags.pplx ?? 'none'}`
                        }
                      >
                        <div className="flex items-center gap-1 truncate font-mono">
                          {a.olderThanData && (
                            <span className="shrink-0 text-amber-400" aria-label="Älter als die Daten">⚠</span>
                          )}
                          <span className="truncate">
                            {a.flags.model} · {a.flags.search} · {a.flags.pplx ?? 'no-pplx'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-ink-500">
                          {a.olderThanData
                            ? <span className="text-amber-400/80">{formatAge(a.generatedAt)} · vor der Aktualisierung</span>
                            : formatAge(a.generatedAt)}
                        </div>
                      </button>
                      <button
                        onClick={() => deleteCachedAnalysis(a.hash)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-600 opacity-0 transition hover:bg-red-900 hover:text-red-400 group-hover:opacity-100"
                        title="Diese gespeicherte Analyse löschen"
                      >🗑</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <div className="border-t border-ink-800 pt-4">
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
              Neu rechnen
            </h3>

            <div className="space-y-4">
              <Section title="Modell">
                <div className="space-y-1">
                  {allModelOptions.map((opt) => (
                    <ModelOption
                      key={opt.value}
                      option={opt}
                      selected={activeModel === opt.value}
                      onSelect={() => setModel(opt.value)}
                      onDelete={opt.deletable ? () => deleteCustomModel(opt.value) : undefined}
                    />
                  ))}
                  {adding ? (
                    <div className="flex gap-1">
                      <input
                        autoFocus
                        value={newModelInput}
                        onChange={(e) => setNewModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addCustomModel();
                          if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); setNewModelInput(''); }
                        }}
                        placeholder="Modell-ID (z. B. gpt-5.4)"
                        className="flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
                      />
                      <button
                        onClick={addCustomModel}
                        className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-dark"
                      >+</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAdding(true)}
                      className="w-full rounded border border-dashed border-ink-700 px-2 py-1.5 text-[11px] text-ink-500 transition hover:border-ink-600 hover:text-ink-300"
                    >
                      + eigene Modell-ID
                    </button>
                  )}
                </div>
              </Section>

              <Section title="Websuche">
                <SearchButtonGroup
                  selected={settings.searches}
                  modelProvider={providerFor(settings.model)}
                  onToggle={(value) => {
                    const has = settings.searches.includes(value);
                    onChange({
                      ...settings,
                      searches: has
                        ? settings.searches.filter((s) => s !== value)
                        : [...settings.searches, value],
                    });
                  }}
                />
              </Section>

              <Section title="Perplexity">
                <SingleButtonGroup
                  value={settings.pplx ?? 'none'}
                  onChange={(v) => onChange({
                    ...settings,
                    pplx: v === 'none' ? null : (v as 'sonar' | 'sonar-pro'),
                  })}
                  options={PPLX_OPTIONS}
                />
              </Section>
            </div>
          </div>
        </div>

        <footer className="shrink-0 space-y-2 border-t border-ink-700 p-4">
          {cachedMatch ? (
            <div
              className={`rounded border px-2.5 py-2 text-[11px] ${
                cachedMatch.olderThanData
                  ? 'border-amber-700 bg-amber-950 text-amber-300'
                  : 'border-emerald-700 bg-emerald-900 text-emerald-400'
              }`}
            >
              {cachedMatch.olderThanData
                ? '⚠ Vorhanden, aber vor der letzten Datenaktualisierung erzeugt'
                : `✓ Vorhanden (${formatAge(cachedMatch.generatedAt)})`}
            </div>
          ) : (
            <div className="rounded border border-amber-700 bg-amber-900 px-2.5 py-2 text-[11px] text-amber-400">
              ○ Für diese Kombination liegt noch nichts vor
            </div>
          )}
          <button
            // `force` only where it changes anything: with nothing cached the
            // plain run is already a fresh call, and bypassing a cache that
            // cannot hit would just be a word nobody can act on.
            onClick={() => { onRun(cachedMatch !== undefined); onClose(); }}
            disabled={loading}
            className={`w-full rounded py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
              cachedMatch
                ? 'border border-ink-700 bg-ink-950 text-ink-200 hover:bg-ink-800'
                : 'bg-accent text-white hover:bg-accent-dark'
            }`}
          >
            {loading
              ? 'Läuft…'
              : cachedMatch ? 'Neu rechnen (ohne Cache)' : 'Analyse starten'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      {hint && <p className="mb-1.5 mt-0.5 text-[10px] text-ink-600">{hint}</p>}
      <div className={hint ? '' : 'mt-1.5'}>{children}</div>
    </div>
  );
}

function ModelOption({ option, selected, onSelect, onDelete }: {
  option: { value: string; label: string; sublabel?: string };
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex gap-1">
      <button
        onClick={onSelect}
        className={`flex-1 rounded border px-2 py-1.5 text-left text-xs transition ${
          selected
            ? 'border-accent bg-accent-soft text-ink-100'
            : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
        }`}
      >
        <div className="truncate font-medium">{option.label}</div>
        {option.sublabel && <div className="truncate text-[10px] text-ink-500">{option.sublabel}</div>}
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="shrink-0 rounded border border-ink-700 bg-ink-950 px-2 text-xs text-ink-500 transition hover:border-red-700 hover:text-red-400"
          title="Aus der Liste entfernen"
        >×</button>
      )}
    </div>
  );
}

/**
 * Multi-select button group for the web search. Same look as the model picker:
 * a clickable card per option, no radio glyph. Native options auto-disable when
 * the model provider doesn't match.
 */
function SearchButtonGroup({ selected, modelProvider, onToggle }: {
  selected: SearchChoice[];
  modelProvider: ModelProvider | null;
  onToggle: (value: SearchChoice) => void;
}) {
  return (
    <div className="space-y-1">
      {SEARCH_OPTIONS.map((o) => {
        const checked = selected.includes(o.value);
        const disabled = o.requires !== undefined && o.requires !== modelProvider;
        return (
          <button
            key={o.value}
            disabled={disabled}
            onClick={() => !disabled && onToggle(o.value)}
            className={`block w-full rounded border px-2 py-1.5 text-left text-xs transition ${
              disabled
                ? 'cursor-not-allowed border-ink-700 bg-ink-950 text-ink-500 opacity-50'
                : checked
                  ? 'border-accent bg-accent-soft text-ink-100'
                  : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
            }`}
          >
            <span className="block font-medium">{o.label}</span>
            <span className="block text-[10px] text-ink-500">
              {disabled ? `braucht ein ${o.requires}-Modell` : o.help}
            </span>
          </button>
        );
      })}
      {selected.length === 0 && (
        <div className="px-2 py-1 text-[10px] italic text-ink-500">
          Ohne Websuche — das Modell verlässt sich auf seine Trainingsdaten.
        </div>
      )}
    </div>
  );
}

/** Single-select button group (Perplexity), in the same visual language. */
function SingleButtonGroup({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`block w-full rounded border px-2 py-1.5 text-left text-xs font-medium transition ${
            value === o.value
              ? 'border-accent bg-accent-soft text-ink-100'
              : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
