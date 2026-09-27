/** StatsRow — four KPI counters across the top */
export default function StatsRow({ stats }) {
  const cards = [
    { label: 'Total Events', value: stats.total, colorClass: 'text-cyan-400 glow-cyan' },
    { label: 'Pass',         value: stats.pass,  colorClass: 'text-green-400 glow-green' },
    { label: 'Fail / Vuln',  value: stats.fail,  colorClass: 'text-red-400 glow-red' },
    { label: 'Warnings',     value: stats.warn,  colorClass: 'text-amber-400 glow-amber' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map(({ label, value, colorClass }) => (
        <div key={label} className="panel p-4">
          <div className="panel-header mb-1">{label}</div>
          <div className={`text-2xl font-bold tabular-nums ${colorClass}`}>{value}</div>
        </div>
      ))}
    </div>
  );
}
