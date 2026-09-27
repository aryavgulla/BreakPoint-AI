/** AgentStatus — active subagent pulse indicators */

const DOT_CLASS = {
  idle:    'pulse-dot idle',
  running: 'pulse-dot running',
  done:    'pulse-dot online',
  error:   'pulse-dot offline',
};
const STATUS_COLOR = {
  idle:    'text-gray-500',
  running: 'text-cyan-400',
  done:    'text-green-400',
  error:   'text-red-400',
};

const AGENTS = [
  { key: 'A', label: 'Subagent A — Concurrency' },
  { key: 'B', label: 'Subagent B — Fuzzing' },
];

export default function AgentStatus({ agents }) {
  return (
    <div className="panel p-4">
      <div className="panel-header mb-3">Active Subagents</div>
      <div className="space-y-2.5 text-xs">
        {AGENTS.map(({ key, label }) => {
          const status = agents[key] ?? 'idle';
          return (
            <div key={key} className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-gray-300">
                <span className={DOT_CLASS[status] ?? 'pulse-dot idle'} />
                <span>{label}</span>
              </div>
              <span className={`font-medium ${STATUS_COLOR[status] ?? 'text-gray-500'}`}>
                {status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
