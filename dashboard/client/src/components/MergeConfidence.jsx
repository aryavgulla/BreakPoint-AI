/**
 * MergeConfidence — animated SVG ring + per-dimension score breakdown.
 */

const CIRCUMFERENCE = 351.86; // 2π × r=56

function scoreColor(s) {
  if (s >= 80) return '#3fb950';
  if (s >= 55) return '#d29922';
  return '#f85149';
}
function scoreLabel(s) {
  if (s >= 80) return 'SAFE TO MERGE';
  if (s >= 55) return 'REVIEW REQUIRED';
  return 'DO NOT MERGE';
}
function scoreLabelClass(s) {
  if (s >= 80) return 'text-green-400';
  if (s >= 55) return 'text-amber-400';
  return 'text-red-400';
}

export default function MergeConfidence({ score }) {
  const { fuzz, concur, patch } = score;
  const vals = [fuzz, concur, patch].filter(v => v != null);
  const avg  = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  const offset = CIRCUMFERENCE - (avg / 100) * CIRCUMFERENCE;
  const color  = scoreColor(avg);

  return (
    <div className="panel p-5 flex flex-col items-center">
      <div className="panel-header mb-4">Merge Confidence Score</div>

      {/* SVG ring */}
      <div className="relative" style={{ width: 140, height: 140 }}>
        <svg viewBox="0 0 140 140" className="w-full h-full -rotate-90">
          <circle cx="70" cy="70" r="56" fill="none" stroke="#21262d" strokeWidth="10" />
          <circle
            cx="70" cy="70" r="56" fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="score-ring"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`text-3xl font-bold tabular-nums ${scoreLabelClass(avg)}`}
            style={{ textShadow: `0 0 10px ${color}` }}
          >
            {avg}
          </span>
          <span className="text-xs text-gray-500 mt-0.5">/ 100</span>
        </div>
      </div>

      <div className={`mt-3 text-xs font-semibold uppercase tracking-wider ${scoreLabelClass(avg)}`}>
        {vals.length ? scoreLabel(avg) : 'Awaiting Results'}
      </div>

      {/* Sub-scores */}
      <div className="w-full mt-4 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-xs text-gray-500 mb-0.5">Fuzz</div>
          <div className="text-sm font-semibold text-violet-400">
            {fuzz != null ? `${fuzz}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-0.5">Concur.</div>
          <div className="text-sm font-semibold text-cyan-400">
            {concur != null ? `${concur}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-0.5">Patch</div>
          <div className="text-sm font-semibold text-amber-400">
            {patch != null ? `${patch}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}
