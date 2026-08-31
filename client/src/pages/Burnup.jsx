import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea
} from 'recharts';

// Consecutive weekend day ranges, for Jira-style shaded bands.
function weekendRanges(points) {
  const ranges = [];
  let start = null;
  for (const p of points) {
    if (p.weekend) {
      if (!start) start = p.date;
    } else if (start) {
      ranges.push([start, points[points.indexOf(p) - 1].date]);
      start = null;
    }
  }
  if (start) ranges.push([start, points[points.length - 1].date]);
  return ranges;
}

const TEAM_ID = '__team__';

function fmtDay(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short'
  });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{fmtDay(label)}</div>
      {payload.map((p) =>
        p.value === null || p.value === undefined ? null : (
          <div key={p.dataKey} style={{ color: p.stroke || p.color }}>
            {p.name}: <strong>{Math.round(p.value * 10) / 10}</strong> SP
          </div>
        )
      )}
    </div>
  );
}

function BurnupChart({ points, height = 380, compact = false }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: compact ? -20 : 0 }}>
        <defs>
          <linearGradient id="burnedFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5e6ad2" stopOpacity={0.18} />
            <stop offset="100%" stopColor="#5e6ad2" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#23252a" vertical={false} />
        {weekendRanges(points).map(([x1, x2]) => (
          <ReferenceArea
            key={x1}
            x1={x1}
            x2={x2}
            fill="#ffffff"
            fillOpacity={0.035}
            stroke="none"
          />
        ))}
        <XAxis
          dataKey="date"
          tickFormatter={fmtDay}
          tick={{ fill: '#8a8f98', fontSize: compact ? 10 : 12 }}
          axisLine={{ stroke: '#23252a' }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: '#8a8f98', fontSize: compact ? 10 : 12 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={true}
          domain={[0, 'auto']}
        />
        <Tooltip content={<ChartTooltip />} />
        {!compact && <Legend wrapperStyle={{ color: '#8a8f98', fontSize: 12 }} />}
        <Line
          name="Scope"
          dataKey="scope"
          type="stepAfter"
          stroke="#8a8f98"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          name="Ideal"
          dataKey="ideal"
          stroke="#62666d"
          strokeDasharray="6 5"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          name="Burned"
          dataKey="burned"
          stroke="#828fff"
          strokeWidth={2}
          fill="url(#burnedFill)"
          dot={{ r: compact ? 0 : 3, fill: '#828fff', strokeWidth: 0 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export default function Burnup({ data, loading }) {
  const [selected, setSelected] = useState(TEAM_ID);

  // Board-level roster/totals (Jira burnup semantics), not the leaf-level
  // numbers used by the Sprint Overview.
  const devs = data?.burnup?.developers || [];
  const totals = data?.burnup?.totals;
  const selectedDev = useMemo(
    () =>
      selected === TEAM_ID
        ? {
            id: TEAM_ID,
            name: 'Whole team',
            totalSP: totals?.totalSP,
            doneSP: totals?.doneSP,
            remainingSP: totals?.remainingSP
          }
        : devs.find((d) => d.id === selected),
    [selected, devs, totals]
  );

  if (loading && !data) return <div className="loading">Loading sprint data…</div>;
  if (!data) return null;
  if (!data.burnup?.days?.length) {
    return <div className="loading">No active sprint dates found — cannot draw a burnup.</div>;
  }

  const points = data.burnup.series[selected] || [];

  return (
    <>
      <section className="chip-row">
        <button
          className={`chip${selected === TEAM_ID ? ' active' : ''}`}
          onClick={() => setSelected(TEAM_ID)}
        >
          Whole team
        </button>
        {devs.map((d) => (
          <button
            key={d.id}
            className={`chip${selected === d.id ? ' active' : ''}`}
            onClick={() => setSelected(d.id)}
          >
            {d.name}
            <span className="chip-sp">{d.remainingSP}</span>
          </button>
        ))}
      </section>

      <section className="panel chart-panel">
        <div className="panel-head">
          <h2>{selectedDev?.name}</h2>
          <div className="panel-head-meta">
            {selectedDev?.doneSP} of {selectedDev?.totalSP} SP burned ·{' '}
            {data.burnup.workingDays.length} working days
          </div>
        </div>
        <BurnupChart points={points} />
        <p className="chart-note">
          Mirrors Jira's board-level burnup: scope and completed lines use issue estimates
          (stories/tasks/bugs, not subtasks) with estimate updates, sprint additions, and removals
          applied on the day they happened.
        </p>
        {data.mode === 'snapshot' && (
          <p className="chart-note">
            Snapshot mode: burn dates come from issue resolution timestamps. Add a Jira API token in{' '}
            <code>.env</code> for changelog-accurate history.
          </p>
        )}
      </section>

      <section className="mini-grid">
        {devs.map((d) => (
          <button
            key={d.id}
            className={`panel mini-chart${selected === d.id ? ' selected' : ''}`}
            onClick={() => setSelected(d.id)}
          >
            <div className="mini-head">
              <span className="mini-name">{d.name}</span>
              <span className="mini-sp">
                {d.doneSP}/{d.totalSP} SP burned
              </span>
            </div>
            <BurnupChart points={data.burnup.series[d.id] || []} height={120} compact />
          </button>
        ))}
      </section>
    </>
  );
}
