import React, { useState, useEffect, useCallback } from 'react';
import { eb } from '../services/eventBus';

const DockerView = ({ sessionId, userId, onOpenTerminal, status, onRestore }) => {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({});

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

  const fetchStats = useCallback((containerId) => {
    eb.send('docker.container.stats', { sessionId, userId, containerId }, (err, res) => {
      if (!err && res && res.body && res.body.status === 'ok') {
        setStats(prev => ({ ...prev, [containerId]: res.body.data }));
      }
    });
  }, [sessionId, userId]);

  useEffect(() => {
    if (containers.length > 0) {
      const fetchAllStats = () => {
        containers.forEach((c, index) => {
          if (c.State === 'running') {
            // Распределяем запросы во времени, чтобы не перегружать SSH-канал и бекенд
            setTimeout(() => fetchStats(c.Id), index * 300);
          }
        });
      };
      fetchAllStats();
      const interval = setInterval(fetchAllStats, 15000); // Обновляем статистику раз в 15 секунд
      return () => clearInterval(interval);
    }
  }, [containers, fetchStats]);

  const handleRestart = (containerId) => {
    eb.send('docker.container.restart', { sessionId, userId, containerId }, (err, res) => {
      if (!err) {
        fetchContainers();
      } else {
        alert('Failed to restart container: ' + (err.message || 'unknown error'));
      }
    });
  };

  const handleLogs = (containerId) => {
    eb.send('docker.container.logs', { sessionId, userId, containerId }, (err, res) => {
        if (!err && res && res.body && res.body.status === 'ok') {
            // Simple log display in alert for now, or we could open a modal
            // The requirement says "показать логи контейнера", let's use alert for simplicity or a basic overlay
            alert('Logs:\n' + (res.body.data || 'No logs'));
        } else {
            alert('Failed to fetch logs');
        }
    });
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
              <th>Uptime</th>
              <th>Status</th>
              <th>CPU</th>
              <th>RAM</th>
              <th>Limits (CPU/RAM)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {containers.map(c => {
              const s = stats[c.Id];
              const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.substring(0, 12);
              return (
                <tr key={c.Id}>
                  <td>{name}</td>
                  <td>{c.Status}</td>
                  <td>{c.State}</td>
                  <td>{calculateCpu(s)}</td>
                  <td>{s ? formatBytes(s.memory_stats.usage) : '-'}</td>
                  <td>
                    {s ? `${s.cpu_stats.online_cpus || '-'} CPU / ${formatBytes(s.memory_stats.limit)}` : '-'}
                  </td>
                  <td className="docker-actions">
                    <button onClick={() => onOpenTerminal(name, c.Id)} title="Terminal">T</button>
                    <button onClick={() => handleLogs(c.Id)} title="Logs">L</button>
                    <button onClick={() => handleRestart(c.Id)} title="Restart">R</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default DockerView;
