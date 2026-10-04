import Journal from '../components/Journal';
import { CloseIcon } from '../components/icons';

/**
 * The whole journal on one page, newest first: every note, purchase and sale,
 * whichever stocks it names — or none, for a thought about the market.
 */
export default function JournalPage({ onClose, symbols }: { onClose: () => void; symbols: string[] }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-ink-100">Journal</h2>
          <span className="text-xs text-ink-500">Was ich gelesen, gedacht, gekauft und verkauft habe — und warum</span>
          <button
            onClick={onClose}
            title="Schließen (Esc)"
            className="ml-auto rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
          >
            <CloseIcon />
          </button>
        </div>
        <Journal suggest={symbols} startOpen />
      </div>
    </div>
  );
}
