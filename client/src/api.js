import { useEffect, useState, useCallback } from 'react';

export function useSprintData(sprintId, teamKey) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (sprintId) params.set('sprintId', sprintId);
        if (teamKey) params.set('team', teamKey);
        if (refresh) params.set('refresh', 'true');
        const qs = params.toString();
        const res = await fetch(`/api/sprint${qs ? `?${qs}` : ''}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        setData(await res.json());
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
    Promise.all([
      fetch('/api/sprints').then((r) => (r.ok ? r.json() : { sprints: [] })),
      fetch('/api/teams').then((r) => (r.ok ? r.json() : { teams: [] }))
    ])
      .then(([sprintBody, teamBody]) => {
        if (cancelled) return;
        setSprints(sprintBody.sprints || []);
        setTeams(teamBody.teams || []);
        setLiveMode(Boolean(sprintBody.liveMode));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { sprints, teams, liveMode };
}
