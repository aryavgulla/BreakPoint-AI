/**
 * MergeRiskRadar — Recharts RadarChart showing per-dimension security coverage.
 * Axes: Input Validation, Race Conditions, Auth Bypass, Payload Fuzzing,
 *       Error Handling, Patch Coverage.
 */
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

const EMPTY_AXES = [
  { subject: 'Input Validation', value: 0, fullMark: 100 },
  { subject: 'Race Conditions',  value: 0, fullMark: 100 },
  { subject: 'Auth Bypass',      value: 0, fullMark: 100 },
  { subject: 'Payload Fuzzing',  value: 0, fullMark: 100 },
  { subject: 'Error Handling',   value: 0, fullMark: 100 },
  { subject: 'Patch Coverage',   value: 0, fullMark: 100 },
];

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { subject, value } = payload[0].payload;
  return (
    <div className="panel px-3 py-2 text-xs text-gray-300 shadow-xl">
      <div className="text-gray-400 mb-0.5">{subject}</div>
      <div className="text-cyan-400 font-bold text-sm">{value}%</div>
    </div>
  );
}

export default function MergeRiskRadar({ axes }) {
  const data = axes?.length ? axes : EMPTY_AXES;

  return (
    <div className="panel p-5 flex flex-col">
      <div className="panel-header mb-4">Merge Risk Radar</div>

      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius={90}>
            <PolarGrid
              stroke="#21262d"
              strokeDasharray="3 3"
            />
            <PolarAngleAxis
              dataKey="subject"
              tick={{ fill: '#8b949e', fontSize: 9, fontFamily: 'var(--font-mono)' }}
              tickLine={false}
            />
            <PolarRadiusAxis
              domain={[0, 100]}
              tickCount={4}
              tick={{ fill: '#30363d', fontSize: 8 }}
              axisLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <Radar
              name="Security Coverage"
              dataKey="value"
              stroke="#58a6ff"
              fill="#58a6ff"
              fillOpacity={0.18}
              strokeWidth={1.5}
              dot={{ r: 3, fill: '#79c0ff', strokeWidth: 0 }}
              activeDot={{ r: 5, fill: '#58a6ff', strokeWidth: 0 }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend row */}
      <div className="mt-3 flex flex-wrap gap-2 justify-center">
        {data.map(({ subject, value }) => (
          <div key={subject} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: value >= 80 ? '#3fb950' : value >= 50 ? '#d29922' : '#f85149' }}
            />
            <span className="text-gray-400">{subject.split(' ')[0]}</span>
            <span className="tabular-nums" style={{ color: value >= 80 ? '#3fb950' : value >= 50 ? '#d29922' : '#f85149' }}>
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
