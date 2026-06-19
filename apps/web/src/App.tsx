import React, { useState, useEffect } from 'react';

interface KPIState {
  totalTraces: number;
  avgTraceLatencyMs: number;
  errorRate: number;
  totalCostUsd: number;
}

interface TraceSummary {
  traceId: string;
  runId: string;
  agentName: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  status: string;
  totalLatencyMs: number;
  totalCostUsd: number;
  llmCalls: number;
  toolCalls: number;
  errorCount: number;
}

interface TraceEvent {
  eventId: string;
  traceId: string;
  runId: string;
  timestamp: string;
  agentName: string;
  userId: string;
  eventType: string;
  stepIndex: number;
  status?: string;
  latencyMs?: number;
  model?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorType?: string;
  metadata: string; // DuckDB stores JSON as VARCHAR string
}

// Preset natural language query insights
const INSIGHT_PRESETS = [
  { text: 'Show average LLM latency by model over time', icon: '📈' },
  { text: 'Which tools fail the most?', icon: '🛠️' },
  { text: 'Token usage by agent type', icon: '📊' },
  { text: 'Cost per successful run by model', icon: '💰' },
  { text: 'Top 10 slowest traces', icon: '⏱️' },
  { text: 'Error rate by tool name', icon: '⚠️' },
  { text: 'Number of runs per hour', icon: '📅' },
  { text: 'Average steps per run by outcome', icon: '🚶' }
];

// Safe date parsing and formatting helper functions to prevent browser-specific unhandled RangeErrors
const parseSafeDate = (val: any): Date | null => {
  if (!val) return null;
  let str = String(val);
  // Handle space separator in SQL datetime strings (common in ClickHouse/DuckDB)
  if (str.includes(' ') && !str.includes('T')) {
    str = str.replace(' ', 'T');
  }
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
};

const formatSafeLocaleString = (val: any): string => {
  const date = parseSafeDate(val);
  return date ? date.toLocaleString() : String(val || '');
};

const formatSafeTimeString = (val: any, options?: Intl.DateTimeFormatOptions): string => {
  const date = parseSafeDate(val);
  return date ? date.toLocaleTimeString([], options) : String(val || '');
};

