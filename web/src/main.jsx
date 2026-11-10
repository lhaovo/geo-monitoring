import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import './styles.css';

const PLATFORM_META = {
  deepseek: { label: 'DeepSeek', tone: 'blue', defaultMode: 'headless' },
  doubao: { label: '豆包', tone: 'orange', defaultMode: 'headed' },
  kimi: { label: 'Kimi', tone: 'cyan', defaultMode: 'headless' },
  qwen: { label: '千问', tone: 'purple', defaultMode: 'headless' },
  wenxiaoyan: { label: '文小言', tone: 'teal', defaultMode: 'headless' },
  yuanbao: { label: '腾讯元宝', tone: 'green', defaultMode: 'headless' },
};

const SHARE_STATUS_LABELS = { captured: '已获取', unavailable: '平台未提供', failed: '采集失败' };

// 左侧平台列表里的「全部平台」虚拟选项。
const ALL_PLATFORMS = 'all';

const SHARE_STATUS_HINTS = {
  captured: '已获取平台公开分享链接，可直接对外分享。',
  unavailable: '该平台未提供分享入口，或账号状态导致入口被隐藏。',
  failed: '找到了分享入口，但复制分享链接失败。',
};

const STATUS_LABELS = {
  queued: '排队中', running: '执行中', cancelling: '取消中', completed: '已完成', partial_failed: '部分失败', failed: '失败', cancelled: '已取消',
  parked: '已挂起', skipped: '已跳过',
};

// 熔断原因的文案：任务详情里要把「为什么停下来」讲清楚。
function describeCooldownKind(kind) {
  if (kind === 'busy') return '平台当前繁忙';
  if (kind === 'no_account') return '没有可用登录账号';
  return '连续遇到验证码';
}

function platformLabel(id) { return PLATFORM_META[id]?.label || id || '未知平台'; }
function statusLabel(status) { return STATUS_LABELS[status] || status || '未知'; }
function displayRunStatus(run) { return run?.cancelRequestedAt && ['queued', 'running'].includes(run.status) ? 'cancelling' : run?.status; }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function formatRate(value) { return value === null || value === undefined ? '—' : `${value}%`; }
function formatCount(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function progressPercent(run) { return run?.totalChecks ? Math.round((run.completedChecks / run.totalChecks) * 100) : 0; }

function readRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '') || 'overview';
  const runMatch = raw.match(/^runs\/([^/]+)$/);
  return runMatch ? { view: 'runs', runId: runMatch[1] } : { view: raw, runId: null };
}

function navigate(view, runId = null) {
  window.location.hash = runId ? `#/runs/${runId}` : `#/${view}`;
}

function StatusPill({ status }) {
  return <span className={`status-pill ${status || 'unknown'}`}>{statusLabel(status)}</span>;
}

function PlatformBadge({ id }) {
  const meta = PLATFORM_META[id] || { label: id, tone: 'slate' };
  return <span className={`platform-badge ${meta.tone}`}><i />{meta.label}</span>;
}

// 只有色块没有文字的平台标记，用于名称已经单独显示的地方。
function PlatformDot({ id }) {
  const meta = PLATFORM_META[id] || { tone: 'slate' };
  return <span className={`platform-dot ${meta.tone}`} />;
}

