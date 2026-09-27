/**
 * LiveLog — virtualised, auto-scrolling SSE event feed.
 * Renders log entries streamed from the Express backend.
 */
import { useEffect, useRef } from 'react';

const TYPE_COLOR = {
  pass:    'text-green-400',
  fail:    'text-red-400',
  warn:    'text-amber-400',
  info:    'text-cyan-400',
  payload: 'text-violet-400',
  patch:   'text-amber-300',
  system:  'text-gray-400',
};

const BADGE_CLASS = {
  pass:    'bg-green-500/10 text-green-400 border-green-500/25',
  fail:    'bg-red-500/10 text-red-400 border-red-500/25',
  warn:    'bg-amber-500/10 text-amber-400 border-amber-500/25',
  payload: 'bg-violet-500/10 text-violet-400 border-violet-500/25',
  patch:   'bg-amber-500/10 text-amber-300 border-amber-400/25',
  info:    'bg-cyan-500/10 text-cyan-400 border-cyan-500/25',
  system:  'bg-gray-700 text-gray-400 border-gray-600',
};

const BADGE_LABEL = {
  pass: 'PASS', fail: 'FAIL', warn: 'WARN', payload: 'PAYLOAD',
  patch: 'PATCH', info: 'INFO', system: 'SYS',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTs(ts) {
  return ts ? new Date(ts).toISOString().slice(11, 23) : new Date().toISOString().slice(11, 23);
}

export default function LiveLog({ logs }) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom when new log entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs.length]);

  return (
    <div className="panel flex flex-col" style={{ height: '520px' }}>
      {/* Header bar (mock macOS window buttons) */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" />
          <span className="panel-header ml-2">Live Attack Log</span>
        </div>
        <div className="text-xs text-gray-500">
          {logs.length > 0 ? `${logs.length} events` : 'Awaiting stream…'}
        </div>
      </div>

      {/* Scrollable log body */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 text-xs font-mono">
        {logs.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-600">
            <span>Waiting for SSE events…</span>
          </div>
        )}
        {logs.map(entry => {
          const bClass = BADGE_CLASS[entry.type] ?? BADGE_CLASS.info;
          const tClass = TYPE_COLOR[entry.type] ?? 'text-gray-300';
          return (
            <div
              key={entry.id}
              className="log-line flex items-start gap-2 py-0.5 px-2 rounded hover:bg-gray-800/50"
            >
              <span className="text-gray-600 select-none shrink-0 tabular-nums w-28">
                {fmtTs(entry.ts)}
              </span>
              <span className={`badge border ${bClass} shrink-0`}>
                {BADGE_LABEL[entry.type] ?? 'INFO'}
              </span>
              <span
                className={`${tClass} break-all leading-relaxed`}
                dangerouslySetInnerHTML={{ __html: escapeHtml(entry.message) }}
              />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
