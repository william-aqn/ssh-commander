import React, { useState, useEffect, useCallback, useRef } from 'react';
import { eb } from '../services/eventBus';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend 
} from 'recharts';

const DockerView = ({ sessionId, userId, onOpenTerminal, status, onRestore, serverName }) => {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({});
  const [expandedLogs, setExpandedLogs] = useState({});
  const [logsHistory, setLogsHistory] = useState({});
  const [logLimits, setLogLimits] = useState({});
  const [logTimestamps, setLogTimestamps] = useState({});
  const [logHeights, setLogHeights] = useState({});
  const [chartData, setChartData] = useState({});
  const [zoomedContainerId, setZoomedContainerId] = useState(null);
  const [editingEnv, setEditingEnv] = useState(null); // { containerId, env: [], name }
  const [envLoading, setEnvLoading] = useState(false);
  const [loadingEnvContainerId, setLoadingEnvContainerId] = useState(null);
  
  // States for Draggable/Resizable ENV Modal
  const [envModalPos, setEnvModalPos] = useState({ x: 0, y: 0 });
  const [envModalSize, setEnvModalSize] = useState({ width: 600, height: 500 });
  const [isEnvDragging, setIsEnvDragging] = useState(false);
  const [envResizing, setEnvResizing] = useState(null);
  const [isEnvMaximized, setIsEnvMaximized] = useState(false);
  
  const envDragStartOffset = useRef({ x: 0, y: 0 });
  const envResizeStartSize = useRef({ width: 0, height: 0, x: 0, y: 0, modalX: 0, modalY: 0 });

  const chartRef = useRef(null);


  const fetchContainers = useCallback(() => {
    if (status !== 'connected') return;
    setLoading(true);
    eb.send('docker.containers.list', { sessionId, userId }, (err, res) => {
      setLoading(false);
      if (err) {
        if (err.failureCode === 503) {
           setError('session_idle');
        } else {
           setError(err.message || 'Failed to fetch containers');
        }
      } else if (res && res.body && res.body.status === 'ok') {
        setContainers(res.body.data || []);
        setError(null);
      } else {
        const msg = res?.body?.message || 'Unknown error';
        if (msg.includes('разбудите сессию') || msg.includes('503')) {
           setError('session_idle');
        } else {
           setError('Failed to load containers: ' + msg);
        }
      }
    });
  }, [sessionId, userId, status]);

  useEffect(() => {
    if (status === 'connected') {
      fetchContainers();
      const interval = setInterval(fetchContainers, 30000); // Refresh list every 30s
      return () => clearInterval(interval);
    }
  }, [fetchContainers, status]);

  useEffect(() => {
    if (containers.length > 0) {
      const fetchAllStats = () => {
        let runningContainers = containers.filter(c => c.State === 'running');
        if (runningContainers.length === 0) return;

        runningContainers.forEach((c, index) => {
          // Распределяем запросы во времени, чтобы не перегружать SSH-канал и бекенд
          setTimeout(() => {
            eb.send('docker.container.stats', { sessionId, userId, containerId: c.Id }, (err, res) => {
              if (!err && res && res.body && res.body.status === 'ok') {
                const s = res.body.data;
                if (!s || !s.memory_stats) return;

                setStats(prev => ({ ...prev, [c.Id]: s }));
                
                const cpuVal = parseFloat(calculateCpu(s));
                const ramMB = s.memory_stats.usage / (1024 * 1024);
                const ramLimit = s.memory_stats.limit;
                const ramPercent = ramLimit > 0 ? (s.memory_stats.usage / ramLimit) * 100 : 0;
                
                const newPoint = {
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                  cpu: cpuVal,
                  ram: ramPercent,
                  ramMB: ramMB
                };

                setChartData(prev => {
                  const history = prev[c.Id] || [];
                  const updatedHistory = [...history, newPoint].slice(-60); // Keep last 60 points
                  return { ...prev, [c.Id]: updatedHistory };
                });
              }
            });
          }, index * 200);
        });
      };
      fetchAllStats();
      const interval = setInterval(fetchAllStats, 15000); // Обновляем статистику раз в 15 секунд
      return () => clearInterval(interval);
    }
  }, [containers, sessionId, userId]);

  // Auto-scroll logs
  useEffect(() => {
    const logContainers = document.querySelectorAll('.log-container');
    logContainers.forEach(container => {
      // scroll to bottom only if it was already near bottom
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [logsHistory]);

  useEffect(() => {
    const activeLogs = Object.keys(expandedLogs).filter(id => expandedLogs[id]);
    if (activeLogs.length > 0) {
      const fetchLogs = () => {
        activeLogs.forEach(containerId => {
          const limit = logLimits[containerId] || 200;
          const timestamps = logTimestamps[containerId] || false;
          eb.send('docker.container.logs', { sessionId, userId, containerId, tail: limit, timestamps }, (err, res) => {
            if (!err && res && res.body && res.body.status === 'ok') {
               let newLogs = res.body.data || '';
               if (typeof newLogs !== 'string') {
                  newLogs = JSON.stringify(newLogs);
               }
               setLogsHistory(prev => {
                  const lines = newLogs.split('\n');
                  return { ...prev, [containerId]: lines.slice(-limit) };
               });
            }
          });
        });
      };
      fetchLogs();
      const interval = setInterval(fetchLogs, 5000); // Poll logs every 5 seconds
      return () => clearInterval(interval);
    }
  }, [expandedLogs, sessionId, userId, logLimits, logTimestamps]);

  const toggleLogs = (containerId) => {
    setExpandedLogs(prev => ({ ...prev, [containerId]: !prev[containerId] }));
    if (!logLimits[containerId]) {
      setLogLimits(prev => ({ ...prev, [containerId]: 200 }));
    }
  };

  const handleResizeStart = (containerId, e) => {
    e.preventDefault();
    const startY = e.pageY;
    const startHeight = logHeights[containerId] || 200;

    const onMouseMove = (moveEvent) => {
      const deltaY = moveEvent.pageY - startY;
      const newHeight = Math.max(100, startHeight + deltaY);
      setLogHeights(prev => ({ ...prev, [containerId]: newHeight }));
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const downloadLogs = (containerId, name) => {
    const logs = logsHistory[containerId] || [];
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const milliseconds = now.getTime();
    
    const host = serverName || 'server';
    a.download = `${host}_${name}_${day}${month}${year}_${milliseconds}.txt`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const saveChartAsImage = () => {
    if (!chartRef.current) return;
    const svg = chartRef.current.querySelector('svg');
    if (!svg) return;
    
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 300;
    
    img.onload = () => {
      canvas.width = width * 2;
      canvas.height = height * 2;
      ctx.scale(2, 2);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'docker_stats_chart.png';
      a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  };

  const ContainerChart = ({ data, isMini, onClick }) => {
    if (!data || data.length < 2) return <div className="no-chart-data"></div>;

    return (
      <div 
        className={isMini ? "mini-chart-container" : "large-chart-container"} 
        onClick={onClick}
        title={isMini ? "Click to enlarge" : ""}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} hide={isMini} />
            <XAxis 
              dataKey="time" 
              stroke="#666" 
              fontSize={10} 
              tick={{fill: '#666'}} 
              interval="preserveStartEnd"
              hide={isMini}
            />
            <YAxis 
              stroke="#666" 
              fontSize={10} 
              tick={{fill: '#666'}}
              domain={[0, 100]}
              tickFormatter={(val) => `${val}%`}
              hide={isMini}
            />
            {!isMini && <Tooltip 
              contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333', borderRadius: '4px', fontSize: '12px' }}
              itemStyle={{ padding: '2px 0' }}
              formatter={(value, name, props) => {
                if (name === "RAM") {
                  const ramMB = props.payload.ramMB;
                  return [`${value.toFixed(2)}% (${ramMB.toFixed(1)} MB)`, "RAM"];
                }
                return [`${value.toFixed(2)}%`, name];
              }}
            />}
            {!isMini && <Legend />}
            <Line 
              type="monotone" 
              dataKey="cpu" 
              name="CPU"
              stroke="#ff4d4d" 
              strokeWidth={isMini ? 1.5 : 2}
              dot={false} 
              activeDot={!isMini ? { r: 4 } : false} 
              isAnimationActive={false}
            />
            <Line 
              type="monotone" 
              dataKey="ram" 
              name="RAM"
              stroke="#4d79ff" 
              strokeWidth={isMini ? 1.5 : 2}
              dot={false} 
              activeDot={!isMini ? { r: 4 } : false} 
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  const renderZoomModal = () => {
    if (!zoomedContainerId) return null;
    const container = containers.find(c => c.Id === zoomedContainerId);
    if (!container) return null;
    const name = container.Names && container.Names[0] ? container.Names[0].replace(/^\//, '') : container.Id.substring(0, 12);
    const data = chartData[zoomedContainerId];

    return (
      <div className="chart-zoom-overlay" onClick={() => setZoomedContainerId(null)}>
        <div className="chart-zoom-modal" onClick={e => e.stopPropagation()}>
          <div className="chart-zoom-header">
            <h3>Stats: {name}</h3>
            <button className="close-zoom-btn" onClick={() => setZoomedContainerId(null)}>×</button>
          </div>
          <div className="chart-zoom-body" ref={chartRef}>
             <ContainerChart data={data} isMini={false} />
          </div>
          <div className="chart-zoom-footer">
            <button onClick={saveChartAsImage} className="download-button">Save Chart Image</button>
          </div>
        </div>
      </div>
    );
  };

  const handleRestart = (containerId) => {
    eb.send('docker.container.restart', { sessionId, userId, containerId }, (err, res) => {
      if (!err) {
        fetchContainers();
      } else {
        alert('Failed to restart container: ' + (err.message || 'unknown error'));
      }
    });
  };

  const handleOpenEnv = (containerId) => {
    setEnvLoading(true);
    setLoadingEnvContainerId(containerId);
    eb.send('docker.container.inspect', { sessionId, userId, containerId }, (err, res) => {
      setEnvLoading(false);
      setLoadingEnvContainerId(null);
      if (!err && res && res.body && res.body.status === 'ok') {
        const data = res.body.data;
        const env = data.Config ? data.Config.Env : [];
        setEditingEnv({ containerId, env, name: data.Name.replace(/^\//, '') });
        
        const initialWidth = 600;
        const initialHeight = 500;
        // Reset modal state to default when opening, center it
        setEnvModalPos({ 
          x: (window.innerWidth - initialWidth) / 2, 
          y: (window.innerHeight - initialHeight) / 2 
        });
        setEnvModalSize({ width: initialWidth, height: initialHeight });
        setIsEnvMaximized(false);
      } else {
        alert('Failed to get container ENV: ' + (err?.message || 'unknown error'));
      }
    });
  };

  const handleEnvMouseDown = (e) => {
    if (e.button !== 0 || isEnvMaximized) return;
    if (e.target.closest('button') || e.target.closest('.no-drag')) return;
    setIsEnvDragging(true);
    envDragStartOffset.current = {
      x: e.clientX - envModalPos.x,
      y: e.clientY - envModalPos.y
    };
  };

  const handleEnvResizeDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    setEnvResizing(type);
    envResizeStartSize.current = {
      width: envModalSize.width,
      height: envModalSize.height,
      x: e.clientX,
      y: e.clientY,
      modalX: envModalPos.x,
      modalY: envModalPos.y
    };
  };

  const handleEnvTitleDoubleClick = () => {
    setIsEnvMaximized(!isEnvMaximized);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isEnvDragging) {
        setEnvModalPos({
          x: e.clientX - envDragStartOffset.current.x,
          y: e.clientY - envDragStartOffset.current.y
        });
      } else if (envResizing) {
        const deltaX = e.clientX - envResizeStartSize.current.x;
        const deltaY = e.clientY - envResizeStartSize.current.y;
        
        let newWidth = envResizeStartSize.current.width;
        let newHeight = envResizeStartSize.current.height;
        let newX = envResizeStartSize.current.modalX;
        let newY = envResizeStartSize.current.modalY;

        if (envResizing.includes('r')) {
          newWidth = Math.max(300, envResizeStartSize.current.width + deltaX);
        }
        if (envResizing.includes('l')) {
          newWidth = Math.max(300, envResizeStartSize.current.width - deltaX);
          if (newWidth > 300) {
            newX = envResizeStartSize.current.modalX + deltaX;
          } else {
            newX = envResizeStartSize.current.modalX + (envResizeStartSize.current.width - 300);
          }
        }
        if (envResizing.includes('b')) {
          newHeight = Math.max(200, envResizeStartSize.current.height + deltaY);
        }
        if (envResizing.includes('t')) {
          newHeight = Math.max(200, envResizeStartSize.current.height - deltaY);
          if (newHeight > 200) {
            newY = envResizeStartSize.current.modalY + deltaY;
          } else {
            newY = envResizeStartSize.current.modalY + (envResizeStartSize.current.height - 200);
          }
        }

        setEnvModalSize({ width: newWidth, height: newHeight });
        setEnvModalPos({ x: newX, y: newY });
      }
    };

    const handleMouseUp = () => {
      setIsEnvDragging(false);
      setEnvResizing(null);
    };

    if (isEnvDragging || envResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isEnvDragging, envResizing]);

  const handleSaveEnv = () => {
    if (!editingEnv) return;
    setEnvLoading(true);
    eb.send('docker.container.update_env', { 
      sessionId, 
      userId, 
      containerId: editingEnv.containerId, 
      env: editingEnv.env 
    }, (err, res) => {
      setEnvLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        setEditingEnv(null);
        fetchContainers();
      } else {
        alert('Failed to update ENV and restart: ' + (err?.message || 'unknown error'));
      }
    });
  };

  const renderEnvModal = () => {
    if (!editingEnv) return null;

    return (
      <div className="chart-zoom-overlay" style={{ display: 'block' }}>
        <div 
          className={`chart-zoom-modal env-modal ${isEnvMaximized ? 'is-maximized' : ''}`}
          onClick={e => e.stopPropagation()}
          style={{
            width: isEnvMaximized ? '100vw' : `${envModalSize.width}px`,
            height: isEnvMaximized ? '100vh' : `${envModalSize.height}px`,
            transform: isEnvMaximized ? 'none' : `translate(${envModalPos.x}px, ${envModalPos.y}px)`,
            maxWidth: 'none',
            position: 'fixed',
            left: 0,
            top: 0,
            margin: 0
          }}
        >
          {/* Resize Handles - only when not maximized */}
          {!isEnvMaximized && (
            <>
              <div className="modal-resizer r" onMouseDown={e => handleEnvResizeDown(e, 'r')} />
              <div className="modal-resizer b" onMouseDown={e => handleEnvResizeDown(e, 'b')} />
              <div className="modal-resizer l" onMouseDown={e => handleEnvResizeDown(e, 'l')} />
              <div className="modal-resizer t" onMouseDown={e => handleEnvResizeDown(e, 't')} />
              <div className="modal-resizer rb" onMouseDown={e => handleEnvResizeDown(e, 'rb')} />
              <div className="modal-resizer lb" onMouseDown={e => handleEnvResizeDown(e, 'lb')} />
              <div className="modal-resizer rt" onMouseDown={e => handleEnvResizeDown(e, 'rt')} />
              <div className="modal-resizer lt" onMouseDown={e => handleEnvResizeDown(e, 'lt')} />
            </>
          )}

          <div 
            className="chart-zoom-header" 
            onMouseDown={handleEnvMouseDown} 
            onDoubleClick={handleEnvTitleDoubleClick}
            style={{ cursor: 'move' }}
          >
            <h3>Environment Variables: {editingEnv.name}</h3>
            <button className="close-zoom-btn no-drag" onClick={() => setEditingEnv(null)}>×</button>
          </div>
          <div className="chart-zoom-body" style={{ position: 'relative' }}>
            {envLoading && (
              <div className="modal-loader-overlay">
                <div className="spinner"></div>
              </div>
            )}
            <div className="env-list no-drag">
              {editingEnv.env.map((envStr, index) => {
                const eqIdx = envStr.indexOf('=');
                const key = eqIdx > -1 ? envStr.substring(0, eqIdx) : envStr;
                const value = eqIdx > -1 ? envStr.substring(eqIdx + 1) : '';
                return (
                  <div key={index} className="env-item no-drag">
                    <input 
                      type="text" 
                      value={key} 
                      onChange={(e) => {
                        const newEnv = [...editingEnv.env];
                        newEnv[index] = e.target.value + '=' + value;
                        setEditingEnv({...editingEnv, env: newEnv});
                      }}
                      placeholder="KEY"
                      className="no-drag"
                    />
                    <span className="no-drag">=</span>
                    <input 
                      type="text" 
                      value={value} 
                      onChange={(e) => {
                        const newEnv = [...editingEnv.env];
                        newEnv[index] = key + '=' + e.target.value;
                        setEditingEnv({...editingEnv, env: newEnv});
                      }}
                      placeholder="VALUE"
                      className="no-drag"
                    />
                    <button className="delete-env-btn no-drag" onClick={() => {
                      const newEnv = editingEnv.env.filter((_, i) => i !== index);
                      setEditingEnv({...editingEnv, env: newEnv});
                    }}>×</button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="chart-zoom-footer no-drag">
            <button className="add-env-btn no-drag" disabled={envLoading} onClick={() => {
              setEditingEnv({...editingEnv, env: [...editingEnv.env, 'NEW_VAR=']});
            }}>+ Add Variable</button>
            <div style={{ flex: 1 }}></div>
            <button className="add-env-btn no-drag" disabled={envLoading} onClick={() => setEditingEnv(null)}>Cancel</button>
            <button onClick={handleSaveEnv} className="download-button no-drag" disabled={envLoading}>
              {envLoading ? 'Updating...' : 'Save & Restart'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const calculateCpu = (stats) => {
    if (!stats || !stats.cpu_stats || !stats.precpu_stats) return '0.00%';
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const numberCpus = stats.cpu_stats.online_cpus || 1;
    if (systemDelta > 0 && cpuDelta > 0) {
      return ((cpuDelta / systemDelta) * numberCpus * 100).toFixed(2) + '%';
    }
    return '0.00%';
  };

  return (
    <div className="docker-view">
      {status === 'restorable' || error === 'session_idle' ? (
        <div className="terminal-error-state" style={{ background: 'transparent' }}>
           <div className="terminal-status-title">Сессия уснула</div>
           <div className="terminal-error-message">Для работы с Docker необходимо активное SSH-соединение.</div>
           <button onClick={onRestore} className="retry-button">Разбудить сессию</button>
        </div>
      ) : loading && containers.length === 0 ? (
        <div className="docker-loading">Loading containers...</div>
      ) : error ? (
        <div className="docker-error">{error}</div>
      ) : (
        <table className="docker-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Activity</th>
              <th>Limits (CPU/RAM)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {containers.map(c => {
              const s = stats[c.Id];
              const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.substring(0, 12);
              const isExpanded = expandedLogs[c.Id];
              return (
                <React.Fragment key={c.Id}>
                  <tr className={isExpanded ? 'expanded' : ''}>
                    <td>{name}</td>
                    <td>{c.State}</td>
                    <td>{calculateCpu(s)}</td>
                    <td>{s && s.memory_stats ? formatBytes(s.memory_stats.usage) : '-'}</td>
                    <td className="chart-td">
                      <ContainerChart 
                        data={chartData[c.Id]} 
                        isMini={true} 
                        onClick={() => setZoomedContainerId(c.Id)} 
                      />
                    </td>
                    <td>
                      {s && s.cpu_stats && s.memory_stats ? `${s.cpu_stats.online_cpus || '-'} CPU / ${formatBytes(s.memory_stats.limit)}` : '-'}
                    </td>
                    <td className="docker-actions">
                      <button onClick={() => onOpenTerminal(name, c.Id)} title="Terminal">T</button>
                      <button onClick={() => toggleLogs(c.Id)} title="Logs" className={isExpanded ? 'active' : ''}>L</button>
                      <button onClick={() => handleRestart(c.Id)} title="Restart">R</button>
                      <button 
                        onClick={() => handleOpenEnv(c.Id)} 
                        title="Environment Variables"
                        disabled={envLoading}
                      >
                        {loadingEnvContainerId === c.Id ? '...' : 'ENV'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="log-row">
                      <td colSpan="7">
                        <div className="log-container-wrapper">
                          <div className="log-header">
                            <span>Logs: {name}</span>
                            <div className="log-actions">
                              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '12px' }}>
                                <input 
                                  type="checkbox" 
                                  checked={logTimestamps[c.Id] || false} 
                                  onChange={(e) => setLogTimestamps(prev => ({ ...prev, [c.Id]: e.target.checked }))}
                                />
                                <span>Dates</span>
                              </label>
                              <label style={{ marginLeft: '10px' }}>Lines: </label>
                              <input 
                                type="number" 
                                value={logLimits[c.Id] || 200} 
                                onChange={(e) => setLogLimits(prev => ({ ...prev, [c.Id]: parseInt(e.target.value) || 200 }))}
                                className="log-limit-input"
                              />
                              <button onClick={() => downloadLogs(c.Id, name)} className="log-action-btn">Download</button>
                              <button onClick={() => toggleLogs(c.Id)} className="log-action-btn">Close</button>
                            </div>
                          </div>
                          <div className="log-container" style={{ height: logHeights[c.Id] || 200 }}>
                            {(logsHistory[c.Id] || []).map((line, idx) => (
                              <div key={idx}>{line}</div>
                            ))}
                          </div>
                          <div 
                            className="log-resize-handle" 
                            onMouseDown={(e) => handleResizeStart(c.Id, e)}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {renderZoomModal()}
      {renderEnvModal()}
    </div>
  );
};

export default DockerView;
