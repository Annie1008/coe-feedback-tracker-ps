import React, { useState } from 'react';
import { REGIONS, formatDate } from '../data';

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function DonutChart({ segments, size = 180, onSegmentClick }) {
  const r = 65, stroke = 28, cx = size / 2, cy = size / 2;
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
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={offset}
        onClick={() => onSegmentClick && onSegmentClick(seg)}
        style={{ transform: 'rotate(-90deg)', transformOrigin: `${cx}px ${cy}px`, transition: 'all 0.4s', cursor: onSegmentClick ? 'pointer' : 'default' }} />
    );
  });
  return (
    <svg width={size} height={size}>
      {total === 0
        ? <circle r={r} cx={cx} cy={cy} fill="none" stroke="#f3f4f6" strokeWidth={stroke} />
        : arcs}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="30" fontWeight="800" fill="#032D60" fontFamily="Salesforce Sans, Inter, sans-serif">{total}</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="11" fill="#9ca3af" fontFamily="Salesforce Sans, Inter, sans-serif">total inputs</text>
    </svg>
  );
}

function OUTile({ region, count, max, color, enabled, showEnabled, enabledCount, totalInitiatives, onClick }) {
  const c = color || '#0176D3';
  const intensity = max === 0 ? 0 : count / max;
  const hasData = count > 0;
  const bg = hasData ? hexToRgba(c, 0.1 + intensity * 0.72) : '#f9fafb';
  const border = hasData ? hexToRgba(c, 0.2 + intensity * 0.4) : '#e5e7eb';
  const numColor = intensity > 0.55 ? '#fff' : hasData ? '#032D60' : '#d1d5db';
  const lblColor = intensity > 0.55 ? 'rgba(255,255,255,0.85)' : hasData ? '#374151' : '#9ca3af';
  const subColor = intensity > 0.55 ? 'rgba(255,255,255,0.65)' : '#6b7280';
  return (
    <div onClick={hasData ? onClick : undefined}
      style={{ background: bg, borderRadius: 10, padding: '14px 8px', textAlign: 'center', border: `1px solid ${border}`, transition: 'all 0.2s', cursor: hasData ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: numColor, lineHeight: 1 }}>{count}</div>
      <div style={{ fontSize: 11, color: lblColor, marginTop: 5, fontWeight: 600, lineHeight: 1.3 }}>{region}</div>
      {showEnabled && enabled && (
        <div style={{ fontSize: 10, color: intensity > 0.55 ? 'rgba(255,255,255,0.7)' : '#059669', marginTop: 4, fontWeight: 600 }}>enabled</div>
      )}
      {!showEnabled && enabledCount > 0 && (
        <div style={{ fontSize: 10, color: subColor, marginTop: 4 }}>{enabledCount}/{totalInitiatives} enabled</div>
      )}
    </div>
  );
}

function InitiativeCard({ initiative, count, openLoops, enabledOUs, totalOUs, onClick }) {
  const pct = totalOUs === 0 ? 0 : enabledOUs / totalOUs;
  return (
    <div onClick={onClick} style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.07)', borderTop: `4px solid ${initiative.color}`, cursor: 'pointer' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: initiative.color, marginBottom: 14 }}>{initiative.name}</div>
      <div style={{ display: 'flex', gap: 0, marginBottom: 16 }}>
        <MiniStat value={count} label="inputs" color="#032D60" />
        <div style={{ width: 1, background: '#e5e7eb', margin: '0 10px' }} />
        <MiniStat value={openLoops} label="open loops" color={openLoops > 0 ? '#d97706' : '#059669'} />
        <div style={{ width: 1, background: '#e5e7eb', margin: '0 10px' }} />
        <MiniStat value={enabledOUs} label="OUs enabled" color="#032D60" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af', marginBottom: 5 }}>
        <span>OU Coverage</span>
        <span style={{ fontWeight: 700, color: initiative.color }}>{Math.round(pct * 100)}%</span>
      </div>
      <div style={{ background: '#f3f4f6', borderRadius: 6, height: 7, overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, background: initiative.color, height: '100%', borderRadius: 6, transition: 'width 0.5s' }} />
      </div>
      <div style={{ fontSize: 11, color: '#0176D3', marginTop: 10, fontWeight: 600 }}>Click to view feedback →</div>
    </div>
  );
}

