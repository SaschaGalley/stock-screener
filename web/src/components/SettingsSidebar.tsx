import { useEffect, useState } from 'react';
import { api, type ModelInfo } from '../api';
import type { AnalysisManifestEntry, SearchChoice, Settings } from '../types';
import { searchesKey } from '../types';
import { formatAge } from '../format';

interface Props {
  symbol: string | null;
  settings: Settings;
  onChange: (next: Settings) => void;
  onLoad: () => void;
  onReload: () => void;
  loading: boolean;
}

interface SearchOption {
  value: SearchChoice;
  label: string;
  help: string;
  /** Native searches require a specific model provider. */
  requires?: 'claude' | 'openai';
}

const SEARCH_OPTIONS: SearchOption[] = [
  { value: 'brave',  label: 'Brave',           help: 'Brave Search API (external)' },
  { value: 'tavily', label: 'Tavily',          help: 'Tavily API (external)' },
  { value: 'claude', label: 'Claude (native)', help: 'Built-in Claude search', requires: 'claude' },
  { value: 'openai', label: 'OpenAI (native)', help: 'Built-in OpenAI search', requires: 'openai' },
];

const PPLX_OPTIONS: { value: 'none' | 'sonar' | 'sonar-pro'; label: string }[] = [
  { value: 'none',      label: 'No Perplexity' },
  { value: 'sonar',     label: 'Sonar (cheap)' },
  { value: 'sonar-pro', label: 'Sonar Pro' },
];

const SHORTCUT_TO_RESOLVED: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
  opus:   'claude-opus-4-7',
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-1.5-pro',
};

const CUSTOM_MODELS_KEY = 'stockcli:custom-models';

function modelToProvider(modelId: string): 'claude' | 'openai' | 'gemini' | 'unknown' {
  const lc = modelId.toLowerCase();
  if (['claude', 'sonnet', 'haiku', 'opus'].includes(lc) || lc.startsWith('claude-')) return 'claude';
  if (lc === 'openai' || /^(gpt|o1|o3|o4)/.test(lc)) return 'openai';
  if (lc === 'gemini' || lc.startsWith('gemini-')) return 'gemini';
  return 'unknown';
}