export default function App() {
  // Filters State
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [timeRangeFilter, setTimeRangeFilter] = useState('last_7d');

  // Database Data States
  const [kpis, setKpis] = useState<KPIState>({ totalTraces: 0, avgTraceLatencyMs: 0, errorRate: 0, totalCostUsd: 0 });
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedTraceEvents, setSelectedTraceEvents] = useState<TraceEvent[]>([]);
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null);

  // NL Query States
  const [nlInput, setNlInput] = useState('');
  const [pendingApprovalSql, setPendingApprovalSql] = useState<string | null>(null);
  const [activeChartData, setActiveChartData] = useState<any[] | null>(null);
  const [activeChartTitle, setActiveChartTitle] = useState('Total Events Stream');
  const [queryLatencyMs, setQueryLatencyMs] = useState<number | null>(null);
  const [querySql, setQuerySql] = useState<string | null>(null);
  const [baseSql, setBaseSql] = useState<string | null>(null);
  
  // Dynamic filter options states
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [timelineFilter, setTimelineFilter] = useState<{ startTime: string; endTime: string; label: string } | null>(null);

  // Loading & Error States
  const [isLoading, setIsLoading] = useState(false);
  const [isLlmMissing, setIsLlmMissing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSqlExpanded, setIsSqlExpanded] = useState(false);

  // Initialize: load default analytics data and active default chart
  useEffect(() => {
    fetchDashboardData();
    if (baseSql) {
      refreshActiveQuery(baseSql);
    } else {
      // Set default chart to total runs
      handlePresetClick('Number of runs per hour');
    }
  }, [agentFilter, statusFilter, modelFilter, toolFilter, timeRangeFilter, timelineFilter]);

  const fetchMetadata = async () => {
    try {
      const res = await fetch('/api/meta');
      if (res.ok) {
        const json = await res.json();
        setAvailableAgents(json.data.agents || []);
        setAvailableModels(json.data.models || []);
        setAvailableTools(json.data.tools || []);
      }
    } catch (err) {
      console.error('Error fetching metadata:', err);
    }
  };

  const fetchTraces = async (chartDataOverride?: any[]) => {
    try {
      const q = new URLSearchParams();
      if (agentFilter) q.set('agentName', agentFilter);
      if (statusFilter) q.set('status', statusFilter);
      if (modelFilter) q.set('model', modelFilter);
      if (toolFilter) q.set('toolName', toolFilter);
      if (timeRangeFilter) q.set('timeRange', timeRangeFilter);
      if (timelineFilter) {
        q.set('startTime', timelineFilter.startTime);
        q.set('endTime', timelineFilter.endTime);
      }

      // Check if we have trace IDs from active chart data to display specifically
      const currentChartData = chartDataOverride !== undefined ? chartDataOverride : activeChartData;
      if (currentChartData && currentChartData.length > 0) {
        const firstRow = currentChartData[0];
        const traceIdKey = Object.keys(firstRow).find(k => k.toLowerCase() === 'traceid' || k.toLowerCase() === 'trace_id');
        if (traceIdKey) {
          const ids = currentChartData.map(row => String(row[traceIdKey])).filter(Boolean);
          if (ids.length > 0) {
            q.set('traceIds', ids.join(','));
          }
        }
      }

      const traceRes = await fetch(`/api/traces?${q.toString()}`);
      if (traceRes.ok) {
        const res = await traceRes.json();
        setTraces(res.data || []);
      }
    } catch (err) {
      console.error('Error fetching traces:', err);
    }
  };

  const fetchDashboardData = async (chartDataOverride?: any[]) => {
    try {
      // Refresh metadata options dynamically
      fetchMetadata();

      const q = new URLSearchParams();
      if (agentFilter) q.set('agentName', agentFilter);
      if (statusFilter) q.set('status', statusFilter);
      if (modelFilter) q.set('model', modelFilter);
      if (toolFilter) q.set('toolName', toolFilter);
      if (timeRangeFilter) q.set('timeRange', timeRangeFilter);
      if (timelineFilter) {
        q.set('startTime', timelineFilter.startTime);
        q.set('endTime', timelineFilter.endTime);
      }

      const kpiRes = await fetch(`/api/kpis?${q.toString()}`);
      if (kpiRes.ok) {
        const res = await kpiRes.json();
        setKpis(res.data || { totalTraces: 0, avgTraceLatencyMs: 0, errorRate: 0, totalCostUsd: 0 });
      }

      fetchTraces(chartDataOverride);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    }
  };

  const refreshActiveQuery = async (sql: string) => {
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/query/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql,
          filters: {
            agentName: agentFilter || undefined,
            status: statusFilter || undefined,
            model: modelFilter || undefined,
            toolName: toolFilter || undefined,
            timeRange: timeRangeFilter || undefined,
            startTime: timelineFilter?.startTime || undefined,
            endTime: timelineFilter?.endTime || undefined
          }
        })
      });
      const data = await res.json();
      if (res.ok) {
        setActiveChartData(data.data);
        setQueryLatencyMs(data.latencyMs);
        setQuerySql(data.sql);
        // Force refresh traces using the query output
        fetchTraces(data.data);
      } else {
        setErrorMsg(data.error || 'Failed to refresh chart query.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Connection failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTraceClick = async (traceId: string) => {
    setSelectedTraceId(traceId);
    setActiveStepIndex(null);
    try {
      const res = await fetch(`/api/traces/${traceId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedTraceEvents(data.data || []);
      }
    } catch (err) {
      console.error('Error fetching trace details:', err);
    }
  };

  const handleNlSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!nlInput.trim()) return;

    setIsLoading(true);
    setErrorMsg(null);
    setIsLlmMissing(false);
    setPendingApprovalSql(null);

    try {
      const res = await fetch('/api/query/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: nlInput })
      });

      const data = await res.json();
      if (res.ok) {
        setPendingApprovalSql(data.sql);
        setActiveChartTitle(nlInput);
      } else {
        if (data.isLlmMissing) {
          setIsLlmMissing(true);
        } else {
          setErrorMsg(data.reason || data.error || 'Failed to translate query.');
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Network connection failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApproveSql = async () => {
    if (!pendingApprovalSql) return;
    setIsLoading(true);
    setErrorMsg(null);

    try {
      setBaseSql(pendingApprovalSql);
      const res = await fetch('/api/query/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: pendingApprovalSql,
          filters: {
            agentName: agentFilter || undefined,
            status: statusFilter || undefined,
            model: modelFilter || undefined,
            toolName: toolFilter || undefined,
            timeRange: timeRangeFilter || undefined
          }
        })
      });

      const data = await res.json();
      if (res.ok) {
        setActiveChartData(data.data);
        setQueryLatencyMs(data.latencyMs);
        setQuerySql(data.sql);
        setPendingApprovalSql(null);
        // Refresh metrics cards in case database was updated, passing new chart data
        fetchDashboardData(data.data);
      } else {
        setErrorMsg(data.error || data.details || 'SQL Execution failed.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Execution error.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePresetClick = async (presetText: string) => {
    setNlInput(presetText);
    setIsLoading(true);
    setErrorMsg(null);
    setIsLlmMissing(false);
    setPendingApprovalSql(null);

    try {
      // 1. Get translation (usually instant deterministic match)
      const res = await fetch('/api/query/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: presetText })
      });
      const data = await res.json();
      if (res.ok) {
        setActiveChartTitle(presetText);
        setBaseSql(data.sql);
        // 2. Curated presets are automatically pre-approved and run directly
        const runRes = await fetch('/api/query/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: data.sql,
            filters: {
              agentName: agentFilter || undefined,
              status: statusFilter || undefined,
              model: modelFilter || undefined,
              toolName: toolFilter || undefined,
              timeRange: timeRangeFilter || undefined,
              startTime: timelineFilter?.startTime || undefined,
              endTime: timelineFilter?.endTime || undefined
            }
          })
        });
        const runData = await runRes.json();
        if (runRes.ok) {
          setActiveChartData(runData.data);
          setQueryLatencyMs(runData.latencyMs);
          setQuerySql(runData.sql);
          // Refresh metrics cards and trace lists using the new preset output
          fetchDashboardData(runData.data);
        } else {
          setErrorMsg(runData.error || 'Failed to run preset query.');
        }
      } else {
        setErrorMsg(data.error || 'Failed to parse preset query.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Connection failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTriggerSimulator = async (mode: 'demo' | 'benchmark') => {
    setIsLoading(true);
    try {
      // Trigger API endpoints that call simulator or direct fetch
      // For local prototype simulator, we can notify that the simulator should be run in shell,
      // or we can invoke the simulator if the API server exposed a trigger (we kept simulator decoupled).
      // Let's print instructions to run it in the terminal or offer a simple mock trigger:
      alert(`To generate events, please run in your terminal:\n\nnpm run simulate:${mode}`);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar Filters */}
      <aside className="sidebar">
        <div className="logo-container">
          <span className="logo-icon">🔮</span>
          <span className="logo-text">Agent Analytics</span>
        </div>

        <div className="filter-group" style={{ marginTop: '20px' }}>
          <button className="nl-btn" style={{ padding: '12px', fontSize: '14px' }} onClick={() => handleTriggerSimulator('demo')}>
            ⚡ Run Simulator (Demo)
          </button>
        </div>

        <div className="sidebar-section-title">Time Range</div>
        <select 
          className="filter-select" 
          value={timeRangeFilter} 
          onChange={(e) => setTimeRangeFilter(e.target.value)}
        >
          <option value="last_hour">Last Hour</option>
          <option value="last_24h">Last 24 Hours</option>
          <option value="last_7d">Last 7 Days</option>
          <option value="">All Time</option>
        </select>

        <div className="sidebar-section-title">Filters</div>
        
        <div className="filter-group">
          <label className="filter-label">Agent Name</label>
          <select 
            className="filter-select" 
            value={agentFilter} 
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="">All Agents</option>
            {availableAgents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label">LLM Model</label>
          <select 
            className="filter-select" 
            value={modelFilter} 
            onChange={(e) => setModelFilter(e.target.value)}
          >
            <option value="">All Models</option>
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label">Tool Used</label>
          <select 
            className="filter-select" 
            value={toolFilter} 
            onChange={(e) => setToolFilter(e.target.value)}
          >
            <option value="">All Tools</option>
            {availableTools.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label className="filter-label">Trace Status</label>
          <select 
            className="filter-select" 
            value={statusFilter} 
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
          </select>
        </div>
      </aside>

      {/* Main Panel */}
      <main className="main-content">
        <header className="main-header">
          <div className="main-title-container">
            <h1 className="main-title">OLAP Dashboard</h1>
            <p className="main-subtitle">Durable analytics engine powered by DuckDB & columnar event storage</p>
          </div>
          <div>
            <span className="status-badge status-success">
              ● Connected to db.duckdb
            </span>
          </div>
        </header>

        {/* Active Filters Summary Bar */}
        {(agentFilter || statusFilter || modelFilter || toolFilter || timelineFilter) && (
          <div className="active-filters-bar">
            <span className="active-filters-title">Active Filters:</span>
            {timelineFilter && (
              <span className="filter-badge time">
                📅 Time: {timelineFilter.label}
                <button className="filter-badge-clear" onClick={() => setTimelineFilter(null)}>×</button>
              </span>
            )}
            {agentFilter && (
              <span className="filter-badge">
                🤖 Agent: {agentFilter}
                <button className="filter-badge-clear" onClick={() => setAgentFilter('')}>×</button>
              </span>
            )}
            {statusFilter && (
              <span className="filter-badge">
                🟢 Status: {statusFilter}
                <button className="filter-badge-clear" onClick={() => setStatusFilter('')}>×</button>
              </span>
            )}
            {modelFilter && (
              <span className="filter-badge">
                🧠 Model: {modelFilter}
                <button className="filter-badge-clear" onClick={() => setModelFilter('')}>×</button>
              </span>
            )}
            {toolFilter && (
              <span className="filter-badge">
                🛠️ Tool: {toolFilter}
                <button className="filter-badge-clear" onClick={() => setToolFilter('')}>×</button>
              </span>
            )}
            <button 
              className="btn-secondary" 
              style={{ padding: '4px 8px', fontSize: '11px', marginLeft: 'auto', borderRadius: '6px' }}
              onClick={() => {
                setAgentFilter('');
                setStatusFilter('');
                setModelFilter('');
                setToolFilter('');
                setTimelineFilter(null);
              }}
            >
              Clear All
            </button>
          </div>
        )}

        {/* KPI metrics cards */}
        <section className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-header">
              <span className="kpi-title">Total Agent Traces</span>
              <span className="kpi-icon">🔄</span>
            </div>
            <div className="kpi-value">{kpis.totalTraces.toLocaleString()}</div>
            <div className="kpi-footer">Completed runs database volume</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-header">
              <span className="kpi-title">Avg Latency per Run</span>
              <span className="kpi-icon">⏱️</span>
            </div>
            <div className="kpi-value">
              {kpis.avgTraceLatencyMs ? `${(kpis.avgTraceLatencyMs / 1000).toFixed(2)}s` : '0.00s'}
            </div>
            <div className="kpi-footer">Mean end-to-end trace latency</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-header">
              <span className="kpi-title">Error Rate</span>
              <span className="kpi-icon">⚠️</span>
            </div>
            <div className="kpi-value" style={{ color: kpis.errorRate > 15 ? 'var(--color-error)' : 'var(--text-primary)' }}>
              {kpis.errorRate ? `${kpis.errorRate.toFixed(1)}%` : '0.0%'}
            </div>
            <div className="kpi-footer">Percentage of traces containing errors</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-header">
              <span className="kpi-title">Total Cost</span>
              <span className="kpi-icon">💰</span>
            </div>
            <div className="kpi-value" style={{ color: 'var(--color-success)' }}>
              ${kpis.totalCostUsd ? kpis.totalCostUsd.toFixed(4) : '0.0000'}
            </div>
            <div className="kpi-footer">Aggregated LLM pricing in USD</div>
          </div>
        </section>

        {/* NL Query bar card */}
        <section className="nl-card">
          <div className="main-title-container">
            <h2 style={{ fontSize: '18px', fontWeight: '700', fontFamily: 'var(--font-display)' }}>🔮 Ask Analytics Engine</h2>
            <p className="main-subtitle">Search with natural language to generate immediate charts and parameterized SQL</p>
          </div>

          <form onSubmit={handleNlSubmit} className="nl-input-container">
            <input 
              type="text" 
              className="nl-input" 
              placeholder="e.g. show average LLM latency by model over time..." 
              value={nlInput}
              onChange={(e) => setNlInput(e.target.value)}
              disabled={isLoading}
            />
            <button type="submit" className="nl-btn" disabled={isLoading}>
              {isLoading ? 'Translating...' : 'Ask Gemini'}
            </button>
          </form>

          {/* Caches / Errors / SQL approval overlay */}
          {isLlmMissing && (
            <div style={{ padding: '16px', background: 'rgba(245,158,11,0.1)', border: '1px solid var(--color-warning)', borderRadius: '8px', color: 'var(--color-warning)', fontSize: '14px' }}>
              ⚠️ <strong>Gemini API Key Missing:</strong> The backend is running in offline mode. Please configure <code>GEMINI_API_KEY</code> to enable dynamic natural language translation. In the meantime, you can click on any of the <strong>Curated Insights</strong> below to run pre-compiled queries.
            </div>
          )}

          {errorMsg && (
            <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--color-error)', borderRadius: '8px', color: 'var(--color-error)', fontSize: '14px' }}>
              ❌ <strong>Error:</strong> {errorMsg}
            </div>
          )}

          {pendingApprovalSql && (
            <div className="approval-card">
              <div className="approval-header">
                <span className="approval-title">🛡️ Verify Generated SQL Before Running</span>
                <span className="status-badge" style={{ background: 'rgba(139,92,246,0.1)', color: 'var(--color-primary-light)' }}>
                  Translated via Gemini 2.5 Flash
                </span>
              </div>
              <div className="sql-container">{pendingApprovalSql}</div>
              <div className="approval-actions">
                <button className="btn-secondary" onClick={() => setPendingApprovalSql(null)}>Discard</button>
                <button className="btn-approve" onClick={handleApproveSql}>Approve & Run Query</button>
              </div>
            </div>
          )}
        </section>

        {/* Curated Insights Presets */}
        <section className="filter-group">
          <div className="sidebar-section-title" style={{ marginTop: '0', marginBottom: '8px' }}>Curated Insights Presets</div>
          <div className="insights-grid">
            {INSIGHT_PRESETS.map((preset, idx) => (
              <div key={idx} className="insight-preset-card" onClick={() => handlePresetClick(preset.text)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '18px' }}>{preset.icon}</span>
                  <span className="insight-preset-text">{preset.text}</span>
                </div>
                <span className="insight-preset-arrow">→</span>
              </div>
            ))}
          </div>
        </section>

        {/* Chart View */}
        {activeChartData && (
          <section className="chart-card">
            <div className="chart-card-header">
              <h3 className="chart-card-title">🔮 Chart Output: {activeChartTitle}</h3>
              <span className="status-badge status-success" style={{ fontSize: '11px' }}>
                Columnar aggregation
              </span>
            </div>

            <div className="chart-canvas">
              <SVGChart data={activeChartData} onPointClick={(clickEvent) => {
                if (clickEvent.type === 'category') {
                  const label = clickEvent.category;
                  if (availableAgents.includes(label)) {
                    setAgentFilter(label);
                  } else if (availableModels.includes(label)) {
                    setModelFilter(label);
                  } else if (availableTools.includes(label)) {
                    setToolFilter(label);
                  } else if (label === 'success' || label === 'failed' || label === 'running') {
                    setStatusFilter(label);
                  }
                } else if (clickEvent.type === 'time') {
                  setTimelineFilter({
                    startTime: clickEvent.startTime,
                    endTime: clickEvent.endTime,
                    label: clickEvent.label
                  });
                }
              }} />
            </div>

            {/* Collapsible SQL Visualizer */}
            {querySql && (
              <div className="sql-visualizer">
                <div className="visualizer-header" onClick={() => setIsSqlExpanded(!isSqlExpanded)}>
                  <div className="visualizer-title">
                    <span>{isSqlExpanded ? '▼' : '▶'}</span>
                    <span>Executed SQL Statement</span>
                  </div>
                  <span className="visualizer-latency">
                    DuckDB compiled & scanned in <strong>{queryLatencyMs}ms</strong> {queryLatencyMs !== null && queryLatencyMs < 15 ? '🚀' : ''}
                  </span>
                </div>
                {isSqlExpanded && (
                  <div className="sql-container" style={{ marginTop: '12px', color: '#818CF8' }}>
                    {querySql}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Trace Explorer Table */}
        <section className="explorer-card">
          <div className="chart-card-header">
            <h3 className="chart-card-title">🕵️ Trace Explorer</h3>
            <span className="main-subtitle">Click row to open chronological Timeline</span>
          </div>

          <div className="table-wrapper">
            <table className="explorer-table">
              <thead>
                <tr>
                  <th>Agent Name</th>
                  <th>User ID</th>
                  <th>Started At</th>
                  <th>Status</th>
                  <th>Steps</th>
                  <th>Latency</th>
                  <th>LLM Cost</th>
                </tr>
              </thead>
              <tbody>
                {traces.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                      No traces found in database. Run the agent simulator to generate trace events!
                    </td>
                  </tr>
                ) : (
                  traces.map((t) => (
                    <tr key={t.traceId} onClick={() => handleTraceClick(t.traceId)} style={{ background: selectedTraceId === t.traceId ? 'rgba(139, 92, 246, 0.08)' : '' }}>
                      <td style={{ fontWeight: '600' }}>{t.agentName}</td>
                      <td>{t.userId}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{formatSafeLocaleString(t.startedAt)}</td>
                      <td>
                        <span className={`status-badge status-${t.status}`}>
                          {t.status}
                        </span>
                      </td>
                      <td>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {t.llmCalls + t.toolCalls + t.errorCount} steps ({t.llmCalls} LLM, {t.toolCalls} Tool)
                        </span>
                      </td>
                      <td>{(t.totalLatencyMs / 1000).toFixed(2)}s</td>
                      <td style={{ color: 'var(--color-success)', fontWeight: '500' }}>
                        ${t.totalCostUsd ? t.totalCostUsd.toFixed(4) : '0.0000'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Trace step timeline overlay panel */}
      {selectedTraceId && (
        <div className="timeline-panel">
          <div className="timeline-header">
            <div className="main-title-container">
              <h3 className="timeline-title">Trace Details</h3>
              <p className="main-subtitle" style={{ fontSize: '12px' }}>ID: {selectedTraceId}</p>
            </div>
            <button className="timeline-close" onClick={() => setSelectedTraceId(null)}>×</button>
          </div>
          <div className="timeline-body">
            {(() => {
              const sortedEvents = [...selectedTraceEvents].sort((a, b) => a.stepIndex - b.stepIndex);
              const firstDate = sortedEvents.length > 0 ? parseSafeDate(sortedEvents[0].timestamp) : null;
              const startTime = firstDate ? firstDate.getTime() : 0;
              let runningCost = 0;
              let runningTokens = 0;
              let runningInputTokens = 0;
              let runningOutputTokens = 0;
              
              const enrichedEvents: EnrichedTraceEvent[] = sortedEvents.map((evt) => {
                if (evt.costUsd) {
                  runningCost += evt.costUsd;
                }
                const tokens = (evt.inputTokens || 0) + (evt.outputTokens || 0);
                runningTokens += tokens;
                runningInputTokens += evt.inputTokens || 0;
                runningOutputTokens += evt.outputTokens || 0;

                const evtDate = parseSafeDate(evt.timestamp);
                const elapsedMs = startTime && evtDate ? evtDate.getTime() - startTime : 0;
                let throughput = 0;
                if (evt.eventType === 'llm_call' && evt.latencyMs) {
                  throughput = tokens / (evt.latencyMs / 1000);
                }
                return {
                  ...evt,
                  accumulatedCost: runningCost,
                  elapsedMs,
                  throughput,
                  accumulatedTokens: runningTokens,
                  accumulatedInputTokens: runningInputTokens,
                  accumulatedOutputTokens: runningOutputTokens
                };
              });

              // Trace overall statistics
              const lastEvent = enrichedEvents[enrichedEvents.length - 1];
              const lastDate = lastEvent ? parseSafeDate(lastEvent.timestamp) : null;
              const totalDurationSec = startTime && lastDate ? (lastDate.getTime() - startTime) / 1000 : 0;
              const totalCost = runningCost;
              const totalTokens = runningTokens;
              const totalInputTokens = runningInputTokens;
              const totalOutputTokens = runningOutputTokens;
              
              const llmCalls = enrichedEvents.filter(e => e.eventType === 'llm_call');
              const toolCalls = enrichedEvents.filter(e => e.eventType === 'tool_call');
              const errorCount = enrichedEvents.filter(e => e.eventType === 'error').length;
              const retryCount = enrichedEvents.filter(e => e.eventType === 'retry').length;
              
              const avgLlmLatencyMs = llmCalls.length > 0 
                ? llmCalls.reduce((sum, e) => sum + (e.latencyMs || 0), 0) / llmCalls.length 
                : 0;
              const avgLlmThroughput = llmCalls.length > 0
                ? llmCalls.reduce((sum, e) => sum + (e.throughput || 0), 0) / llmCalls.length
                : 0;

              return (
                <>
                  {/* Trace Summary Card */}
                  <div className="trace-summary-card">
                    <div className="trace-summary-metric">
                      <span className="trace-summary-label">Total Duration</span>
                      <span className="trace-summary-value">{totalDurationSec.toFixed(2)}s</span>
                      <span className="trace-summary-subvalue">Start-to-end time</span>
                    </div>
                    <div className="trace-summary-metric">
                      <span className="trace-summary-label">Total Cost</span>
                      <span className="trace-summary-value" style={{ color: 'var(--color-success)' }}>${totalCost.toFixed(4)}</span>
                      <span className="trace-summary-subvalue">Cumulative USD</span>
                    </div>
                    <div className="trace-summary-metric">
                      <span className="trace-summary-label">Token Usage</span>
                      <span className="trace-summary-value">{totalTokens.toLocaleString()} t</span>
                      <span className="trace-summary-subvalue">{totalInputTokens.toLocaleString()} in / {totalOutputTokens.toLocaleString()} out</span>
                    </div>
                    <div className="trace-summary-metric">
                      <span className="trace-summary-label">Execution Steps</span>
                      <span className="trace-summary-value">{enrichedEvents.length} steps</span>
                      <span className="trace-summary-subvalue">
                        {llmCalls.length} LLM | {toolCalls.length} Tool {errorCount > 0 ? `| ${errorCount} Err` : ''} {retryCount > 0 ? `| ${retryCount} Ret` : ''}
                      </span>
                    </div>
                    {llmCalls.length > 0 && (
                      <div className="trace-summary-metric">
                        <span className="trace-summary-label">LLM Avg Speed</span>
                        <span className="trace-summary-value">{avgLlmThroughput.toFixed(1)} t/s</span>
                        <span className="trace-summary-subvalue">{(avgLlmLatencyMs / 1000).toFixed(2)}s avg latency</span>
                      </div>
                    )}
                  </div>

                  {/* Horizontal Workflow DAG View */}
                  <SVGWorkflowDAG
                    events={enrichedEvents}
                    activeStepIndex={activeStepIndex}
                    onStepClick={(stepIndex) => {
                      setActiveStepIndex(stepIndex);
                      document.getElementById(`step-${stepIndex}`)?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'nearest'
                      });
                    }}
                  />

                  <div className="timeline-steps">
                    {enrichedEvents.map((evt) => (
                      <TraceStepCard
                        key={evt.eventId}
                        evt={evt}
                        isActive={activeStepIndex === evt.stepIndex}
                        onCardClick={() => setActiveStepIndex(evt.stepIndex)}
                      />
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// Adaptive SVG Chart component to render queries dynamically
function SVGChart({ data, onPointClick }: { data: any[]; onPointClick: (clickEvent: any) => void }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ display: 'flex', height: '100%', width: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        No chart data returned.
      </div>
    );
  }

  // Get headers from first row
  const keys = Object.keys(data[0]);

  // Determine chart type
  // If there's an hour or timestamp column, draw a Line/Area Chart
  const timeKey = keys.find(k => k.toLowerCase().includes('hour') || k.toLowerCase().includes('time') || k.toLowerCase().includes('date') || k.toLowerCase().includes('timestamp'));
  const valueKeys = keys.filter(k => k !== timeKey && typeof data[0][k] === 'number');

  if (timeKey && valueKeys.length > 0) {
    return <SVGLineChart data={data} timeKey={timeKey} valKey={valueKeys[0]} onPointClick={onPointClick} />;
  }

  // Otherwise draw a Bar Chart
  const catKey = keys.find(k => typeof data[0][k] === 'string');
  const numKey = keys.find(k => typeof data[0][k] === 'number');

  if (catKey && numKey) {
    return <SVGBarChart data={data} catKey={catKey} valKey={numKey} onPointClick={onPointClick} />;
  }

  // Fallback to simple table view
  return (
    <div className="table-wrapper" style={{ maxHeight: '250px', overflowY: 'auto' }}>
      <table className="explorer-table">
        <thead>
          <tr>
            {keys.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => <td key={k}>{String(row[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 1. Line/Area Chart component using raw SVG
function SVGLineChart({ data, timeKey, valKey, onPointClick }: { data: any[]; timeKey: string; valKey: string; onPointClick: (clickEvent: any) => void }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const width = 800;
  const height = 240;
  const paddingLeft = 60;
  const paddingRight = 30;
  const paddingTop = 20;
  const paddingBottom = 40;

  // Extract and parse coordinates
  const points = data.map((d) => ({
    xLabel: formatSafeTimeString(d[timeKey], { hour: '2-digit', minute: '2-digit' }),
    val: Number(d[valKey]) || 0
  }));

  const maxVal = Math.max(...points.map(p => p.val), 1) * 1.1; // 10% headroom
  const minVal = 0;

  // Compute SVG positions
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const getX = (index: number) => paddingLeft + (index / (points.length - 1 || 1)) * plotWidth;
  const getY = (val: number) => paddingTop + plotHeight - ((val - minVal) / (maxVal - minVal)) * plotHeight;

  // Build path coordinates
  const linePoints = points.map((p, i) => `${getX(i)},${getY(p.val)}`).join(' ');
  const areaPoints = points.length > 0 
    ? `${getX(0)},${paddingTop + plotHeight} ${linePoints} ${getX(points.length - 1)},${paddingTop + plotHeight}`
    : '';

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
          const y = paddingTop + ratio * plotHeight;
          const labelVal = maxVal - ratio * (maxVal - minVal);
          return (
            <g key={idx}>
              <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="rgba(255,255,255,0.05)" strokeDasharray="3" />
              <text x={paddingLeft - 10} y={y + 4} fill="var(--text-muted)" fontSize="10" textAnchor="end">
                {labelVal >= 1000 ? `${(labelVal / 1000).toFixed(1)}k` : labelVal.toFixed(1)}
              </text>
            </g>
          );
        })}

        {/* X axis labels (limited to max 6 labels for readability) */}
        {points.map((p, i) => {
          if (points.length > 6 && i % Math.floor(points.length / 5) !== 0 && i !== points.length - 1) return null;
          const x = getX(i);
          return (
            <text key={i} x={x} y={height - 15} fill="var(--text-secondary)" fontSize="10" textAnchor="middle">
              {p.xLabel}
            </text>
          );
        })}

        {/* Area fill */}
        {areaPoints && <polygon points={areaPoints} fill="url(#chartGradient)" />}

        {/* Line stroke */}
        {linePoints && <polyline points={linePoints} fill="none" stroke="var(--color-primary)" strokeWidth="2.5" />}

        {/* Data points */}
        {points.map((p, i) => (
          <circle key={i} cx={getX(i)} cy={getY(p.val)} r="4" fill="var(--bg-main)" stroke="var(--color-primary-light)" strokeWidth="2" />
        ))}

        {/* Hover elements */}
        {hoveredIdx !== null && (
          <g>
            <line
              x1={getX(hoveredIdx)}
              y1={paddingTop}
              x2={getX(hoveredIdx)}
              y2={paddingTop + plotHeight}
              className="chart-hover-line"
            />
            <circle
              cx={getX(hoveredIdx)}
              cy={getY(points[hoveredIdx].val)}
              r="6"
              fill="var(--color-primary)"
              className="chart-hover-dot"
            />
            {(() => {
              const dotY = getY(points[hoveredIdx].val);
              const tooltipY = dotY < 60 ? dotY + 15 : dotY - 50;
              const tooltipX = getX(hoveredIdx) + (hoveredIdx > points.length / 2 ? -130 : 10);
              return (
                <g transform={`translate(${tooltipX}, ${tooltipY})`} style={{ pointerEvents: 'none' }}>
                  <rect x="0" y="0" width="120" height="42" rx="6" className="chart-tooltip-bg" />
                  <text x="10" y="18" fill="var(--text-secondary)" fontSize="9" fontWeight="500">
                    {points[hoveredIdx].xLabel}
                  </text>
                  <text x="10" y="32" fill="var(--text-primary)" fontSize="11" fontWeight="700">
                    {points[hoveredIdx].val >= 1000 ? points[hoveredIdx].val.toLocaleString() : points[hoveredIdx].val.toFixed(2)}
                  </text>
                </g>
              );
            })()}
          </g>
        )}

        {/* Slice triggers for hover detection */}
        {points.map((_, i) => {
          const sliceWidth = plotWidth / (points.length || 1);
          const x = getX(i) - sliceWidth / 2;
          return (
            <rect
              key={i}
              x={x}
              y={paddingTop}
              width={sliceWidth}
              height={plotHeight}
              className="chart-slice-trigger"
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={() => {
                const item = data[i];
                const date = parseSafeDate(item[timeKey]);
                if (!date) return;
                const startTime = date.toISOString();
                const endTime = new Date(date.getTime() + 60 * 60 * 1000).toISOString();
                onPointClick({
                  type: 'time',
                  startTime,
                  endTime,
                  label: date.toLocaleString()
                });
              }}
            />
          );
        })}
      </svg>
    </div>
  );
}

// 2. Bar Chart component using raw SVG
function SVGBarChart({ data, catKey, valKey, onPointClick }: { data: any[]; catKey: string; valKey: string; onPointClick: (clickEvent: any) => void }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const width = 800;
  const height = 240;
  const paddingLeft = 80;
  const paddingRight = 30;
  const paddingTop = 20;
  const paddingBottom = 40;

  // Parse items
  const items = data.map((d) => ({
    label: String(d[catKey]) || 'Unknown',
    val: Number(d[valKey]) || 0
  })).slice(0, 10); // Limit to top 10

  const maxVal = Math.max(...items.map(p => p.val), 1) * 1.1;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const barWidth = Math.min(45, (plotWidth / items.length) * 0.6);
  const gap = (plotWidth - barWidth * items.length) / (items.length - 1 || 1);

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ overflow: 'visible' }}>
        {/* Y Axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
          const y = paddingTop + ratio * plotHeight;
          const labelVal = maxVal - ratio * maxVal;
          return (
            <g key={idx}>
              <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="rgba(255,255,255,0.05)" />
              <text x={paddingLeft - 10} y={y + 4} fill="var(--text-muted)" fontSize="10" textAnchor="end">
                {labelVal >= 1000 ? `${(labelVal / 1000).toFixed(1)}k` : labelVal.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {items.map((item, i) => {
          const x = paddingLeft + i * (barWidth + gap);
          const barHeight = (item.val / maxVal) * plotHeight;
          const y = paddingTop + plotHeight - barHeight;
          const isHovered = hoveredIdx === i;

          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                onPointClick({
                  type: 'category',
                  category: item.label,
                  value: item.val
                });
              }}
            >
              {/* Bar rectangle */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx="4"
                style={{
                  fill: isHovered ? 'var(--color-primary-light)' : 'var(--color-primary)',
                  opacity: hoveredIdx !== null && !isHovered ? 0.5 : 1,
                  transition: 'all 0.15s ease'
                }}
              />

              {/* Bar value label (always visible, highlight on hover) */}
              <text
                x={x + barWidth / 2}
                y={y - 6}
                fill={isHovered ? 'var(--color-primary-light)' : 'var(--text-primary)'}
                fontSize="10"
                fontWeight="600"
                textAnchor="middle"
                style={{ transition: 'fill 0.15s ease' }}
              >
                {item.val >= 1000 ? `${(item.val / 1000).toFixed(1)}k` : item.val.toFixed(2)}
              </text>

              {/* Categorical label on X Axis */}
              <text x={x + barWidth / 2} y={height - 15} fill="var(--text-secondary)" fontSize="10" textAnchor="middle">
                {item.label.length > 12 ? `${item.label.substring(0, 10)}...` : item.label}
              </text>

              {/* Hover Tooltip overlay */}
              {isHovered && (
                <g transform={`translate(${x + barWidth / 2 - 60}, ${y < 40 ? y + 10 : y - 38})`} style={{ pointerEvents: 'none' }}>
                  <rect x="0" y="0" width="120" height="28" rx="4" className="chart-tooltip-bg" />
                  <text x="60" y="17" fill="var(--text-primary)" fontSize="9" fontWeight="700" textAnchor="middle">
                    {item.val.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// 3. Temporal-style Workflow DAG Execution Path
interface EnrichedTraceEvent extends TraceEvent {
  accumulatedCost: number;
  elapsedMs: number;
  throughput: number;
  accumulatedTokens: number;
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
}

interface SVGWorkflowDAGProps {
  events: EnrichedTraceEvent[];
  activeStepIndex: number | null;
  onStepClick: (stepIndex: number) => void;
}

function SVGWorkflowDAG({ events, activeStepIndex, onStepClick }: SVGWorkflowDAGProps) {
  if (!events || events.length === 0) return null;

  return (
    <div className="workflow-dag-section">
      <h4 className="sidebar-section-title" style={{ marginTop: 0, marginBottom: '6px' }}>⚡ Execution Workflow Path</h4>
      <div className="dag-scroll-container">
        {events.map((evt, idx) => {
          const isSelected = activeStepIndex === evt.stepIndex;
          let nodeClass = '';
          let icon = '⚙️';
          let title = evt.eventType;
          let meta = `step ${evt.stepIndex}`;
          
          const metadataObj = evt.metadata ? JSON.parse(evt.metadata) : {};

          if (evt.eventType === 'trace_started') {
            nodeClass = 'start';
            icon = '▶️';
            title = 'Start';
            meta = evt.agentName;
          } else if (evt.eventType === 'trace_completed') {
            nodeClass = evt.status === 'success' ? 'end-success' : 'end-failed';
            icon = evt.status === 'success' ? '🏁' : '❌';
            title = evt.status === 'success' ? 'Completed' : 'Failed';
            
            const elapsedStr = `+${(evt.elapsedMs / 1000).toFixed(1)}s`;
            const tokenStr = evt.accumulatedTokens ? `${evt.accumulatedTokens}t` : '';
            const costStr = `$${evt.accumulatedCost.toFixed(4)}`;
            meta = `${elapsedStr} | ${tokenStr} | ${costStr}`;
          } else if (evt.eventType === 'llm_call') {
            nodeClass = 'llm';
            icon = '🤖';
            title = evt.model || 'LLM';
            
            const totalTokens = (evt.inputTokens || 0) + (evt.outputTokens || 0);
            const tokenStr = totalTokens > 0 ? `${totalTokens}t` : '';
            const costStr = evt.costUsd ? `$${evt.costUsd.toFixed(4)}` : '';
            const throughputStr = evt.throughput > 0 ? `${evt.throughput.toFixed(0)}t/s` : '';
            const parts = [`+${(evt.latencyMs ? evt.latencyMs / 1000 : 0).toFixed(1)}s`];
            if (tokenStr) parts.push(tokenStr);
            if (throughputStr) parts.push(throughputStr);
            if (costStr) parts.push(costStr);
            meta = parts.join(' | ');
          } else if (evt.eventType === 'tool_call') {
            nodeClass = 'tool';
            icon = '🛠️';
            title = evt.toolName || 'Tool';
            
            const latencyStr = `+${(evt.latencyMs ? evt.latencyMs / 1000 : 0).toFixed(1)}s`;
            const statusStr = evt.status || 'success';
            const costStr = evt.costUsd ? ` | $${evt.costUsd.toFixed(4)}` : '';
            meta = `${latencyStr} | ${statusStr}${costStr}`;
          } else if (evt.eventType === 'error') {
            nodeClass = 'error';
            icon = '⚠️';
            title = evt.errorType || 'Error';
            
            const errMsg = metadataObj.message || '';
            const errSnippet = errMsg.length > 12 ? `${errMsg.substring(0, 10)}...` : errMsg;
            meta = `+${(evt.elapsedMs / 1000).toFixed(1)}s${errSnippet ? ` | ${errSnippet}` : ''}`;
          } else if (evt.eventType === 'retry') {
            nodeClass = 'retry';
            icon = '🔄';
            title = `Retry ${evt.toolName || ''}`;
            
            const attempt = metadataObj.attempt ? `#${metadataObj.attempt}` : '';
            meta = `Retrying${attempt ? ` ${attempt}` : ''}`;
          }

          return (
            <React.Fragment key={evt.eventId}>
              <div
                className={`dag-node ${nodeClass} ${isSelected ? 'active' : ''}`}
                onClick={() => onStepClick(evt.stepIndex)}
              >
                <div className="dag-node-header">
                  <span>{icon}</span>
                  <span>{evt.eventType.replace('_', ' ')}</span>
                </div>
                <div className="dag-node-title" title={title}>{title}</div>
                <div className="dag-node-meta" title={meta}>{meta}</div>
              </div>
              {idx < events.length - 1 && (
                <div className="dag-connector">➔</div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// 4. Detailed Timeline Step Card (with Summary vs JSON tabs)
interface TraceStepCardProps {
  evt: EnrichedTraceEvent;
  isActive: boolean;
  onCardClick: () => void;
}

function TraceStepCard({ evt, isActive, onCardClick }: TraceStepCardProps) {
  const [activeTab, setActiveTab] = useState<'summary' | 'payload'>('summary');
  const metadataObj = evt.metadata ? JSON.parse(evt.metadata) : {};
  let dotClass = evt.status || 'success';

  if (evt.eventType === 'trace_started') {
    dotClass = 'running';
  } else if (evt.eventType === 'error') {
    dotClass = 'failed';
  }

  return (
    <div
      id={`step-${evt.stepIndex}`}
      className={`timeline-step-item`}
      onClick={onCardClick}
    >
      <div className={`timeline-step-dot ${dotClass}`} />
      <div className={`timeline-step-card ${isActive ? 'active-highlight' : ''}`}>
        <div className="step-header">
          <span className="step-type-badge">{evt.eventType}</span>
          <span>step {evt.stepIndex}</span>
        </div>

        <div className="step-tabs-container">
          <button
            className={`step-tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveTab('summary');
            }}
          >
            Summary
          </button>
          <button
            className={`step-tab-btn ${activeTab === 'payload' ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setActiveTab('payload');
            }}
          >
            Payload (JSON)
          </button>
        </div>

        {activeTab === 'summary' ? (
          <>
            {evt.eventType === 'trace_started' && (
              <>
                <div className="step-title" style={{ fontSize: '15px', fontWeight: '600' }}>
                  🏁 Trace Started: <span style={{ color: 'var(--color-primary-light)' }}>{evt.agentName}</span>
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">User ID</span>
                    <span className="step-metric-value">{evt.userId || 'anonymous'}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Timestamp</span>
                    <span className="step-metric-value">{formatSafeTimeString(evt.timestamp)}</span>
                  </div>
                </div>
                {metadataObj.input && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Initial Prompt Input</span>
                    <div className="step-preview-quote">
                      "{metadataObj.input}"
                    </div>
                  </div>
                )}
              </>
            )}

            {evt.eventType === 'llm_call' && (
              <>
                <div className="step-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: '600' }}>
                  🤖 LLM Call: <span className="badge-model">{evt.model}</span>
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Latency</span>
                    <span className="step-metric-value">{evt.latencyMs ? `${evt.latencyMs}ms` : '0ms'}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Throughput</span>
                    <span className="step-metric-value">{evt.throughput > 0 ? `${evt.throughput.toFixed(1)} t/s` : 'N/A'}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Tokens (Input / Output)</span>
                    <span className="step-metric-value">
                      {evt.inputTokens || 0} / {evt.outputTokens || 0} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({(evt.inputTokens || 0) + (evt.outputTokens || 0)} total)</span>
                    </span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Cost / Acc. Cost</span>
                    <span className="step-metric-value" style={{ color: 'var(--color-success)' }}>
                      ${evt.costUsd?.toFixed(4) || '0.0000'} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>(${evt.accumulatedCost.toFixed(4)})</span>
                    </span>
                  </div>
                </div>
                {metadataObj.route && (
                  <div style={{ fontSize: '12px', marginTop: '6px', color: 'var(--text-secondary)' }}>
                    🎯 Decision Route: <strong style={{ color: 'var(--color-primary-light)' }}>{metadataObj.route}</strong>
                  </div>
                )}
                {metadataObj.prompt && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Prompt Preview</span>
                    <div className="step-preview-quote" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                      {metadataObj.prompt.length > 200 ? `${metadataObj.prompt.substring(0, 200)}...` : metadataObj.prompt}
                    </div>
                  </div>
                )}
                {metadataObj.response && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Response Preview</span>
                    <div className="step-preview-quote success" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                      {metadataObj.response.length > 200 ? `${metadataObj.response.substring(0, 200)}...` : metadataObj.response}
                    </div>
                  </div>
                )}
              </>
            )}

            {evt.eventType === 'tool_call' && (
              <>
                <div className="step-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: '600' }}>
                  🛠️ Tool Call: <span className="badge-tool">{evt.toolName}</span>
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Status</span>
                    <span className={`step-metric-value ${evt.status === 'success' ? 'status-success' : 'status-failed'}`} style={{ background: 'transparent', padding: 0 }}>
                      {evt.status}
                    </span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Execution Latency</span>
                    <span className="step-metric-value">{evt.latencyMs ? `${evt.latencyMs}ms` : '0ms'}</span>
                  </div>
                </div>
                {Object.entries(metadataObj).filter(([k]) => k !== 'tags').map(([k, v]) => (
                  <div className="step-preview-container" key={k}>
                    <span className="step-preview-title">{k}</span>
                    <div className="step-preview-quote" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                      {typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
                    </div>
                  </div>
                ))}
              </>
            )}

            {evt.eventType === 'error' && (
              <>
                <div className="step-title" style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-error)' }}>
                  ⚠️ Error Encountered: {evt.errorType}
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Target Tool</span>
                    <span className="step-metric-value">{evt.toolName || 'none'}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Timeline Offset</span>
                    <span className="step-metric-value">+{(evt.elapsedMs / 1000).toFixed(2)}s</span>
                  </div>
                </div>
                {metadataObj.message && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Error Message</span>
                    <div className="step-preview-quote error">
                      {metadataObj.message}
                    </div>
                  </div>
                )}
              </>
            )}

            {evt.eventType === 'retry' && (
              <>
                <div className="step-title" style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-warning)' }}>
                  🔄 Retrying Tool Execution: {evt.toolName}
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Attempt Number</span>
                    <span className="step-metric-value">#{metadataObj.attempt || 1}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Timeline Offset</span>
                    <span className="step-metric-value">+{(evt.elapsedMs / 1000).toFixed(2)}s</span>
                  </div>
                </div>
                {metadataObj.error && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Retrying due to error</span>
                    <div className="step-preview-quote error">
                      {metadataObj.error}
                    </div>
                  </div>
                )}
              </>
            )}

            {evt.eventType === 'trace_completed' && (
              <>
                <div className="step-title" style={{ fontSize: '15px', fontWeight: '600', color: evt.status === 'success' ? 'var(--color-success)' : 'var(--color-error)' }}>
                  🏁 Trace Finished ({evt.status})
                </div>
                <div className="step-summary-grid">
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Total Duration</span>
                    <span className="step-metric-value">{(evt.latencyMs ? evt.latencyMs / 1000 : 0).toFixed(2)}s</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Final Accumulated Cost</span>
                    <span className="step-metric-value" style={{ color: 'var(--color-success)' }}>${evt.accumulatedCost.toFixed(4)}</span>
                  </div>
                  <div className="step-summary-metric">
                    <span className="step-metric-label">Cumulative Tokens</span>
                    <span className="step-metric-value">
                      {evt.accumulatedTokens} <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({evt.accumulatedInputTokens} in / {evt.accumulatedOutputTokens} out)</span>
                    </span>
                  </div>
                </div>
                {metadataObj.output && (
                  <div className="step-preview-container">
                    <span className="step-preview-title">Final Agent Output</span>
                    <div className="step-preview-quote success">
                      "{metadataObj.output}"
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Rich Analytics Metrics Strip (Secondary helper metrics) */}
            <div className="step-metrics-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '14px', background: 'rgba(0,0,0,0.15)', padding: '8px 12px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <span>⏱️ Elapsed: <strong>+{(evt.elapsedMs / 1000).toFixed(2)}s</strong></span>
              <span>💳 Total Cost: <strong>${evt.accumulatedCost.toFixed(4)}</strong></span>
              <span>⚡ Acc. Tokens: <strong>{evt.accumulatedTokens.toLocaleString()}</strong></span>
            </div>
          </>
        ) : (
          <pre className="json-payload-pre">
            {JSON.stringify(metadataObj, null, 2)}
          </pre>
        )}

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          {formatSafeTimeString(evt.timestamp)}
        </div>
      </div>
    </div>
  );
}
