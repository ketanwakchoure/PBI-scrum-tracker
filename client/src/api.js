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

// Deterministic filename slug for a release (shared with the static export).
export const releaseSlug = (name) => name.replace(/[^a-zA-Z0-9.]/g, '_');

export function useReleases(teamKey) {
  const [releases, setReleases] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setReleases(null);
    const url = STATIC
      ? `${BASE}data/epics/${teamKey}/releases.json`
      : `/api/releases?team=${teamKey}`;
    fetchJson(url)
      .then((body) => {
        if (!cancelled) setReleases(body.releases || []);
      })
      .catch(() => {
        if (!cancelled) setReleases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamKey]);
  return releases;
}

export function useEpics(teamKey, release) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!release) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    const url = STATIC
      ? `${BASE}data/epics/${teamKey}/${releaseSlug(release)}.json`
      : `/api/epics?team=${teamKey}&release=${encodeURIComponent(release)}`;
    fetchJson(url)
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamKey, release]);
  return { data, error, loading };
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