function MetricCard({ label, value, hint, tone = 'blue' }) {
  return <article className={`metric-card ${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div>{hint && <div className="metric-hint">{hint}</div>}</article>;
}

function EmptyState({ title, description, action }) {
  return <div className="empty-state"><div className="empty-mark">＋</div><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function BrandPicker({ brands, brand, onSelect, onCreate }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState({ top: 0, left: 0, width: 0 });
  const fieldRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      setRect({ top: box.bottom + 6, left: box.left, width: box.width });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    const onPointerDown = (event) => {
      const inField = fieldRef.current?.contains(event.target);
      const inMenu = menuRef.current?.contains(event.target);
      if (!inField && !inMenu) setOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <>
    <div className="brand-picker">
      <div className="brand-picker-field" ref={fieldRef}>
        <button type="button" ref={triggerRef} className={`brand-picker-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((value) => !value)} disabled={!brands.length} aria-haspopup="listbox" aria-expanded={open}>
          <span className="brand-avatar">{brand?.name ? brand.name.slice(0, 1) : '·'}</span>
          <span className="brand-picker-name">{brand?.name || '选择品牌'}</span>
          <span className="brand-chevron">▾</span>
        </button>
      </div>
      <button type="button" className="brand-picker-add" aria-label="新建品牌" onClick={onCreate}>＋</button>
    </div>
    {open ? createPortal(
      <div className="brand-picker-menu" ref={menuRef} role="listbox" style={{ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px` }}>
        {brands.map((item) => (
          <button key={item.id} type="button" role="option" aria-selected={item.id === brand?.id} className={`brand-picker-option ${item.id === brand?.id ? 'active' : ''}`} onClick={() => { onSelect(item.id); setOpen(false); }}>
            <span className="brand-avatar">{item.name.slice(0, 1)}</span>
            <span className="brand-option-name">{item.name}</span>
            {item.id === brand?.id ? <span className="brand-option-check">✓</span> : null}
          </button>
        ))}
        {!brands.length ? <p className="brand-picker-empty">还没有品牌，先新建一个</p> : null}
      </div>,
      document.body,
    ) : null}
  </>;
}

function AppShell({ brands, brand, view, onNavigate, onSelectBrand, onNewBrand, onNewRun, children }) {
  const nav = [
    ['overview', '品牌总览', '⌂'], ['questions', '监控问题', '◇'], ['runs', '监控任务', '▦'], ['sources', '来源中心', '↗'], ['trends', '历史趋势', '⌁'], ['reports', '报告中心', '▤'],
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-mark"><span className="brand-logo">G</span><div><strong>GEO Monitoring</strong><small>品牌可见度监测</small></div></div>

      <div className="side-section-label">当前品牌</div>
      <BrandPicker brands={brands} brand={brand} onSelect={onSelectBrand} onCreate={onNewBrand} />

      <div className="side-section-label side-nav-label">功能导航</div>
      <nav className="side-nav">{nav.map(([key, label, icon]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => onNavigate(key)} disabled={!brand}><span className="nav-icon">{icon}</span>{label}</button>)}</nav>

      <div className="side-section-label side-nav-label">系统</div>
      <nav className="side-nav secondary"><button className={view === 'platforms' ? 'active' : ''} onClick={() => onNavigate('platforms')}><span className="nav-icon">◎</span>平台与登录</button></nav>

      <button className="side-cta" onClick={onNewRun} disabled={!brand}><span className="side-cta-icon">＋</span>发起一次监控</button>

      <div className="sidebar-foot"><span className="online-dot" /><div className="sidebar-foot-text"><strong>采集服务在线</strong><small>浏览器自动化采集运行中</small></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><div className="top-eyebrow">BRAND VISIBILITY / 浏览器自动化采集</div><h1>{brand?.name || '品牌中心'}</h1></div><div className="top-actions"><span className="top-status"><span className="online-dot" />服务正常</span><button className="button primary" onClick={onNewRun} disabled={!brand}>立即监控</button></div></header>
      <main className="content">{children}</main>
    </div>
  </div>;
}

function PageHeader({ eyebrow, title, description, actions }) {
  return <div className="page-header"><div><div className="page-eyebrow">{eyebrow}</div><h2>{title}</h2>{description && <p>{description}</p>}</div><div className="page-actions">{actions}</div></div>;
}

function OverviewPage({ overview, onNewRun, onOpenRun, onNavigate }) {
  if (!overview) return <EmptyState title="还没有品牌数据" description="创建品牌并添加监控问题后，这里会显示品牌在 AI 平台中的出现情况。" />;
  const { summary, platforms = [], questions = [], recentRuns = [], trend = [] } = overview;
  const topQuestions = [...questions].sort((a, b) => (b.mentionRate ?? -1) - (a.mentionRate ?? -1)).slice(0, 6);
  const maxTrend = Math.max(...trend.map((item) => item.mentionRate || 0), 1);
  return <>
    <PageHeader eyebrow="BRAND OVERVIEW" title="品牌总览" description="查看品牌在国内 AI 平台回答中的出现、推荐和来源表现。" actions={<><select className="select compact" defaultValue="30"><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select><button className="button primary" onClick={onNewRun}>＋ 发起监控</button></>} />
    <section className="metric-grid"><MetricCard label="品牌出现率" value={formatRate(summary.mentionRate)} hint={`${formatCount(summary.mentioned)} / ${formatCount(summary.completed)} 个有效回答`} tone="blue" /><MetricCard label="有效样本" value={formatCount(summary.completed)} hint={`共 ${formatCount(summary.totalChecks)} 次检查`} tone="violet" /><MetricCard label="来源引用率" value={formatRate(summary.citationRate)} hint={`${formatCount(summary.cited)} 个回答有来源`} tone="green" /><MetricCard label="引用次数" value={formatCount(summary.citations)} hint={`${formatCount(summary.failures)} 次失败`} tone="orange" /></section>
    {summary.completed ? <section className="card support-card"><div className="card-heading"><div><h3>提及来源支撑</h3><p>回答提到品牌时，引用来源本身是否也在谈这个品牌</p></div><button className="text-button" onClick={() => onNavigate('sources')}>查看来源中心 →</button></div><div className="support-grid"><div className="support-item backed"><strong>{formatCount(summary.mentionBacked)}</strong><span>有来源支撑</span><small>引用标题中同样命中品牌</small></div><div className="support-item unsupported"><strong>{formatCount(summary.mentionUnsupported)}</strong><span>无来源支撑</span><small>模型自有认知，来源未提及</small></div><div className="support-item source"><strong>{formatCount(summary.sourceMentioned)}</strong><span>来源提及回答</span><small>占比 {formatRate(summary.sourceMentionRate)}</small></div></div></section> : null}
    <div className="dashboard-grid">
      <section className="card platform-performance"><div className="card-heading"><div><h3>平台表现</h3><p>品牌出现率和来源采集质量</p></div><button className="text-button" onClick={() => onNavigate('platforms')}>查看平台状态 →</button></div><div className="platform-table"><div className="table-row table-head"><span>平台</span><span>出现率</span><span>有效样本</span><span>来源率</span><span>失败</span></div>{platforms.length ? platforms.map((item) => <div className="table-row" key={item.platform}><span><PlatformBadge id={item.platform} /></span><strong>{formatRate(item.mentionRate)}</strong><span>{item.completed}/{item.checks}</span><span>{formatRate(item.citationRate)}</span><span className={item.failures ? 'danger-text' : 'muted'}>{item.failures || '—'}</span></div>) : <EmptyState title="暂无平台数据" description="执行一次监控后查看平台表现。" />}</div></section>
      <section className="card trend-card"><div className="card-heading"><div><h3>出现率趋势</h3><p>按日统计有效回答</p></div><button className="text-button" onClick={() => onNavigate('trends')}>查看趋势 →</button></div>{trend.length ? <div className="mini-chart">{trend.map((item) => <div className="chart-column" key={item.date}><div className="chart-bar" style={{ height: `${Math.max(8, ((item.mentionRate || 0) / maxTrend) * 100)}%` }} title={`${item.date} ${formatRate(item.mentionRate)}`} /><small>{item.date.slice(5)}</small></div>)}</div> : <EmptyState title="暂无趋势" description="完成一次有效监控后生成趋势。" />}</section>
    </div>
    <div className="dashboard-grid lower">
      <section className="card"><div className="card-heading"><div><h3>问题表现</h3><p>优先关注品牌未出现的问题</p></div><button className="text-button" onClick={() => onNavigate('questions')}>管理问题 →</button></div>{topQuestions.length ? <div className="question-performance">{topQuestions.map((item) => <button key={item.id} onClick={() => onNavigate('questions')}><span className="question-text">{item.text}</span><span className={`rate-dot ${item.mentionRate >= 70 ? 'good' : item.mentionRate >= 40 ? 'warn' : 'bad'}`} /> <strong>{formatRate(item.mentionRate)}</strong><small>{item.completed} 个样本</small></button>)}</div> : <EmptyState title="还没有监控问题" description="在问题库添加用户真实问题。" />}</section>
      <section className="card"><div className="card-heading"><div><h3>最近监控</h3><p>点击查看问题 × 平台结果</p></div><button className="text-button" onClick={() => onNavigate('runs')}>全部任务 →</button></div>{recentRuns.length ? <div className="recent-list">{recentRuns.slice(0, 5).map((run) => <button key={run.id} onClick={() => onOpenRun(run.id)}><div><StatusPill status={run.status} /><span>{formatTime(run.createdAt)}</span></div><strong>{run.completedChecks}/{run.totalChecks} 检查完成</strong><small>{run.targetPlatforms.map(platformLabel).join(' · ')}</small></button>)}</div> : <EmptyState title="暂无任务" description="发起一次监控开始积累数据。" />}</section>
    </div>
  </>;
}

function QuestionsPage({ questions, onReload, onNewRun }) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [importing, setImporting] = useState(false);
  const filtered = questions.filter((item) => !search || item.text.includes(search));
  const importQuestions = async (event) => {
    event.preventDefault();
    const texts = draft.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!texts.length) return;
    setImporting(true);
    try { await onReload({ texts }); setDraft(''); } finally { setImporting(false); }
  };
  const toggle = async (item) => { await api.updateQuestion(item.id, { enabled: !item.enabled }); onReload(); };
  return <>
    <PageHeader eyebrow="MONITOR QUESTIONS" title="监控问题" description="问题是品牌监测的样本资产，建议优先使用真实用户问法。" actions={<button className="button primary" onClick={onNewRun}>用问题发起监控</button>} />
    <section className="card import-card"><div className="card-heading"><div><h3>批量添加问题</h3><p>一行一个问题，导入前会自动去重。</p></div><span className="import-count">当前 {questions.length} 条</span></div><form onSubmit={importQuestions} className="import-form"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：第一次买伟哥，哪个牌子更稳一点？\n备孕时老是硬不起来，吃什么药更稳？" /><div className="form-inline"><button className="button primary" disabled={importing || !draft.trim()}>{importing ? '导入中…' : '添加问题'}</button></div></form></section>
    <section className="card"><div className="filter-bar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索问题" /><span className="filter-count">显示 {filtered.length} / {questions.length}</span></div><div className="question-list">{filtered.map((item, index) => <div className="question-row" key={item.id}><span className="question-index">{String(index + 1).padStart(2, '0')}</span><div className="question-main"><strong>{item.text}</strong>{item.mentionRate === null || item.mentionRate === undefined ? null : <div><small>近 30 天出现率 {formatRate(item.mentionRate)}</small></div>}</div><span className={`toggle ${item.enabled ? 'on' : ''}`} role="switch" aria-checked={item.enabled} tabIndex="0" onClick={() => toggle(item)} onKeyDown={(event) => event.key === 'Enter' && toggle(item)}>{item.enabled ? '启用' : '停用'}</span></div>)}{!filtered.length && <EmptyState title="没有匹配的问题" description="可以调整筛选条件，或添加一批新的监控问题。" />}</div></section>
  </>;
}

function RunsPage({ runs, activeRun, onOpenRun, onCloseRun, onCancel, onNewRun, onSelectCell, onResumePlatform, onAbortPlatform, onClearManualWindow }) {
  return <>
    <PageHeader eyebrow="MONITORING RUNS" title="监控任务" description="点击任意任务行即可就地展开或收起详情，查看问题 × 平台结果矩阵。" actions={<button className="button primary" onClick={onNewRun}>＋ 新建任务</button>} />
    <section className="card runs-list">
      {runs.length ? runs.map((run) => {
        const expanded = activeRun?.id === run.id;
        return <div className={`run-list-item ${expanded ? 'expanded' : ''}`} key={run.id}>
          <button className={`run-list-row ${expanded ? 'selected' : ''}`} aria-expanded={expanded} onClick={() => (expanded ? onCloseRun() : onOpenRun(run.id))}>
            <div className="run-date"><StatusPill status={displayRunStatus(run)} /><strong>{formatTime(run.createdAt)}</strong></div>
            <div className="run-progress"><div className="progress-line"><span style={{ width: `${progressPercent(run)}%` }} /></div><small>{run.completedChecks} / {run.totalChecks} 检查完成</small></div>
            <div className="run-platforms">{run.targetPlatforms.map((id) => <PlatformBadge key={id} id={id} />)}</div>
            <div className="run-stats"><span>{run.mentionedChecks} 次提及</span><span>{run.citationCount} 条引用</span></div>
            <div className="run-row-tail">{['queued', 'running'].includes(run.status) && <span className="run-cancel" onClick={(event) => { event.stopPropagation(); onCancel(run.id); }}>{run.cancelRequestedAt ? '取消中…' : '取消'}</span>}<span className="run-chevron" aria-hidden="true" /></div>
          </button>
          {expanded && <RunDetail run={activeRun} onSelectCell={onSelectCell} onCancel={onCancel} onClose={onCloseRun} onResumePlatform={onResumePlatform} onAbortPlatform={onAbortPlatform} onClearManualWindow={onClearManualWindow} />}
        </div>;
      }) : <EmptyState title="还没有监控任务" description="选择问题和平台，发起第一轮品牌监控。" action={<button className="button primary" onClick={onNewRun}>发起监控</button>} />}
    </section>
  </>;
}

function RunDetail({ run, onSelectCell, onCancel, onClose, onResumePlatform, onAbortPlatform, onClearManualWindow }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of run.platformRuns || []) { if (!map.has(item.promptId)) map.set(item.promptId, { id: item.promptId, prompt: item.prompt, cells: {} }); map.get(item.promptId).cells[item.platformId] = item; }
    return [...map.values()];
  }, [run]);
  // 熔断的平台在这里手动决定续跑还是中止：
  // 平台不可用时任务不会自动恢复，剩余检查也不会被直接判成失败，只是挂起等着。
  // 只列出这一轮里真正还受影响的平台：中止之后不再有挂起检查，就不用再提示。
  const paused = (run.platformStates || []).filter((item) => item.parked > 0
    || item.manualWindow
    || (item.cooldown && (item.queued > 0 || item.running > 0)));
  return <div className="run-detail">
    <div className="detail-header">
      <div><div className="page-eyebrow">TASK DETAIL</div><h3>{formatTime(run.createdAt)} 的监控任务</h3><p>{run.completedChecks}/{run.totalChecks} 检查完成 · {run.mentionedChecks} 个回答提到品牌 · {run.citationCount} 条引用</p></div>
      <div className="detail-actions"><StatusPill status={displayRunStatus(run)} />{['queued', 'running'].includes(run.status) && <button className="button danger-outline" onClick={() => onCancel(run.id)}>{run.cancelRequestedAt ? '取消中…' : '取消任务'}</button>}<button className="button ghost" onClick={onClose}>收起</button></div>
    </div>
    <div className="detail-progress"><div className="progress-line large"><span style={{ width: `${progressPercent(run)}%` }} /></div><span>{progressPercent(run)}%</span></div>
    {paused.length ? <div className="run-paused-list">
      {paused.map((item) => <div key={item.platformId} className="run-paused-item">
        <div className="run-paused-text">
          <strong>{platformLabel(item.platformId)}{item.cooldown ? ` ${describeCooldownKind(item.cooldown.kind)}` : item.parked ? ' 剩余检查已挂起' : ' 需要人工验证'}</strong>
          <span>{item.cooldown?.reason || item.manualWindow?.reason || '剩余检查已挂起，等待人工处理。'}{item.parked ? `　·　${item.parked} 项检查挂起` : ''}{item.cooldown?.until ? `　·　熔断至 ${formatTime(item.cooldown.until)}` : ''}</span>
        </div>
        <div className="run-paused-actions">
          {item.manualWindow ? <button className="button secondary" onClick={() => onClearManualWindow?.(item.platformId)}>恢复无头</button> : null}
          {item.parked || item.cooldown ? <button className="button secondary" onClick={() => onResumePlatform?.(run.id, item.platformId)}>续跑</button> : null}
          {item.parked || item.cooldown ? <button className="button danger-outline" onClick={() => onAbortPlatform?.(run.id, item.platformId)}>中止</button> : null}
        </div>
      </div>)}
    </div> : null}
    <div className="matrix-wrap"><table className="matrix"><thead><tr><th>监控问题</th>{run.targetPlatforms.map((id) => <th key={id}><PlatformBadge id={id} /></th>)}</tr></thead><tbody>{grouped.map((row, index) => <tr key={row.id}><td><div className="matrix-question"><span className="matrix-index">{String(index + 1).padStart(2, '0')}</span><strong>{row.prompt?.text || '未知问题'}</strong></div></td>{run.targetPlatforms.map((id) => <td key={id}><button className={`matrix-cell ${row.cells[id]?.status || 'queued'}`} onClick={() => row.cells[id] && onSelectCell(row.cells[id])}>{row.cells[id] ? <><StatusPill status={row.cells[id].status} />{row.cells[id].answer ? <span className={row.cells[id].answer.brandMentioned ? 'mention yes' : 'mention'}>{row.cells[id].answer.brandMentioned ? '已提及' : '未提及'}</span> : null}<small title={row.cells[id].answer ? undefined : row.cells[id].errorMessage || '等待执行'}>{row.cells[id].answer ? `${row.cells[id].answer.citations.length} 条来源` : row.cells[id].errorMessage || '等待执行'}</small></> : <span>—</span>}</button></td>)}</tr>)}</tbody></table></div>
  </div>;
}

const SOURCE_DAY_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
  { value: 180, label: '近 180 天' },
  { value: 365, label: '近 365 天' },
];

const SOURCE_SORT_OPTIONS = [
  { value: 'citations', label: '按引用次数' },
  { value: 'questions', label: '按覆盖问题数' },
  { value: 'lastSeen', label: '按最近出现' },
  { value: 'domain', label: '按域名' },
];

// 排行条：域名、问题、平台共用一套条形展示。
function RankCard({ title, description, items, emptyText, activeKey, onSelect, valueLabel = '次引用' }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  const select = (item) => { if (onSelect) onSelect(item); };
  return <section className="card rank-card">
    <div className="card-heading"><div><h3>{title}</h3><p>{description}</p></div></div>
    {items.length ? <ol className="rank-list">
      {items.map((item, index) => <li key={item.key}>
        <div className={`rank-item ${activeKey === item.key ? 'active' : ''} ${onSelect ? 'clickable' : ''}`}
          role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined}
          onClick={() => select(item)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(item); } }}>
          <span className="rank-index">{index + 1}</span>
          <span className="rank-main">
            <span className="rank-head">
              {item.link ? <a className="rank-title" href={item.link} target="_blank" rel="noreferrer"
                onClick={(event) => event.stopPropagation()}>{item.title} ↗</a>
                : <strong title={item.title}>{item.title}</strong>}
              <em>{formatCount(item.value)} {valueLabel}</em>
            </span>
            <span className="rank-bar"><i style={{ width: `${Math.max(3, (item.value / max) * 100)}%` }} /></span>
            <small>{item.meta}</small>
          </span>
        </div>
      </li>)}
    </ol> : <p className="rank-empty">{emptyText}</p>}
  </section>;
}

// 来源中心：既看整体看板，也支持按平台、域名、问题、关键词逐层下钻。
function AllSourcesPanel({ brand, days }) {
  const [sources, setSources] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ platformId: '', domain: '', promptId: '', mention: '', owned: '', search: '', sort: 'citations' });
  const [keywordInput, setKeywordInput] = useState('');
  const [expandedUrl, setExpandedUrl] = useState('');
  const [visibleCount, setVisibleCount] = useState(40);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.getBrandSources(brand.id, { ...filters, days });
        if (!cancelled) { setSources(data); setError(''); }
      } catch (cause) {
        if (!cancelled) setError(cause.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, filters.search ? 320 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [brand?.id, days, filters]);

  // 搜索框输入做防抖，避免每敲一个字就打一次后端。
  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => (
      current.search === keywordInput.trim() ? current : { ...current, search: keywordInput.trim() }
    )), 320);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const update = (patch) => setFilters((current) => ({ ...current, ...patch }));
  const resetFilters = () => {
    setFilters({ platformId: '', domain: '', promptId: '', mention: '', owned: '', search: '', sort: 'citations' });
    setKeywordInput('');
    setExpandedUrl('');
  };
  const activeFilterCount = ['platformId', 'domain', 'promptId', 'mention', 'owned'].filter((key) => filters[key]).length
    + (filters.search ? 1 : 0);

  const summary = sources?.summary ?? {};
  const domainItems = (sources?.domains ?? []).slice(0, 12).map((item) => ({
    key: item.domain,
    value: item.urlCount,
    title: item.domain,
    link: `https://${item.domain}`,
    meta: `${formatCount(item.citationCount)} 次引用${item.citationOccurrences ? ` · ${formatCount(item.citationOccurrences)} 次出现` : ''} · 占 ${item.urlShare}% 的来源 · ${item.platforms.map(platformLabel).join('、') || '—'}${item.owned ? ' · 自有域名' : ''}`,
  }));
  const questionItems = (sources?.questions ?? []).slice(0, 12).map((item) => ({
    key: item.promptId,
    value: item.citationCount,
    title: item.text,
    meta: `${item.urlCount} 个来源 · ${item.domainCount} 个域名 · ${item.mentionedUrls} 个来源提及品牌 · ${item.platforms.map(platformLabel).join('、') || '—'}`,
  }));
  const platformItems = sources?.platformStats ?? [];
  const platformMax = Math.max(1, ...platformItems.map((item) => item.citationCount));
  const sourceRows = sources?.sources ?? [];
  const visibleSources = sourceRows.slice(0, visibleCount);
  const sortLabel = SOURCE_SORT_OPTIONS.find((item) => item.value === filters.sort)?.label ?? '按引用次数';
  const latestStamp = summary.latestSeenAt ? formatTime(summary.latestSeenAt).split(' ') : [];
  const latestDate = latestStamp[0] ?? '';
  const latestTime = latestStamp[1] ?? '—';

  if (!sources && loading) return <EmptyState title="正在加载来源" description="读取品牌在回答中的原始引用网页。" />;

  return <>
    {error ? <div className="notice">{error}</div> : null}

    <section className="metric-grid source-metrics">
      <MetricCard label="唯一 URL" value={formatCount(summary.uniqueUrls)} hint={`${formatCount(summary.domains)} 个域名`} tone="blue" />
      <MetricCard label="引用记录" value={formatCount(summary.citationCount)} hint={`${formatCount(summary.citationOccurrences)} 次出现`} tone="violet" />
      <MetricCard label="覆盖问题" value={formatCount(summary.questionCount)} hint={`来自 ${formatCount(summary.platformCount)} 个平台 · 平均 ${formatCount(summary.avgCitationsPerQuestion)} 条/问题`} tone="green" />
      <MetricCard label="提及品牌来源" value={formatCount(summary.sourceMentionedUrls)} hint={`占 ${formatRate(summary.sourceMentionedRate)} 的来源`} tone="orange" />
      <MetricCard label="外部域名" value={formatCount(summary.externalDomains)} hint={summary.topDomain ? `Top ${summary.topDomain} 占 ${summary.topDomainShare}%` : '暂无域名数据'} tone="blue" />
      <MetricCard label="自有域名引用" value={formatCount(summary.ownedDomainCitations)} hint={summary.ownedDomainCited ? '品牌自有站点被引用' : '暂未引用自有站点'} tone="green" />
      <MetricCard label="平均每 URL" value={formatCount(summary.avgCitationsPerUrl)} hint={`${formatCount(summary.activeDays)} 天有新增来源`} tone="violet" />
      <MetricCard label="最近出现" value={latestTime} hint={latestDate ? `${latestDate} · 时间范围 ${summary.periodDays ?? days} 天` : `时间范围 ${summary.periodDays ?? days} 天`} tone="orange" />
    </section>

    <section className="card source-filter-card">
      <div className="filter-bar source-filters">
        <span className="filter-title">筛选<small>{activeFilterCount ? `${activeFilterCount} 个条件生效` : '全部来源'}</small></span>
        <input placeholder="搜索标题、网址或问题关键词" value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} />
        <select className="select" value={filters.platformId} onChange={(event) => update({ platformId: event.target.value })}>
          <option value="">全部平台</option>
          {Object.keys(PLATFORM_META).map((id) => <option key={id} value={id}>{platformLabel(id)}</option>)}
        </select>
        <select className="select" value={filters.domain} onChange={(event) => update({ domain: event.target.value })}>
          <option value="">全部域名</option>
          {(sources?.options?.domains ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select className="select" value={filters.promptId} onChange={(event) => update({ promptId: event.target.value })}>
          <option value="">全部问题</option>
          {(sources?.options?.questions ?? []).map((item) => <option key={item.promptId} value={item.promptId}>{item.text}</option>)}
        </select>
        <select className="select" value={filters.sort} onChange={(event) => update({ sort: event.target.value })}>
          {SOURCE_SORT_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <button type="button" className={`toggle ${filters.mention === 'mentioned' ? 'on' : ''}`} onClick={() => update({ mention: filters.mention === 'mentioned' ? '' : 'mentioned' })}>只看提及品牌</button>
        <button type="button" className={`toggle ${filters.owned === 'owned' ? 'on' : ''}`} onClick={() => update({ owned: filters.owned === 'owned' ? '' : 'owned' })}>只看自有域名</button>
        {activeFilterCount ? <button type="button" className="text-button" onClick={resetFilters}>重置筛选</button> : null}
      </div>
    </section>

    <section className="source-rank-grid">
      <RankCard title="域名来源排行" description="按该域名贡献的来源数量排序，点域名可打开站点，点其它位置只看该域名" items={domainItems} emptyText="当前筛选下没有域名数据。" activeKey={filters.domain} valueLabel="个来源"
        onSelect={(item) => update({ domain: filters.domain === item.key ? '' : item.key })} />
      <RankCard title="问题引用排行" description="哪些问题最常带出外部来源，点击只看该问题" items={questionItems} emptyText="当前筛选下没有问题数据。" activeKey={filters.promptId} valueLabel="次引用"
        onSelect={(item) => update({ promptId: filters.promptId === item.key ? '' : item.key })} />
    </section>

    <section className="card">
      <div className="card-heading"><div><h3>平台分布</h3><p>哪个平台最常把外部来源带进回答，点击可筛选</p></div></div>
      {platformItems.length ? <div className="source-platform-grid">
        {platformItems.map((item) => <button key={item.platformId} type="button" className={`source-platform ${filters.platformId === item.platformId ? 'active' : ''}`}
          onClick={() => update({ platformId: filters.platformId === item.platformId ? '' : item.platformId })}>
          <PlatformBadge id={item.platformId} />
          <strong>{formatCount(item.citationCount)}</strong>
          <small>次引用 · {formatCount(item.urlCount)} 个来源 · {formatCount(item.questionCount)} 个问题</small>
          <span className="rank-bar"><i style={{ width: `${Math.max(3, (item.citationCount / platformMax) * 100)}%` }} /></span>
        </button>)}
      </div> : <p className="rank-empty">当前筛选下没有平台数据。</p>}
    </section>

    <section className="card">
      <div className="card-heading">
        <div><h3>URL 明细</h3><p>共 {formatCount(sourceRows.length)} 个来源，{sortLabel}；同一 URL 跨平台不丢失出现记录</p></div>
        <span className="filter-count">显示前 {Math.min(visibleCount, sourceRows.length)} 条</span>
      </div>
      <div className="source-list">
        {visibleSources.map((item) => {
          const expanded = expandedUrl === item.url;
          return <div className="source-item" key={item.url}>
            <article className={`source-row ${expanded ? 'expanded' : ''}`}>
              <div className="source-title">
                <strong>{item.title || item.domain || item.url}</strong>
                <div className="source-links">
                  <a href={item.url} target="_blank" rel="noreferrer">打开原网页 ↗</a>
                  <a href={`https://${item.domain}`} target="_blank" rel="noreferrer">{item.domain} ↗</a>
                </div>
                <small>{item.url}</small>
              </div>
              <div className="source-tags">
                {item.platforms.map((id) => <PlatformBadge key={id} id={id} />)}
                {item.owned ? <span className="source-owned">自有域名</span> : null}
                {item.brandMentioned ? <span className="source-mention">提及品牌{item.matchedTerms?.length ? ` · ${item.matchedTerms.join('、')}` : ''}</span> : null}
              </div>
              <div className="source-number"><strong>{formatCount(item.citationOccurrences || item.citationCount)}</strong><small>次引用</small></div>
              <div className="source-number"><strong>{formatCount(item.promptIds.length)}</strong><small>个问题</small></div>
              <time>{formatTime(item.lastSeenAt)}</time>
              <button type="button" className="source-expand" onClick={() => setExpandedUrl(expanded ? '' : item.url)}>
                {expanded ? '收起' : '明细'} <span>{formatCount(item.detailTotal ?? item.details.length)}</span>
              </button>
            </article>
            {expanded ? <div className="source-detail">
              <div className="source-detail-head">
                <strong>出现明细</strong>
                <span>被 {item.prompts.length} 个问题、{item.platforms.length} 个平台引用{(item.detailTotal ?? 0) > item.details.length ? `，仅显示最近 ${item.details.length} 条` : ''}</span>
              </div>
              <div className="source-detail-list">
                {item.details.map((detail, index) => <div className="source-detail-row" key={`${detail.answerId}-${index}`}>
                  <PlatformBadge id={detail.platformId} />
                  <button type="button" className="source-detail-question" title={detail.promptText} onClick={() => update({ promptId: detail.promptId })}>{detail.promptText}</button>
                  {detail.brandMentioned ? <span className="source-mention">提及品牌{detail.matchedTerms?.length ? ` · ${detail.matchedTerms.join('、')}` : ''}</span> : null}
                  <span className="source-detail-count">{formatCount(detail.occurrences)} 次出现</span>
                  <time>{formatTime(detail.createdAt)}</time>
                </div>)}
              </div>
            </div> : null}
          </div>;
        })}
        {!sourceRows.length && <EmptyState title="还没有来源记录" description="完成带搜索的回答后，原网页会出现在这里。" />}
      </div>
      {visibleCount < sourceRows.length ? <div className="source-more">
        <button type="button" className="button secondary" onClick={() => setVisibleCount((count) => count + 60)}>再加载 60 条（剩余 {formatCount(sourceRows.length - visibleCount)} 条）</button>
      </div> : null}
    </section>
  </>;
}

// 添加自有链接：支持一次粘贴多行，导入后立刻回算历史引用。
function OwnedLinkModal({ brand, onClose, onDone }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.importBrandLinks(brand.id, { urls: text, title, label });
      await api.recomputeBrandLinkCitations(brand.id);
      onDone(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}>
    <div className="modal-head"><div><div className="page-eyebrow">OWNED CONTENT</div><h3>添加自有链接</h3></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
    <p className="modal-intro">把自己发布过的文章链接贴进来（每行一个）。系统会在采集到的引用里匹配这些链接，统计它们被哪些 AI 回答引用过。</p>
    {error ? <div className="notice">{error}</div> : null}
    <label>文章链接<textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder={'https://example.com/blog/post-1\nhttps://example.com/blog/post-2'} /></label>
    <div className="form-grid">
      <label>统一标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可留空" /></label>
      <label>备注<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：新品发布" /></label>
    </div>
    <p className="rw-note">匹配时会自动忽略 utm/spm 等追踪参数，因此「同一篇文章带不同来源参数」也能统计到。</p>
    <div className="modal-foot"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !text.trim()}>{busy ? '导入中…' : '导入并回算'}</button></div>
  </form></div>;
}

// 自有链接监测：自己发的文章有没有被 AI 引用、被哪些问题和平台引用。
function OwnedLinksPanel({ brand, days, onCount }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [platformId, setPlatformId] = useState('');
  const [search, setSearch] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [onlyUncited, setOnlyUncited] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.getBrandOwnedLinks(brand.id, { days, platformId, search });
        if (!cancelled) { setData(result); setError(''); }
      } catch (cause) {
        if (!cancelled) setError(cause.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, search ? 320 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [brand?.id, days, platformId, search]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch((current) => (current === keywordInput.trim() ? current : keywordInput.trim())), 320);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const summary = data?.summary ?? {};
  const allLinks = data?.links ?? [];
  const links = onlyUncited ? allLinks.filter((item) => !item.cited) : allLinks;
  const latestStamp = summary.latestSeenAt ? formatTime(summary.latestSeenAt).split(' ') : [];
  const latestTime = latestStamp[1] ?? '—';
  const latestDate = latestStamp[0] ?? '';

  const removeLink = async (link) => {
    if (!window.confirm(`确认不再监测这条链接吗？\n${link.url}`)) return;
    setBusy(true);
    try {
      await api.deleteBrandLink(link.id);
      const result = await api.getBrandOwnedLinks(brand.id, { days, platformId, search });
      setData(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const recompute = async () => {
    setBusy(true);
    try {
      const result = await api.recomputeBrandLinkCitations(brand.id);
      const next = await api.getBrandOwnedLinks(brand.id, { days, platformId, search });
      setData(next);
      setNotice(`已回算 ${formatCount(result.citations)} 条引用，命中自有链接 ${formatCount(result.matched)} 条。`);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  // 把自有链接总数回传给外层，标签上显示角标。
  useEffect(() => { onCount?.(summary.totalLinks ?? 0); }, [summary.totalLinks, onCount]);

  if (!data && loading) return <EmptyState title="正在加载自有链接" description="读取自己发布的内容被引用的情况。" />;

  return <>
    {error ? <div className="notice">{error}</div> : null}
    {notice ? <div className="notice success">{notice}<button onClick={() => setNotice('')}>×</button></div> : null}

    <section className="card owned-toolbar">
      <div className="card-heading">
        <div><h3>自有内容监测</h3><p>把发布过的文章链接加进来，追踪它们有没有被 AI 回答引用、引用在哪个问题里</p></div>
        <div className="card-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={recompute}>回算历史引用</button>
          <button type="button" className="button primary" onClick={() => setShowModal(true)}>添加链接</button>
        </div>
      </div>
      {!summary.totalLinks ? <div className="owned-empty">
        <strong>还没有监测自有链接</strong>
        <p>点「添加链接」把发布过的文章贴进来，之后每次采集都会自动统计这些链接有没有被引用。</p>
      </div> : null}
    </section>

    {summary.totalLinks ? <>
      <section className="metric-grid source-metrics">
        <MetricCard label="监测链接" value={formatCount(summary.links)} hint={`未被引用 ${formatCount(summary.unreferencedLinks)} 条`} tone="blue" />
        <MetricCard label="被引用链接" value={formatCount(summary.citedLinks)} hint={`覆盖率 ${formatRate(summary.coverageRate)}`} tone="green" />
        <MetricCard label="引用次数" value={formatCount(summary.citationCount)} hint={`${formatCount(summary.citationOccurrences)} 次出现`} tone="violet" />
        <MetricCard label="涉及平台" value={formatCount(summary.platformCount)} hint="哪些平台引用了自有内容" tone="orange" />
        <MetricCard label="涉及问题" value={formatCount(summary.questionCount)} hint="在哪些问题里被引用" tone="violet" />
        <MetricCard label="最近引用" value={latestTime} hint={latestDate ? `${latestDate} · 时间范围 ${summary.periodDays} 天` : `时间范围 ${summary.periodDays} 天`} tone="green" />
      </section>

      <section className="card source-filter-card">
        <div className="filter-bar source-filters">
          <span className="filter-title">筛选<small>{onlyUncited ? '只看未被引用' : '全部自有链接'}</small></span>
          <input placeholder="搜索标题、备注或链接" value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} />
          <select className="select" value={platformId} onChange={(event) => setPlatformId(event.target.value)}>
            <option value="">全部平台</option>
            {Object.keys(PLATFORM_META).map((id) => <option key={id} value={id}>{platformLabel(id)}</option>)}
          </select>
          <button type="button" className={`toggle ${onlyUncited ? 'on' : ''}`} onClick={() => setOnlyUncited((value) => !value)}>只看未被引用</button>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div><h3>链接明细</h3><p>共 {formatCount(links.length)} 条自有链接，点「明细」查看每次被引用的平台与问题</p></div>
          <span className="filter-count">按引用次数排序</span>
        </div>
        <div className="source-list">
          {links.map((item) => {
            const expanded = expandedId === item.id;
            return <div className="source-item" key={item.id}>
              <article className={`source-row owned-link-row ${expanded ? 'expanded' : ''}`}>
                <div className="source-title">
                  <strong>{item.title || item.url}</strong>
                  <div className="source-links">
                    <a href={item.url} target="_blank" rel="noreferrer">打开原文 ↗</a>
                    <a href={`https://${item.domain}`} target="_blank" rel="noreferrer">{item.domain} ↗</a>
                  </div>
                  <small>{item.url}</small>
                </div>
                <div className="source-tags">
                  {item.platforms.length ? item.platforms.map((id) => <PlatformBadge key={id} id={id} />) : <span className="source-untouched">未被引用</span>}
                  {item.label ? <span className="source-owned">{item.label}</span> : null}
                </div>
                <div className="source-number"><strong>{formatCount(item.citationCount)}</strong><small>次引用</small></div>
                <div className="source-number"><strong>{formatCount(item.promptIds.length)}</strong><small>个问题</small></div>
                <time>{item.lastSeenAt ? formatTime(item.lastSeenAt) : '—'}</time>
                <div className="owned-row-actions">
                  <button type="button" className="source-expand" onClick={() => setExpandedId(expanded ? '' : item.id)}>
                    {expanded ? '收起' : '明细'} <span>{formatCount(item.details.length)}</span>
                  </button>
                  <button type="button" className="source-remove" disabled={busy} onClick={() => removeLink(item)} title="不再监测这条链接">删除</button>
                </div>
              </article>
              {expanded ? <div className="source-detail">
                <div className="source-detail-head">
                  <strong>被引用明细</strong>
                  <span>被 {item.prompts.length} 个问题、{item.platforms.length} 个平台引用</span>
                </div>
                <div className="source-detail-list">
                  {item.details.length ? item.details.map((detail, index) => <div className="source-detail-row" key={`${detail.answerId}-${index}`}>
                    <PlatformBadge id={detail.platformId} />
                    <span className="source-detail-question" title={detail.promptText}>{detail.promptText}</span>
                    {detail.brandMentioned ? <span className="source-mention">提及品牌</span> : null}
                    <span className="source-detail-count">{formatCount(detail.occurrences)} 次出现</span>
                    <time>{formatTime(detail.createdAt)}</time>
                  </div>) : <p className="rank-empty">这条链接还没有被引用过。</p>}
                </div>
              </div> : null}
            </div>;
          })}
          {!links.length && <EmptyState title={onlyUncited ? '所有链接都被引用过了' : '还没有匹配的链接'} description={onlyUncited ? '当前筛选下没有被引用的自有链接。' : '调整筛选条件或添加更多链接。'} />}
        </div>
      </section>
    </> : null}

    {showModal ? <OwnedLinkModal brand={brand} onClose={() => setShowModal(false)} onDone={async (result) => {
      setShowModal(false);
      const next = await api.getBrandOwnedLinks(brand.id, { days, platformId, search });
      setData(next);
      setNotice(`已导入 ${formatCount(result.imported)} 条链接${result.duplicates ? `，跳过重复 ${formatCount(result.duplicates)} 条` : ''}${result.invalid?.length ? `，${formatCount(result.invalid.length)} 条格式无效` : ''}。`);
    }} /> : null}
  </>;
}

function SourcesPage({ brand }) {
  const [tab, setTab] = useState('all');
  const [days, setDays] = useState(30);
  const [ownedCount, setOwnedCount] = useState(0);
  return <>
    <PageHeader eyebrow="SOURCE EVIDENCE" title="来源中心" description="查看品牌相关回答引用了哪些原网页，并保留跨平台出现记录。" actions={<>
      <select className="select compact" value={days} onChange={(event) => setDays(Number(event.target.value))}>
        {SOURCE_DAY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <button className="button secondary" onClick={() => window.print()}>导出 / 打印</button>
    </>} />
    <div className="source-tabs">
      <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部来源</button>
      <button type="button" className={tab === 'owned' ? 'active' : ''} onClick={() => setTab('owned')}>自有链接{ownedCount ? ` ${ownedCount}` : ''}</button>
    </div>
    {tab === 'all'
      ? <AllSourcesPanel brand={brand} days={days} onDaysChange={setDays} />
      : <OwnedLinksPanel brand={brand} days={days} onCount={setOwnedCount} />}
  </>;
}

function TrendsPage({ overview }) {
  if (!overview) return <EmptyState title="暂无趋势数据" description="完成监控后，这里会按时间和平台展示品牌出现率变化。" />;
  const { trend = [], platforms = [] } = overview;
  return <><PageHeader eyebrow="HISTORICAL TRENDS" title="历史趋势" description="观察品牌出现率、来源率和平台稳定性的长期变化。" actions={<select className="select compact" defaultValue="30"><option value="30">近 30 天</option><option value="90">近 90 天</option></select>} /><section className="card trend-page-card"><div className="card-heading"><div><h3>每日品牌出现率</h3><p>分母只包含成功获取回答的有效样本</p></div></div>{trend.length ? <div className="trend-table"><div className="trend-row trend-head"><span>日期</span><span>出现率</span><span>有效样本</span><span>来源率</span><span>失败</span></div>{trend.map((item) => <div className="trend-row" key={item.date}><strong>{item.date}</strong><div className="rate-bar"><span style={{ width: `${item.mentionRate || 0}%` }} /><b>{formatRate(item.mentionRate)}</b></div><span>{item.completed}</span><span>{formatRate(item.citationRate)}</span><span className={item.failures ? 'danger-text' : 'muted'}>{item.failures || '—'}</span></div>)}</div> : <EmptyState title="还没有连续数据" description="至少完成一次监控后开始记录趋势。" />}</section><section className="card platform-trend"><div className="card-heading"><div><h3>平台基线</h3><p>当前周期各平台的整体表现</p></div></div><div className="platform-baselines">{platforms.map((item) => <div key={item.platform}><PlatformBadge id={item.platform} /><div className="baseline-bar"><span style={{ width: `${item.mentionRate || 0}%` }} /></div><strong>{formatRate(item.mentionRate)}</strong><small>{item.completed} 有效样本</small></div>)}</div></section></>;
}

function ReportsPage({ overview }) {
  if (!overview) return <EmptyState title="暂无报告数据" description="完成监控后可以生成品牌可见度报告。" />;
  const { brand, summary, platforms = [], questions = [] } = overview;
  return <><PageHeader eyebrow="BRAND REPORT" title="报告中心" description="汇总品牌出现率、平台差异、问题表现和来源证据。" actions={<button className="button secondary" onClick={() => window.print()}>打印 / 导出 PDF</button>} /><section className="card report-cover"><div><div className="page-eyebrow">GEO VISIBILITY REPORT</div><h2>{brand.name} 品牌可见度报告</h2><p>统计周期：近 {summary.periodDays} 天 · 生成时间：{formatTime(new Date().toISOString())}</p></div><div className="report-score"><strong>{formatRate(summary.mentionRate)}</strong><span>品牌出现率</span></div></section><section className="metric-grid report-metrics"><MetricCard label="有效样本" value={formatCount(summary.completed)} hint={`共 ${summary.totalChecks} 次检查`} /><MetricCard label="品牌提及" value={formatCount(summary.mentioned)} hint="回答中命中品牌词" tone="violet" /><MetricCard label="来源回答" value={formatCount(summary.cited)} hint={formatRate(summary.citationRate)} tone="green" /><MetricCard label="来源支撑" value={formatCount(summary.mentionBacked)} hint={`${formatCount(summary.mentionUnsupported)} 个无来源支撑`} tone="blue" /><MetricCard label="采集失败" value={formatCount(summary.failures)} hint="需人工复核" tone="orange" /></section><div className="dashboard-grid"><section className="card"><div className="card-heading"><div><h3>平台表现</h3></div></div><div className="platform-table">{platforms.map((item) => <div className="table-row" key={item.platform}><PlatformBadge id={item.platform} /><strong>{formatRate(item.mentionRate)}</strong><span>{item.completed} 样本</span><span>{formatRate(item.citationRate)} 来源率</span><span>{item.failures || '—'}</span></div>)}</div></section><section className="card"><div className="card-heading"><div><h3>重点问题</h3></div></div><div className="report-questions">{[...questions].sort((a, b) => (a.mentionRate ?? 101) - (b.mentionRate ?? 101)).slice(0, 8).map((item) => <div key={item.id}><span>{item.text}</span><strong>{formatRate(item.mentionRate)}</strong></div>)}</div></section></div></>;
}

const PROFILE_HEALTH = {
  new: { label: '未登录', tone: 'unknown' },
  ready: { label: '可用', tone: 'ready' },
  expired: { label: '已过期', tone: 'expired' },
  error: { label: '异常', tone: 'error' },
  restricted: { label: '受限', tone: 'restricted' },
  disabled: { label: '已停用', tone: 'disabled' },
};

const LOGIN_STATE_LABELS = {
  none: '无登录账号',
  unknown: '登录状态待手动验证',
  ready: '已有可用登录态',
  restricted: '登录态受限，需要处理',
};


function AddAccountModal({ platforms, defaultPlatformId, onClose, onSubmit }) {
  const [platformId, setPlatformId] = useState(defaultPlatformId || platforms[0]?.id || '');
  const [account, setAccount] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!platformId || !account.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ platformId, account: account.trim(), label: label.trim() });
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><div className="page-eyebrow">ADD ACCOUNT</div><h3>添加账号并登录</h3></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p className="modal-intro">保存后会打开该账号专属的浏览器窗口，在窗口中完成登录并关闭窗口即可完成绑定。</p><label>平台<select className="select" value={platformId} onChange={(event) => setPlatformId(event.target.value)}><option value="">选择平台</option>{platforms.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>手机号或登录账号<input autoFocus value={account} onChange={(event) => setAccount(event.target.value)} placeholder="手机号或登录账号" /></label><label>备注（可选）<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：主号、备用号" /></label><div className="modal-foot"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !platformId || !account.trim()}>{busy ? '正在打开…' : '添加并登录'}</button></div></form></div>;
}

function PlatformsPage({ platforms }) {
  const [profiles, setProfiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [cooldowns, setCooldowns] = useState({});
  const [manualWindows, setManualWindows] = useState({});
  const [selectedPlatformId, setSelectedPlatformId] = useState('');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [items, openSessions, status] = await Promise.all([
      api.listProfiles(),
      api.listLoginSessions(),
      api.listPlatformStatus(),
    ]);
    setProfiles(items);
    setSessions(openSessions);
    setCooldowns(Object.fromEntries(status.map((item) => [item.id, item.cooldown ?? null])));
    setManualWindows(Object.fromEntries(status.map((item) => [item.id, item.manualWindow ?? null])));
  }, []);

  useEffect(() => { reload().catch(() => undefined); }, [reload]);

  useEffect(() => {
    if (!platforms.length) return;
    setSelectedPlatformId((current) => {
      if (current === ALL_PLATFORMS) return current;
      return platforms.some((item) => item.id === current) ? current : ALL_PLATFORMS;
    });
  }, [platforms]);

  const hasOpenSession = sessions.some((session) => session.status === 'open' || session.status === 'starting');
  // 登录窗口还开着时轮询一次状态，操作员关闭窗口后登录态健康度会自动刷新。
  useEffect(() => {
    if (!hasOpenSession) return undefined;
    const timer = setInterval(() => { reload().catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [hasOpenSession, reload]);

  const showAll = selectedPlatformId === ALL_PLATFORMS;
  const selected = showAll ? null : (platforms.find((item) => item.id === selectedPlatformId) ?? platforms[0] ?? null);
  const openSessions = sessions.filter((session) => session.status === 'open' || session.status === 'starting');
  const own = showAll ? profiles : profiles.filter((profile) => profile.platformId === selected?.id);
  const readyAll = profiles.filter((profile) => profile.health === 'ready').length;
  const cooldown = showAll ? null : (cooldowns[selected?.id] ?? null);
  const manualWindow = showAll ? null : (manualWindows[selected?.id] ?? null);

  const addAccount = async ({ platformId, account, label }) => {
    setError('');
    setMessage('');
    try {
      const result = await api.startLoginSession({ platformId, account, label });
      setAdding(false);
      setSelectedPlatformId(platformId);
      setMessage(result.session.message);
      await reload();
    } catch (cause) {
      setError(cause.message);
    }
  };

  const login = async (profile) => {
    setError('');
    setMessage('');
    try {
      const result = await api.startLoginSession({ platformId: profile.platformId, profileId: profile.profileId });
      setMessage(result.session.message);
      await reload();
    } catch (cause) {
      setError(cause.message);
    }
  };

  const closeSession = async (sessionId) => {
    try {
      const session = await api.closeLoginSession(sessionId);
      setMessage(session.message);
      await reload();
    } catch (cause) {
      setError(cause.message);
    }
  };

  const disable = async (id) => {
    try {
      await api.disableProfile(id);
      await reload();
    } catch (cause) {
      setError(cause.message);
    }
  };

  return <>
    <PageHeader eyebrow="PLATFORM ACCESS" title="平台与登录状态" description="左侧可选择「全部平台」查看所有平台的账号汇总，或单独切换到某个平台；新增账号后会自动打开浏览器窗口，手动登录并关闭窗口即可完成绑定。" />
    {message ? <div className="notice info">{message}</div> : null}
    {error ? <div className="notice">{error}</div> : null}
    {openSessions.length ? <section className="card login-session-card"><div className="card-heading"><div><h3>正在登录</h3><p>请在已打开的浏览器窗口中完成登录，关闭窗口后登录态会自动标记为可用。</p></div></div><div className="login-session-list">{openSessions.map((session) => <div className="login-session-item" key={session.id}><span className="state-dot unknown" /><div className="login-session-main"><strong>{platformLabel(session.platformId)} · {session.account || session.profileId}</strong><span>{session.message}</span></div><button className="button secondary" onClick={() => closeSession(session.id).catch(() => undefined)}>关闭窗口</button></div>)}</div></section> : null}
    <div className="platform-layout">
      <aside className="card platform-side">
        <div className="platform-side-title">平台</div>
        <div className="platform-side-list">
          <button className={`platform-side-item ${showAll ? 'active' : ''}`} onClick={() => setSelectedPlatformId(ALL_PLATFORMS)}><span className="platform-side-all">全部</span><span className="platform-side-name">全部平台</span><span className="platform-side-count">{profiles.length ? `${readyAll}/${profiles.length}` : '无'}</span></button>
          <div className="platform-side-divider">按平台</div>
          {platforms.map((item) => {
          const count = profiles.filter((profile) => profile.platformId === item.id).length;
          const ready = profiles.filter((profile) => profile.platformId === item.id && profile.health === 'ready').length;
          return <button key={item.id} className={`platform-side-item ${selected?.id === item.id ? 'active' : ''}`} onClick={() => setSelectedPlatformId(item.id)}><PlatformDot id={item.id} /><span className="platform-side-name">{item.label}</span>{manualWindows[item.id] ? <span className="platform-side-paused manual">人工</span> : null}{cooldowns[item.id] ? <span className={`platform-side-paused ${cooldowns[item.id].kind === 'busy' ? 'busy' : ''}`}>{cooldowns[item.id].kind === 'busy' ? '繁忙' : cooldowns[item.id].kind === 'no_account' ? '无账号' : '暂停'}</span> : null}<span className="platform-side-count">{count ? `${ready}/${count}` : '无'}</span></button>;
        })}</div>
      </aside>
      {showAll || selected ? <section className="card platform-detail">
        <div className="platform-detail-head">
          <div className="platform-detail-title">{showAll ? <span className="platform-side-all">全部</span> : <PlatformDot id={selected.id} />}<h3>{showAll ? '全部平台' : selected.label}</h3>{showAll ? null : <span className={`state-dot ${selected.loginStatus ?? 'unknown'}`} />}{showAll ? null : (LOGIN_STATE_LABELS[selected.loginStatus] ?? LOGIN_STATE_LABELS.unknown)}</div>
          <div className="platform-detail-actions">{showAll ? null : <button className="button secondary" onClick={() => window.open(selected.entryUrl, '_blank')}>打开平台</button>}<button className="button primary" onClick={() => setAdding(true)}>添加账号</button></div>
        </div>
        {showAll
          ? (platforms.some((item) => cooldowns[item.id])
            ? <div className="platform-cooldown-list">
            {platforms.filter((item) => cooldowns[item.id]).map((item) => <div key={item.id} className="platform-cooldown-notice">
              <div><strong>{item.label} {describeCooldownKind(cooldowns[item.id]?.kind)}，已暂停采集</strong><span>暂停至 {formatTime(cooldowns[item.id]?.until)}　·　{cooldowns[item.id]?.reason}　·　续跑与中止请到「监控任务」详情里操作</span></div>
            </div>)}
          </div>
            : null)
          : cooldown
            ? <div className="platform-cooldown-notice">
              <div><strong>该平台{describeCooldownKind(cooldown.kind)}，已暂停采集</strong><span>暂停至 {formatTime(cooldown.until)}　·　{cooldown.reason}　·　续跑与中止请到「监控任务」详情里操作</span></div>
            </div>
            : null}
        {manualWindow
          ? <div className="platform-manual-notice">
            <div><strong>该平台需要人工验证，已自动改用有头模式</strong><span>持续至 {formatTime(manualWindow.until)}　·　遇到验证码时会在浏览器窗口里等待人工处理　·　恢复无头请到「监控任务」详情里操作</span></div>
          </div>
          : null}

        {showAll
          ? <dl className="platform-detail-meta"><div><dt>平台数量</dt><dd>{platforms.length} 个</dd></div><div><dt>账号总数</dt><dd>{own.length} 个</dd></div><div><dt>可用账号</dt><dd>{own.filter((profile) => profile.health === 'ready').length} 个</dd></div><div><dt>受限账号</dt><dd>{own.filter((profile) => profile.health === 'restricted').length} 个</dd></div><div><dt>待登录</dt><dd>{own.filter((profile) => profile.health === 'new' || profile.health === 'expired').length} 个</dd></div><div><dt>已停用</dt><dd>{own.filter((profile) => profile.health === 'disabled').length} 个</dd></div></dl>
          : <dl className="platform-detail-meta"><div><dt>账号总数</dt><dd>{own.length} 个</dd></div><div><dt>可用账号</dt><dd>{own.filter((profile) => profile.health === 'ready').length} 个</dd></div><div><dt>受限账号</dt><dd>{own.filter((profile) => profile.health === 'restricted').length} 个</dd></div><div><dt>入口</dt><dd>{selected.entryUrl}</dd></div></dl>}
        <div className={`account-table ${showAll ? 'with-platform' : ''}`}>
          <div className="account-row head">{showAll ? <span>平台</span> : null}<span>账号</span><span>状态</span><span>最近登录</span><span>最近使用</span><span>操作</span></div>
          {own.map((profile) => {
            const running = openSessions.some((session) => session.platformId === profile.platformId && session.profileId === profile.profileId);
            return <div className="account-row" key={profile.id}>
              {showAll ? <div className="account-platform"><PlatformDot id={profile.platformId} />{platformLabel(profile.platformId)}</div> : null}
              <div className="account-name"><span className={`state-dot ${profile.health}`} /><span title={profile.account || profile.profileId}>{profile.label || profile.account || profile.profileId}</span></div>
              <div><span className={`profile-health ${profile.health}`}>{PROFILE_HEALTH[profile.health]?.label ?? profile.health}</span></div>
              <div className="account-time">{formatTime(profile.lastLoginAt)}</div>
              <div className="account-time">{formatTime(profile.lastUsedAt)}</div>
              <div className="account-actions"><button className="text-button" disabled={running} onClick={() => login(profile).catch(() => undefined)}>{running ? '登录中…' : profile.health === 'ready' ? '重新登录' : '登录'}</button>{profile.health !== 'disabled' ? <button className="text-button danger" onClick={() => disable(profile.id).catch(() => undefined)}>停用</button> : null}</div>
            </div>;
          })}
          {!own.length ? <div className="account-empty">{showAll ? '无登录账号，点击右上角「添加账号」开始配置。' : '无登录账号，点击右上角「添加账号」开始配置。'}</div> : null}
        </div>
      </section> : null}
    </div>
    {adding ? <AddAccountModal platforms={platforms} defaultPlatformId={selected?.id ?? platforms[0]?.id ?? ''} onClose={() => setAdding(false)} onSubmit={addAccount} /> : null}
  </>;
}
function BrandModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', aliases: '', products: '', website: '', ownedDomains: '', description: '' });
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => { event.preventDefault(); if (!form.name.trim()) return; setBusy(true); try { await onCreated({ name: form.name, description: form.description, aliases: form.aliases, products: form.products, website: form.website, ownedDomains: form.ownedDomains }); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><div className="page-eyebrow">NEW BRAND</div><h3>创建品牌</h3></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p className="modal-intro">品牌信息会用于识别 AI 回答中的提及和自有来源。</p><label>品牌名称<input autoFocus value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：千威" /></label><div className="form-grid"><label>品牌别名<input value={form.aliases} onChange={(event) => update('aliases', event.target.value)} placeholder="逗号分隔" /></label><label>产品名称<input value={form.products} onChange={(event) => update('products', event.target.value)} placeholder="逗号分隔" /></label><label>官网<input value={form.website} onChange={(event) => update('website', event.target.value)} placeholder="https://" /></label><label>自有域名<input value={form.ownedDomains} onChange={(event) => update('ownedDomains', event.target.value)} placeholder="用于来源覆盖率" /></label></div><label>备注<textarea value={form.description} onChange={(event) => update('description', event.target.value)} placeholder="品牌定位或监测说明" /></label><div className="modal-foot"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !form.name.trim()}>{busy ? '创建中…' : '创建品牌'}</button></div></form></div>;
}

function RunWizard({ brand, questions, platforms, onClose, onCreated }) {
  const enabled = questions.filter((item) => item.enabled);
  const [selectedQuestions, setSelectedQuestions] = useState(enabled.map((item) => item.id));
  const [selectedPlatforms, setSelectedPlatforms] = useState(platforms.map((item) => item.id));
  const [modes, setModes] = useState(Object.fromEntries(platforms.map((item) => [
    item.id,
    item.defaultMode ?? PLATFORM_META[item.id]?.defaultMode ?? 'headless',
  ])));
  const [concurrency, setConcurrency] = useState(3);
  const [appendSearchPrompt, setAppendSearchPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  // 平台列表是异步加载的：未手动调整过时默认全选，调整过则只剔除已消失的平台。
  const [platformSelectionTouched, setPlatformSelectionTouched] = useState(false);
  useEffect(() => {
    const availableIds = platforms.map((item) => item.id);
    setSelectedPlatforms((current) => {
      if (!platformSelectionTouched) return availableIds;
      const alive = new Set(availableIds);
      return current.filter((id) => alive.has(id));
    });
  }, [platforms, platformSelectionTouched]);
  const updatePlatforms = (next) => { setPlatformSelectionTouched(true); setSelectedPlatforms(next); };
  const totalChecks = selectedQuestions.length * selectedPlatforms.length;
  const toggle = (id, values, setter) => setter(values.includes(id) ? values.filter((item) => item !== id) : [...values, id]);
  const submit = async () => {
    setBusy(true);
    try {
      await onCreated({
        brandId: brand.id,
        questionIds: selectedQuestions,
        platforms: selectedPlatforms,
        mode: 'headless',
        platformModes: Object.fromEntries(selectedPlatforms.map((id) => [id, modes[id]])),
        concurrency,
        appendSearchPrompt,
      });
    } finally {
      setBusy(false);
    }
  };
  const setMode = (platformId, mode) => setModes((current) => ({ ...current, [platformId]: mode }));
  return <div className="modal-backdrop">
    <div className="rw">
      <div className="rw-head">
        <div className="rw-head-main">
          <div className="page-eyebrow">NEW MONITORING RUN</div>
          <h3>发起品牌监控</h3>
          <p className="rw-head-sub">选择需要监测的问题与平台，提交后按并发数排队执行。</p>
        </div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>

      <div className="rw-stats">
        <div className="rw-stat"><span className="rw-stat-label">监控品牌</span><strong className="rw-stat-value accent">{brand.name}</strong></div>
        <div className="rw-stat"><span className="rw-stat-label">监控问题</span><strong className="rw-stat-value">{selectedQuestions.length}<small> / {enabled.length}</small></strong></div>
        <div className="rw-stat"><span className="rw-stat-label">目标平台</span><strong className="rw-stat-value">{selectedPlatforms.length}<small> / {platforms.length}</small></strong></div>
        <div className="rw-stat"><span className="rw-stat-label">预计检查次数</span><strong className="rw-stat-value">{totalChecks}</strong></div>
        <div className="rw-stat rw-stat-control">
          <span className="rw-stat-label">全局并发数</span>
          <select className="select compact" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </div>
      </div>

      <div className="rw-columns">
        <section className="rw-panel">
          <div className="rw-panel-head">
            <div className="rw-panel-title">
              <span className="rw-step">1</span>
              <div><strong>选择监控问题</strong><small>已选 {selectedQuestions.length} / {enabled.length} 条</small></div>
            </div>
            <div className="rw-panel-actions">
              <button type="button" className="text-button" onClick={() => setSelectedQuestions(enabled.map((item) => item.id))}>全选</button>
              <button type="button" className="text-button" onClick={() => setSelectedQuestions([])}>清空</button>
            </div>
          </div>
          <div className="rw-list">
            {enabled.map((item, index) => {
              const on = selectedQuestions.includes(item.id);
              return <label className={`rw-check ${on ? 'on' : ''}`} key={item.id}>
                <input type="checkbox" checked={on} onChange={() => toggle(item.id, selectedQuestions, setSelectedQuestions)} />
                <span className="rw-check-index">{index + 1}</span>
                <span className="rw-check-text">{item.text}</span>
              </label>;
            })}
            {!enabled.length ? <div className="rw-empty">还没有启用中的监控问题，请先到「监控问题」添加。</div> : null}
          </div>
        </section>

        <section className="rw-panel rw-panel-alt">
          <div className="rw-panel-head">
            <div className="rw-panel-title">
              <span className="rw-step">2</span>
              <div><strong>选择平台与模式</strong><small>已选 {selectedPlatforms.length} / {platforms.length} 个</small></div>
            </div>
            <div className="rw-panel-actions">
              <button type="button" className="text-button" onClick={() => updatePlatforms(platforms.map((item) => item.id))}>全选</button>
              <button type="button" className="text-button" onClick={() => updatePlatforms([])}>清空</button>
            </div>
          </div>
          <div className="rw-list rw-list-platform">
            {platforms.map((item) => {
              const on = selectedPlatforms.includes(item.id);
              const ready = item.profileSummary?.ready ?? 0;
              const total = item.profileSummary?.total ?? 0;
              const current = modes[item.id] ?? 'headless';
              return <div className={`rw-platform ${on ? 'on' : ''}`} key={item.id}>
                <label className="rw-platform-main">
                  <input type="checkbox" checked={on} onChange={() => updatePlatforms(selectedPlatforms.includes(item.id) ? selectedPlatforms.filter((id) => id !== item.id) : [...selectedPlatforms, item.id])} />
                  <PlatformDot id={item.id} />
                  <span className="rw-platform-name">{item.label || platformLabel(item.id)}</span>
                </label>
                {on ? <>
                  <span className={`rw-chip ${ready ? 'ok' : 'warn'}`}>{total ? `${ready}/${total} 登录态可用` : '无登录账号'}</span>
                  <div className="rw-segment">
                    <button type="button" className={current === 'headless' ? 'active' : ''} onClick={() => setMode(item.id, 'headless')}>无头</button>
                    <button type="button" className={current === 'headed' ? 'active' : ''} onClick={() => setMode(item.id, 'headed')}>有头</button>
                  </div>
                </> : <span className="rw-chip muted">未选择</span>}
              </div>;
            })}
            {!platforms.length ? <div className="rw-empty">暂无可用平台。</div> : null}
          </div>
          <label className="rw-toggle">
            <input type="checkbox" checked={appendSearchPrompt} onChange={(event) => setAppendSearchPrompt(event.target.checked)} />
            <span className="rw-toggle-track"><i /></span>
            <span className="rw-toggle-text"><strong>附加搜索提示词</strong><small>要求模型先搜索相关信息，再结合可靠来源作答</small></span>
          </label>
        </section>
      </div>

      <div className="rw-note">
        <span className="rw-note-dot" />
        全局最多同时执行 {concurrency} 项，同一平台同一时间仅运行 1 个问题。豆包默认有头模式，其他平台默认无头模式。
      </div>

      <div className="rw-foot">
        <div className="rw-foot-hint">共 {totalChecks} 次检查，将按 {concurrency} 并发排队执行。</div>
        <div className="rw-foot-actions">
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button type="button" className="button primary" disabled={busy || !selectedQuestions.length || !selectedPlatforms.length} onClick={submit}>{busy ? '加入队列…' : '确认并开始监控'}</button>
        </div>
      </div>
    </div>
  </div>;
}
function EvidenceDrawer({ platformRun, onClose }) {
  if (!platformRun) return null;
  const answer = platformRun.answer;
  return <div className="drawer-backdrop" onClick={onClose}><aside className="drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><PlatformBadge id={platformRun.platformId} /><h3>{platformRun.prompt?.text}</h3><p>{platformRun.mode === 'headed' ? '有头模式' : '无头模式'} · {formatTime(platformRun.createdAt)}</p></div><button className="icon-button" onClick={onClose}>×</button></div><div className="drawer-body"><div className="drawer-status"><StatusPill status={platformRun.status} />{platformRun.account ? <span className={`account-chip ${platformRun.accountHealth || ''}`} title="本次监测使用的登录账号">监测账号：{platformRun.accountLabel || platformRun.account}</span> : null}{answer && <span className={answer.brandMentioned ? 'mention-chip yes' : 'mention-chip'}>{answer.brandMentioned ? `已提及品牌 · ${answer.mentionCount} 次` : '回答未提及品牌'}</span>}{answer && <span className={answer.sourceMentioned ? 'mention-chip source yes' : 'mention-chip source'}>{answer.sourceMentioned ? `来源提及品牌 · ${answer.sourceMentionCount} 条` : '来源未提及品牌'}</span>}{answer && answer.mentionBackedBySource ? <span className="mention-chip source backed">来源支撑</span> : null}{answer && answer.mentionWithoutSource ? <span className="mention-chip source unsupported">模型自有认知</span> : null}</div>{platformRun.errorMessage && <div className="error-box">{platformRun.errorMessage}</div>}{answer && <><div className="evidence-section"><div className="evidence-heading"><h4>回答原文</h4>{answer.responseUrl && <a href={answer.responseUrl} target="_blank" rel="noreferrer">打开回答 ↗</a>}</div><div className="answer-content">{answer.content}</div>{answer.matchedTerms?.length ? <div className="matched-terms">命中词：{answer.matchedTerms.map((term) => <span className="tag" key={term}>{term}</span>)}</div> : null}</div><div className="evidence-section"><div className="evidence-heading"><h4>来源证据 <span>{answer.citations.length}</span></h4><span className={answer.sourcePanelOpened && (answer.platformReportedCount === null || answer.platformReportedCount === answer.citations.length) ? 'quality good' : 'quality warn'}>{answer.sourcePanelOpened ? `平台显示 ${answer.platformReportedCount ?? '—'} 篇` : '未展开来源面板'}</span></div><div className="citation-list">{answer.citations.map((citation) => <a className="citation-item" key={citation.id} href={citation.url} target="_blank" rel="noreferrer"><strong>{citation.title || citation.domain}</strong><span>{citation.domain} · {citation.citationOccurrences || 0} 次引用</span>{citation.brandMentioned ? <span className="citation-mention">提及品牌{citation.matchedTerms?.length ? ` · ${citation.matchedTerms.join('、')}` : ''}</span> : null}<small>{citation.url}</small></a>)}{!answer.citations.length && <p className="muted">没有抓到来源 URL。</p>}</div></div><div className="evidence-section"><div className="evidence-heading"><h4>分享链接</h4><span className={platformRun.shareStatus === 'captured' ? 'quality good' : 'quality warn'}>{SHARE_STATUS_LABELS[platformRun.shareStatus] ?? '未采集'}</span></div>{platformRun.shareStatus === 'captured' && platformRun.shareUrl ? <div className="share-box"><a href={platformRun.shareUrl} target="_blank" rel="noreferrer">{platformRun.shareUrl}</a></div> : <p className="muted">{SHARE_STATUS_HINTS[platformRun.shareStatus] ?? '本次没有采集分享链接。'}</p>}</div><div className="evidence-section"><div className="evidence-heading"><h4>采集证据文件</h4></div><div className="artifact-list">{answer.artifacts.map((artifact) => <a key={artifact.id} href={`/artifacts/${artifact.relativePath}`} target="_blank" rel="noreferrer">{artifact.kind === 'screenshot' ? '查看截图' : artifact.kind === 'html' ? '查看 HTML' : '查看 JSON'}</a>)}</div></div></>}</div></aside></div>;
}

function App() {
  const [route, setRoute] = useState(readRoute());
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState(null);
  const [overview, setOverview] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [platforms, setPlatforms] = useState([]);
  const [drawerRun, setDrawerRun] = useState(null);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');

  const loadBrand = useCallback(async (brandId) => {
    const selected = brands.find((item) => item.id === brandId) || brands[0] || null;
    setBrand(selected);
    if (!selected) return;
    const [nextQuestions, nextRuns] = await Promise.all([api.listQuestions(selected.id), api.listRuns(selected.id)]);
    setQuestions(nextQuestions);
    setRuns(nextRuns);
  }, [brands]);

  const refreshOverview = useCallback(async () => { if (brand) setOverview(await api.getBrandOverview(brand.id)); }, [brand]);
  const openRun = useCallback(async (runId) => { const detail = await api.getRun(runId); setActiveRun(detail); navigate('runs', runId); }, []);
  const closeRun = useCallback(() => { setActiveRun(null); navigate('runs'); }, []);
  const reloadQuestions = useCallback(async (payload) => { if (!brand) return; if (payload) await api.createQuestions(brand.id, payload); const next = await api.listQuestions(brand.id); setQuestions(next); await refreshOverview(); }, [brand, refreshOverview]);

  useEffect(() => { const handler = () => setRoute(readRoute()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => {
    api.listBrands().then((items) => {
      setBrands(items);
      if (items[0]) setBrand((current) => current || items[0]);
    }).catch((cause) => setError(cause.message));
    api.listPlatformStatus().then(setPlatforms).catch(() => {
      api.listPlatforms().then((items) => setPlatforms(items.map((item) => ({
        ...item,
        defaultMode: PLATFORM_META[item.id]?.defaultMode || 'headless',
        loginStatus: 'unknown',
        riskLevel: 'normal',
      }))));
    });
  }, []);
  useEffect(() => { if (brand) loadBrand(brand.id).catch((cause) => setError(cause.message)); }, [brand?.id]);
  useEffect(() => { if (!brand) return; if (['overview', 'trends', 'reports'].includes(route.view)) refreshOverview().catch((cause) => setError(cause.message)); }, [brand?.id, route.view]);
  useEffect(() => { if (route.runId) api.getRun(route.runId).then(setActiveRun).catch((cause) => setError(cause.message)); }, [route.runId]);
  useEffect(() => { if (!activeRun || !['queued', 'running'].includes(activeRun.status)) return undefined; const timer = setInterval(() => api.getRun(activeRun.id).then((run) => { setActiveRun(run); setRuns((items) => items.map((item) => item.id === run.id ? run : item)); if (!['queued', 'running'].includes(run.status)) refreshOverview().catch(() => undefined); }).catch(() => undefined), 2500); return () => clearInterval(timer); }, [activeRun?.id, activeRun?.status, refreshOverview]);
  // 任务列表定期刷新：取消、失败、完成等状态变化要尽快反映到列表里，
  // 否则列表会一直停留在旧状态（例如永远显示「取消中」）。
  const hasActiveRuns = runs.some((item) => ['queued', 'running'].includes(item.status));
  useEffect(() => {
    if (!brand || !hasActiveRuns) return undefined;
    const timer = setInterval(() => { api.listRuns(brand.id).then(setRuns).catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, [brand?.id, hasActiveRuns]);

  const selectBrand = (id) => { const selected = brands.find((item) => item.id === id); setBrand(selected); setActiveRun(null); navigate('overview'); };
  const createBrand = async (body) => { const created = await api.createBrand(body); const next = [created, ...brands]; setBrands(next); setBrand(created); setModal(null); navigate('overview'); };
  const createRun = async (body) => { const run = await api.createMonitoringRun(body); setRuns((items) => [run, ...items]); setModal(null); setActiveRun(run); navigate('runs', run.id); };
  const cancelRun = async (id) => {
    if (!window.confirm('确认取消这个监控任务吗？已打开的浏览器会被强制关闭，未完成的问题不会继续执行。')) return;
    try {
      const run = await api.cancelRun(id);
      setRuns((items) => items.map((item) => item.id === id ? run : item));
      setActiveRun(await api.getRun(id));
    } catch (cause) {
      setError(cause.message);
    }
  };
  // 熔断的平台在任务详情里手动续跑或中止。
  const resumeRunPlatform = async (runId, platformId) => {
    try {
      await api.resumeRunPlatform(runId, platformId);
      setActiveRun(await api.getRun(runId));
    } catch (cause) {
      setError(cause.message);
    }
  };
  const abortRunPlatform = async (runId, platformId) => {
    try {
      await api.abortRunPlatform(runId, platformId);
      setActiveRun(await api.getRun(runId));
    } catch (cause) {
      setError(cause.message);
    }
  };
  // 人工窗口期间该平台一直用有头模式跑，任务详情里可以提前解除。
  const clearManualWindow = async (platformId) => {
    try {
      await api.clearPlatformManualWindow(platformId);
      setPlatforms((items) => items.map((item) => item.id === platformId ? { ...item, manualWindow: null } : item));
    } catch (cause) {
      setError(cause.message);
    }
  };
  const currentView = ['overview', 'questions', 'runs', 'sources', 'trends', 'reports', 'platforms'].includes(route.view) ? route.view : 'overview';
  const page = currentView === 'platforms' ? <PlatformsPage platforms={platforms} />
    : !brand ? <EmptyState title="先创建一个品牌" description="品牌是 GEO 监测的主体，添加品牌后再配置监控问题。" action={<button className="button primary" onClick={() => setModal('brand')}>创建品牌</button>} />
    : currentView === 'overview' ? <OverviewPage overview={overview} onNewRun={() => setModal('run')} onOpenRun={openRun} onNavigate={navigate} />
      : currentView === 'questions' ? <QuestionsPage questions={questions} onReload={reloadQuestions} onNewRun={() => setModal('run')} />
        : currentView === 'runs' ? <RunsPage runs={runs} activeRun={activeRun} onOpenRun={openRun} onCloseRun={closeRun} onCancel={cancelRun} onNewRun={() => setModal('run')} onSelectCell={setDrawerRun} onResumePlatform={resumeRunPlatform} onAbortPlatform={abortRunPlatform} onClearManualWindow={clearManualWindow} />
          : currentView === 'sources' ? <SourcesPage brand={brand} />
              : currentView === 'trends' ? <TrendsPage overview={overview} />
                : currentView === 'reports' ? <ReportsPage overview={overview} />
                  : <OverviewPage overview={overview} onNewRun={() => setModal('run')} onOpenRun={openRun} onNavigate={navigate} />;
  return <><AppShell brands={brands} brand={brand} view={currentView} onNavigate={navigate} onSelectBrand={selectBrand} onNewBrand={() => setModal('brand')} onNewRun={() => setModal('run')}><>{error && <div className="notice">{error}<button onClick={() => setError('')}>×</button></div>}{page}</></AppShell>{modal === 'brand' && <BrandModal onClose={() => setModal(null)} onCreated={createBrand} />}{modal === 'run' && brand && <RunWizard brand={brand} questions={questions} platforms={platforms.length ? platforms : Object.keys(PLATFORM_META).map((id) => ({ id, label: platformLabel(id) }))} onClose={() => setModal(null)} onCreated={createRun} />}{drawerRun && <EvidenceDrawer platformRun={drawerRun} onClose={() => setDrawerRun(null)} />}</>;
}

createRoot(document.getElementById('root')).render(<App />);
