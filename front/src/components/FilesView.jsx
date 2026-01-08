import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { eb, registerHandler } from '../services/eventBus';

const FilePanel = ({ sessionId, userId, status, initialPath, serverId, serverName, onPathChange, onRestore, isPinned, onPinClose, onDropFiles, onPinToggle, isCurrentlyPinned, onCopy }) => {
  const [files, setFiles] = useState([]);
  const [diskInfo, setDiskInfo] = useState(null);
  const [currentPath, setCurrentPath] = useState(initialPath || '.');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
  const [calculatingSizes, setCalculatingSizes] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [selectionMask, setSelectionMask] = useState(() => localStorage.getItem('files_selection_mask') || '*');
  const fileInputRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('files_selection_mask', selectionMask);
  }, [selectionMask]);

  useEffect(() => {
    if (onPathChange) onPathChange(currentPath);
  }, [currentPath]);

  useEffect(() => {
    if (initialPath && initialPath !== currentPath) {
      setCurrentPath(initialPath);
      fetchFiles(initialPath);
    }
  }, [initialPath]);


  const calculateDirectorySizes = (path = currentPath) => {
    if (status !== 'connected') return;
    setCalculatingSizes(true);
    eb.send('files.size', { sessionId, userId, path }, (err, res) => {
      setCalculatingSizes(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        const sizes = res.body.sizes;
        setFiles(prev => prev.map(f => ({
          ...f,
          size: sizes[f.name] || f.size
        })));
      }
    });
  };

  const fetchFiles = useCallback((path = currentPath) => {
    if (status !== 'connected') return;
    setLoading(true);
    eb.send('files.list', { sessionId, userId, path }, (err, res) => {
      setLoading(false);
      if (err) {
        setError(err.message || 'Failed to fetch files');
        if (err.message === 'SSH session not active' && onRestore) {
          onRestore();
        }
      } else if (res && res.body && res.body.status === 'ok') {
        const fetchedPath = res.body.path;
        const fetchedFiles = res.body.files || [];
        setFiles(fetchedFiles);
        setDiskInfo(res.body.diskInfo || null);
        setCurrentPath(fetchedPath);
        setError(null);
        setSelectedPaths(new Set());
        if (fetchedFiles.some(f => f.isDir)) {
          calculateDirectorySizes(fetchedPath);
        }
      } else {
        setError('Failed to load files');
      }
    });
  }, [sessionId, userId, status, currentPath]);

  useEffect(() => {
    if (status === 'connected') {
      fetchFiles(currentPath);
    }
  }, [status, sessionId]); // Рефетч при смене сессии (для pinned)

  useEffect(() => {
    if (!userId || !serverId || status !== 'connected') return;
    
    const handler = (err, msg) => {
      if (msg && msg.body) {
        const { serverId: eventServerId, path: eventPath } = msg.body;
        if (eventServerId === serverId && eventPath === currentPath) {
          fetchFiles(currentPath);
        }
      }
    };
    
    const addr = `ssh.out.${userId}.files.changed`;
    return registerHandler(addr, handler);
  }, [userId, serverId, status, currentPath, fetchFiles]);

  const navigateTo = (name) => {
    const newPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    fetchFiles(newPath);
  };

  const navigateUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/');
    parts.pop();
    const newPath = parts.join('/') || '/';
    fetchFiles(newPath);
  };

  const getFullPath = (name) => {
    if (currentPath === '/') return `/${name}`;
    if (currentPath === '.') return name;
    return `${currentPath}/${name}`;
  };

  const toggleSelect = (name) => {
    const fullPath = getFullPath(name);
    const next = new Set(selectedPaths);
    if (next.has(fullPath)) next.delete(fullPath);
    else next.add(fullPath);
    setSelectedPaths(next);
  };

  const handleDownload = (name, isDir) => {
    const fullPath = getFullPath(name);
    if (isDir) {
        setLoading(true);
        eb.send('files.archive', { sessionId, userId, paths: [fullPath] }, (err, res) => {
          setLoading(false);
          if (!err && res && res.body && res.body.status === 'ok') {
            window.open(`/api/download?sessionId=${sessionId}&path=${encodeURIComponent(res.body.archivePath)}`, '_blank');
          } else {
            alert('Failed to create archive: ' + (err ? err.message : 'Unknown error'));
          }
        });
    } else {
      window.open(`/api/download?sessionId=${sessionId}&path=${encodeURIComponent(fullPath)}`, '_blank');
    }
  };

  const handleUploadFiles = async (filesToUpload) => {
    if (status !== 'connected' || !filesToUpload.length) return;
    setLoading(true);
    const formData = new FormData();
    for (let i = 0; i < filesToUpload.length; i++) formData.append('files', filesToUpload[i]);
    try {
      const response = await fetch(`/api/upload?sessionId=${sessionId}&path=${encodeURIComponent(currentPath)}`, {
        method: 'POST',
        body: formData,
      });
      if (response.ok) fetchFiles();
      else alert('Ошибка при загрузке: ' + await response.text());
    } catch (err) {
      alert('Ошибка при загрузке: ' + err.message);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Drag & Drop Logic
  const onDragStart = (e, file) => {
    const fullPath = getFullPath(file.name);
    const dragData = {
        sessionId,
        userId,
        serverName,
        sourcePath: currentPath,
        paths: selectedPaths.has(fullPath) ? Array.from(selectedPaths) : [fullPath]
    };
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    if (status === 'connected') setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (status !== 'connected') return;

    const jsonData = e.dataTransfer.getData('application/json');
    if (jsonData) {
        try {
            const dragData = JSON.parse(jsonData);
            onDropFiles(dragData, currentPath);
            return;
        } catch (e) {}
    }

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) handleUploadFiles(droppedFiles);
  };

  const handleCreateDir = () => {
    const name = prompt('Введите имя директории:');
    if (!name) return;
    const path = getFullPath(name);
    setLoading(true);
    eb.send('files.mkdir', { sessionId, userId, path }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') fetchFiles();
      else alert('Ошибка при создании директории: ' + (err ? err.message : 'Unknown error'));
    });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    const pathsToDelete = deleteConfirm.paths;
    setDeleteConfirm(null);
    setLoading(true);
    eb.send('files.delete', { sessionId, userId, paths: pathsToDelete }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') fetchFiles();
      else alert('Ошибка при удалении: ' + (err ? err.message : 'Unknown error'));
    });
  };

  const handleChmod = (file) => {
    const mode = prompt('Введите права (например, 755):', file.perm_numeric || '');
    if (!mode) return;
    const path = getFullPath(file.name);
    setLoading(true);
    eb.send('files.chmod', { sessionId, userId, path, mode }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') fetchFiles();
      else alert('Ошибка при изменении прав: ' + (err ? err.message : 'Unknown error'));
    });
  };

  const handleRename = (file) => {
    const newName = prompt('Введите новое имя:', file.name);
    if (!newName || newName === file.name) return;
    const oldPath = getFullPath(file.name);
    const newPath = getFullPath(newName);
    setLoading(true);
    eb.send('files.rename', { sessionId, userId, oldPath, newPath }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') fetchFiles();
      else alert('Ошибка при переименовании: ' + (err ? err.message : 'Unknown error'));
    });
  };

  const selectByMask = () => {
    try {
      const pattern = selectionMask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const regex = new RegExp('^' + pattern + '$');
      const next = new Set();
      files.forEach(f => {
        if (regex.test(f.name)) {
          next.add(getFullPath(f.name));
        }
      });
      setSelectedPaths(next);
    } catch (e) {
      alert('Некорректная маска');
    }
  };

  const sortedFiles = React.useMemo(() => {
    let sortableFiles = [...files];
    if (sortConfig !== null) {
      sortableFiles.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];
        if (sortConfig.key === 'size') {
          aVal = parseInt(aVal) || 0;
          bVal = parseInt(bVal) || 0;
        }
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return sortableFiles;
  }, [files, sortConfig]);

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
    setSortConfig({ key, direction });
  };

  const getSortIcon = (key) => {
    if (sortConfig.key !== key) return '↕️';
    return sortConfig.direction === 'asc' ? '🔼' : '🔽';
  };

  return (
    <div className={`file-panel ${isDragOver ? 'drag-over' : ''}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <div className="panel-header">
        <div className="panel-title" title={`${serverName}: ${currentPath}`}>
            {isPinned && <span style={{marginRight: 8}}>📌</span>}
            <span className="panel-server-name">{serverName}</span>: {currentPath}
        </div>
        <div className="files-actions" style={{padding: 0, border: 'none'}}>
            <div className="mask-selection" style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8, border: '1px solid #444', borderRadius: 4, padding: '0 4px', height: 24 }}>
                <input 
                    type="text" 
                    value={selectionMask} 
                    onChange={(e) => setSelectionMask(e.target.value)} 
                    placeholder="Маска (*)"
                    style={{ width: 60, border: 'none', background: 'transparent', outline: 'none', color: 'inherit', fontSize: '12px' }}
                />
                <button onClick={selectByMask} title="Выделить по маске" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: '12px' }}>✅</button>
            </div>
            <button onClick={handleCreateDir} title="Создать директорию">📁+</button>
            <button onClick={() => fileInputRef.current?.click()} title="Загрузить файлы">📤</button>
            <input type="file" ref={fileInputRef} style={{ display: 'none' }} multiple onChange={(e) => handleUploadFiles(e.target.files)} />
            <button onClick={() => fetchFiles()} title="Refresh">🔄</button>
            {!isPinned && onPinToggle && (
                <button 
                  className={`pin-panel-btn ${isCurrentlyPinned ? 'active' : ''}`}
                  onClick={() => onPinToggle({ sessionId, serverId, path: currentPath })}
                  title={isCurrentlyPinned ? "Открепить панель" : "Закрепить панель"}
                >
                  📌
                </button>
            )}
            {isPinned && <button className="pin-close-btn" onClick={onPinClose} title="Закрыть панель">✕</button>}
        </div>
      </div>

      {status === 'restorable' ? (
        <div className="terminal-error-state" style={{ flex: 1, background: 'transparent' }}>
            <div className="terminal-status-title">Сессия уснула</div>
            <button onClick={onRestore} className="retry-button">Разбудить сессию</button>
        </div>
      ) : (
        <div 
            className="files-table-container" 
            onContextMenu={(e) => {
                if (e.target === e.currentTarget || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY' || e.target.tagName === 'THEAD') {
                    setContextMenu(null);
                }
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY' || e.target.tagName === 'THEAD') {
                    setContextMenu(null);
                }
            }}
        >
            <table className="files-table">
            <thead>
                <tr>
                <th style={{ width: '30px' }}></th>
                <th onClick={() => requestSort('name')} style={{ cursor: 'pointer' }}>Имя {getSortIcon('name')}</th>
                <th onClick={() => requestSort('size')} style={{ cursor: 'pointer' }}>Размер {getSortIcon('size')}</th>
                <th style={{ width: '60px' }}></th>
                </tr>
            </thead>
            <tbody>
                {currentPath !== '/' && (
                <tr onDoubleClick={navigateUp} className="file-row">
                    <td></td>
                    <td colSpan="3" onClick={navigateUp} style={{ cursor: 'pointer', color: '#007acc' }}>[ .. ]</td>
                </tr>
                )}
                {sortedFiles.map(f => {
                const fullPath = getFullPath(f.name);
                const isSelected = selectedPaths.has(fullPath);
                return (
                    <tr 
                    key={f.name} 
                    className={`file-row ${isSelected ? 'selected' : ''}`} 
                    draggable
                    onDragStart={(e) => onDragStart(e, f)}
                    onDoubleClick={() => f.isDir ? navigateTo(f.name) : handleDownload(f.name, f.isDir)}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ x: e.clientX, y: e.clientY, file: f });
                    }}
                    >
                    <td><input type="checkbox" checked={isSelected} onChange={() => toggleSelect(f.name)} /></td>
                    <td onClick={() => f.isDir ? navigateTo(f.name) : toggleSelect(f.name)} style={{ cursor: 'pointer' }}>
                        <span className="file-icon">{f.isDir ? '📁' : '📄'}</span> {f.name}
                    </td>
                    <td>{f.isDir ? '-' : f.size}</td>
                    <td>
                        <button onClick={() => handleDownload(f.name, f.isDir)} title="Скачать">⬇️</button>
                    </td>
                    </tr>
                );
                })}
            </tbody>
            </table>
        </div>
      )}

      {loading && <div className="files-loading-overlay"><div className="spinner"></div></div>}
      {error && <div className="files-error">{error}</div>}

      {contextMenu && createPortal(
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={() => setContextMenu(null)}>
          <div className="context-menu-item" onClick={() => handleDownload(contextMenu.file.name, contextMenu.file.isDir)}>⬇️ Скачать</div>
          <div className="context-menu-item" onClick={() => onCopy(getFullPath(contextMenu.file.name))}>📋 Копировать</div>
          <div className="context-menu-item" onClick={() => handleRename(contextMenu.file)}>✏️ Переименовать</div>
          <div className="context-menu-item" onClick={() => handleChmod(contextMenu.file)}>🔑 Права (chmod)</div>
          <div className="context-menu-divider" />
          <div className="context-menu-item delete" onClick={() => setDeleteConfirm({ paths: [getFullPath(contextMenu.file.name)], message: `Удалить "${contextMenu.file.name}"?` })}>🗑️ Удалить</div>
        </div>, document.body
      )}

      {deleteConfirm && (
        <div className="files-confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="files-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="files-confirm-message">{deleteConfirm.message}</div>
            <div className="files-confirm-buttons">
              <button className="confirm-no-btn" onClick={() => setDeleteConfirm(null)}>Отмена</button>
              <button className="confirm-yes-btn" onClick={confirmDelete}>Удалить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FilesView = ({ 
    sessionId, userId, status, path: pathProp, serverId, serverName, onRestore, onPathChange, 
    pinnedTab, pinnedStatus, pinnedServerId, pinnedServerName, onPinPathChange, onPinRestore, onPinClose,
    tasks, setTasks, showTasks, setShowTasks, onPinToggle
}) => {
  const [copyData, setCopyData] = useState(null); // { dragData, targetPath, targetSessionId, targetServerName }
  const [copyMethod, setCopyMethod] = useState(() => localStorage.getItem('files_copy_method') || 'stream');
  const [scpAvailable, setScpAvailable] = useState(true);
  const [checkingTools, setCheckingTools] = useState(false);

  useEffect(() => {
    if (copyData && copyData.dragData.sessionId !== copyData.targetSessionId) {
      setCheckingTools(true);
      eb.send('files.check.tools', { 
        sessionId: copyData.dragData.sessionId, 
        userId 
      }, (err, res) => {
        setCheckingTools(false);
        if (!err && res && res.body) {
          setScpAvailable(res.body.available);
          if (!res.body.available && copyMethod === 'direct') {
            setCopyMethod('stream');
          }
        }
      });
    }
  }, [copyData, userId]);

  const handleDropFiles = (dragData, targetPath, targetSessionId, targetServerName) => {
    if (dragData.paths.length === 1 && dragData.sourcePath === targetPath && dragData.serverName === targetServerName) {
        handleSingleCopy(targetSessionId, dragData.paths[0]);
        return;
    }
    setCopyData({ dragData, targetPath, targetSessionId, targetServerName });
  };

  const confirmCopy = () => {
    if (!copyData) return;
    const { dragData, targetPath, targetSessionId } = copyData;
    setCopyData(null);
    setShowTasks(true);

    dragData.paths.forEach(srcPath => {
        const taskId = Math.random().toString(36).substring(2, 9);
        const fileName = srcPath.split('/').pop();
        let destPath = targetPath === '/' ? `/${fileName}` : `${targetPath}/${fileName}`;
        if (targetPath === '.') destPath = fileName;
        
        setTasks(prev => ({
            ...prev,
            [taskId]: { srcPath, status: 'starting', percent: 0 }
        }));

        eb.send('files.copy', {
            srcPath,
            destPath,
            srcSessionId: dragData.sessionId,
            destSessionId: targetSessionId,
            userId,
            taskId,
            method: dragData.sessionId === targetSessionId ? 'local' : copyMethod
        }, (err, res) => {
            if (err) {
                setTasks(prev => ({
                    ...prev,
                    [taskId]: { ...prev[taskId], status: 'error', error: err.message, percent: 0, hadError: true }
                }));
            } else {
                setTasks(prev => {
                    const currentTask = prev[taskId];
                    if (currentTask && (currentTask.status === 'fallback' || currentTask.status === 'error' || currentTask.hadError)) {
                        return {
                            ...prev,
                            [taskId]: { ...currentTask, status: 'done', percent: 100 }
                        };
                    }
                    const next = { ...prev };
                    delete next[taskId];
                    return next;
                });
            }
        });
    });
  };

  const handleSingleCopy = (srcSessionId, srcPath) => {
    const newPath = prompt('Скопировать в (путь и название):', srcPath);
    if (!newPath || newPath === srcPath) return;

    const taskId = Math.random().toString(36).substring(2, 9);
    setShowTasks(true);
    setTasks(prev => ({
        ...prev,
        [taskId]: { srcPath, status: 'starting', percent: 0 }
    }));

    eb.send('files.copy', {
        srcPath,
        destPath: newPath,
        srcSessionId: srcSessionId,
        destSessionId: srcSessionId,
        userId,
        taskId,
        method: 'local'
    }, (err, res) => {
        if (err) {
            setTasks(prev => ({
                ...prev,
                [taskId]: { ...prev[taskId], status: 'error', error: err.message, percent: 0 }
            }));
        } else {
            setTasks(prev => {
                const currentTask = prev[taskId];
                if (currentTask && (currentTask.status === 'error' || currentTask.hadError)) {
                    return {
                        ...prev,
                        [taskId]: { ...currentTask, status: 'done', percent: 100 }
                    };
                }
                const next = { ...prev };
                delete next[taskId];
                return next;
            });
        }
    });
  };

  const installScp = () => {
    if (!copyData) return;
    const taskId = 'install-' + Math.random().toString(36).substring(2, 7);
    const sessionId = copyData.dragData.sessionId;
    
    setTasks(prev => ({
        ...prev,
        [taskId]: { srcPath: 'Установка scp/sshpass', status: 'starting', percent: 0 }
    }));
    setShowTasks(true);

    eb.send('files.install.tools', { sessionId, userId, taskId }, (err, res) => {
        if (!err) {
            // Re-check after a delay or just wait for success
            setTimeout(() => {
                eb.send('files.check.tools', { sessionId, userId }, (err2, res2) => {
                    if (!err2 && res2 && res2.body) {
                        setScpAvailable(res2.body.available);
                    }
                });
            }, 5000);
            
            // Удаляем задачу из списка после успешного ответа от бекенда
            setTasks(prev => {
                const next = { ...prev };
                delete next[taskId];
                return next;
            });
        } else {
            setTasks(prev => ({
                ...prev,
                [taskId]: { ...prev[taskId], status: 'error', error: err.message, percent: 0 }
            }));
        }
    });
  };

  return (
    <div className="files-view">
        <div className="files-container">
            <FilePanel 
                sessionId={sessionId} 
                userId={userId} 
                status={status} 
                initialPath={pathProp} 
                serverId={serverId}
                serverName={serverName}
                onPathChange={onPathChange}
                onRestore={onRestore}
                onDropFiles={(data, path) => handleDropFiles(data, path, sessionId, serverName)}
                onPinToggle={onPinToggle}
                isCurrentlyPinned={pinnedTab?.sessionId === sessionId}
                onCopy={(srcPath) => handleSingleCopy(sessionId, srcPath)}
            />
            {pinnedTab && (
                <FilePanel 
                    sessionId={pinnedTab.sessionId} 
                    userId={userId} 
                    status={pinnedStatus || 'connected'} 
                    initialPath={pinnedTab.path} 
                    serverId={pinnedServerId}
                    serverName={pinnedServerName}
                    onPathChange={onPinPathChange}
                    onRestore={onPinRestore}
                    isPinned
                    onPinClose={onPinClose}
                    onDropFiles={(data, path) => handleDropFiles(data, path, pinnedTab.sessionId, pinnedServerName)}
                    onCopy={(srcPath) => handleSingleCopy(pinnedTab.sessionId, srcPath)}
                />
            )}
        </div>

        {copyData && (
            <div className="copy-confirm-overlay">
                <div className="copy-confirm-modal">
                    <div style={{marginBottom: 20}}>
                        <div style={{marginBottom: 10, fontSize: '14px', fontWeight: 'bold'}}>Подтверждение копирования</div>
                        
                        {copyData.dragData.sessionId !== copyData.targetSessionId && (
                            <div className="copy-method-container" style={{marginBottom: 15, borderBottom: '1px solid #444', paddingBottom: 15}}>
                                <div className="copy-method-options">
                                    <label className="copy-method-option">
                                        <input 
                                            type="radio" 
                                            name="copyMethod" 
                                            value="stream" 
                                            checked={copyMethod === 'stream'} 
                                            onChange={(e) => {
                                                setCopyMethod(e.target.value);
                                                localStorage.setItem('files_copy_method', e.target.value);
                                            }} 
                                        />
                                        <span>Потоком (через бэкенд)</span>
                                    </label>
                                    <label className={`copy-method-option ${!scpAvailable ? 'disabled' : ''}`}>
                                        <input 
                                            type="radio" 
                                            name="copyMethod" 
                                            value="direct" 
                                            disabled={!scpAvailable}
                                            checked={copyMethod === 'direct'} 
                                            onChange={(e) => {
                                                setCopyMethod(e.target.value);
                                                localStorage.setItem('files_copy_method', e.target.value);
                                            }} 
                                        />
                                        <span>Напрямую (SCP) {!scpAvailable && '(недоступно)'}</span>
                                    </label>
                                </div>
                                {!scpAvailable && !checkingTools && (
                                    <div style={{marginTop: 8, fontSize: '11px', color: '#e81123', display: 'flex', alignItems: 'center', gap: 8}}>
                                        <span>Нужно установить scp и sshpass на сервере-источнике</span>
                                        <button className="install-tool-btn" onClick={installScp}>Установить scp</button>
                                    </div>
                                )}
                                {checkingTools && <div style={{marginTop: 8, fontSize: '11px', color: '#aaa'}}>Проверка доступности SCP...</div>}
                            </div>
                        )}

                        <div className="copy-info-row">
                            <span className="copy-info-label">Откуда:</span>
                            <span className="copy-info-value">
                                <b className="panel-server-name">{copyData.dragData.serverName}</b>: {copyData.dragData.sourcePath}
                            </span>
                        </div>
                        <div className="copy-info-row">
                            <span className="copy-info-label">Куда:</span>
                            <span className="copy-info-value">
                                <b className="panel-server-name">{copyData.targetServerName}</b>: {copyData.targetPath}
                            </span>
                        </div>
                        <div style={{fontSize: '13px', color: '#ccc', marginTop: 15}}>
                            Объектов: <b>{copyData.dragData.paths.length}</b> ({copyData.dragData.paths.map(p => p.split('/').pop() || '/').join(', ')})
                        </div>
                    </div>
                    <div className="files-confirm-buttons">
                        <button className="confirm-no-btn" onClick={() => setCopyData(null)}>Отмена</button>
                        <button className="confirm-yes-btn" onClick={confirmCopy}>Копировать</button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};

export default FilesView;
