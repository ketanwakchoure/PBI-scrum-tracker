import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useSprintData, useSprintList, IS_STATIC, REFRESH_REPO, getGeneratedAt } from './api.js';
import Overview from './pages/Overview.jsx';
import Burnup from './pages/Burnup.jsx';

function workingDaysLeft(burnup) {
  if (!burnup?.workingDays?.length) return null;
  return burnup.workingDays.filter((d) => d > burnup.todayKey).length;
}

const STATE_LABEL = { active: 'Active', closed: 'Closed', future: 'Future' };

export default function App() {
  const [sprintId, setSprintId] = useState('');
  const [teamKey, setTeamKey] = useState('iota');
  const [waitingForData, setWaitingForData] = useState(false);

  // On GitHub Pages, "Force refresh" opens a pre-filled [Refresh] issue; the
  // repo workflow re-exports Jira data, closes the issue, and redeploys. We
  // poll the published index until the new data lands, then reload.
  // (Pattern borrowed from celigo/UI-Team-Dashboard.)
  const forceRefresh = async () => {
    const baseline = await getGeneratedAt();
    const title = encodeURIComponent('[Refresh] dashboard data');
    const body = encodeURIComponent(
      'Requesting a sprint-data refresh. This issue is closed automatically when the refresh completes (~3 min).'
    );
    window.open(
      `https://github.com/${REFRESH_REPO}/issues/new?title=${title}&body=${body}`,
      '_blank',
      'noopener'
    );
    setWaitingForData(true);
    const started = Date.now();
    const timer = setInterval(async () => {
      const generatedAt = await getGeneratedAt();
      if (generatedAt && generatedAt !== baseline) {
        clearInterval(timer);
        window.location.reload();
      } else if (Date.now() - started > 15 * 60 * 1000) {
        clearInterval(timer);
        setWaitingForData(false);
      }
    }, 20000);
  };
  const { sprints, teams } = useSprintList();
  const sprintState = useSprintData(sprintId, teamKey);
  const { data, loading, error, refresh } = sprintState;
  const left = workingDaysLeft(data?.burnup);
  const teamName = data?.team?.name || teams.find((t) => t.key === teamKey)?.name || 'IOTA (PBI)';

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
            <div className="brand-title">Sprint Tracker</div>
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
          {sprints.length > 0 && (
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
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {IS_STATIC && REFRESH_REPO && (
            <button
              className="btn"
              onClick={forceRefresh}
              disabled={waitingForData}
              title="Opens a pre-filled GitHub issue that triggers a Jira data refresh; the page reloads when new data is published (~3 min)."
            >
              {waitingForData ? 'Waiting for fresh data…' : 'Force refresh'}
            </button>
          )}
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
        </Routes>
      </main>
    </div>
  );
}
