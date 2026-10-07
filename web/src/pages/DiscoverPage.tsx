import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import Page from '../components/Page';
import Section from '../components/Section';
import Tip from '../components/Tip';
import StockLogo, { initialsFromName } from '../components/StockLogo';
import { useFirst } from '../components/More';
import { scoreColor } from '../components/stockList';
import { deNumber, fmtBig, fmtPrice } from '../format';
import {
  ANALYST_DAYS, ANALYST_MIN_NET, CHEAP_CONFIDENCE, CHEAP_GAP, CHEAP_HEALTH, CHEAP_MAX_GAP, INSIDER_DAYS,
  STRONG_PILLAR, TURN_DAYS, WEAK_PILLAR,
  type DiscoverUniverse, type UniverseStock,
} from '../../../src/analysis/discover';

type Region = 'all' | 'us' | 'eu';
const REGIONS: { key: Region; label: string }[] = [
  { key: 'all', label: 'Alle' }, { key: 'us', label: 'USA' }, { key: 'eu', label: 'Europa' },
];
/** The universe is the S&P 500 in dollars and the European indices in euros. */
const regionOf = (s: UniverseStock): Region => (s.currency === 'USD' ? 'us' : 'eu');

/** Rows each list shows before „alle anzeigen“. */
const FIRST = 6;

/** "27.9." this year, "27.9.25" before it. */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : String(d.getFullYear()).slice(2);
  return `${d.getDate()}.${d.getMonth() + 1}.${year}`;
}
const pct = (x: number) => `${deNumber(x * 100, 0)} %`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the page last showed, for the way back from a stock opened on it: the
 * lists at once instead of a loading line, and the filters as they were. For
 * the session only — a reload starts afresh.
 */
let last: { data: DiscoverUniverse | null; region: Region; sector: string } = { data: null, region: 'all', sector: '' };

/** An add in flight, done, or the error it ended with. */
type AddState = 'busy' | 'added' | { error: string };

/**
 * What else is worth a look: the reference universe — the S&P 500, the EURO
 * STOXX 50 and the DAX, scored every few nights to give the score a population
 * — asked five questions, each answered with the stocks and the reason each is
 * there. Until now it was only seen as the peers of a stock already on the
 * list. The stocks on the list are not in it; a click on a name opens the
 * stock, the button beside it puts it on the list.
 */
