/**
 * useSSE — custom hook that connects to the Express SSE endpoint and
 * dispatches all named events into a single reducer-based state object.
 *
 * useFuzzerStream — companion hook that opens the dedicated /events/fuzzer
 * SSE channel whenever `active` flips to true.  Live terminal lines are
 * appended to the shared reducer via the LOG action; the final `radar` event
 * updates MergeRiskRadar in real time; the `done` event marks the run as
 * finished and the EventSource is closed.
 *
 * Usage in App.jsx:
 *   const [fuzzerActive, setFuzzerActive] = useState(false);
 *   const { isFuzzing, lastResult } = useFuzzerStream(dispatch, fuzzerActive, {
 *     pattern: 'Fuzzing',   // optional: jest -t pattern
 *   });
 */
import { useEffect, useReducer, useCallback, useRef, useState } from 'react';

const MAX_LOG_LINES    = 500;
const MAX_TIMELINE     = 150;

const INITIAL = {
  serverStatus:  'connecting',   // connecting | online | offline
  logs:          [],
  stats:         { total: 0, pass: 0, fail: 0, warn: 0 },
  score:         { fuzz: null, concur: null, patch: null },
  surface:       { transfer: 'unknown', validation: 'unknown', race: 'unknown', auth: 'unknown' },
  agents:        { A: 'idle', B: 'idle' },
  radarAxes:     [],
  timeline:      [],
};

function reducer(state, action) {
  switch (action.type) {
    case 'SERVER_STATUS':
      return { ...state, serverStatus: action.status };

    case 'LOG': {
      const { type, message, ts } = action.data;
      const newStats = { ...state.stats, total: state.stats.total + 1 };
      if (type === 'pass') newStats.pass++;
      else if (type === 'fail') newStats.fail++;
      else if (type === 'warn') newStats.warn++;
      const entry = { id: `${ts}-${Math.random()}`, type, message, ts };
      const logs = [...state.logs, entry];
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
      return { ...state, logs, stats: newStats };
    }

    case 'SCORE':
      return {
        ...state,
        score: {
          fuzz:   action.data.fuzz   ?? state.score.fuzz,
          concur: action.data.concur ?? state.score.concur,
          patch:  action.data.patch  ?? state.score.patch,
        },
      };

    case 'STATUS':
      return { ...state, agents: { ...state.agents, [action.data.agent]: action.data.status } };

    case 'SURFACE':
      return { ...state, surface: { ...state.surface, ...action.data } };

    case 'RADAR':
      return { ...state, radarAxes: action.data.axes ?? [] };

    case 'TIMELINE': {
      const entries = [...state.timeline, action.data];
      if (entries.length > MAX_TIMELINE) entries.shift();
      return { ...state, timeline: entries };
    }

    case 'RESET':
      return { ...INITIAL, serverStatus: state.serverStatus };

    default:
      return state;
  }
}

