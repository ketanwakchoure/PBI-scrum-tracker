import { useMemo, useState } from 'react';

const STATUS_LABEL = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };

function sprintProgress(burnup) {
  if (!burnup?.workingDays?.length) return null;
  const totalDays = burnup.workingDays.length;
  const dayNum = Math.min(
    Math.max(burnup.workingDays.filter((d) => d <= burnup.todayKey).length, 1),
    totalDays
  );
  return { pct: (dayNum / totalDays) * 100, dayNum, totalDays };
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function Avatar({ dev }) {
  if (dev.avatar) return <img className="avatar" src={dev.avatar} alt={dev.name} referrerPolicy="no-referrer" />;
  const initials = dev.name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return <div className="avatar avatar-fallback">{initials}</div>;
}

function SegmentBar({ dev }) {
  const total = dev.totalSP || 1;
  return (
    <div className="segbar" title={`Done ${dev.doneSP} · In progress ${dev.inProgressSP} · To do ${dev.todoSP}`}>
      <div className="seg done" style={{ width: `${(dev.doneSP / total) * 100}%` }} />
      <div className="seg inprogress" style={{ width: `${(dev.inProgressSP / total) * 100}%` }} />
      <div className="seg todo" style={{ width: `${(dev.todoSP / total) * 100}%` }} />
    </div>
  );
}

function TrackerRow({ t }) {
  return (
    <tr className={t.statusCategory === 'done' ? 'row-done' : ''}>
      <td className="mono">
        <a href={t.url} target="_blank" rel="noreferrer" className="issue-link">
          {t.key}
        </a>
      </td>
      <td className="tracker-summary">
        <span className="tracker-type">{t.type}</span>
        {t.summary}
        {t.parentKey && (
          <span className="parent-ref" title={t.parentSummary || ''}>
            ↳ {t.parentKey}
          </span>
        )}
      </td>
      <td>
        <span className={`pill ${t.statusCategory}`}>{t.status}</span>
      </td>
      <td className="sp-cell mono">{t.sp || '—'}</td>
    </tr>
  );
}

export default function Overview({ data, loading }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const trackersByDev = useMemo(() => {
    const map = {};
    for (const t of data?.trackers || []) {
      (map[t.devId] = map[t.devId] || []).push(t);
    }
    for (const list of Object.values(map)) {
      const order = { indeterminate: 0, new: 1, done: 2 };
      list.sort((a, b) => order[a.statusCategory] - order[b.statusCategory] || b.sp - a.sp);
    }
    return map;
  }, [data]);

  if (loading && !data) return <div className="loading">Loading sprint data…</div>;
  if (!data) return null;

  const prog = sprintProgress(data.burnup);

  // On track when the remaining SP fits in the remaining working days at a
  // pace of 1 SP per day (today excluded, matching the "workdays left" count).
  const paceClass = (dev) => {
    if (!prog || !dev.totalSP) return '';
    const workdaysLeft = prog.totalDays - prog.dayNum;
    return dev.remainingSP <= workdaysLeft + 0.001 ? ' ok' : ' behind';
  };
  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <>
      {data.sprint && (
        <section className="sprint-banner">
          <div className="sprint-banner-main">
            <h1>{data.sprint.name}</h1>
            {data.sprint.goal && <p className="sprint-goal">{data.sprint.goal.split('\n')[0]}</p>}
          </div>
          <div className="sprint-banner-side">
            <div className="sprint-dates">
              {fmtDate(data.sprint.startDate)} → {fmtDate(data.sprint.endDate)}
            </div>
            {prog && (
              <>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${prog.pct}%` }} />
                </div>
                <div className="progress-label">
                  Working day {prog.dayNum} of {prog.totalDays}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{data.totals.totalSP}</div>
          <div className="stat-label">Committed SP (leaf level)</div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-value">{data.totals.doneSP}</div>
          <div className="stat-label">Burned</div>
        </div>
        <div className="stat-card accent-amber">
          <div className="stat-value">{data.totals.remainingSP}</div>
          <div className="stat-label">Remaining to burn</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {data.totals.doneCount}
            <span className="stat-denom">/{data.totals.trackerCount}</span>
          </div>
          <div className="stat-label">Trackers done</div>
        </div>
      </section>

      <section className="dev-list">
        {data.developers.map((dev) => {
          const isOpen = expanded.has(dev.id);
          return (
            <div key={dev.id} className={`dev-card${isOpen ? ' open' : ''}`}>
              <button className="dev-head" onClick={() => toggle(dev.id)}>
                <Avatar dev={dev} />
                <div className="dev-name-block">
                  <div className="dev-name">{dev.name}</div>
                  <div className="dev-meta">
                    {dev.trackerCount} tracker{dev.trackerCount !== 1 ? 's' : ''} · {dev.doneCount} done
                  </div>
                </div>
                <div className="dev-bar-block">
                  <SegmentBar dev={dev} />
                  <div className="dev-bar-legend">
                    <span className="lg done">{dev.doneSP} done</span>
                    <span className="lg inprogress">{dev.inProgressSP} in progress</span>
                    <span className="lg todo">{dev.todoSP} to do</span>
                  </div>
                </div>
                <div className="dev-remaining">
                  <div className={`dev-remaining-value${paceClass(dev)}`}>
                    {dev.remainingSP}
                    <span className="dev-remaining-denom">/{dev.totalSP}</span>
                  </div>
                  <div className="dev-remaining-label">SP to burn</div>
                </div>
                <div className={`chevron${isOpen ? ' up' : ''}`}>▾</div>
              </button>
              {isOpen && (
                <div className="tracker-table-wrap">
                  <table className="tracker-table">
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Tracker</th>
                        <th>Status</th>
                        <th>SP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(trackersByDev[dev.id] || []).map((t) => (
                        <TrackerRow key={t.id} t={t} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}
