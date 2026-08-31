import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useSprintData, useSprintList, useReleases } from './api.js';
import Overview from './pages/Overview.jsx';
import Burnup from './pages/Burnup.jsx';
import Epics from './pages/Epics.jsx';

function workingDaysLeft(burnup) {
  if (!burnup?.workingDays?.length) return null;
  return burnup.workingDays.filter((d) => d > burnup.todayKey).length;
}

const STATE_LABEL = { active: 'Active', closed: 'Closed', future: 'Future' };

export default function App() {
  const [sprintId, setSprintId] = useState('');
  const [teamKey, setTeamKey] = useState('iota');
  const [release, setRelease] = useState('');
  const { sprints, teams } = useSprintList();
  const releases = useReleases(teamKey);
  const sprintState = useSprintData(sprintId, teamKey);
  const { data, loading, error, refresh } = sprintState;
  const left = workingDaysLeft(data?.burnup);
  const teamName = data?.team?.name || teams.find((t) => t.key === teamKey)?.name || 'IOTA (PBI)';
  const onEpicsPage = useLocation().pathname.startsWith('/epics');

  // Default to the newest release; reset when the team's release list changes.
  useEffect(() => {
    if (releases?.length && !releases.some((r) => r.name === release)) {
      setRelease(releases[0].name);
    }
  }, [releases, release]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-mark"
            src={`${import.meta.env.BASE_URL}celigo-monogram.png?v=2`}
            alt="Celigo"
          />
          <div>
            <div className="brand-title">Scrum Tracker</div>
            <div className="brand-sub">
              {teamName}
              {data?.sprint ? ` · ${data.sprint.name}` : ''}
              {left !== null && <span className="days-left"> · {left} workdays left</span>}
            </div>
          </div>
        </div>
        <nav className="tabs">
          <NavLink to="/" end className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            Sprint Overview
          </NavLink>
          <NavLink to="/burnup" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            Burnup
          </NavLink>
          <NavLink to="/epics" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            Epics
          </NavLink>
        </nav>
        <div className="topbar-right">
          {teams.length > 0 && (
            <select
              className="sprint-select"
              value={teamKey}
              onChange={(e) => setTeamKey(e.target.value)}
              title="Pick a team"
            >
              {teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {/* The second picker swaps with the page: sprints normally, releases on the Epics tab. */}
          {onEpicsPage
            ? (releases?.length || 0) > 0 && (
                <select
                  className="sprint-select"
                  value={release}
                  onChange={(e) => setRelease(e.target.value)}
                  title="Pick a release"
                >
                  {releases.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                      {r.released ? ' · Released' : ''} ({r.epicCount} epic{r.epicCount !== 1 ? 's' : ''})
                    </option>
                  ))}
                </select>
              )
            : sprints.length > 0 && (
                <select
                  className="sprint-select"
                  value={sprintId}
                  onChange={(e) => setSprintId(e.target.value)}
                  title="Pick a sprint"
                >
                  <option value="">Active sprint</option>
                  {sprints.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {STATE_LABEL[s.state] || s.state}
                    </option>
                  ))}
                </select>
              )}
          {data && (
            <span className={`mode-badge ${data.mode}`}>{data.mode.toUpperCase()}</span>
          )}
          {data?.fetchedAt && (
            <span className="fetched-at">
              data as of{' '}
              {new Date(data.fetchedAt).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
          <button type="button" className="btn" onClick={refresh} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="error-banner">Failed to load sprint data: {error}</div>}

      <main className="content">
        <Routes>
          <Route
            path="/"
            element={<Overview key={`${teamKey}-${data?.sprint?.id || sprintId || 'active'}`} {...sprintState} />}
          />
          <Route
            path="/burnup"
            element={<Burnup key={`${teamKey}-${data?.sprint?.id || sprintId || 'active'}`} {...sprintState} />}
          />
          <Route
            path="/epics"
            element={<Epics key={teamKey} teamKey={teamKey} release={release} />}
          />
        </Routes>
      </main>
    </div>
  );
}
