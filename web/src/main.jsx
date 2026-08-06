import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import './styles.css';

const PLATFORM_META = {
  deepseek: { label: 'DeepSeek', tone: 'blue', defaultMode: 'headless' },
  doubao: { label: '豆包', tone: 'orange', defaultMode: 'headed' },
  kimi: { label: 'Kimi', tone: 'cyan', defaultMode: 'headless' },
  qwen: { label: '千问', tone: 'purple', defaultMode: 'headless' },
  yuanbao: { label: '腾讯元宝', tone: 'green', defaultMode: 'headless' },
};

const STATUS_LABELS = {
  queued: '排队中', running: '执行中', cancelling: '取消中', completed: '已完成', partial_failed: '部分失败', failed: '失败', cancelled: '已取消',
};

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

function MetricCard({ label, value, hint, tone = 'blue' }) {
  return <article className={`metric-card ${tone}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div>{hint && <div className="metric-hint">{hint}</div>}</article>;
}

function EmptyState({ title, description, action }) {
  return <div className="empty-state"><div className="empty-mark">＋</div><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function AppShell({ brands, brand, view, onNavigate, onSelectBrand, onNewBrand, onNewRun, children }) {
  const nav = [
    ['overview', '品牌总览', '⌂'], ['questions', '监控问题', '◇'], ['runs', '监控任务', '▦'], ['sources', '来源中心', '↗'], ['trends', '历史趋势', '⌁'], ['reports', '报告中心', '▤'],
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-mark"><span className="brand-logo">G</span><div><strong>GEO Signal</strong><small>品牌可见度监测</small></div></div>
      <div className="side-section-label">当前品牌</div>
      <div className="brand-picker"><select value={brand?.id || ''} onChange={(event) => onSelectBrand(event.target.value)} disabled={!brands.length}><option value="">选择品牌</option>{brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button aria-label="新建品牌" onClick={onNewBrand}>＋</button></div>
      <nav className="side-nav">{nav.map(([key, label, icon]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => onNavigate(key)} disabled={!brand}><span className="nav-icon">{icon}</span>{label}</button>)}</nav>
      <div className="side-divider" />
      <nav className="side-nav secondary"><button className={view === 'platforms' ? 'active' : ''} onClick={() => onNavigate('platforms')}><span className="nav-icon">◎</span>平台与登录</button><button onClick={onNewRun} disabled={!brand}><span className="nav-icon">＋</span>发起一次监控</button></nav>
      <div className="sidebar-foot"><span className="online-dot" />采集服务在线<span className="version">v0.2 brand-first</span></div>
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
  const [category, setCategory] = useState('');
  const [draft, setDraft] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [importing, setImporting] = useState(false);
  const filtered = questions.filter((item) => (!search || item.text.includes(search)) && (!category || item.category === category));
  const categories = [...new Set(questions.map((item) => item.category).filter(Boolean))];
  const importQuestions = async (event) => {
    event.preventDefault();
    const texts = draft.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!texts.length) return;
    setImporting(true);
    try { await onReload({ texts, category: draftCategory }); setDraft(''); } finally { setImporting(false); }
  };
  const toggle = async (item) => { await api.updateQuestion(item.id, { enabled: !item.enabled }); onReload(); };
  return <>
    <PageHeader eyebrow="MONITOR QUESTIONS" title="监控问题" description="问题是品牌监测的样本资产，建议优先使用真实用户问法。" actions={<button className="button primary" onClick={onNewRun}>用问题发起监控</button>} />
    <section className="card import-card"><div className="card-heading"><div><h3>批量添加问题</h3><p>一行一个问题，导入前会自动去重。</p></div><span className="import-count">当前 {questions.length} 条</span></div><form onSubmit={importQuestions} className="import-form"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：第一次买伟哥，哪个牌子更稳一点？\n备孕时老是硬不起来，吃什么药更稳？" /><div className="form-inline"><input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} placeholder="分类（可选，例如：购买决策）" /><button className="button primary" disabled={importing || !draft.trim()}>{importing ? '导入中…' : '添加问题'}</button></div></form></section>
    <section className="card"><div className="filter-bar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索问题" /><select className="select" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部分类</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select><span className="filter-count">显示 {filtered.length} / {questions.length}</span></div><div className="question-list">{filtered.map((item, index) => <div className="question-row" key={item.id}><span className="question-index">{String(index + 1).padStart(2, '0')}</span><div className="question-main"><strong>{item.text}</strong><div><span className="tag">{item.category || '未分类'}</span><small>最近有效率 {formatRate(item.mentionRate)}</small></div></div><span className={`toggle ${item.enabled ? 'on' : ''}`} role="switch" aria-checked={item.enabled} tabIndex="0" onClick={() => toggle(item)} onKeyDown={(event) => event.key === 'Enter' && toggle(item)}>{item.enabled ? '启用' : '停用'}</span></div>)}{!filtered.length && <EmptyState title="没有匹配的问题" description="可以调整筛选条件，或添加一批新的监控问题。" />}</div></section>
  </>;
}

function RunsPage({ runs, activeRun, onOpenRun, onCancel, onNewRun, onSelectCell }) {
  return <>
    <PageHeader eyebrow="MONITORING RUNS" title="监控任务" description="每个任务由多个问题和平台检查组成，点击进入问题 × 平台结果矩阵。" actions={<button className="button primary" onClick={onNewRun}>＋ 新建任务</button>} />
    <section className="card runs-list">{runs.length ? runs.map((run) => <button className={`run-list-row ${activeRun?.id === run.id ? 'selected' : ''}`} key={run.id} onClick={() => onOpenRun(run.id)}><div className="run-date"><StatusPill status={displayRunStatus(run)} /><strong>{formatTime(run.createdAt)}</strong></div><div className="run-progress"><div className="progress-line"><span style={{ width: `${progressPercent(run)}%` }} /></div><small>{run.completedChecks} / {run.totalChecks} 检查完成</small></div><div className="run-platforms">{run.targetPlatforms.map((id) => <PlatformBadge key={id} id={id} />)}</div><div className="run-stats"><span>{run.mentionedChecks} 次提及</span><span>{run.citationCount} 条引用</span></div>{['queued', 'running'].includes(run.status) && <span className="run-cancel" onClick={(event) => { event.stopPropagation(); onCancel(run.id); }}>{run.cancelRequestedAt ? '取消中…' : '取消'}</span>}</button>) : <EmptyState title="还没有监控任务" description="选择问题和平台，发起第一轮品牌监控。" action={<button className="button primary" onClick={onNewRun}>发起监控</button>} />}</section>
    {activeRun && <RunDetail run={activeRun} onSelectCell={onSelectCell} onCancel={onCancel} />}
  </>;
}

function RunDetail({ run, onSelectCell, onCancel }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of run.platformRuns || []) { if (!map.has(item.promptId)) map.set(item.promptId, { id: item.promptId, prompt: item.prompt, cells: {} }); map.get(item.promptId).cells[item.platformId] = item; }
    return [...map.values()];
  }, [run]);
  return <section className="card run-detail"><div className="detail-header"><div><div className="page-eyebrow">TASK DETAIL</div><h3>{formatTime(run.createdAt)} 的监控任务</h3><p>{run.completedChecks}/{run.totalChecks} 检查完成 · {run.mentionedChecks} 个回答提到品牌 · {run.citationCount} 条引用</p></div><div className="detail-actions"><StatusPill status={displayRunStatus(run)} />{['queued', 'running'].includes(run.status) && <button className="button danger-outline" onClick={() => onCancel(run.id)}>{run.cancelRequestedAt ? '取消中…' : '取消任务'}</button>}</div></div><div className="detail-progress"><div className="progress-line large"><span style={{ width: `${progressPercent(run)}%` }} /></div><span>{progressPercent(run)}%</span></div><div className="matrix-wrap"><table className="matrix"><thead><tr><th>监控问题</th>{run.targetPlatforms.map((id) => <th key={id}><PlatformBadge id={id} /></th>)}</tr></thead><tbody>{grouped.map((row) => <tr key={row.id}><td><strong>{row.prompt?.text || '未知问题'}</strong><small>{row.prompt?.category || '未分类'}</small></td>{run.targetPlatforms.map((id) => <td key={id}><button className={`matrix-cell ${row.cells[id]?.status || 'queued'}`} onClick={() => row.cells[id] && onSelectCell(row.cells[id])}>{row.cells[id] ? <><StatusPill status={row.cells[id].status} />{row.cells[id].answer ? <span className={row.cells[id].answer.brandMentioned ? 'mention yes' : 'mention'}>{row.cells[id].answer.brandMentioned ? '已提及' : '未提及'}</span> : null}<small>{row.cells[id].answer ? `${row.cells[id].answer.citations.length} 条来源` : row.cells[id].errorMessage || '等待执行'}</small></> : <span>—</span>}</button></td>)}</tr>)}</tbody></table></div></section>;
}

function SourcesPage({ sources, onReload }) {
  const [platform, setPlatform] = useState('');
  useEffect(() => { onReload(platform); }, [platform]);
  if (!sources) return <EmptyState title="正在加载来源" description="读取品牌在回答中的原始引用网页。" />;
  return <><PageHeader eyebrow="SOURCE EVIDENCE" title="来源中心" description="查看品牌相关回答引用了哪些原网页，并保留跨平台出现记录。" actions={<><select className="select compact" defaultValue="30"><option value="30">近 30 天</option><option value="90">近 90 天</option></select><button className="button secondary" onClick={() => window.print()}>导出 / 打印</button></>} /><section className="metric-grid source-metrics"><MetricCard label="唯一 URL" value={formatCount(sources.summary.uniqueUrls)} hint={`${sources.summary.domains} 个域名`} tone="blue" /><MetricCard label="引用记录" value={formatCount(sources.summary.citationCount)} hint={`${sources.summary.citationOccurrences} 次出现`} tone="violet" /><MetricCard label="来源平台" value={formatCount(new Set(sources.sources.flatMap((item) => item.platforms)).size)} hint="跨平台保留明细" tone="green" /><MetricCard label="时间范围" value={`${sources.summary.periodDays} 天`} hint="可切换周期" tone="orange" /></section><section className="card"><div className="filter-bar"><span className="filter-title">URL 明细</span><select className="select" value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="">全部平台</option>{Object.keys(PLATFORM_META).map((id) => <option key={id} value={id}>{platformLabel(id)}</option>)}</select><span className="filter-count">同一 URL 跨平台不丢失出现记录</span></div><div className="source-list">{sources.sources.map((item) => <article className="source-row" key={item.url}><div className="source-title"><strong>{item.title || item.domain || item.url}</strong><a href={item.url} target="_blank" rel="noreferrer">打开原网页 ↗</a><small>{item.url}</small></div><div className="source-tags">{item.platforms.map((id) => <PlatformBadge key={id} id={id} />)}</div><div className="source-number"><strong>{item.citationOccurrences || item.citationCount}</strong><small>次引用</small></div><div className="source-number"><strong>{item.prompts.length}</strong><small>个问题</small></div><time>{formatTime(item.lastSeenAt)}</time></article>)}{!sources.sources.length && <EmptyState title="还没有来源记录" description="完成带搜索的回答后，原网页会出现在这里。" />}</div></section></>;
}

function TrendsPage({ overview }) {
  if (!overview) return <EmptyState title="暂无趋势数据" description="完成监控后，这里会按时间和平台展示品牌出现率变化。" />;
  const { trend = [], platforms = [] } = overview;
  return <><PageHeader eyebrow="HISTORICAL TRENDS" title="历史趋势" description="观察品牌出现率、来源率和平台稳定性的长期变化。" actions={<select className="select compact" defaultValue="30"><option value="30">近 30 天</option><option value="90">近 90 天</option></select>} /><section className="card trend-page-card"><div className="card-heading"><div><h3>每日品牌出现率</h3><p>分母只包含成功获取回答的有效样本</p></div></div>{trend.length ? <div className="trend-table"><div className="trend-row trend-head"><span>日期</span><span>出现率</span><span>有效样本</span><span>来源率</span><span>失败</span></div>{trend.map((item) => <div className="trend-row" key={item.date}><strong>{item.date}</strong><div className="rate-bar"><span style={{ width: `${item.mentionRate || 0}%` }} /><b>{formatRate(item.mentionRate)}</b></div><span>{item.completed}</span><span>{formatRate(item.citationRate)}</span><span className={item.failures ? 'danger-text' : 'muted'}>{item.failures || '—'}</span></div>)}</div> : <EmptyState title="还没有连续数据" description="至少完成一次监控后开始记录趋势。" />}</section><section className="card platform-trend"><div className="card-heading"><div><h3>平台基线</h3><p>当前周期各平台的整体表现</p></div></div><div className="platform-baselines">{platforms.map((item) => <div key={item.platform}><PlatformBadge id={item.platform} /><div className="baseline-bar"><span style={{ width: `${item.mentionRate || 0}%` }} /></div><strong>{formatRate(item.mentionRate)}</strong><small>{item.completed} 有效样本</small></div>)}</div></section></>;
}

function ReportsPage({ overview }) {
  if (!overview) return <EmptyState title="暂无报告数据" description="完成监控后可以生成品牌可见度报告。" />;
  const { brand, summary, platforms = [], questions = [] } = overview;
  return <><PageHeader eyebrow="BRAND REPORT" title="报告中心" description="汇总品牌出现率、平台差异、问题表现和来源证据。" actions={<button className="button secondary" onClick={() => window.print()}>打印 / 导出 PDF</button>} /><section className="card report-cover"><div><div className="page-eyebrow">GEO VISIBILITY REPORT</div><h2>{brand.name} 品牌可见度报告</h2><p>统计周期：近 {summary.periodDays} 天 · 生成时间：{formatTime(new Date().toISOString())}</p></div><div className="report-score"><strong>{formatRate(summary.mentionRate)}</strong><span>品牌出现率</span></div></section><section className="metric-grid"><MetricCard label="有效样本" value={formatCount(summary.completed)} hint={`共 ${summary.totalChecks} 次检查`} /><MetricCard label="品牌提及" value={formatCount(summary.mentioned)} hint="回答中命中品牌词" tone="violet" /><MetricCard label="来源回答" value={formatCount(summary.cited)} hint={formatRate(summary.citationRate)} tone="green" /><MetricCard label="采集失败" value={formatCount(summary.failures)} hint="需人工复核" tone="orange" /></section><div className="dashboard-grid"><section className="card"><div className="card-heading"><div><h3>平台表现</h3></div></div><div className="platform-table">{platforms.map((item) => <div className="table-row" key={item.platform}><PlatformBadge id={item.platform} /><strong>{formatRate(item.mentionRate)}</strong><span>{item.completed} 样本</span><span>{formatRate(item.citationRate)} 来源率</span><span>{item.failures || '—'}</span></div>)}</div></section><section className="card"><div className="card-heading"><div><h3>重点问题</h3></div></div><div className="report-questions">{[...questions].sort((a, b) => (a.mentionRate ?? 101) - (b.mentionRate ?? 101)).slice(0, 8).map((item) => <div key={item.id}><span>{item.text}</span><strong>{formatRate(item.mentionRate)}</strong></div>)}</div></section></div></>;
}

function PlatformsPage({ platforms }) {
  return <><PageHeader eyebrow="PLATFORM ACCESS" title="平台与登录状态" description="管理五个平台的登录状态、浏览器模式和采集风险。" /><section className="platform-cards">{platforms.map((item) => <article className="card platform-card" key={item.id}><div className="platform-card-head"><PlatformBadge id={item.id} /><span className={`risk ${item.riskLevel}`}>{item.riskLevel === 'elevated' ? '风控较高' : '常规'}</span></div><div className="login-state"><span className="state-dot unknown" />登录状态待手动验证</div><dl><div><dt>默认模式</dt><dd>{item.defaultMode === 'headed' ? '有头模式' : '无头模式'}</dd></div><div><dt>入口</dt><dd>{item.entryUrl}</dd></div></dl><div className="platform-card-actions"><button className="button secondary" onClick={() => window.open(item.entryUrl, '_blank')}>打开平台</button><button className="button ghost">验证登录</button></div></article>)}</section></>;
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
  const [selectedPlatforms, setSelectedPlatforms] = useState(Object.keys(PLATFORM_META));
  const [modes, setModes] = useState(Object.fromEntries(platforms.map((item) => [
    item.id,
    item.defaultMode ?? PLATFORM_META[item.id]?.defaultMode ?? 'headless',
  ])));
  const [concurrency, setConcurrency] = useState(3);
  const [appendSearchPrompt, setAppendSearchPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
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
  return <div className="modal-backdrop">
    <div className="modal wide">
      <div className="modal-head">
        <div><div className="page-eyebrow">NEW MONITORING RUN</div><h3>发起品牌监控</h3></div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>
      <div className="wizard-summary">
        <strong>{brand.name}</strong>
        <span>{selectedQuestions.length} 个问题 × {selectedPlatforms.length} 个平台 = {selectedQuestions.length * selectedPlatforms.length} 次检查</span>
        <div className="concurrency-control">
          <span>全局并发数</span>
          <select className="select compact" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </div>
      </div>
      <div className="wizard-columns">
        <section>
          <div className="section-caption">1 / 选择监控问题 <small>{selectedQuestions.length} 已选</small></div>
          <div className="wizard-list">{enabled.map((item) => <label className="wizard-check" key={item.id}><input type="checkbox" checked={selectedQuestions.includes(item.id)} onChange={() => toggle(item.id, selectedQuestions, setSelectedQuestions)} /><span>{item.text}</span></label>)}</div>
        </section>
        <section>
          <div className="section-caption">2 / 选择平台和模式 <small>{selectedPlatforms.length} 已选</small></div>
          <div className="wizard-platforms">{platforms.map((item) => <div className={`wizard-platform ${selectedPlatforms.includes(item.id) ? 'selected' : ''}`} key={item.id}>
            <label><input type="checkbox" checked={selectedPlatforms.includes(item.id)} onChange={() => toggle(item.id, selectedPlatforms, setSelectedPlatforms)} /><PlatformBadge id={item.id} /></label>
            {selectedPlatforms.includes(item.id) && <select className="select" value={modes[item.id]} onChange={(event) => setModes((current) => ({ ...current, [item.id]: event.target.value }))}><option value="headless">无头</option><option value="headed">有头</option></select>}
          </div>)}</div>
          <label className="wizard-search-toggle">
            <input type="checkbox" checked={appendSearchPrompt} onChange={(event) => setAppendSearchPrompt(event.target.checked)} />
            <span><strong>附加搜索提示词</strong><small>提交时要求模型先搜索相关信息，再结合可靠来源回答</small></span>
          </label>
          <div className="wizard-note">全局最多同时执行 {concurrency} 项，同一平台始终只运行 1 个问题。豆包默认有头，其他平台默认无头。</div>
        </section>
      </div>
      <div className="modal-foot"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !selectedQuestions.length || !selectedPlatforms.length} onClick={submit}>{busy ? '加入队列…' : '确认并开始监控'}</button></div>
    </div>
  </div>;
}

function EvidenceDrawer({ platformRun, onClose }) {
  if (!platformRun) return null;
  const answer = platformRun.answer;
  return <div className="drawer-backdrop" onClick={onClose}><aside className="drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><PlatformBadge id={platformRun.platformId} /><h3>{platformRun.prompt?.text}</h3><p>{platformRun.mode === 'headed' ? '有头模式' : '无头模式'} · {formatTime(platformRun.createdAt)}</p></div><button className="icon-button" onClick={onClose}>×</button></div><div className="drawer-body"><div className="drawer-status"><StatusPill status={platformRun.status} />{answer && <span className={answer.brandMentioned ? 'mention-chip yes' : 'mention-chip'}>{answer.brandMentioned ? `已提及品牌 · ${answer.mentionCount} 次` : '回答未提及品牌'}</span>}</div>{platformRun.errorMessage && <div className="error-box">{platformRun.errorMessage}</div>}{answer && <><div className="evidence-section"><div className="evidence-heading"><h4>回答原文</h4>{answer.responseUrl && <a href={answer.responseUrl} target="_blank" rel="noreferrer">打开回答 ↗</a>}</div><div className="answer-content">{answer.content}</div>{answer.matchedTerms?.length ? <div className="matched-terms">命中词：{answer.matchedTerms.map((term) => <span className="tag" key={term}>{term}</span>)}</div> : null}</div><div className="evidence-section"><div className="evidence-heading"><h4>来源证据 <span>{answer.citations.length}</span></h4><span className={answer.sourcePanelOpened && (answer.platformReportedCount === null || answer.platformReportedCount === answer.citations.length) ? 'quality good' : 'quality warn'}>{answer.sourcePanelOpened ? `平台显示 ${answer.platformReportedCount ?? '—'} 篇` : '未展开来源面板'}</span></div><div className="citation-list">{answer.citations.map((citation) => <a className="citation-item" key={citation.id} href={citation.url} target="_blank" rel="noreferrer"><strong>{citation.title || citation.domain}</strong><span>{citation.domain} · {citation.citationOccurrences || 0} 次引用</span><small>{citation.url}</small></a>)}{!answer.citations.length && <p className="muted">没有抓到来源 URL。</p>}</div></div><div className="evidence-section"><div className="evidence-heading"><h4>采集证据文件</h4></div><div className="artifact-list">{answer.artifacts.map((artifact) => <a key={artifact.id} href={`/artifacts/${artifact.relativePath}`} target="_blank" rel="noreferrer">{artifact.kind === 'screenshot' ? '查看截图' : artifact.kind === 'html' ? '查看 HTML' : '查看 JSON'}</a>)}</div></div></>}</div></aside></div>;
}

function App() {
  const [route, setRoute] = useState(readRoute());
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState(null);
  const [overview, setOverview] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [sources, setSources] = useState(null);
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
  const refreshSources = useCallback(async (platformId = '') => { if (brand) setSources(await api.getBrandSources(brand.id, 30, platformId)); }, [brand]);
  const openRun = useCallback(async (runId) => { const detail = await api.getRun(runId); setActiveRun(detail); navigate('runs', runId); }, []);
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
  useEffect(() => { if (!brand) return; if (['overview', 'trends', 'reports'].includes(route.view)) refreshOverview().catch((cause) => setError(cause.message)); if (route.view === 'sources') refreshSources().catch((cause) => setError(cause.message)); }, [brand?.id, route.view]);
  useEffect(() => { if (route.runId) api.getRun(route.runId).then(setActiveRun).catch((cause) => setError(cause.message)); }, [route.runId]);
  useEffect(() => { if (!activeRun || !['queued', 'running'].includes(activeRun.status)) return undefined; const timer = setInterval(() => api.getRun(activeRun.id).then((run) => { setActiveRun(run); setRuns((items) => items.map((item) => item.id === run.id ? run : item)); if (!['queued', 'running'].includes(run.status)) refreshOverview().catch(() => undefined); }).catch(() => undefined), 2500); return () => clearInterval(timer); }, [activeRun?.id, activeRun?.status, refreshOverview]);

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
  const currentView = ['overview', 'questions', 'runs', 'sources', 'trends', 'reports', 'platforms'].includes(route.view) ? route.view : 'overview';
  const page = currentView === 'platforms' ? <PlatformsPage platforms={platforms} />
    : !brand ? <EmptyState title="先创建一个品牌" description="品牌是 GEO 监测的主体，添加品牌后再配置监控问题。" action={<button className="button primary" onClick={() => setModal('brand')}>创建品牌</button>} />
    : currentView === 'overview' ? <OverviewPage overview={overview} onNewRun={() => setModal('run')} onOpenRun={openRun} onNavigate={navigate} />
      : currentView === 'questions' ? <QuestionsPage questions={questions} onReload={reloadQuestions} onNewRun={() => setModal('run')} />
        : currentView === 'runs' ? <RunsPage runs={runs} activeRun={activeRun} onOpenRun={openRun} onCancel={cancelRun} onNewRun={() => setModal('run')} onSelectCell={setDrawerRun} />
          : currentView === 'sources' ? <SourcesPage sources={sources} onReload={refreshSources} />
              : currentView === 'trends' ? <TrendsPage overview={overview} />
                : currentView === 'reports' ? <ReportsPage overview={overview} />
                  : <OverviewPage overview={overview} onNewRun={() => setModal('run')} onOpenRun={openRun} onNavigate={navigate} />;
  return <><AppShell brands={brands} brand={brand} view={currentView} onNavigate={navigate} onSelectBrand={selectBrand} onNewBrand={() => setModal('brand')} onNewRun={() => setModal('run')}><>{error && <div className="notice">{error}<button onClick={() => setError('')}>×</button></div>}{page}</></AppShell>{modal === 'brand' && <BrandModal onClose={() => setModal(null)} onCreated={createBrand} />}{modal === 'run' && brand && <RunWizard brand={brand} questions={questions} platforms={platforms.length ? platforms : Object.keys(PLATFORM_META).map((id) => ({ id, label: platformLabel(id) }))} onClose={() => setModal(null)} onCreated={createRun} />}{drawerRun && <EvidenceDrawer platformRun={drawerRun} onClose={() => setDrawerRun(null)} />}</>;
}

createRoot(document.getElementById('root')).render(<App />);
