import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AppConfig, ConfigResponse, JobRun, SchedulerStatus, SearchChoice } from '../types';
import { MODELS, PERPLEXITY_MODELS, type PerplexityModelId, perplexityLabel } from '../../../src/models';
import Page from '../components/Page';
import { BacktestStatusLine, useBacktestOverview } from '../components/BacktestRuns';
import CalibrationPanel from '../components/CalibrationPanel';
import { universeIndices } from '../../../src/data/universe';
import { deNumber } from '../format';

/** Poll interval while a run is in flight — fast enough to feel live, slow
 *  enough that a two-hour run doesn't hammer the API. */
const POLL_MS = 3000;

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'täglich 00:00',   cron: '0 0 * * *' },
  { label: 'täglich 06:00',   cron: '0 6 * * *' },
  { label: 'alle 6 Stunden',  cron: '0 */6 * * *' },
  { label: 'werktags 22:00',  cron: '0 22 * * 1-5' },
];

const SEARCH_CHOICES: SearchChoice[] = ['brave', 'tavily', 'claude', 'openai'];

/** Plain-language reading of the common cron shapes; falls back to the raw expression. */
function describeCron(cron: string): string {
  const m = cron.trim().split(/\s+/);
  if (m.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = m;
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `täglich um ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow === '1-5' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `werktags um ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  const every = hour.match(/^\*\/(\d+)$/);
  if (every && dom === '*' && mon === '*' && dow === '*') return `alle ${every[1]} Stunden`;
  return cron;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtDuration(from: string, to: string | null): string {
  const end = to ? new Date(to).getTime() : Date.now();
  const secs = Math.max(0, (end - new Date(from).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)} s`;
  if (secs < 5400) return `${deNumber(secs / 60, 1)} min`;
  return `${deNumber(secs / 3600, 1)} h`;
}

// ── Small layout primitives ──────────────────────────────────────────────────

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
      </header>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span>
        <span className="text-sm text-ink-200">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

const inputCls =
  'rounded border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 focus:border-accent focus:outline-none';

/** A day count between 1 and 365, with its unit. */
function DaysInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        max={365}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
        className={`${inputCls} w-16 text-right font-mono`}
      />
      <span className="text-xs text-ink-500">Tage</span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [meta, setMeta] = useState<ConfigResponse | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [jobs, setJobs] = useState<SchedulerStatus | null>(null);
  const backtest = useBacktestOverview();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await api.getConfig();
      setMeta(r);
      // Never clobber unsaved edits with a background reload.
      setConfig((prev) => (prev && dirty ? prev : r.config));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [dirty]);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api.getJobs());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { loadConfig(); loadJobs(); }, [loadConfig, loadJobs]);

  // Poll only while something is actually happening.
  useEffect(() => {
    if (!jobs?.running) {
      if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = window.setInterval(loadJobs, POLL_MS);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); pollRef.current = null; };
  }, [jobs?.running, loadJobs]);

  function patch(mutate: (draft: AppConfig) => void) {
    setConfig((prev) => {
      if (!prev) return prev;
      const next: AppConfig = JSON.parse(JSON.stringify(prev));
      mutate(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.saveConfig(config);
      setConfig(r.config);
      setJobs(r.scheduler);
      setDirty(false);
      setNotice('Gespeichert — Zeitplan neu installiert.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow(symbols?: string[]) {
    setError(null);
    try {
      await api.runJob(symbols);
      setNotice(symbols?.length ? `Lauf für ${symbols.join(', ')} gestartet.` : 'Lauf gestartet.');
      await loadJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function testAlert() {
    setError(null);
    try {
      const r = await api.testAlert();
      if (r.ok) setNotice('Testnachricht gesendet.');
      else setError(`Der Webhook hat die Testnachricht nicht angenommen${r.error ? ` — ${r.error}` : ''}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runBacktest() {
    setError(null);
    try {
      const r = await api.runBacktest();
      if (r.started) setNotice('Backtest gestartet — der Fortschritt steht in der Karte.');
      else setError(r.reason ?? 'Backtest nicht gestartet.');
    } catch (e) {
      setError((e as Error).message);
    }
    backtest.reload();
  }

  async function testDigest() {
    setError(null);
    try {
      const r = await api.testDigest();
      if (!r.ok) setError(`Der Überblick ging nicht raus${r.error ? ` — ${r.error}` : ''}.`);
      else setNotice(r.events ? `Überblick mit ${r.events} Ereignissen des letzten Tages gesendet.` : 'Im letzten Tag ist nichts passiert — nichts gesendet.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function stopRun() {
    try {
      await api.stopJob();
      setNotice('Stopp angefordert — der laufende Titel wird noch fertig gemacht.');
      await loadJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!config || !meta) {
    return <Page title="Administration"><div className="p-8 text-center text-sm text-ink-500">{error ?? 'Lade Konfiguration …'}</div></Page>;
  }

  const analysis = config.steps.analysis;

  return (
    <Page
      title="Administration"
      subtitle={<>Dateien: <span className="font-mono">{meta.dataDir}</span></>}
      actions={<>
        {dirty && <span className="text-xs text-amber-400">ungespeicherte Änderungen</span>}
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-ink-950 transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Speichere …' : 'Speichern'}
        </button>
      </>}
    >

      {error && (
        <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>
      )}
      {notice && (
        <div className="rounded border border-emerald-700 bg-emerald-950 px-3 py-2 text-sm text-emerald-400">{notice}</div>
      )}

      {/* ── Zeitplan ───────────────────────────────────────────────────── */}
      <Card
        title="Zeitplan"
        hint="Ein Lauf, seriell pro Aktie: Daten → Distill → Analyse. Parallel würde dieselben Caches und dieselben Rate-Limits gleichzeitig treffen."
      >
        <Toggle
          checked={config.schedule.enabled}
          onChange={(v) => patch((d) => { d.schedule.enabled = v; })}
          label="Zeitplan aktiv"
          // Three states, not two. `nextRun` is only known when the
          // in-process scheduler owns the cron; Hatchet does not report one,
          // so an installed Hatchet cron would otherwise read as "none".
          hint={jobs?.nextRun
            ? `Nächster Lauf: ${fmtDateTime(jobs.nextRun)}`
            : jobs?.cron
              ? `Installiert: ${jobs.cron} (${jobs.timezone})`
              : 'Kein Cron installiert'}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-ink-400">Cron</label>
          <input
            value={config.schedule.cron}
            onChange={(e) => patch((d) => { d.schedule.cron = e.target.value; })}
            className={`${inputCls} w-40 font-mono`}
            placeholder="0 0 * * *"
          />
          <span className="text-xs text-ink-500">{describeCron(config.schedule.cron)}</span>
          <label className="ml-3 text-xs text-ink-400">Zeitzone</label>
          <input
            value={config.schedule.timezone}
            onChange={(e) => patch((d) => { d.schedule.timezone = e.target.value; })}
            className={`${inputCls} w-44 font-mono`}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((p) => (
            <button
              key={p.cron}
              onClick={() => patch((d) => { d.schedule.cron = p.cron; })}
              className={`rounded border px-2 py-0.5 text-xs transition ${
                config.schedule.cron === p.cron
                  ? 'border-accent bg-accent-soft text-ink-100'
                  : 'border-ink-700 text-ink-400 hover:bg-ink-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      {/* ── Schritte ───────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="1 · Marktdaten" hint="Yahoo, Finnhub, FRED, Makro + Charttechnik">
          <Toggle
            checked={config.steps.data.enabled}
            onChange={(v) => patch((d) => { d.steps.data.enabled = v; })}
            label="Daten aktualisieren"
            hint="Schreibt zusätzlich einen Verlaufspunkt (Kurs, Ziel, fairer Wert)."
          />
        </Card>

        <Card title="2 · Distill" hint="Dossiers + frische Insights">
          <Toggle
            checked={config.steps.distill.enabled}
            onChange={(v) => patch((d) => { d.steps.distill.enabled = v; })}
            label="Distill einbeziehen"
            hint={meta.keys.distill ? meta.distillApiUrl : 'DISTILL_API_KEY fehlt — Schritt wird übersprungen'}
          />
          <p className="text-xs leading-relaxed text-ink-500">
            Holt das Firmen-Dossier, die Dossiers der Sektoren der Aktie und die rohen
            Insights, die keines davon wiedergibt. Kostenlos — es gibt nichts mehr
            einzustellen, weil kein bezahlter Aufruf mehr nötig ist.
          </p>
        </Card>

        <Card title="3 · Analyse" hint="Nur wenn das Urteil zu alt ist">
          <Toggle
            checked={analysis.enabled}
            onChange={(v) => patch((d) => { d.steps.analysis.enabled = v; })}
            label="Analyse mitziehen"
            hint="Läuft direkt nach Daten + Distill derselben Aktie."
          />
          {/* One grid for every labelled field, so the inputs line up in a
              column whatever the label's length. */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <label className="text-xs text-ink-400">max. Alter</label>
            <DaysInput
              value={analysis.maxAgeDays}
              onChange={(v) => patch((d) => { d.steps.analysis.maxAgeDays = v; })}
            />

            <label className="text-xs text-ink-400">Modell</label>
            <select
              value={analysis.model}
              onChange={(e) => patch((d) => { d.steps.analysis.model = e.target.value; })}
              className={`${inputCls} w-full min-w-0`}
            >
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {!MODELS.some((m) => m.id === analysis.model) && (
                <option value={analysis.model}>{analysis.model} (eigenes)</option>
              )}
            </select>

            <span className="self-start pt-0.5 text-xs text-ink-400">Websuche</span>
            <div className="flex flex-wrap gap-1.5">
              {SEARCH_CHOICES.map((choice) => {
                const on = analysis.search.includes(choice);
                return (
                  <button
                    key={choice}
                    onClick={() => patch((d) => {
                      const list = new Set(d.steps.analysis.search);
                      if (on) list.delete(choice); else list.add(choice);
                      d.steps.analysis.search = [...list].sort();
                    })}
                    className={`rounded border px-2 py-0.5 text-xs transition ${
                      on ? 'border-accent bg-accent-soft text-ink-100' : 'border-ink-700 text-ink-400 hover:bg-ink-800'
                    }`}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>

            <label className="text-xs text-ink-400">Perplexity</label>
            <select
              value={analysis.pplx ?? 'none'}
              onChange={(e) => patch((d) => {
                const v = e.target.value;
                d.steps.analysis.pplx = v === 'none' ? null : (v as PerplexityModelId);
              })}
              className={`${inputCls} w-full min-w-0`}
            >
              <option value="none">aus</option>
              {PERPLEXITY_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{perplexityLabel(m.id)}</option>
              ))}
            </select>
            {analysis.pplx && (
              <p className="col-start-2 -mt-1 text-2xs text-ink-500">
                {PERPLEXITY_MODELS.find((m) => m.id === analysis.pplx)?.note}
              </p>
            )}

            <label className="text-xs text-ink-400">Recherche-Cache</label>
            <DaysInput
              value={config.perplexity.maxAgeDays}
              onChange={(v) => patch((d) => { d.perplexity.maxAgeDays = v; })}
            />

            <label className="text-xs text-ink-400">Deep Research</label>
            <DaysInput
              value={config.perplexity.deepMaxAgeDays}
              onChange={(v) => patch((d) => { d.perplexity.deepMaxAgeDays = v; })}
            />
          </div>
          <p className="text-xs leading-relaxed text-ink-500">
            Der Recherche-Cache gilt für jede Analyse, auch für von Hand gestartete —
            jeder Aufruf kostet; „↻ Neu holen“ im Research-Tab fragt sofort neu.
            Deep Research wird nur dort von Hand angefordert und geht so lange
            zusätzlich in jede Analyse ein.
          </p>
        </Card>
      </div>

      {/* ── Referenzuniversum ──────────────────────────────────────────── */}
      <Card
        title={`Referenzuniversum (${meta.referenceSymbols} gespeichert)`}
        hint={`${universeIndices()}, nach der Watchlist rotierend aktualisiert und nur mit Zahlen bewertet — die Grundgesamtheit für Kalibrierung, Auswertung und „Entdecken“. Erscheint nie in der Liste, wird nie analysiert.`}
      >
        <Toggle
          checked={config.universe.enabled}
          onChange={(v) => patch((d) => { d.universe.enabled = v; })}
          label="Referenzuniversum pflegen"
          hint="Nur bei vollständigen Läufen, nicht bei einzeln gestarteten Aktien."
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-ink-400">Pro Nacht</label>
          <input
            type="number"
            min={0}
            max={600}
            value={config.universe.batchSize}
            onChange={(e) => patch((d) => {
              d.universe.batchSize = Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0)));
            })}
            className={`${inputCls} w-20 text-right font-mono`}
          />
          <span className="text-xs text-ink-500">
            Aktien{config.universe.batchSize > 0 && meta.universeSize > 0
              && ` · jede der ${meta.universeSize} etwa alle ${Math.max(1, Math.round(meta.universeSize / config.universe.batchSize))} Nächte`}
          </span>
        </div>
        {meta.universeSize > 0 && (
          <p className="text-xs text-ink-400">
            {meta.universeFresh} von {meta.universeSize} in den letzten 7 Tagen aktualisiert
          </p>
        )}
        <CalibrationPanel committed={meta.calibration} />
      </Card>

      {/* ── Backtest ───────────────────────────────────────────────────── */}
      <Card
        title="Backtest"
        hint="Rechnet den Faktor-Score an jedem Monatsende seit 2013 für den S&P 1500 nach und prüft ihn an den Renditen danach. Einmal im Monat genügt: Er rechnet Monatsenden, und ein neues kommt einmal im Monat. Läuft als eigener Prozess, eine Viertelstunde mit warmem Cache, beim ersten Mal rund eine Stunde."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={config.backtest.enabled}
            onChange={(v) => patch((d) => { d.backtest.enabled = v; })}
            label="Monatlich automatisch"
          />
          <label className="text-xs text-ink-400">Cron</label>
          <input
            value={config.backtest.cron}
            onChange={(e) => patch((d) => { d.backtest.cron = e.target.value; })}
            className={`${inputCls} w-32 font-mono`}
            title="5 Felder, in der Zeitzone des Zeitplans; Standard: am 2. um 14 Uhr"
          />
          {backtest.data?.schedule.next && (
            <span className="text-xs text-ink-500">nächster Lauf {new Date(backtest.data.schedule.next).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</span>
          )}
          <button
            onClick={() => void runBacktest()}
            disabled={!!backtest.data?.running}
            className="ml-auto rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-200 transition hover:bg-ink-700 disabled:opacity-40"
          >
            Jetzt rechnen
          </button>
        </div>
        {backtest.data && <p className="text-xs"><BacktestStatusLine o={backtest.data} /></p>}
      </Card>

      {/* ── Benachrichtigungen ─────────────────────────────────────────── */}
      <Card
        title="Benachrichtigungen"
        hint="Ein Urteilswechsel auf der Watchlist wird gemeldet, sobald er einen weiteren Nachtlauf gehalten hat — ein Score auf der Bandgrenze meldet sich so nicht jede Nacht. Alle Wechsel stehen außerdem über der Übersicht. Dazu nach dem Nachtlauf der Watchlist ein Überblick über alles andere, was seit dem letzten passiert ist."
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-ink-400">Format</label>
          <select
            value={config.alerts.format}
            onChange={(e) => patch((d) => { d.alerts.format = e.target.value as typeof d.alerts.format; })}
            className={inputCls}
          >
            <option value="json">JSON (Slack, Discord, …)</option>
            <option value="ntfy">ntfy</option>
          </select>
          <label className="text-xs text-ink-400">{config.alerts.format === 'ntfy' ? 'Topic-URL' : 'Webhook-URL'}</label>
          <input
            value={config.alerts.webhookUrl}
            onChange={(e) => patch((d) => { d.alerts.webhookUrl = e.target.value.trim(); })}
            placeholder={config.alerts.format === 'ntfy'
              ? 'https://ntfy.sh/dein-topic'
              : 'https://hooks.slack.com/… oder https://discord.com/api/webhooks/…'}
            className={`${inputCls} min-w-[280px] flex-1 font-mono`}
          />
          <button
            onClick={() => void testAlert()}
            disabled={!config.alerts.webhookUrl || dirty}
            title={dirty ? 'Erst speichern' : 'Eine Testnachricht an die gespeicherte URL senden'}
            className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-200 transition hover:bg-ink-700 disabled:opacity-40"
          >
            Test senden
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={config.alerts.digest}
              onChange={(e) => patch((d) => { d.alerts.digest = e.target.checked; })}
            />
            Täglicher Überblick nach dem Nachtlauf
          </label>
          <span className="text-xs text-ink-500">
            Herabstufungen und Kursziele, Insider-Trades, Quartalszahlen, Kurssprünge und Recherche-Funde der Watchlist,
            jedes Ereignis einmal; dazu die Quartalszahlen der nächsten drei Tage. Nichts Neues, keine Nachricht.
          </span>
          <button
            onClick={() => void testDigest()}
            disabled={!config.alerts.webhookUrl || dirty}
            title={dirty ? 'Erst speichern' : 'Den Überblick des letzten Tages jetzt senden, als Test markiert'}
            className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-ink-200 transition hover:bg-ink-700 disabled:opacity-40"
          >
            Überblick testen
          </button>
        </div>
        <p className="text-xs leading-relaxed text-ink-500">
          {config.alerts.format === 'ntfy'
            ? <>Leer = aus. Die URL des ntfy-Topics, auf ntfy.sh oder einem eigenen Server; die ntfy-App abonniert dasselbe
                Topic. Titel ist der Wechsel (<span className="font-mono">MSFT: HOLD → BUY</span>), darunter der Score, dazu 📈 oder 📉.
                Geschützter Server: <span className="font-mono">https://nutzer:passwort@…/topic</span> oder mit Zugangstoken{' '}
                <span className="font-mono">https://:tk_…@…/topic</span>.</>
            : <>Leer = aus. Gesendet wird ein JSON-POST mit <span className="font-mono">text</span> (Slack) und{' '}
                <span className="font-mono">content</span> (Discord) sowie Symbol, altem und neuem Urteil und Score.</>}
        </p>
      </Card>

      {/* ── Läufe ──────────────────────────────────────────────────────── */}
      <Card
        title="Läufe"
        hint={jobs?.running
          ? `Läuft gerade${jobs.current?.currentSymbol ? ` — ${jobs.current.currentSymbol}` : ''}`
          : `Nächster Lauf: ${fmtDateTime(jobs?.nextRun ?? null)}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => runNow()}
            disabled={jobs?.running}
            className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-ink-100 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ▶ Jetzt laufen ({jobs?.watched.length ?? 0} Aktien)
          </button>
          {jobs?.running && (
            <button
              onClick={stopRun}
              className="rounded border border-amber-700 bg-amber-950 px-3 py-1.5 text-sm text-amber-300 transition hover:bg-amber-900"
            >
              ■ Stoppen
            </button>
          )}
          {jobs?.current && (
            <span className="text-xs text-ink-400">
              {jobs.current.symbols.length}/{jobs.current.totals.symbols} erledigt ·{' '}
              {fmtDuration(jobs.current.startedAt, null)} ·{' '}
              <span className="text-ink-500">
                Daten {jobs.current.totals.data} · Distill {jobs.current.totals.distill} · Analyse {jobs.current.totals.analysis}
                {jobs.current.totals.reference > 0 && ` · Referenz ${jobs.current.totals.reference}`}
              </span>
              {jobs.current.totals.failed > 0 && (
                <span className="text-red-400"> · {jobs.current.totals.failed} Fehler</span>
              )}
            </span>
          )}
        </div>

        {(jobs?.runs.length ?? 0) === 0 ? (
          <p className="text-xs text-ink-500">Noch keine Läufe aufgezeichnet.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {jobs!.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                expanded={expandedRun === run.id}
                onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      {/* ── Schlüssel ──────────────────────────────────────────────────── */}
      <Card title="API-Schlüssel" hint="Nur Status — Werte werden ausschließlich aus der .env gelesen und nie ausgeliefert.">
        <div className="flex flex-wrap gap-2">
          {Object.entries(meta.keys).map(([name, present]) => (
            <span
              key={name}
              className={`rounded border px-2 py-0.5 text-xs ${
                present
                  ? 'border-emerald-700 bg-emerald-950 text-emerald-400'
                  : 'border-ink-700 bg-ink-950 text-ink-500'
              }`}
            >
              {present ? '✓' : '○'} {name}
            </span>
          ))}
        </div>
      </Card>
    </Page>
  );
}

// ── Run log row ──────────────────────────────────────────────────────────────

const RUN_STATUS_STYLE: Record<JobRun['status'], string> = {
  running: 'text-accent',
  ok:      'text-emerald-400',
  partial: 'text-amber-400',
  failed:  'text-red-400',
  stopped: 'text-ink-400',
};

const RUN_STATUS_LABEL: Record<JobRun['status'], string> = {
  running: 'läuft',
  ok:      'ok',
  partial: 'teilweise',
  failed:  'Fehler',
  stopped: 'gestoppt',
};

const TRIGGER_LABEL: Record<string, string> = {
  cron: 'Zeitplan', manual: 'von Hand', api: 'API', cli: 'Terminal', backfill: 'Nachholen',
};

const STEP_LABEL: Record<string, string> = {
  data: 'Daten', distill: 'Distill', analysis: 'Analyse', reference: 'Referenz',
};

const STEP_STATUS_STYLE = {
  ok:      'text-emerald-400',
  skipped: 'text-ink-500',
  failed:  'text-red-400',
} as const;

function RunRow({ run, expanded, onToggle }: { run: JobRun; expanded: boolean; onToggle: () => void }) {
  return (
    <li className="py-1.5">
      <button onClick={onToggle} className="flex w-full items-center gap-2 text-left">
        <span className="text-2xs text-ink-600">{expanded ? '▾' : '▸'}</span>
        <span className={`w-16 shrink-0 text-xs font-semibold ${RUN_STATUS_STYLE[run.status]}`}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="w-32 shrink-0 font-mono text-xs text-ink-400">{fmtDateTime(run.startedAt)}</span>
        <span className="shrink-0 rounded border border-ink-700 px-1 text-2xs text-ink-500">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
        <span className="truncate text-xs text-ink-500">
          {run.symbols.length}/{run.totals.symbols} Aktien · Daten {run.totals.data} · Distill {run.totals.distill} · Analyse {run.totals.analysis}
          {run.totals.reference > 0 && ` · Referenz ${run.totals.reference}`}
          {run.totals.failed > 0 && <span className="text-red-400"> · {run.totals.failed} Fehler</span>}
        </span>
        <span className="ml-auto shrink-0 text-xs text-ink-500">{fmtDuration(run.startedAt, run.finishedAt)}</span>
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 pl-6">
          {run.error && <div className="text-xs text-red-400">⚠ {run.error}</div>}
          {run.symbols.length === 0 && <div className="text-xs text-ink-500">Keine Aktien verarbeitet.</div>}
          {run.symbols.map((s) => (
            <div key={s.symbol} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="w-16 shrink-0 font-mono text-ink-300">{s.symbol}</span>
              {s.steps.map((step) => (
                <span key={step.step} className="text-ink-500">
                  <span className={STEP_STATUS_STYLE[step.status]}>{STEP_LABEL[step.step] ?? step.step}</span>
                  {': '}{step.detail}
                  {step.ms > 0 && <span className="text-ink-500"> ({deNumber(step.ms / 1000, 1)} s)</span>}
                  <span className="mx-1 text-ink-700">|</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
