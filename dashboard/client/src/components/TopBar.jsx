/** TopBar — sticky header with clock, status, RUN TESTS button */
import { useEffect, useState } from 'react';

const STATUS_LABEL = {
  online:     'Server Online',
  offline:    'Server Offline',
  connecting: 'Connecting…',
};
const STATUS_DOT_CLASS = {
  online:     'pulse-dot online',
  offline:    'pulse-dot offline',
  connecting: 'pulse-dot idle',
};
const STATUS_TEXT_COLOR = {
  online:     'text-green-400',
  offline:    'text-red-400',
  connecting: 'text-amber-400',
};

export default function TopBar({ serverStatus, running, onRunTests, onClear }) {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header
      className="sticky top-0 z-20 border-b border-gray-700 bg-gray-900 px-5 py-2.5"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="#f85149" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          <span className="text-xs font-semibold tracking-widest text-gray-100 uppercase">
            BreakPoint AI
          </span>
          <span className="badge bg-red-500/10 text-red-400 border border-red-500/30">
            C2 DASHBOARD
          </span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-5 text-xs">
          <span className="tabular-nums text-gray-500 hidden sm:block">{clock}</span>

          {/* Connection status */}
          <div className={`flex items-center gap-2 ${STATUS_TEXT_COLOR[serverStatus] ?? 'text-gray-400'}`}>
            <span className={STATUS_DOT_CLASS[serverStatus] ?? 'pulse-dot idle'} />
            <span className="font-medium">{STATUS_LABEL[serverStatus] ?? serverStatus}</span>
          </div>

          <button
            onClick={onRunTests}
            disabled={running}
            className={`px-3 py-1.5 rounded border text-xs font-semibold transition-colors
              ${running
                ? 'bg-gray-700/50 border-gray-600 text-gray-500 cursor-not-allowed'
                : 'bg-red-500/10 border-red-500/40 text-red-400 hover:bg-red-500/20'}`}
          >
            {running ? '⏳ RUNNING…' : '▶ RUN TESTS'}
          </button>

          <button
            onClick={onClear}
            className="px-3 py-1.5 rounded border border-gray-600 bg-gray-700/40 text-gray-400 text-xs font-semibold hover:bg-gray-700 transition-colors"
          >
            CLR
          </button>
        </div>
      </div>
    </header>
  );
}
