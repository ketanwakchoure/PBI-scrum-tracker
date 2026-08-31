import { useEffect, useState, useCallback } from 'react';

// Static mode (GitHub Pages): data comes from pre-computed JSON published by
// the CI export instead of the live Express API.
const STATIC = import.meta.env.VITE_STATIC_DATA === 'true';
const BASE = import.meta.env.BASE_URL || '/';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export function useSprintData(sprintId, teamKey) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        if (STATIC) {
          const file = `${BASE}data/${teamKey || 'iota'}/${sprintId || 'active'}.json`;
          setData(await fetchJson(`${file}${refresh ? `?t=${Date.now()}` : ''}`));
        } else {
          const params = new URLSearchParams();
          if (sprintId) params.set('sprintId', sprintId);
          if (teamKey) params.set('team', teamKey);
          if (refresh) params.set('refresh', 'true');
          const qs = params.toString();
          setData(await fetchJson(`/api/sprint${qs ? `?${qs}` : ''}`));
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [sprintId, teamKey]
  );

  useEffect(() => {
    // Drop the previous sprint/team roster immediately so old developers
    // do not stay on screen while the next selection loads.
    setData(null);
    load();
  }, [load]);

  return { data, error, loading, refresh: () => load(true) };
}

export function useSprintList() {
  const [sprints, setSprints] = useState([]);
  const [teams, setTeams] = useState([]);
  const [liveMode, setLiveMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = STATIC
      ? fetchJson(`${BASE}data/index.json`).then((body) => ({
          sprints: body.sprints || [],
          teams: body.teams || [],
          liveMode: false
        }))
      : Promise.all([
          fetchJson('/api/sprints').catch(() => ({ sprints: [] })),
          fetchJson('/api/teams').catch(() => ({ teams: [] }))
        ]).then(([sprintBody, teamBody]) => ({
          sprints: sprintBody.sprints || [],
          teams: teamBody.teams || [],
          liveMode: Boolean(sprintBody.liveMode)
        }));
    load
      .then((r) => {
        if (cancelled) return;
        setSprints(r.sprints);
        setTeams(r.teams);
        setLiveMode(r.liveMode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { sprints, teams, liveMode };
}