function MiniStat({ value, label, color }) {
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

function StatCard({ label, value, gradient, suffix, onClick }) {
  return (
    <div onClick={onClick} style={{ background: gradient, borderRadius: 12, padding: '20px 18px', color: '#fff', boxShadow: '0 4px 14px rgba(0,0,0,0.14)', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>
        {value}
        {suffix && <span style={{ fontSize: 16, fontWeight: 400, opacity: 0.65, marginLeft: 4 }}>{suffix}</span>}
      </div>
      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 7, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      {onClick && <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>Click to view →</div>}
    </div>
  );
}

function DrillDown({ title, feedback, data, onClose }) {
  if (!feedback || feedback.length === 0) return null;
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.10)', marginTop: 20, border: '1px solid #bae6fd' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#032D60' }}>{title}</span>
          <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 8 }}>({feedback.length} {feedback.length === 1 ? 'entry' : 'entries'})</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {feedback.map(f => {
          const initiative = data.initiatives.find(i => i.id === f.initiativeId);
          const closed = data.closedLoop[f.id]?.closed;
          const notes = [f.frictionPoints, f.toolsMentioned, f.workarounds, f.dealImpact, f.quotes, f.notes].filter(Boolean).join('\n\n');
          const openActions = (f.actionItems || []).filter(a => !a.done).length;
          return (
            <div key={f.id} style={{ border: `1px solid #e5e7eb`, borderLeft: `4px solid ${closed ? '#059669' : '#d97706'}`, borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#1f2937' }}>{f.providerName}</span>
                  {f.providerRole && <span style={{ fontSize: 13, color: '#6b7280' }}> · {f.providerRole}</span>}
                  <span style={{ fontSize: 13, color: '#6b7280' }}> · {f.region} · {formatDate(f.date)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {initiative && <span style={{ fontSize: 11, background: '#e0f0ff', color: '#0176D3', padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{initiative.name}</span>}
                  {openActions > 0 && <span style={{ fontSize: 11, background: '#fef3c7', color: '#d97706', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>{openActions} action{openActions > 1 ? 's' : ''}</span>}
                  <span style={{ fontSize: 11, fontWeight: 600, color: closed ? '#059669' : '#d97706' }}>{closed ? '✓ Loop Closed' : '⚡ Open'}</span>
                </div>
              </div>
              {notes && <p style={{ fontSize: 13, color: '#374151', marginTop: 8, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{notes.slice(0, 300)}{notes.length > 300 ? '…' : ''}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard({ data }) {
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
  const initiativeColor = selectedInitiative?.color || '#0176D3';
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
    <div style={{ padding: 24 }}>

      {/* Stat row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Field Inputs" value={totalFeedback} gradient="linear-gradient(135deg, #032D60 0%, #0176D3 100%)"
          onClick={totalFeedback > 0 ? () => showDrill('All Field Inputs', allFeedback) : undefined} />
        <StatCard label="Open Loops" value={openLoops} gradient={openLoops > 0 ? 'linear-gradient(135deg, #92400e, #d97706)' : 'linear-gradient(135deg, #065f46, #059669)'}
          onClick={openLoops > 0 ? () => showDrill('Open Loops', allFeedback.filter(f => !data.closedLoop[f.id]?.closed)) : undefined} />
        <StatCard label="Open Actions" value={openActions} gradient={openActions > 0 ? 'linear-gradient(135deg, #92400e, #d97706)' : 'linear-gradient(135deg, #065f46, #059669)'}
          onClick={openActions > 0 ? () => showDrill('Feedback with Open Actions', allFeedback.filter(f => (f.actionItems || []).some(a => !a.done))) : undefined} />
        <StatCard label="OUs Active" value={enabledOUs} suffix={`/ ${REGIONS.length}`} gradient="linear-gradient(135deg, #0c2d5c, #0D7DBF)" />
        <StatCard label="Initiatives" value={initiatives.length} gradient="linear-gradient(135deg, #032D60, #1B96FF)" />
      </div>

      {/* Donut + OU heat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, marginBottom: 20 }}>
        <div style={card}>
          <div style={sectionTitle}>Feedback by Initiative</div>
          {totalFeedback === 0
            ? <p style={emptyText}>No feedback logged yet.</p>
            : <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <DonutChart segments={donutSegments} size={180}
                  onSegmentClick={seg => showDrill(`${seg.label} — All Feedback`, allFeedback.filter(f => f.initiativeId === seg.initiativeId))} />
                <div style={{ flex: 1 }}>
                  {donutSegments.map((seg, i) => (
                    <div key={i} onClick={() => showDrill(`${seg.label} — All Feedback`, allFeedback.filter(f => f.initiativeId === seg.initiativeId))}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, cursor: seg.value > 0 ? 'pointer' : 'default' }}>
                      <div style={{ width: 11, height: 11, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: '#374151', flex: 1 }}>{seg.label}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: seg.color }}>{seg.value}</span>
                    </div>
                  ))}
                </div>
              </div>
          }
        </div>

        <div style={card}>
          <div style={sectionTitle}>Feedback Volume by OU <span style={{ fontSize: 12, fontWeight: 400, color: '#9ca3af' }}>— all initiatives</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8 }}>
            {ouCounts.map(({ region, count, enabledCount }) => (
              <OUTile key={region} region={region} count={count} max={maxOU}
                enabledCount={enabledCount} totalInitiatives={initiatives.length}
                onClick={() => showDrill(`${region} — All Feedback`, allFeedback.filter(f => f.region === region))} />
            ))}
          </div>
        </div>
      </div>

      {/* Initiative summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12, marginBottom: 20 }}>
        {initStats.map(({ initiative, count, openLoops, enabledOUs }) => (
          <InitiativeCard key={initiative.id} initiative={initiative} count={count}
            openLoops={openLoops} enabledOUs={enabledOUs} totalOUs={REGIONS.length}
            onClick={() => showDrill(`${initiative.name} — All Feedback`, allFeedback.filter(f => f.initiativeId === initiative.id))} />
        ))}
      </div>

      {/* Per-initiative OU breakdown */}
      <div style={{ ...card, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div style={sectionTitle}>OU Breakdown by Initiative</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => setSelectedInitiativeId('all')}
              style={{ ...filterBtn, ...(selectedInitiativeId === 'all' ? filterBtnActive : {}) }}>All</button>
            {initiatives.map(i => (
              <button key={i.id} onClick={() => setSelectedInitiativeId(i.id)}
                style={{ ...filterBtn, ...(selectedInitiativeId === i.id ? { background: i.color, color: '#fff', borderColor: i.color } : {}) }}>
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
      <div style={{ ...card, overflowX: 'auto' }}>
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
              const rowBg = idx % 2 ? '#f8fafc' : '#fff';
              return (
                <tr key={r}>
                  <td style={{ ...td, background: rowBg, fontWeight: 600, color: '#374151' }}>{r}</td>
                  {initiatives.map(i => {
                    const isEnabled = !!i.ouEnablement?.[r]?.enabled;
                    const date = i.ouEnablement?.[r]?.date;
                    const fb = allFeedback.filter(f => f.region === r && f.initiativeId === i.id);
                    return (
                      <td key={i.id} style={{ ...td, background: rowBg, textAlign: 'center' }}>
                        <span onClick={fb.length > 0 ? () => showDrill(`${r} — ${i.name}`, fb) : undefined}
                          title={date || (isEnabled ? 'Enabled' : undefined)}
                          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', cursor: fb.length > 0 ? 'pointer' : 'default',
                            background: isEnabled ? i.color : '#f3f4f6',
                            color: isEnabled ? '#fff' : '#d1d5db',
                            fontSize: 13, fontWeight: 700,
                            boxShadow: isEnabled ? `0 2px 6px ${hexToRgba(i.color, 0.4)}` : 'none',
                            border: !isEnabled ? '2px solid #e5e7eb' : 'none' }}>
                          {isEnabled ? '✓' : (fb.length > 0 ? fb.length : '')}
                        </span>
                      </td>
                    );
                  })}
                  <td style={{ ...td, background: rowBg, textAlign: 'center' }}>
                    {fbCount > 0
                      ? <span onClick={() => showDrill(`${r} — All Feedback`, allFeedback.filter(f => f.region === r))}
                          style={{ background: hexToRgba('#0176D3', 0.12), color: '#0176D3', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{fbCount}</span>
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

const card = { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.07)' };
const sectionTitle = { fontSize: 14, fontWeight: 700, color: '#032D60', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.04em' };
const emptyText = { fontSize: 13, color: '#9ca3af' };
const filterBtn = { border: '1px solid #d1d5db', borderRadius: 20, padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#374151', whiteSpace: 'nowrap' };
const filterBtnActive = { background: '#0176D3', color: '#fff', borderColor: '#0176D3' };
const th = { padding: '10px 14px', borderBottom: '2px solid #e5e7eb', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9ca3af', textAlign: 'center' };
const td = { padding: '10px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 13 };