function flagsMatch(a: AnalysisManifestEntry, settings: Settings, resolveModel: (s: string) => string): boolean {
  return (
    a.flags.model === resolveModel(settings.model)
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

export default function SettingsSidebar({ symbol, settings, onChange, onLoad, onReload, loading }: Props) {
  const [analyses, setAnalyses]         = useState<AnalysisManifestEntry[]>([]);
  const [models, setModels]             = useState<ModelInfo | null>(null);
  const [customModels, setCustomModels] = useState<string[]>(loadCustomModels);
  const [refreshKey, setRefreshKey]     = useState(0);
  const [adding, setAdding]             = useState(false);
  const [newModelInput, setNewModelInput] = useState('');

  useEffect(() => { saveCustomModels(customModels); }, [customModels]);

  useEffect(() => {
    api.listModels().then(setModels).catch(() => setModels(null));
  }, [refreshKey]);

  useEffect(() => {
    if (!symbol) { setAnalyses([]); return; }
    api.listAnalyses(symbol)
      .then((r) => setAnalyses(r.analyses))
      .catch(() => setAnalyses([]));
  }, [symbol, refreshKey]);

  useEffect(() => {
    if (!loading) setRefreshKey((k) => k + 1);
  }, [loading]);

  const resolveModel = (s: string): string => SHORTCUT_TO_RESOLVED[s.toLowerCase()] ?? s;
  const cachedMatch = analyses.find((a) => flagsMatch(a, settings, resolveModel));

  /**
   * Switch the model — and drop any native search options that no longer
   * match the new provider (e.g. removing 'claude' when switching to a GPT
   * model, otherwise the request would fail validation).
   */
  function setModel(modelId: string) {
    const newProvider = modelToProvider(resolveModel(modelId));
    const filtered = settings.searches.filter((s) => {
      if (s === 'claude' && newProvider !== 'claude') return false;
      if (s === 'openai' && newProvider !== 'openai') return false;
      return true;
    });
    onChange({ ...settings, model: modelId, searches: filtered });
  }

  const allModelOptions: { value: string; label: string; sublabel?: string; deletable: boolean }[] = [];
  if (models) {
    // 1. Shortcuts (built-in, not deletable, sorted as defined by server)
    for (const s of models.shortcuts) {
      allModelOptions.push({ value: s.id, label: s.label, sublabel: s.resolved, deletable: false });
    }
    // 2. Used model IDs that aren't shortcuts (deletable via DELETE analyses)
    const shortcutResolved = new Set(models.shortcuts.map((s) => s.resolved));
    for (const u of models.used) {
      if (shortcutResolved.has(u.modelId)) continue;
      allModelOptions.push({
        value: u.modelId,
        label: u.modelId,
        sublabel: `${u.count} cached analysis${u.count === 1 ? '' : 'es'}`,
        deletable: false, // deletion handled via per-analysis delete in cache list
      });
    }
    // 3. User-saved custom IDs (LocalStorage, deletable from list)
    const usedIds = new Set(models.used.map((u) => u.modelId));
    for (const c of customModels) {
      if (shortcutResolved.has(c) || usedIds.has(c)) continue;
      allModelOptions.push({ value: c, label: c, sublabel: 'custom', deletable: true });
    }
  }

  function addCustomModel() {
    const id = newModelInput.trim();
    if (!id) return;
    if (!customModels.includes(id)) setCustomModels([...customModels, id]);
    setModel(id);
    setNewModelInput('');
    setAdding(false);
  }

  function deleteCustomModel(id: string) {
    setCustomModels(customModels.filter((m) => m !== id));
    if (settings.model === id) setModel('claude');
  }

  async function deleteCachedAnalysis(hash: string) {
    if (!symbol) return;
    if (!confirm(`Delete cached analysis ${hash}?`)) return;
    try {
      await api.deleteAnalysis(symbol, hash);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <aside className="flex h-full w-72 flex-col border-l border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
          Analysis Settings
        </h2>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <Section title="Model">
          <div className="space-y-1">
            {allModelOptions.map((opt) => (
              <ModelOption
                key={opt.value}
                option={opt}
                selected={settings.model === opt.value}
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
                    if (e.key === 'Escape') { setAdding(false); setNewModelInput(''); }
                  }}
                  placeholder="model id (e.g. gpt-5.4)"
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
                + add custom model id
              </button>
            )}
          </div>
        </Section>

        <Section title="Web Search">
          <SearchButtonGroup
            selected={settings.searches}
            modelProvider={modelToProvider(resolveModel(settings.model))}
            onToggle={(value) => {
              const has = settings.searches.includes(value);
              const next = has
                ? settings.searches.filter((s) => s !== value)
                : [...settings.searches, value];
              onChange({ ...settings, searches: next });
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
            options={PPLX_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Section>

        {symbol && (
          <Section title={`Cached for ${symbol}`}>
            {analyses.length === 0 ? (
              <div className="text-xs text-ink-500">None yet</div>
            ) : (
              <ul className="space-y-1">
                {analyses.map((a) => {
                  const isCurrent = cachedMatch?.hash === a.hash;
                  return (
                    <li key={a.hash} className="group relative">
                      <button
                        onClick={() => onChange({
                          model: a.flags.model,
                          searches: a.flags.search === 'none'
                            ? []
                            : (a.flags.search.split(',') as SearchChoice[]),
                          pplx: a.flags.pplx,
                        })}
                        className={`block w-full overflow-hidden rounded border pl-2 pr-9 py-1.5 text-left text-[11px] transition ${
                          isCurrent
                            ? 'border-accent bg-accent-soft text-ink-100'
                            : a.olderThanData
                              ? 'border-amber-700/60 bg-ink-950 text-ink-300 hover:bg-ink-800'
                              : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
                        }`}
                        title={
                          (a.olderThanData
                            ? '⚠ Generated before the latest data refresh — re-run to update.\n'
                            : '')
                          + `${a.flags.model} · search=${a.flags.search} · pplx=${a.flags.pplx ?? 'none'}`
                        }
                      >
                        <div className="flex items-center gap-1 truncate font-mono">
                          {a.olderThanData && (
                            <span className="shrink-0 text-amber-400" aria-label="Older than latest data">⚠</span>
                          )}
                          <span className="truncate">
                            {a.flags.model.split('-').slice(0, 2).join('-')} · {a.flags.search} · {a.flags.pplx ?? 'no-pplx'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-ink-500">
                          {a.olderThanData
                            ? <span className="text-amber-400/80">{formatAge(a.generatedAt)} · pre-refresh</span>
                            : formatAge(a.generatedAt)}
                        </div>
                      </button>
                      <button
                        onClick={() => deleteCachedAnalysis(a.hash)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-600 opacity-0 transition hover:bg-red-900 hover:text-red-400 group-hover:opacity-100"
                        title="Delete this cached analysis"
                      >🗑</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        )}
      </div>

      {symbol && (
        <div className="space-y-2 border-t border-ink-700 p-3">
          {cachedMatch ? (
            <>
              {cachedMatch.olderThanData ? (
                <div className="rounded border border-amber-700 bg-amber-950 px-2.5 py-2 text-[11px] text-amber-300">
                  ⚠ Cached but pre-refresh — re-run to update with latest data
                </div>
              ) : (
                <div className="rounded border border-emerald-700 bg-emerald-900 px-2.5 py-2 text-[11px] text-emerald-400">
                  ✓ Cached ({formatAge(cachedMatch.generatedAt)})
                </div>
              )}
              <button
                onClick={onReload}
                disabled={loading}
                className="w-full rounded border border-ink-700 bg-ink-950 py-2 text-xs font-medium text-ink-200 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Re-run (without cache)'}
              </button>
            </>
          ) : (
            <>
              <div className="rounded border border-amber-700 bg-amber-900 px-2.5 py-2 text-[11px] text-amber-400">
                ○ Not cached yet
              </div>
              <button
                onClick={onLoad}
                disabled={loading}
                className="w-full rounded bg-accent py-2 text-xs font-medium text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Run Analysis'}
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      {children}
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
        <div className="font-medium truncate">{option.label}</div>
        {option.sublabel && <div className="text-[10px] text-ink-500 truncate">{option.sublabel}</div>}
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="shrink-0 rounded border border-ink-700 bg-ink-950 px-2 text-xs text-ink-500 transition hover:border-red-700 hover:text-red-400"
          title="Remove from list"
        >×</button>
      )}
    </div>
  );
}

/**
 * Multi-select button group for Web Search. Same look as the model selector:
 * just a clickable button card per option, no radio/checkbox glyph. Click
 * toggles selection. Native options auto-disable when the model provider
 * doesn't match.
 */
function SearchButtonGroup({ selected, modelProvider, onToggle }: {
  selected: SearchChoice[];
  modelProvider: 'claude' | 'openai' | 'gemini' | 'unknown';
  onToggle: (value: SearchChoice) => void;
}) {
  return (
    <div className="space-y-1">
      {SEARCH_OPTIONS.map((o) => {
        const checked = selected.includes(o.value);
        const disabled = o.requires !== undefined && o.requires !== modelProvider;
        const disabledHint = disabled ? `requires ${o.requires} model` : null;
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
              {disabledHint ?? o.help}
            </span>
          </button>
        );
      })}
      {selected.length === 0 && (
        <div className="px-2 py-1 text-[10px] italic text-ink-500">
          No web search — LLM relies on training data only.
        </div>
      )}
    </div>
  );
}

/**
 * Single-select button group (Perplexity). Clicking another option deselects
 * the previous. Same visual language as the model selector.
 */
function SingleButtonGroup({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; help?: string }[];
}) {
  return (
    <div className="space-y-1">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`block w-full rounded border px-2 py-1.5 text-left text-xs transition ${
              active
                ? 'border-accent bg-accent-soft text-ink-100'
                : 'border-ink-700 bg-ink-950 text-ink-300 hover:bg-ink-800'
            }`}
          >
            <span className="block font-medium">{o.label}</span>
            {o.help && <span className="block text-[10px] text-ink-500">{o.help}</span>}
          </button>
        );
      })}
    </div>
  );
}
