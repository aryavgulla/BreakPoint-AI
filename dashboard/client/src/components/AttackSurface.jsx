/** AttackSurface — badge grid showing live status of each attack vector */

const BADGE_CONFIG = {
  vulnerable: 'bg-red-500/10 text-red-400 border-red-500/30',
  patched:    'bg-green-500/10 text-green-400 border-green-500/30',
  scanning:   'bg-amber-500/10 text-amber-400 border-amber-500/30',
  clean:      'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
  unknown:    'bg-gray-700 text-gray-400 border-gray-600',
};
const BADGE_LABEL = {
  vulnerable: 'VULNERABLE',
  patched:    'PATCHED',
  scanning:   'SCANNING',
  clean:      'CLEAN',
  unknown:    '—',
};

const SURFACES = [
  { key: 'transfer',   label: 'POST /api/v1/transfer' },
  { key: 'validation', label: 'Input Validation' },
  { key: 'race',       label: 'Race Condition' },
  { key: 'auth',       label: 'Auth Bypass' },
];

export default function AttackSurface({ surface }) {
  return (
    <div className="panel p-4">
      <div className="panel-header mb-3">Attack Surface</div>
      <div className="space-y-2 text-xs">
        {SURFACES.map(({ key, label }) => {
          const status = surface[key] ?? 'unknown';
          const badgeClass = BADGE_CONFIG[status] ?? BADGE_CONFIG.unknown;
          const badgeText  = BADGE_LABEL[status] ?? status.toUpperCase();
          return (
            <div key={key} className="flex items-center justify-between">
              <span className="text-gray-400">{label}</span>
              <span className={`badge border ${badgeClass}`}>{badgeText}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
