/**
 * ThreatTimeline — visual horizontal timeline of security events.
 * Each entry is a pill-shaped card grouped by phase, colour-coded by severity.
 * A thin coloured tick bar sits above each card.
 */

const SEVERITY_COLORS = {
  info:     { bar: '#58a6ff', bg: 'rgba(88,166,255,0.08)',  border: 'rgba(88,166,255,0.25)',  text: '#79c0ff' },
  warn:     { bar: '#d29922', bg: 'rgba(210,153,34,0.08)',   border: 'rgba(210,153,34,0.3)',   text: '#e3b341' },
  critical: { bar: '#f85149', bg: 'rgba(248,81,73,0.1)',     border: 'rgba(248,81,73,0.3)',    text: '#ff7b72' },
  success:  { bar: '#3fb950', bg: 'rgba(63,185,80,0.08)',    border: 'rgba(63,185,80,0.25)',   text: '#56d364' },
};

const PHASE_ICON = {
  Init:      '⚡',
  Scan:      '🔍',
  Fuzzing:   '💉',
  Analysis:  '🧪',
  Patch:     '🩹',
  Result:    '✓',
  Discovery: '📂',
};

function fmtTime(ts) {
  return ts ? new Date(ts).toISOString().slice(11, 19) : '—';
}

export default function ThreatTimeline({ timeline }) {
  if (!timeline?.length) {
    return (
      <div className="panel p-4">
        <div className="panel-header mb-3">Threat Mitigation Timeline</div>
        <div className="text-xs text-gray-600 py-4 text-center">No events yet — run tests to populate the timeline.</div>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="panel-header mb-3">Threat Mitigation Timeline</div>

      {/* Scrollable horizontal row */}
      <div className="overflow-x-auto pb-1">
        <div className="flex items-end gap-2 min-w-max py-1">
          {/* Connector line */}
          {timeline.map((entry, idx) => {
            const c = SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info;
            return (
              <div key={entry.id ?? idx} className="flex flex-col items-center gap-1">
                {/* Severity tick bar */}
                <div
                  className="rounded"
                  style={{
                    width: 4,
                    height: entry.severity === 'critical' ? 28 : entry.severity === 'success' ? 24 : 18,
                    background: c.bar,
                    opacity: 0.9,
                  }}
                />
                {/* Card */}
                <div
                  className="rounded px-2 py-1.5 text-xs cursor-default select-none"
                  style={{
                    background:  c.bg,
                    border:      `1px solid ${c.border}`,
                    minWidth:    72,
                    maxWidth:    120,
                  }}
                  title={entry.detail}
                >
                  <div className="flex items-center gap-1 mb-0.5">
                    <span style={{ fontSize: 9 }}>{PHASE_ICON[entry.phase] ?? '•'}</span>
                    <span className="font-semibold" style={{ color: c.text, fontSize: '0.6rem', letterSpacing: '0.04em' }}>
                      {entry.phase?.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-gray-300 leading-snug" style={{ fontSize: '0.62rem', lineHeight: 1.35 }}>
                    {entry.label}
                  </div>
                  <div className="text-gray-600 mt-0.5 tabular-nums" style={{ fontSize: '0.55rem' }}>
                    {fmtTime(entry.ts)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex gap-4 text-xs text-gray-500">
        {Object.entries(SEVERITY_COLORS).map(([sev, c]) => (
          <div key={sev} className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: c.bar }} />
            {sev}
          </div>
        ))}
      </div>
    </div>
  );
}