export default function DiscoverPage({ onSelect, onAdded }: {
  onSelect: (symbol: string) => void;
  /** A stock joined the list, so the list should show it. */
  onAdded: () => void;
}) {
  const [data, setData] = useState<DiscoverUniverse | null>(last.data);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState<Region>(last.region);
  const [sector, setSector] = useState(last.sector);
  useEffect(() => { last = { data, region, sector }; }, [data, region, sector]);
  const [adds, setAdds] = useState<Record<string, AddState>>({});

  useEffect(() => {
    let live = true;
    api.getDiscoverUniverse()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);

  const sectors = useMemo(() => (data
    ? [...new Set(Object.values(data.stocks).map((s) => s.sector).filter((s): s is string => !!s))].sort()
    : []), [data]);

  const shown = (symbol: string) => {
    const s = data?.stocks[symbol];
    return !!s && (region === 'all' || regionOf(s) === region) && (!sector || s.sector === sector);
  };
  const lists = useMemo(() => data && {
    best:     data.best.filter((x) => shown(x.symbol)),
    turns:    data.turns.filter((x) => shown(x.symbol)),
    cheap:    data.cheap.filter((x) => shown(x.symbol)),
    analysts: data.analysts.filter((x) => shown(x.symbol)),
    insiders: data.insiders.filter((x) => shown(x.symbol)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, region, sector]);

  async function add(symbol: string) {
    setAdds((a) => ({ ...a, [symbol]: 'busy' }));
    try {
      await api.addStock(symbol);
      setAdds((a) => ({ ...a, [symbol]: 'added' }));
      onAdded();
    } catch (e) {
      setAdds((a) => ({ ...a, [symbol]: { error: (e as Error).message } }));
    }
  }

  const line = (symbol: string, reason: ReactNode) => {
    const s = data!.stocks[symbol];
    return (
      <StockLine
        key={symbol}
        s={s}
        reason={reason}
        add={adds[symbol]}
        onAdd={() => { void add(symbol); }}
        onOpen={() => onSelect(symbol)}
      />
    );
  };
  const name = (symbol: string) => data?.stocks[symbol]?.name ?? symbol;

  const asOf = data?.oldest && data.newest
    ? (fmtDay(data.oldest) === fmtDay(data.newest) ? `Stand ${fmtDay(data.newest)}` : `Stand ${fmtDay(data.oldest)} bis ${fmtDay(data.newest)}`)
    : null;

  return (
    <Page
      title="Entdecken"
      subtitle={data
        ? `${data.size} Aktien aus S&P 500, EURO STOXX 50 und DAX, die nicht auf deiner Liste stehen${asOf ? ` · ${asOf}` : ''}`
        : 'Aktien außerhalb der Watchlist, die einen Blick wert sind'}
      width="max-w-6xl"
      actions={
        <>
          {REGIONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRegion(r.key)}
              aria-pressed={region === r.key}
              className={`rounded px-2.5 py-1 text-xs transition ${
                region === r.key ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
              }`}
            >
              {r.label}
            </button>
          ))}
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            aria-label="Sektor"
            className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-xs text-ink-200 focus:border-accent focus:outline-none"
          >
            <option value="">Alle Sektoren</option>
            {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </>
      }
    >
      {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
      {!data && !error && <div className="p-8 text-center text-sm text-ink-500">Lese das Universum …</div>}

      {data && lists && (
        <>
          <p className="text-sm text-ink-400">
            Die Scores hier rechnen nur mit den Zahlen. Die Text-Analyse kommt dazu, sobald eine Aktie auf der Liste steht;
            jede Aktie des Universums wird etwa einmal in der Woche neu bewertet.
          </p>
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Section fixed
              title="Was schneidet am besten ab?"
              finding={lists.best.length === 0 ? 'Kein Kaufurteil' : `${plural(lists.best.length, 'Kaufurteil', 'Kaufurteile')} · vorn ${name(lists.best[0].symbol)}`}
            >
              <List
                rows={lists.best}
                empty="Keine Aktie mit Kaufurteil unter diesem Filter."
                render={(b) => line(b.symbol, (
                  <>
                    {b.strong.length > 0 && <>stark in {b.strong.join(', ')}</>}
                    {b.strong.length > 0 && b.weak.length > 0 && ' · '}
                    {b.weak.length > 0 && <span className="text-ink-400">schwach in {b.weak.join(', ')}</span>}
                    {b.strong.length === 0 && b.weak.length === 0 && 'ohne herausragende Stärke, ohne Schwäche'}
                  </>
                ))}
                criteria={`Kaufurteile, bester Score zuerst. Stark heißt ab ${STRONG_PILLAR} von 10 in einer Säule des Scores, schwach bis ${WEAK_PILLAR}.`}
              />
            </Section>

            <Section fixed
              title="Wo hat sich das Urteil gedreht?"
              finding={lists.turns.length === 0 ? `Kein Wechsel in ${TURN_DAYS} Tagen`
                : `${lists.turns.filter((t) => t.up).length} nach oben, ${lists.turns.filter((t) => !t.up).length} nach unten`}
            >
              <List
                rows={lists.turns}
                empty={`Kein Urteilswechsel in den letzten ${TURN_DAYS} Tagen. Das Universum wird reihum alle paar Nächte neu bewertet; ein Wechsel erscheint mit der Bewertung danach.`}
                render={(t) => line(t.symbol, (
                  <>
                    <span className={t.up ? 'text-emerald-400' : 'text-red-400'}>{t.up ? '▲' : '▼'}</span>{' '}
                    {t.from} → <span className="font-semibold text-ink-100">{t.to}</span> am {fmtDay(t.day)}
                    {t.fromScore !== null && t.toScore !== null && (
                      <span className="text-ink-400"> · Score {deNumber(t.fromScore, 1)} → {deNumber(t.toScore, 1)}</span>
                    )}
                  </>
                ))}
                criteria={`Der letzte Wechsel des Urteils in den vergangenen ${TURN_DAYS} Tagen, der neueste zuerst.`}
              />
            </Section>

            <Section fixed
              title="Was ist deutlich unter Wert, ohne Warnzeichen?"
              finding={lists.cheap.length === 0 ? 'Keine' : `${plural(lists.cheap.length, 'Aktie', 'Aktien')}, fairer Wert mindestens ${pct(CHEAP_GAP)} über dem Kurs`}
            >
              <List
                rows={lists.cheap}
                empty="Keine Aktie erfüllt hier alle Bedingungen."
                render={(c) => {
                  const s = data.stocks[c.symbol];
                  return line(c.symbol, (
                    <>
                      fairer Wert <span className="font-mono text-ink-100">{fmtPrice(c.fair, s.currency)}</span>,{' '}
                      <span className="text-emerald-400">{pct(c.gap)} über dem Kurs</span>
                      {c.undervalued !== null && <span className="text-ink-400"> · {pct(c.undervalued)} der Modelle darüber</span>}
                    </>
                  ));
                }}
                criteria={`Der Median der marktnahen Modelle ${pct(CHEAP_GAP)} bis ${pct(CHEAP_MAX_GAP)} über dem Kurs — darüber liegt eher ein Modellfehler —, auch ihr vorsichtiges Viertel noch über dem Kurs; Verlässlichkeit ab ${CHEAP_CONFIDENCE} und Bilanz ab ${CHEAP_HEALTH} von 10, kein Verkaufsurteil und kein Deckel darauf, keine Pleitewarnung nach Altman, aktuelle Abschlüsse.`}
              />
            </Section>

            <Section fixed
              title="Wo werden die Analysten optimistischer?"
              finding={lists.analysts.length === 0 ? `Nirgends in ${ANALYST_DAYS} Tagen` : `${plural(lists.analysts.length, 'Aktie', 'Aktien')} in ${ANALYST_DAYS} Tagen`}
            >
              <List
                rows={lists.analysts}
                empty={`Keine Aktie, bei der die Analysten in ${ANALYST_DAYS} Tagen deutlich optimistischer wurden.`}
                render={(a) => line(a.symbol, (
                  <>
                    {[
                      a.upgrades > 0 && plural(a.upgrades, 'Hochstufung', 'Hochstufungen'),
                      a.raises > 0 && plural(a.raises, 'höheres Kursziel', 'höhere Kursziele'),
                      a.downgrades > 0 && plural(a.downgrades, 'Abstufung', 'Abstufungen'),
                      a.cuts > 0 && plural(a.cuts, 'niedrigeres Kursziel', 'niedrigere Kursziele'),
                    ].filter(Boolean).join(', ')}
                    {a.firms.length > 0 && (
                      <span className="text-ink-400"> · {a.firms.slice(0, 3).join(', ')}{a.firms.length > 3 ? ` und ${a.firms.length - 3} weitere` : ''}</span>
                    )}
                  </>
                ))}
                criteria={`Eine Hochstufung zählt zwei, ein höheres Kursziel eins, Abstufungen und Senkungen werden abgezogen; ab ${ANALYST_MIN_NET} in ${ANALYST_DAYS} Tagen und nicht mehr Ab- als Hochstufungen.`}
              />
            </Section>

            <Section fixed
              title="Wo kaufen Insider selbst?"
              finding={lists.insiders.length === 0 ? `Keine Käufe in ${INSIDER_DAYS} Tagen` : `${plural(lists.insiders.length, 'Aktie', 'Aktien')} in ${INSIDER_DAYS} Tagen`}
            >
              <List
                rows={lists.insiders}
                empty={`Kein Insider-Kauf an der Börse in ${INSIDER_DAYS} Tagen. Bei großen Firmen sind sie selten — Verkäufe sind die Regel, Käufe mit eigenem Geld die Ausnahme.`}
                render={(i) => {
                  const s = data.stocks[i.symbol];
                  return line(i.symbol, (
                    <>
                      {plural(i.buys, 'Kauf', 'Käufe')}{i.buyers > 1 ? ` von ${i.buyers} Personen` : ''}
                      {i.value !== null && <> für <span className="font-mono text-ink-100">{fmtBig(i.value, s.currency)}</span></>}
                      <span className="text-ink-400"> · zuletzt {fmtDay(i.last)}</span>
                    </>
                  ));
                }}
                criteria={`Käufe an der Börse mit eigenem Geld in ${INSIDER_DAYS} Tagen, die mit den meisten Käufern zuerst. Zuteilungen und ausgeübte Optionen zählen nicht.`}
              />
            </Section>
          </div>
        </>
      )}
    </Page>
  );
}

/** A list's first rows, the button for the rest, and what it takes to be on it. */
function List<T>({ rows, render, empty, criteria }: {
  rows: readonly T[];
  render: (row: T) => ReactNode;
  empty: string;
  criteria: string;
}) {
  const [first, more] = useFirst(rows, FIRST, 'Aktien');
  return (
    <div>
      {rows.length === 0
        ? <p className="text-sm text-ink-500">{empty}</p>
        : <ul className="divide-y divide-ink-800">{first.map(render)}</ul>}
      {more}
      <p className="mt-2 border-t border-ink-800 pt-2 text-xs leading-relaxed text-ink-500">{criteria}</p>
    </div>
  );
}

function StockLine({ s, reason, add, onAdd, onOpen }: {
  s: UniverseStock;
  reason: ReactNode;
  add?: AddState;
  onAdd: () => void;
  onOpen: () => void;
}) {
  const name = s.name ?? s.symbol;
  // A grid rather than a row: the reason runs under the score and the button
  // too, where a row squeezed it into a third of a phone's width.
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-start gap-x-3 py-2.5">
      <span className="mt-0.5">
        <StockLogo domain={s.logoDomain} symbol={s.symbol} fallbackInitials={initialsFromName(name)} size={24} />
      </span>
      <div className="min-w-0">
        <Tip focusable={false} content={`${name} ansehen`}>
          <button onClick={onOpen} className="max-w-full truncate text-left text-sm font-medium text-ink-100 transition hover:text-accent">
            {name}
          </button>
        </Tip>
        <div className="truncate font-mono text-2xs text-ink-500">
          {s.symbol}{s.industry ? ` · ${s.industry}` : ''}{s.marketCap !== null ? ` · ${fmtBig(s.marketCap, s.currency)}` : ''}
        </div>
      </div>
      <span className="mt-0.5">
        {s.score !== null && (
          <Tip focusable={false} content={`${s.verdict ?? ''} — nur aus den Zahlen${s.asOf ? `, Stand ${fmtDay(s.asOf)}` : ''}`}>
            <span className={`font-mono text-sm font-semibold tabular ${scoreColor(s.score)}`}>{deNumber(s.score, 1)}</span>
          </Tip>
        )}
      </span>
      <span className="w-[5.5rem] text-right">
        {add === 'added' ? (
          <span className="text-xs text-emerald-400">✓ auf der Liste</span>
        ) : add === 'busy' ? (
          <span className="text-xs text-ink-400">Hole Daten …</span>
        ) : (
          <Tip focusable={false} content={add ? `Fehlgeschlagen: ${add.error}` : 'Auf die Liste setzen — holt die Daten, die Text-Analyse folgt in der Nacht'}>
            <button
              onClick={onAdd}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition ${
                add ? 'border-red-700 text-red-400 hover:bg-red-950' : 'border-ink-700 bg-ink-800 text-ink-200 hover:border-accent hover:text-ink-50'
              }`}
            >
              {add ? '↻ Nochmal' : '+ Liste'}
            </button>
          </Tip>
        )}
      </span>
      <div className="col-span-3 col-start-2 mt-0.5 text-[13px] leading-snug text-ink-300">{reason}</div>
    </li>
  );
}
