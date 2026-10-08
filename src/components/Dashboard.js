import React, { useState } from 'react';
import { REGIONS, formatDate, advisorsForRegion } from '../data';
import { monthLabel } from './TimelineView';
import ShareToChannelButton from './ShareToChannelButton';

const C = {
  bg: '#f5f6f8',
  card: '#ffffff',
  border: '#e5e7eb',
  borderLight: '#eef1f4',
  textPrimary: '#0f1b2d',
  textSecondary: '#5b6472',
  textMuted: '#98a2b0',
  accent: '#0176D3',
  accentDark: '#032D60',
  success: '#0f8a5f',
  successBg: '#e7f7ef',
  warn: '#b45309',
  warnBg: '#fef3e2'
};

const cardStyle = { background: C.card, borderRadius: 14, border: `1px solid ${C.border}`, boxShadow: '0 1px 2px rgba(15,23,42,0.04)' };
const sectionTitle = { fontSize: 14, fontWeight: 700, color: C.textPrimary };
const sectionSub = { fontSize: 12, fontWeight: 400, color: C.textMuted, marginLeft: 8 };
const emptyText = { fontSize: 13, color: C.textMuted };

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function DonutChart({ segments, size = 176, onSegmentClick }) {
  const r = 62, stroke = 22, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  let cumulative = 0;
  const arcs = total === 0 ? null : segments.filter(s => s.value > 0).map((seg, i) => {
    const frac = seg.value / total;
    const dash = frac * circ;
    const offset = circ * (1 - cumulative);
    cumulative += frac;
    return (
      <circle key={i} r={r} cx={cx} cy={cy} fill="none" stroke={seg.color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={offset} strokeLinecap="butt"
        onClick={() => onSegmentClick && onSegmentClick(seg)}
        style={{ transform: 'rotate(-90deg)', transformOrigin: `${cx}px ${cy}px`, transition: 'stroke-dasharray 0.4s', cursor: onSegmentClick ? 'pointer' : 'default' }} />
    );
  });
  return (
    <svg width={size} height={size}>
      {total === 0
        ? <circle r={r} cx={cx} cy={cy} fill="none" stroke={C.borderLight} strokeWidth={stroke} />
        : arcs}
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="28" fontWeight="700" fill={C.textPrimary} fontFamily="Salesforce Sans, Inter, sans-serif">{total}</text>
      <text x={cx} y={cy + 15} textAnchor="middle" fontSize="10.5" fill={C.textMuted} fontFamily="Salesforce Sans, Inter, sans-serif">total inputs</text>
    </svg>
  );
}

function OUTile({ region, count, max, color, enabled, showEnabled, enabledCount, totalInitiatives, onClick }) {
  const c = color || C.accent;
  const intensity = max === 0 ? 0 : count / max;
  const hasData = count > 0;
  const bg = hasData ? hexToRgba(c, 0.06 + intensity * 0.18) : '#fafbfc';
  const border = hasData ? hexToRgba(c, 0.25 + intensity * 0.35) : C.borderLight;
  return (
    <div onClick={hasData ? onClick : undefined}
      style={{ background: bg, borderRadius: 10, padding: '13px 8px', textAlign: 'center', border: `1px solid ${border}`, cursor: hasData ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: hasData ? C.textPrimary : '#c7ccd3', lineHeight: 1 }}>{count}</div>
      <div style={{ fontSize: 10.5, color: hasData ? C.textSecondary : C.textMuted, marginTop: 5, fontWeight: 600, lineHeight: 1.3 }}>{region}</div>
      {showEnabled && enabled && (
        <div style={{ fontSize: 9.5, color: C.success, marginTop: 4, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>● enabled</div>
      )}
      {!showEnabled && enabledCount > 0 && (
        <div style={{ fontSize: 9.5, color: C.textMuted, marginTop: 4 }}>{enabledCount}/{totalInitiatives} enabled</div>
      )}
    </div>
  );
}

function InitiativeCard({ initiative, count, openLoops, enabledOUs, totalOUs, onClick }) {
  const pct = totalOUs === 0 ? 0 : enabledOUs / totalOUs;
  return (
    <div onClick={onClick} style={{ ...cardStyle, padding: 18, cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: initiative.color, flexShrink: 0 }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: C.textPrimary }}>{initiative.name}</div>
      </div>
      <div style={{ display: 'flex', gap: 0, marginBottom: 16 }}>
        <MiniStat value={count} label="inputs" color={C.textPrimary} />
        <div style={{ width: 1, background: C.borderLight, margin: '0 10px' }} />
        <MiniStat value={openLoops} label="open loops" color={openLoops > 0 ? C.warn : C.success} />
        <div style={{ width: 1, background: C.borderLight, margin: '0 10px' }} />
        <MiniStat value={enabledOUs} label="OUs enabled" color={C.textPrimary} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.textMuted, marginBottom: 5 }}>
        <span>OU Coverage</span>
        <span style={{ fontWeight: 700, color: initiative.color }}>{Math.round(pct * 100)}%</span>
      </div>
      <div style={{ background: C.borderLight, borderRadius: 6, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, background: initiative.color, height: '100%', borderRadius: 6, transition: 'width 0.5s' }} />
      </div>
      <div style={{ fontSize: 11.5, color: C.accent, marginTop: 12, fontWeight: 600 }}>View feedback →</div>
    </div>
  );
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Formats the same lines shown on screen into a Slack-postable digest — kept in one place so
// what gets posted to the channel always matches what's visible above it.
function historyLine(h, initiative) {
  const who = h.providerName ? ` — ${h.providerName}` : '';
  const body = h.type === 'loop'
    ? `loop marked ${h.closed ? 'Closed' : 'Open'}${h.summary ? `: ${h.summary}` : ''}`
    : `moved from ${monthLabel(h.from)} to ${monthLabel(h.to)}`;
  return `• ${initiative?.name || 'Feedback'}${who} — ${body}`;
}

function RecentTimelineChanges({ history, initiatives }) {
  if (!history || history.length === 0) return null;
  const recent = history.slice(0, 12);
  const digest = ['CoE Feedback — Recent Status Changes', ...recent.map(h => historyLine(h, initiatives.find(i => i.id === h.initiativeId)))].join('\n');

  return (
    <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={sectionTitle}>Recent Status Changes</div>
        <ShareToChannelButton message={digest} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {recent.map(h => {
          const initiative = initiatives.find(i => i.id === h.initiativeId);
          const isLoopChange = h.type === 'loop';
          const advisors = advisorsForRegion(h.region);
          return (
            <div key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 10, borderBottom: `1px solid ${C.borderLight}` }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: initiative?.color || C.accent, marginTop: 5, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: C.textPrimary }}>
                  {initiative && <span style={{ fontWeight: 700 }}>{initiative.name}</span>}{' '}
                  {isLoopChange ? (
                    <>
                      {h.providerName ? <>feedback from <span style={{ fontWeight: 600, color: C.textSecondary }}>{h.providerName}</span> </> : 'feedback '}
                      loop marked <span style={{ fontWeight: 700, color: h.closed ? C.success : C.warn }}>{h.closed ? 'Closed' : 'Open'}</span>
                    </>
                  ) : (
                    <>
                      moved from <span style={{ fontWeight: 600, color: C.textSecondary }}>{monthLabel(h.from)}</span>
                      {' → '}
                      <span style={{ fontWeight: 700, color: C.accent }}>{monthLabel(h.to)}</span>
                    </>
                  )}
                </div>
                {h.summary && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{h.summary}</div>}
                {advisors.length > 0 && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>CoE Advisor: {advisors.join(', ')}</div>
                )}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>{timeAgo(h.changedAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Every Story created via the Timeline's "+ Create Jira Story" button, across all initiatives —
// manualJiraLinks is keyed by groupKey, not by initiative, so this pulls entries by object.values
// rather than a per-initiative array the way most other feedback data is organized.
function CreatedJiraStories({ links, initiatives }) {
  const created = Object.values(links || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (created.length === 0) return null;
  return (
    <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
      <div style={{ ...sectionTitle, marginBottom: 14 }}>Jira Stories Created from Feedback</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {created.map(link => {
          const initiative = initiatives.find(i => i.id === link.initiativeId);
          return (
            <div key={`${link.groupKey}-${link.key}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 10, borderBottom: `1px solid ${C.borderLight}` }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: initiative?.color || C.accent, marginTop: 5, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: C.textPrimary }}>
                  {initiative && <span style={{ fontWeight: 700 }}>{initiative.name}</span>}{' '}
                  <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 700, color: C.accent, textDecoration: 'none' }}>
                    {link.key} ↗
                  </a>
                </div>
                {link.summary && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{link.summary}</div>}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}>{timeAgo(link.createdAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({ value, label, color }) {
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9.5, color: C.textMuted, marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

function StatCard({ label, value, icon, accent, suffix, onClick }) {
  return (
    <div onClick={onClick}
      style={{ ...cardStyle, padding: '18px 18px', borderLeft: `3px solid ${accent}`, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11.5, color: C.textSecondary, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ fontSize: 15 }}>{icon}</div>
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: C.textPrimary, lineHeight: 1, marginTop: 10 }}>
        {value}
        {suffix && <span style={{ fontSize: 14, fontWeight: 500, color: C.textMuted, marginLeft: 4 }}>{suffix}</span>}
      </div>
      {onClick && <div style={{ fontSize: 11, color: C.accent, marginTop: 8, fontWeight: 600 }}>View →</div>}
    </div>
  );
}

function DrillDown({ title, feedback, data, onClose }) {
  if (!feedback || feedback.length === 0) return null;
  return (
    <div style={{ ...cardStyle, padding: 20, marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <span style={sectionTitle}>{title}</span>
          <span style={sectionSub}>({feedback.length} {feedback.length === 1 ? 'entry' : 'entries'})</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: C.textMuted, cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {feedback.map(f => {
          const initiative = data.initiatives.find(i => i.id === f.initiativeId);
          const closed = data.closedLoop[f.id]?.closed;
          const notes = [f.frictionPoints, f.toolsMentioned, f.workarounds, f.dealImpact, f.quotes, f.notes].filter(Boolean).join('\n\n');
          const openActions = (f.actionItems || []).filter(a => !a.done).length;
          return (
            <div key={f.id} style={{ border: `1px solid ${C.borderLight}`, borderLeft: `3px solid ${closed ? C.success : C.warn}`, borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: C.textPrimary }}>{f.providerName}</span>
                  {f.providerRole && <span style={{ fontSize: 13, color: C.textSecondary }}> · {f.providerRole}</span>}
                  <span style={{ fontSize: 13, color: C.textSecondary }}> · {f.region} · {formatDate(f.date)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {initiative && <span style={{ fontSize: 11, background: hexToRgba(C.accent, 0.1), color: C.accent, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{initiative.name}</span>}
                  {openActions > 0 && <span style={{ fontSize: 11, background: C.warnBg, color: C.warn, padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>{openActions} action{openActions > 1 ? 's' : ''}</span>}
                  <span style={{ fontSize: 11, fontWeight: 600, color: closed ? C.success : C.warn }}>{closed ? '✓ Loop Closed' : '⚡ Open'}</span>
                </div>
              </div>
              {notes && <p style={{ fontSize: 13, color: C.textSecondary, marginTop: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{notes.slice(0, 300)}{notes.length > 300 ? '…' : ''}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard({ data, onDataChange }) {
  const [selectedInitiativeId, setSelectedInitiativeId] = useState('all');
  const [drillDown, setDrillDown] = useState(null); // { title, feedback }

  const initiatives = data.initiatives;
  const allFeedback = data.feedback;

  const totalFeedback = allFeedback.length;
  const openLoops = allFeedback.filter(f => !data.closedLoop[f.id]?.closed).length;
  const openActions = allFeedback.flatMap(f => f.actionItems || []).filter(a => !a.done).length;
  const enabledOUs = new Set(initiatives.flatMap(i => REGIONS.filter(r => i.ouEnablement?.[r]?.enabled))).size;

  function showDrill(title, feedback) {
    if (!feedback || feedback.length === 0) return;
    setDrillDown({ title, feedback });
    setTimeout(() => document.getElementById('dashboard-drilldown')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  const donutSegments = initiatives.map(i => ({
    label: i.name,
    value: allFeedback.filter(f => f.initiativeId === i.id).length,
    color: i.color,
    initiativeId: i.id
  }));

  const ouCounts = REGIONS.map(r => ({
    region: r,
    count: allFeedback.filter(f => f.region === r).length,
    enabledCount: initiatives.filter(i => i.ouEnablement?.[r]?.enabled).length
  }));
  const maxOU = Math.max(...ouCounts.map(x => x.count), 1);

  const selectedInitiative = initiatives.find(i => i.id === selectedInitiativeId);
  const initiativeColor = selectedInitiative?.color || C.accent;
  const filteredFeedback = selectedInitiativeId === 'all'
    ? allFeedback
    : allFeedback.filter(f => f.initiativeId === selectedInitiativeId);
  const initOUCounts = REGIONS.map(r => ({
    region: r,
    count: filteredFeedback.filter(f => f.region === r).length,
    enabled: selectedInitiativeId === 'all'
      ? initiatives.some(i => i.ouEnablement?.[r]?.enabled)
      : !!selectedInitiative?.ouEnablement?.[r]?.enabled
  })).sort((a, b) => b.count - a.count);
  const maxInitOU = Math.max(...initOUCounts.map(x => x.count), 1);

  const initStats = initiatives.map(i => ({
    initiative: i,
    count: allFeedback.filter(f => f.initiativeId === i.id).length,
    openLoops: allFeedback.filter(f => f.initiativeId === i.id && !data.closedLoop[f.id]?.closed).length,
    enabledOUs: REGIONS.filter(r => i.ouEnablement?.[r]?.enabled).length
  }));

  return (
    <div style={{ padding: 24, background: C.bg }}>

      {/* Stat row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Field Inputs" value={totalFeedback} icon="📋" accent={C.accent}
          onClick={totalFeedback > 0 ? () => showDrill('All Field Inputs', allFeedback) : undefined} />
        <StatCard label="Open Loops" value={openLoops} icon="⚡" accent={openLoops > 0 ? C.warn : C.success}
          onClick={openLoops > 0 ? () => showDrill('Open Loops', allFeedback.filter(f => !data.closedLoop[f.id]?.closed)) : undefined} />
        <StatCard label="Open Actions" value={openActions} icon="✅" accent={openActions > 0 ? C.warn : C.success}
          onClick={openActions > 0 ? () => showDrill('Feedback with Open Actions', allFeedback.filter(f => (f.actionItems || []).some(a => !a.done))) : undefined} />
        <StatCard label="OUs Active" value={enabledOUs} suffix={`/ ${REGIONS.length}`} icon="🌍" accent={C.accentDark} />
        <StatCard label="Initiatives" value={initiatives.length} icon="🏁" accent={C.accentDark} />
      </div>

      {/* Donut + OU heat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, marginBottom: 16 }}>
        <div style={{ ...cardStyle, padding: 20 }}>
          <div style={{ ...sectionTitle, marginBottom: 16 }}>Feedback by Initiative</div>
          {totalFeedback === 0
            ? <p style={emptyText}>No feedback logged yet.</p>
            : <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <DonutChart segments={donutSegments} size={176}
                  onSegmentClick={seg => showDrill(`${seg.label} — All Feedback`, allFeedback.filter(f => f.initiativeId === seg.initiativeId))} />
                <div style={{ flex: 1 }}>
                  {donutSegments.map((seg, i) => (
                    <div key={i} onClick={() => showDrill(`${seg.label} — All Feedback`, allFeedback.filter(f => f.initiativeId === seg.initiativeId))}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, cursor: seg.value > 0 ? 'pointer' : 'default' }}>
                      <div style={{ width: 9, height: 9, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: C.textSecondary, flex: 1 }}>{seg.label}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>{seg.value}</span>
                    </div>
                  ))}
                </div>
              </div>
          }
        </div>

        <div style={{ ...cardStyle, padding: 20 }}>
          <div style={{ marginBottom: 16 }}>
            <span style={sectionTitle}>Feedback Volume by OU</span>
            <span style={sectionSub}>all initiatives</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8 }}>
            {ouCounts.map(({ region, count, enabledCount }) => (
              <OUTile key={region} region={region} count={count} max={maxOU}
                enabledCount={enabledCount} totalInitiatives={initiatives.length}
                onClick={() => showDrill(`${region} — All Feedback`, allFeedback.filter(f => f.region === region))} />
            ))}
          </div>
        </div>
      </div>

      <RecentTimelineChanges history={data.timelineHistory} initiatives={initiatives} />
      <CreatedJiraStories links={data.manualJiraLinks} initiatives={initiatives} />

      {/* Initiative summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12, marginBottom: 16 }}>
        {initStats.map(({ initiative, count, openLoops, enabledOUs }) => (
          <InitiativeCard key={initiative.id} initiative={initiative} count={count}
            openLoops={openLoops} enabledOUs={enabledOUs} totalOUs={REGIONS.length}
            onClick={() => showDrill(`${initiative.name} — All Feedback`, allFeedback.filter(f => f.initiativeId === initiative.id))} />
        ))}
      </div>

      {/* Per-initiative OU breakdown */}
      <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div style={sectionTitle}>OU Breakdown by Initiative</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', background: C.bg, padding: 4, borderRadius: 10 }}>
            <button onClick={() => setSelectedInitiativeId('all')}
              style={{ ...filterBtn, ...(selectedInitiativeId === 'all' ? filterBtnActive : {}) }}>All</button>
            {initiatives.map(i => (
              <button key={i.id} onClick={() => setSelectedInitiativeId(i.id)}
                style={{ ...filterBtn, ...(selectedInitiativeId === i.id ? { background: '#fff', color: i.color, boxShadow: '0 1px 2px rgba(15,23,42,0.08)' } : {}) }}>
                {i.name}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(95px, 1fr))', gap: 8 }}>
          {initOUCounts.map(({ region, count, enabled }) => {
            const fb = selectedInitiativeId === 'all'
              ? allFeedback.filter(f => f.region === region)
              : allFeedback.filter(f => f.region === region && f.initiativeId === selectedInitiativeId);
            const label = selectedInitiativeId === 'all'
              ? `${region} — All Feedback`
              : `${region} — ${selectedInitiative?.name}`;
            return (
              <OUTile key={region} region={region} count={count} max={maxInitOU}
                color={initiativeColor} enabled={enabled} showEnabled
                onClick={() => showDrill(label, fb)} />
            );
          })}
        </div>
      </div>

      {/* Enablement matrix */}
      <div style={{ ...cardStyle, padding: 20, overflowX: 'auto' }}>
        <div style={{ ...sectionTitle, marginBottom: 16 }}>OU Enablement Matrix</div>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={th}>OU</th>
              {initiatives.map(i => (
                <th key={i.id} style={{ ...th, color: i.color }}>{i.name}</th>
              ))}
              <th style={th}>Feedback</th>
            </tr>
          </thead>
          <tbody>
            {REGIONS.map((r, idx) => {
              const fbCount = allFeedback.filter(f => f.region === r).length;
              const rowBg = idx % 2 ? C.bg : C.card;
              return (
                <tr key={r}>
                  <td style={{ ...td, background: rowBg, fontWeight: 600, color: C.textPrimary }}>{r}</td>
                  {initiatives.map(i => {
                    const isEnabled = !!i.ouEnablement?.[r]?.enabled;
                    const date = i.ouEnablement?.[r]?.date;
                    const fb = allFeedback.filter(f => f.region === r && f.initiativeId === i.id);
                    return (
                      <td key={i.id} style={{ ...td, background: rowBg, textAlign: 'center' }}>
                        <span onClick={fb.length > 0 ? () => showDrill(`${r} — ${i.name}`, fb) : undefined}
                          title={date || (isEnabled ? 'Enabled' : undefined)}
                          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', cursor: fb.length > 0 ? 'pointer' : 'default',
                            background: isEnabled ? i.color : 'transparent',
                            color: isEnabled ? '#fff' : C.textMuted,
                            fontSize: 12.5, fontWeight: 700,
                            border: !isEnabled ? `1.5px solid ${C.borderLight}` : 'none' }}>
                          {isEnabled ? '✓' : (fb.length > 0 ? fb.length : '')}
                        </span>
                      </td>
                    );
                  })}
                  <td style={{ ...td, background: rowBg, textAlign: 'center' }}>
                    {fbCount > 0
                      ? <span onClick={() => showDrill(`${r} — All Feedback`, allFeedback.filter(f => f.region === r))}
                          style={{ background: hexToRgba(C.accent, 0.1), color: C.accent, padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{fbCount}</span>
                      : <span style={{ color: '#d1d5db', fontSize: 13 }}>—</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Drill-down panel */}
      <div id="dashboard-drilldown">
        {drillDown && (
          <DrillDown title={drillDown.title} feedback={drillDown.feedback} data={data} onClose={() => setDrillDown(null)} />
        )}
      </div>
    </div>
  );
}

const filterBtn = { border: 'none', borderRadius: 8, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: C.textSecondary, whiteSpace: 'nowrap' };
const filterBtnActive = { background: '#fff', color: C.accent };
const th = { padding: '10px 14px', borderBottom: `2px solid ${C.borderLight}`, fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textMuted, textAlign: 'center' };
const td = { padding: '10px 14px', borderBottom: `1px solid ${C.borderLight}`, fontSize: 13 };