export function useSSE() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const connect = useCallback(() => {
    dispatch({ type: 'SERVER_STATUS', status: 'connecting' });
    const es = new EventSource('/events');

    es.onopen  = () => dispatch({ type: 'SERVER_STATUS', status: 'online' });
    es.onerror = () => {
      dispatch({ type: 'SERVER_STATUS', status: 'offline' });
      es.close();
      setTimeout(connect, 3000);
    };

    es.addEventListener('log',      e => dispatch({ type: 'LOG',      data: JSON.parse(e.data) }));
    es.addEventListener('score',    e => dispatch({ type: 'SCORE',    data: JSON.parse(e.data) }));
    es.addEventListener('status',   e => dispatch({ type: 'STATUS',   data: JSON.parse(e.data) }));
    es.addEventListener('surface',  e => dispatch({ type: 'SURFACE',  data: JSON.parse(e.data) }));
    es.addEventListener('radar',    e => dispatch({ type: 'RADAR',    data: JSON.parse(e.data) }));
    es.addEventListener('timeline', e => dispatch({ type: 'TIMELINE', data: JSON.parse(e.data) }));
    es.addEventListener('reset',    () => dispatch({ type: 'RESET' }));

    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  // Fetch initial radar + timeline on mount
  useEffect(() => {
    fetch('/api/radar').then(r => r.json()).then(data => {
      dispatch({ type: 'RADAR', data });
    }).catch(() => {});
    fetch('/api/timeline').then(r => r.json()).then(entries => {
      entries.forEach(e => dispatch({ type: 'TIMELINE', data: e }));
    }).catch(() => {});
  }, []);

  // Expose dispatch so App.jsx can pass it to useFuzzerStream without
  // duplicating state or adding a React context.
  return { ...state, dispatch };
}

// ─────────────────────────────────────────────────────────────────────────────
// useFuzzerStream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens `GET /events/fuzzer` as an EventSource whenever `active` is true.
 * Feeds every received event directly into the caller-supplied `dispatch`
 * (the same dispatcher returned by `useSSE`'s internal useReducer) so the
 * LiveLog and MergeRiskRadar update without any extra state or prop drilling.
 *
 * @param {function}  dispatch  - The `dispatch` function from useSSE's reducer.
 *                                Pass it down from App via a context or a ref.
 * @param {boolean}   active    - Set to true to start the run; false to ignore.
 * @param {object}    [opts]
 * @param {string}    [opts.pattern]  - Optional Jest -t filter pattern.
 * @param {number}    [opts.timeout]  - Max ms before Jest is killed (default 60000).
 *
 * @returns {{ isFuzzing: boolean, lastResult: {exitCode,passed,failed}|null }}
 */
export function useFuzzerStream(dispatch, active, opts = {}, onDone = null) {
  const [isFuzzing,  setIsFuzzing]  = useState(false);
  const [lastResult, setLastResult] = useState(null);

  // Keep a stable ref to opts so the effect doesn't re-run on every render
  // when the caller passes an inline object literal.
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; }, [opts]);

  useEffect(() => {
    if (!active) return;

    // Build the URL — append query params only when provided
    const params = new URLSearchParams();
    if (optsRef.current.pattern) params.set('pattern', optsRef.current.pattern);
    if (optsRef.current.timeout) params.set('timeout', String(optsRef.current.timeout));
    const url = `/events/fuzzer${params.size ? `?${params}` : ''}`;

    setIsFuzzing(true);
    setLastResult(null);

    dispatch({ type: 'SERVER_STATUS', status: 'online' });
    dispatch({
      type: 'LOG',
      data: { type: 'system', message: '── Connecting to fuzzer stream… ──', ts: Date.now() },
    });

    const es = new EventSource(url);

    // ── Named event handlers ────────────────────────────────────────────────

    es.addEventListener('log', e => {
      dispatch({ type: 'LOG', data: JSON.parse(e.data) });
    });

    es.addEventListener('score', e => {
      dispatch({ type: 'SCORE', data: JSON.parse(e.data) });
    });

    es.addEventListener('status', e => {
      dispatch({ type: 'STATUS', data: JSON.parse(e.data) });
    });

    es.addEventListener('surface', e => {
      dispatch({ type: 'SURFACE', data: JSON.parse(e.data) });
    });

    // `radar` — the key event: updates MergeRiskRadar axes in real time
    es.addEventListener('radar', e => {
      dispatch({ type: 'RADAR', data: JSON.parse(e.data) });
    });

    es.addEventListener('timeline', e => {
      dispatch({ type: 'TIMELINE', data: JSON.parse(e.data) });
    });

    // `done` — server signals the Jest run has exited; close cleanly
    es.addEventListener('done', e => {
      const result = JSON.parse(e.data);
      setLastResult(result);
      setIsFuzzing(false);
      es.close();
      if (onDone) onDone(result);
    });

    // Transport error (network drop, server restart, etc.)
    es.onerror = () => {
      dispatch({
        type: 'LOG',
        data: { type: 'fail', message: '── Fuzzer stream error — connection lost ──', ts: Date.now() },
      });
      setIsFuzzing(false);
      es.close();
    };

    // Cleanup: close the EventSource when `active` becomes false or the
    // component unmounts mid-run
    return () => {
      es.close();
      setIsFuzzing(false);
    };
  }, [active, dispatch]);

  return { isFuzzing, lastResult };
}
