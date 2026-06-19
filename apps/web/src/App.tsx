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
  }, [agentFilter, statusFilter, modelFilter, toolFilter, timeRangeFilter]);

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

  const fetchDashboardData = async () => {
    try {
      // Refresh metadata options dynamically
      fetchMetadata();

      const q = new URLSearchParams();
      if (agentFilter) q.set('agentName', agentFilter);
      if (statusFilter) q.set('status', statusFilter);
      if (modelFilter) q.set('model', modelFilter);
      if (toolFilter) q.set('toolName', toolFilter);
      if (timeRangeFilter) q.set('timeRange', timeRangeFilter);

      const kpiRes = await fetch(`/api/kpis?${q.toString()}`);
      if (kpiRes.ok) {
        const res = await kpiRes.json();
        setKpis(res.data || { totalTraces: 0, avgTraceLatencyMs: 0, errorRate: 0, totalCostUsd: 0 });
      }

      const traceRes = await fetch(`/api/traces?${q.toString()}`);
      if (traceRes.ok) {
        const res = await traceRes.json();
        setTraces(res.data || []);
      }
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
            timeRange: timeRangeFilter || undefined
          }
        })
      });
      const data = await res.json();
      if (res.ok) {
        setActiveChartData(data.data);
        setQueryLatencyMs(data.latencyMs);
        setQuerySql(data.sql);
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
        // Refresh metrics cards in case database was updated
        fetchDashboardData();
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
              timeRange: timeRangeFilter || undefined
            }
          })
        });
        const runData = await runRes.json();
        if (runRes.ok) {
          setActiveChartData(runData.data);
          setQueryLatencyMs(runData.latencyMs);
          setQuerySql(runData.sql);
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
              <SVGChart data={activeChartData} />
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
                      <td style={{ color: 'var(--text-secondary)' }}>{new Date(t.startedAt).toLocaleString()}</td>
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
            <div className="timeline-steps">
              {selectedTraceEvents.map((evt) => {
                const metadataObj = evt.metadata ? JSON.parse(evt.metadata) : {};
                let title = evt.eventType;
                let details = '';
                let dotClass = evt.status || 'success';

                if (evt.eventType === 'trace_started') {
                  title = `Trace Started: ${evt.agentName}`;
                  details = `Prompt input: "${metadataObj.input}"`;
                  dotClass = 'running';
                } else if (evt.eventType === 'llm_call') {
                  title = `LLM Call: ${evt.model}`;
                  details = `Tokens: ${evt.inputTokens} in / ${evt.outputTokens} out\nCost: $${evt.costUsd?.toFixed(4)}\nLatency: ${evt.latencyMs}ms\n\nRoute: ${metadataObj.route || 'none'}`;
                } else if (evt.eventType === 'tool_call') {
                  title = `Tool Call: ${evt.toolName}`;
                  details = `Status: ${evt.status}\nLatency: ${evt.latencyMs}ms`;
                } else if (evt.eventType === 'error') {
                  title = `Error: ${evt.errorType}`;
                  details = `${metadataObj.message}\nTool: ${evt.toolName || 'none'}`;
                  dotClass = 'failed';
                } else if (evt.eventType === 'retry') {
                  title = `Retry Tool: ${evt.toolName}`;
                  details = `Attempt number: ${metadataObj.attempt}`;
                } else if (evt.eventType === 'trace_completed') {
                  title = `Trace Completed (${evt.status})`;
                  details = `Final Output: "${metadataObj.output}"\nTotal Latency: ${(evt.latencyMs ? evt.latencyMs / 1000 : 0).toFixed(2)}s`;
                }

                return (
                  <div key={evt.eventId} className="timeline-step-item">
                    <div className={`timeline-step-dot ${dotClass}`} />
                    <div className="timeline-step-card">
                      <div className="step-header">
                        <span className="step-type-badge">{evt.eventType}</span>
                        <span>step {evt.stepIndex}</span>
                      </div>
                      <div className="step-title">{title}</div>
                      <div className="step-metadata">{details}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Adaptive SVG Chart component to render queries dynamically
function SVGChart({ data }: { data: any[] }) {
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
    return <SVGLineChart data={data} timeKey={timeKey} valKey={valueKeys[0]} />;
  }

  // Otherwise draw a Bar Chart
  const catKey = keys.find(k => typeof data[0][k] === 'string');
  const numKey = keys.find(k => typeof data[0][k] === 'number');

  if (catKey && numKey) {
    return <SVGBarChart data={data} catKey={catKey} valKey={numKey} />;
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
function SVGLineChart({ data, timeKey, valKey }: { data: any[]; timeKey: string; valKey: string }) {
  const width = 800;
  const height = 240;
  const paddingLeft = 60;
  const paddingRight = 30;
  const paddingTop = 20;
  const paddingBottom = 40;

  // Extract and parse coordinates
  const points = data.map((d) => ({
    xLabel: new Date(d[timeKey]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    val: Number(d[valKey])
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
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.3" />
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
      </svg>
    </div>
  );
}

// 2. Bar Chart component using raw SVG
function SVGBarChart({ data, catKey, valKey }: { data: any[]; catKey: string; valKey: string }) {
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

          return (
            <g key={i}>
              {/* Bar rectangle */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx="4"
                fill="linear-gradient(180deg, var(--color-primary-light), var(--color-accent))"
                style={{ fill: 'var(--color-primary)' }}
              />

              {/* Bar value label */}
              <text x={x + barWidth / 2} y={y - 6} fill="var(--text-primary)" fontSize="10" fontWeight="600" textAnchor="middle">
                {item.val >= 1000 ? `${(item.val / 1000).toFixed(1)}k` : item.val.toFixed(2)}
              </text>

              {/* Categorical label on X Axis */}
              <text x={x + barWidth / 2} y={height - 15} fill="var(--text-secondary)" fontSize="10" textAnchor="middle">
                {item.label.length > 12 ? `${item.label.substring(0, 10)}...` : item.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
