import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { eb } from '../services/eventBus';

const FilesView = ({ sessionId, userId, status, path: pathProp, onRestore, onPathChange }) => {
  const [files, setFiles] = useState([]);
  const [diskInfo, setDiskInfo] = useState(null);
  const [currentPath, setCurrentPath] = useState(() => {
    if (pathProp) return pathProp;
    const params = new URLSearchParams(window.location.search);
    const urlTab = params.get('tab');
    const urlPath = params.get('path');
    if (urlTab === sessionId && urlPath && !urlPath.includes('<script')) return urlPath;
    return '.';
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
  const [calculatingSizes, setCalculatingSizes] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, file }
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { paths: [], message: "" }
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (onPathChange) onPathChange(currentPath);
  }, [currentPath]);

  useEffect(() => {
    if (pathProp && pathProp !== currentPath) {
      setCurrentPath(pathProp);
      fetchFiles(pathProp);
    }
  }, [pathProp]);

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
  }, [status]);

  const navigateTo = (name) => {
    const newPath = currentPath === '.' ? name : `${currentPath}/${name}`;
    fetchFiles(newPath);
  };

  const navigateUp = () => {
    if (currentPath === '.' || currentPath === '/') return;
    const parts = currentPath.split('/');
    parts.pop();
    const newPath = parts.length === 0 ? '.' : parts.join('/') || '/';
    fetchFiles(newPath);
  };

  const toggleSelect = (name) => {
    const fullPath = currentPath === '.' ? name : `${currentPath}/${name}`;
    const next = new Set(selectedPaths);
    if (next.has(fullPath)) next.delete(fullPath);
    else next.add(fullPath);
    setSelectedPaths(next);
  };

  const archiveAndDownload = (paths) => {
    setLoading(true);
    eb.send('files.archive', { sessionId, userId, paths }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        window.open(`/api/download?sessionId=${sessionId}&path=${encodeURIComponent(res.body.archivePath)}`, '_blank');
      } else {
        alert('Failed to create archive: ' + (err ? err.message : 'Unknown error'));
      }
    });
  };

  const handleDownload = (name, isDir) => {
    const fullPath = currentPath === '.' ? name : `${currentPath}/${name}`;
    if (isDir) {
      archiveAndDownload([fullPath]);
    } else {
      window.open(`/api/download?sessionId=${sessionId}&path=${encodeURIComponent(fullPath)}`, '_blank');
    }
  };

  const handleDownloadSelected = () => {
    if (selectedPaths.size === 0) return;
    
    const pathsArray = Array.from(selectedPaths);
    
    if (pathsArray.length === 1) {
      const fullPath = pathsArray[0];
      const fileName = fullPath.includes('/') ? fullPath.substring(fullPath.lastIndexOf('/') + 1) : (fullPath === '.' ? '' : fullPath);
      const file = files.find(f => f.name === fileName);
      if (file && file.isDir) {
        archiveAndDownload([fullPath]);
      } else {
        window.open(`/api/download?sessionId=${sessionId}&path=${encodeURIComponent(fullPath)}`, '_blank');
      }
      return;
    }

    archiveAndDownload(pathsArray);
  };

  const handleUploadFiles = async (filesToUpload) => {
    if (status !== 'connected' || !filesToUpload.length) return;
    
    setLoading(true);
    const formData = new FormData();
    for (let i = 0; i < filesToUpload.length; i++) {
      formData.append('files', filesToUpload[i]);
    }

    try {
      const response = await fetch(`/api/upload?sessionId=${sessionId}&path=${encodeURIComponent(currentPath)}`, {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        fetchFiles();
      } else {
        const errText = await response.text();
        alert('Ошибка при загрузке: ' + errText);
      }
    } catch (err) {
      alert('Ошибка при загрузке: ' + err.message);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === 'connected') {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (status !== 'connected') return;

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      handleUploadFiles(droppedFiles);
    }
  };

  const handleCreateDir = () => {
    const name = prompt('Введите имя директории:');
    if (!name) return;

    const path = currentPath === '.' ? name : `${currentPath}/${name}`;
    setLoading(true);
    eb.send('files.mkdir', { sessionId, userId, path }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        fetchFiles();
      } else {
        alert('Ошибка при создании директории: ' + (err ? err.message : 'Unknown error'));
      }
    });
  };

  const handleDelete = (pathsToDelete) => {
    if (!pathsToDelete || pathsToDelete.length === 0) return;
    
    let message;
    if (pathsToDelete.length === 1) {
      const fullPath = pathsToDelete[0];
      const fileName = fullPath.split('/').pop() || fullPath;
      message = `Вы уверены, что хотите безвозвратно удалить "${fileName}"?`;
    } else {
      message = `Вы уверены, что хотите безвозвратно удалить выбранные элементы (${pathsToDelete.length} шт.)?`;
    }

    setDeleteConfirm({ paths: pathsToDelete, message });
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    const pathsToDelete = deleteConfirm.paths;
    setDeleteConfirm(null);

    setLoading(true);
    eb.send('files.delete', { sessionId, userId, paths: pathsToDelete }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        fetchFiles();
      } else {
        alert('Ошибка при удалении: ' + (err ? err.message : 'Unknown error'));
      }
    });
  };

  const handleChmod = (file) => {
    const mode = prompt('Введите права (например, 755):', file.perm_numeric || '');
    if (!mode) return;

    const path = currentPath === '.' ? file.name : `${currentPath}/${file.name}`;
    setLoading(true);
    eb.send('files.chmod', { sessionId, userId, path, mode }, (err, res) => {
      setLoading(false);
      if (!err && res && res.body && res.body.status === 'ok') {
        fetchFiles();
      } else {
        alert('Ошибка при изменении прав: ' + (err ? err.message : 'Unknown error'));
      }
    });
  };

  const handleContextMenu = (e, file) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      file
    });
  };

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const sortedFiles = React.useMemo(() => {
    let sortableFiles = [...files];
    if (sortConfig !== null) {
      sortableFiles.sort((a, b) => {
        // Папки всегда первыми
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;

        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];

        if (sortConfig.key === 'size') {
          aVal = parseInt(aVal) || 0;
          bVal = parseInt(bVal) || 0;
        }

        if (aVal < bVal) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aVal > bVal) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableFiles;
  }, [files, sortConfig]);

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const getSortIcon = (key) => {
    if (sortConfig.key !== key) return '↕️';
    return sortConfig.direction === 'asc' ? '🔼' : '🔽';
  };

  return (
    <div className="files-view">
      {status === 'restorable' ? (
        <div className="terminal-error-state" style={{ background: 'transparent' }}>
           <div className="terminal-status-title">Сессия уснула</div>
           <div className="terminal-error-message">Для работы с файлами необходимо активное SSH-соединение.</div>
           <button onClick={onRestore} className="retry-button">Разбудить сессию</button>
        </div>
      ) : (
        <>
          <div className="files-header">
            <div className="files-breadcrumb">
              <span onClick={() => fetchFiles('.')} className="breadcrumb-item">root</span>
              {currentPath !== '.' && currentPath.split('/').filter(Boolean).map((part, i, arr) => (
                <span key={i} onClick={() => fetchFiles(arr.slice(0, i+1).join('/'))} className="breadcrumb-item">
                  / {part}
                </span>
              ))}
            </div>
            <div className="files-actions">
              {diskInfo && (
                <div className="disk-info" title={`Used: ${diskInfo.used} / Total: ${diskInfo.size}`}>
                   💽 Free: <span style={{color: '#00ff00'}}>{diskInfo.avail}</span> ({diskInfo.usePercent} used)
                </div>
              )}
              <button onClick={handleCreateDir} title="Создать директорию">📁+</button>
              <button onClick={() => fileInputRef.current?.click()} title="Загрузить файлы">📤</button>
              <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                multiple 
                onChange={(e) => handleUploadFiles(e.target.files)} 
              />
              <button onClick={() => fetchFiles()} title="Refresh">🔄</button>
            </div>
          </div>

          {error && <div className="files-error">{error}</div>}
          
          <div 
            className={`files-table-container ${isDragging ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <table className="files-table">
              <thead>
                <tr>
                  <th style={{ width: '30px' }}></th>
                  <th onClick={() => requestSort('name')} style={{ cursor: 'pointer' }}>
                    Имя {getSortIcon('name')}
                  </th>
                  <th onClick={() => requestSort('size')} style={{ cursor: 'pointer' }}>
                    Размер {getSortIcon('size')}
                  </th>
                  <th onClick={() => requestSort('date')} style={{ cursor: 'pointer' }}>
                    Дата {getSortIcon('date')}
                  </th>
                  <th onClick={() => requestSort('perm')} style={{ cursor: 'pointer' }}>
                    Права {getSortIcon('perm')}
                  </th>
                  <th style={{ width: '80px' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {currentPath !== '.' && (
                  <tr onDoubleClick={navigateUp} className="file-row">
                    <td></td>
                    <td colSpan="5" onClick={navigateUp} style={{ cursor: 'pointer', color: '#007acc' }}>
                      [ .. ]
                    </td>
                  </tr>
                )}
                {sortedFiles.map(f => {
                  const fullPath = currentPath === '.' ? f.name : `${currentPath}/${f.name}`;
                  const isSelected = selectedPaths.has(fullPath);
                  const displaySize = f.isDir ? (f.size === '4096' || f.size === '4.0K' ? '-' : f.size) : f.size;
                  return (
                    <tr 
                      key={f.name} 
                      className={`file-row ${isSelected ? 'selected' : ''}`} 
                      onDoubleClick={() => f.isDir ? navigateTo(f.name) : handleDownload(f.name, f.isDir)}
                      onContextMenu={(e) => handleContextMenu(e, f)}
                    >
                      <td>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(f.name)} />
                      </td>
                      <td onClick={() => f.isDir ? navigateTo(f.name) : toggleSelect(f.name)} style={{ cursor: 'pointer' }}>
                        <span className="file-icon">{f.isDir ? '📁' : '📄'}</span>
                        {f.name}
                      </td>
                      <td>{displaySize}</td>
                      <td>{f.date}</td>
                      <td>{f.perm}</td>
                      <td>
                        <button onClick={() => handleDownload(f.name, f.isDir)} title="Скачать">⬇️</button>
                        <button onClick={() => handleDelete([fullPath])} title="Удалить">🗑️</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          {selectedPaths.size > 0 && (
            <div className="files-selection-panel">
               <div className="selection-info">Выбрано элементов: {selectedPaths.size}</div>
               <div className="selection-actions">
                  <button onClick={() => setSelectedPaths(new Set())} className="selection-cancel-btn">Отмена</button>
                  <button onClick={() => handleDelete(Array.from(selectedPaths))} className="selection-delete-btn">Удалить всё</button>
                  <button onClick={handleDownloadSelected} className="selection-download-btn">Скачать всё</button>
               </div>
            </div>
          )}

          {contextMenu && createPortal(
            <div 
              className="context-menu" 
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-menu-item" onClick={() => { handleDownload(contextMenu.file.name, contextMenu.file.isDir); setContextMenu(null); }}>
                ⬇️ Скачать
              </div>
              <div className="context-menu-item" onClick={() => { handleChmod(contextMenu.file); setContextMenu(null); }}>
                🔑 Права (chmod)
              </div>
              <div className="context-menu-divider" />
              <div className="context-menu-item delete" onClick={() => { handleDelete([currentPath === '.' ? contextMenu.file.name : `${currentPath}/${contextMenu.file.name}`]); setContextMenu(null); }}>
                🗑️ Удалить
              </div>
            </div>,
            document.body
          )}

          {deleteConfirm && (
            <div className="files-confirm-overlay" onClick={() => setDeleteConfirm(null)}>
              <div className="files-confirm-modal" onClick={e => e.stopPropagation()}>
                <div className="files-confirm-title">
                  <span>⚠️</span> Подтверждение удаления
                </div>
                <div className="files-confirm-message">
                  {deleteConfirm.message}
                </div>
                <div className="files-confirm-buttons">
                  <button className="confirm-no-btn" onClick={() => setDeleteConfirm(null)}>Отмена</button>
                  <button className="confirm-yes-btn" onClick={confirmDelete}>Удалить</button>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="files-loading-overlay">
                <div className="spinner"></div>
                <div style={{marginTop: '10px', color: '#007acc'}}>Обработка...</div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default FilesView;
