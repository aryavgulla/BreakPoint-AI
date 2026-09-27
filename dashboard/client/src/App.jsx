/**
 * BreakPoint AI — C2 Dashboard (React edition)
 * Root application component — assembles all panels and drives state via useSSE.
 *
 * Fuzzer SSE integration
 * ──────────────────────
 * Clicking "Run Tests" now does two things simultaneously:
 *   1. POSTs to /run-tests  (existing path — keeps the demo sequence / MCP
 *      broadcast channel alive for any other connected dashboard tabs).
 *   2. Sets `fuzzerActive` to true, which causes `useFuzzerStream` to open
 *      GET /events/fuzzer.  That dedicated SSE channel streams live Jest
 *      terminal output as `log` events and emits an updated `radar` payload
 *      the moment Jest exits — all dispatched into the same reducer that
 *      feeds LiveLog and MergeRiskRadar.
 */
import { useReducer, useState } from 'react';
import { useSSE, useFuzzerStream } from './hooks/useSSE';
import TopBar          from './components/TopBar.jsx';
import StatsRow        from './components/StatsRow.jsx';
import LiveLog         from './components/LiveLog.jsx';
import MergeConfidence from './components/MergeConfidence.jsx';
import MergeRiskRadar  from './components/MergeRiskRadar.jsx';
import AttackSurface   from './components/AttackSurface.jsx';
import AgentStatus     from './components/AgentStatus.jsx';
import ThreatTimeline  from './components/ThreatTimeline.jsx';

export default function App() {
  // useSSE now returns { ...state, dispatch } so we can share the reducer
  // with useFuzzerStream without introducing a context.
  const { dispatch, ...sseState } = useSSE();

  // `fuzzerActive` gates the useFuzzerStream effect.  It flips to true when
  // the user clicks "Run Tests" and returns to false when the `done` event
  // arrives (or on error / unmount).
  const [fuzzerActive, setFuzzerActive] = useState(false);

  const { isFuzzing } = useFuzzerStream(dispatch, fuzzerActive, {
    // No pattern filter by default — run the full suite.
    // Pass e.g. { pattern: 'Fuzzing' } to limit to fuzzing tests only.
  }, () => setFuzzerActive(false));

  // isFuzzing drives the button's disabled/loading state; also track the
  // legacy `running` flag for the POST to /run-tests.
  const [running, setRunning] = useReducer((_, v) => v, false);

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handleRunTests() {
    if (running || isFuzzing) return;

    // Open the fuzzer SSE stream — useFuzzerStream will close it on `done`
    setFuzzerActive(true);
    setRunning(true);

    try {
      const res = await fetch('/run-tests', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Failed to trigger test run:', err);
      // Only reset on error — on success, useFuzzerStream resets when `done` arrives
      setFuzzerActive(false);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="min-h-screen" style={{ fontFamily: 'var(--font-mono)', background: '#0a0c10' }}>
      <TopBar
        serverStatus={sseState.serverStatus}
        running={running || isFuzzing}
        onRunTests={handleRunTests}
        onClear={() => {/* logs live in SSE state; just scroll to top */}}
      />

      <main className="p-4 max-w-screen-2xl mx-auto space-y-4">
        {/* KPI row */}
        <StatsRow stats={sseState.stats} />

        {/* Main content: log (left) + right sidebar */}
        <div className="grid grid-cols-12 gap-4">
          {/* Live Log — 8 cols */}
          <div className="col-span-12 lg:col-span-8">
            <LiveLog logs={sseState.logs} />
          </div>

          {/* Right sidebar — 4 cols */}
          <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
            <MergeConfidence score={sseState.score} />
            <AttackSurface   surface={sseState.surface} />
            <AgentStatus     agents={sseState.agents} />
          </div>
        </div>

        {/* Full-width bottom row: Radar + Timeline */}
        <div className="grid grid-cols-12 gap-4">
          {/* Merge Risk Radar — 5 cols */}
          <div className="col-span-12 lg:col-span-5">
            <MergeRiskRadar axes={sseState.radarAxes} />
          </div>

          {/* Threat Mitigation Timeline — 7 cols */}
          <div className="col-span-12 lg:col-span-7">
            <ThreatTimeline timeline={sseState.timeline} />
          </div>
        </div>
      </main>
    </div>
  );
}
