import React, { useState, useEffect, useRef } from 'react';
import { eb, subscribeEb, EventBus, registerHandler } from './services/eventBus';
import MatrixBackground from './components/MatrixBackground';
import RetryTimer from './components/RetryTimer';
import LoginForm from './components/LoginForm';
import SshTerminal from './components/SshTerminal';
import DockerView from './components/DockerView';
import FilesView from './components/FilesView';
import TasksWidget from './components/TasksWidget';
import './components/FilesView.css';

function App() {
  const [user, setUser] = useState(null);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [connected, setConnected] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [availableServers, setAvailableServers] = useState([]);
  const [isTerminalVisible, setIsTerminalVisible] = useState(() => {
    return localStorage.getItem('ssh_widget_visible') === 'true';
  });
  const [widgetPos, setWidgetPos] = useState(() => {
    try {
      const saved = localStorage.getItem('ssh_widget_pos');
      return saved ? JSON.parse(saved) : { x: 0, y: 0 };
    } catch (e) {
      return { x: 0, y: 0 };
    }
  });
  const [widgetSize, setWidgetSize] = useState(() => {
    try {
      const saved = localStorage.getItem('ssh_widget_size');
      return saved ? JSON.parse(saved) : { width: window.innerWidth * 0.8, height: window.innerHeight * 0.6 };
    } catch (e) {
      return { width: window.innerWidth * 0.8, height: window.innerHeight * 0.6 };
    }
  });
  const [isDragging, setIsDragging] = useState(false);
  const [resizing, setResizing] = useState(null); // 'r', 'b', 'rb', 'l', 't', 'lt', 'lb', 'rt'
  const [isMaximized, setIsMaximized] = useState(() => {
    return localStorage.getItem('ssh_widget_maximized') === 'true';
  });
  const [detachedTabs, setDetachedTabs] = useState(new Set());
  const [tabSearch, setTabSearch] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('ssh_history');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const detachedWindows = useRef({});
  const [draggedGroupId, setDraggedGroupId] = useState(null);
  const [dragOverGroupId, setDragOverGroupId] = useState(null);
  const [draggedTabIndex, setDraggedTabIndex] = useState(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState(null);
  const restoringRef = useRef(new Set());
  const [pinnedFilesTab, setPinnedFilesTab] = useState(() => {
    try {
      const saved = localStorage.getItem('ssh_pinned_files_tab');
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });

  const [tasks, setTasks] = useState({});
  const [showTasks, setShowTasks] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.code === 'KeyW') {
        e.preventDefault();
      }
    };

    const handleBeforeUnload = (e) => {
      if (tabs.length > 0) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [tabs.length]);

  useEffect(() => {
    if (!userId) return;
    const handler = (err, msg) => {
      if (msg && msg.body) {
        const { taskId, status, percent, srcPath, error } = msg.body;
        setTasks(prev => {
            const currentTask = prev[taskId];
            const hasHadIssues = currentTask && (currentTask.status === 'fallback' || currentTask.status === 'error' || currentTask.hadError);
            
            if (status === 'done' && !hasHadIssues) {
                const next = { ...prev };
                delete next[taskId];
                return next;
            }
            return {
                ...prev,
                [taskId]: { 
                    ...currentTask, 
                    srcPath, 
                    status, 
                    percent, 
                    error: error || (currentTask ? currentTask.error : null),
                    hadError: hasHadIssues || status === 'error' || status === 'fallback'
                }
            };
        });
      }
    };
    const addr = `ssh.out.${userId}.files.copy.progress`;
    return registerHandler(addr, handler);
  }, [userId]);

  useEffect(() => {
    if (pinnedFilesTab) {
      localStorage.setItem('ssh_pinned_files_tab', JSON.stringify(pinnedFilesTab));
    } else {
      localStorage.removeItem('ssh_pinned_files_tab');
    }
    
    if (eb.state === EventBus.OPEN && sessionsLoaded) {
      const currentStr = JSON.stringify(pinnedFilesTab);
      // Отправляем на бэкенд только если изменение произошло локально
      if (window._lastRemotePinnedTab !== currentStr) {
        // console.log('[DEBUG_LOG] Publishing layout to EB (local change)', currentStr);
        eb.publish('ssh.session.widget.layout', { pos: widgetPos, size: widgetSize, pinnedFilesTab });
      }
    }
  }, [pinnedFilesTab]);
  const searchInputRef = useRef(null);
  const skipUrlSync = useRef(false);

  useEffect(() => {
    localStorage.setItem('ssh_widget_visible', isTerminalVisible);
  }, [isTerminalVisible]);

  useEffect(() => {
    localStorage.setItem('ssh_widget_maximized', isMaximized);
  }, [isMaximized]);

  const updateUrl = (sessionId, viewMode, path = null, serverId = null) => {
    if (skipUrlSync.current) return;
    const url = new URL(window.location);
    if (sessionId) {
        url.searchParams.set('tab', sessionId);
    } else {
        url.searchParams.delete('tab');
    }
    
    if (viewMode) {
        url.searchParams.set('mode', viewMode);
    } else {
        url.searchParams.delete('mode');
    }

    if (path && viewMode === 'files') {
        url.searchParams.set('path', path);
    } else {
        url.searchParams.delete('path');
    }

    if (serverId) {
        url.searchParams.set('server', serverId);
    } else {
        url.searchParams.delete('server');
    }

    // Если это не первоначальная загрузка и URL изменился, пушим в историю
    if (window.location.search !== url.search) {
        window.history.pushState({}, '', url);
    }
  };

  useEffect(() => {
    const handlePopState = () => {
        const params = new URLSearchParams(window.location.search);
        const tabId = params.get('tab');
        const mode = params.get('mode');
        const path = params.get('path');
        const serverId = params.get('server');
        
        // Simple validation
        const validModes = ['terminal', 'docker', 'files'];
        const safeMode = validModes.includes(mode) ? mode : null;
        const safePath = (path && !path.includes('<script')) ? path : null;
        
        skipUrlSync.current = true;
        if (tabId) {
            setActiveTab(tabId);
            setIsTerminalVisible(true);
            setTabs(prev => prev.map(t => {
                if (t.id === tabId) {
                    const updates = {};
                    if (safeMode && t.viewMode !== safeMode) updates.viewMode = safeMode;
                    if (serverId && t.serverId !== serverId) updates.serverId = serverId;
                    if (safeMode === 'files') {
                        const targetPath = safePath || '.';
                        if (t.currentPath !== targetPath) updates.currentPath = targetPath;
                    }
                    return Object.keys(updates).length > 0 ? { ...t, ...updates } : t;
                }
                return t;
            }));
        } else if (serverId) {
            // Если в URL есть сервер, но нет таба, тоже открываем виджет
            setIsTerminalVisible(true);
            // activeTab будет обработан в useEffect
        } else {
            setActiveTab(null);
            setIsTerminalVisible(false);
        }
        skipUrlSync.current = false;
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (activeTab) {
        const tab = tabs.find(t => t.id === activeTab);
        if (tab) {
            updateUrl(activeTab, tab.viewMode, tab.currentPath, tab.serverId);
        }
    } else if (user) {
        updateUrl(null, null, null, null);
    }
  }, [activeTab, tabs]);

  const isEmpty = tabs.length === 0;

  useEffect(() => {
    if (isEmpty) {
      setIsSidebarCollapsed(false);
    }
  }, [isEmpty]);

  // Check if we are in detached mode
  const urlParams = new URLSearchParams(window.location.search);
  const detachedSessionId = urlParams.get('sessionId');
  const detachedMode = urlParams.get('mode') || 'terminal';
  const detachedPath = urlParams.get('path') || '.';
  const detachedServerId = urlParams.get('serverId') || '';


  useEffect(() => {
    fetch('/api/user')
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(data => {
        setUser(data.username);
        setUserId(data.userId);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleLogin = (username, userId) => {
    setUser(username);
    setUserId(userId);
    if (eb.state !== EventBus.OPEN) {
        //eb.onopen(); // This is hacky, better let the auto-reconnect or force it
    }
    // Force reconnect to ensure new session is used
    eb.close();
  };

  const handleLogout = () => {
    fetch('/api/logout', { method: 'POST' })
      .then(() => {
        setUser(null);
        setTabs([]);
        setActiveTab(null);
        setSessionsLoaded(false);
        setHistory([]);
        localStorage.removeItem('ssh_history');
        eb.close();
      });
  };

  useEffect(() => {
    localStorage.setItem('ssh_history', JSON.stringify(history));
  }, [history]);

  const dragStartOffset = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0, x: 0, y: 0, widgetX: 0, widgetY: 0 });

  useEffect(() => {
    if (detachedSessionId) {
        document.title = `Terminal ${detachedSessionId}`;
    }
  }, [detachedSessionId]);

  useEffect(() => {
    localStorage.setItem('ssh_widget_pos', JSON.stringify(widgetPos));
  }, [widgetPos]);

  useEffect(() => {
    localStorage.setItem('ssh_widget_size', JSON.stringify(widgetSize));
  }, [widgetSize]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) {
        setWidgetPos({
          x: e.clientX - dragStartOffset.current.x,
          y: e.clientY - dragStartOffset.current.y
        });
      } else if (resizing) {
        const deltaX = e.clientX - resizeStartSize.current.x;
        const deltaY = e.clientY - resizeStartSize.current.y;
        
        let newWidth = resizeStartSize.current.width;
        let newHeight = resizeStartSize.current.height;
        let newX = resizeStartSize.current.widgetX;
        let newY = resizeStartSize.current.widgetY;

        if (resizing.includes('r')) {
          newWidth = Math.max(400, resizeStartSize.current.width + deltaX);
        }
        if (resizing.includes('l')) {
          newWidth = Math.max(400, resizeStartSize.current.width - deltaX);
          if (newWidth > 400) {
            newX = resizeStartSize.current.widgetX + deltaX;
          } else {
            newX = resizeStartSize.current.widgetX + (resizeStartSize.current.width - 400);
          }
        }
        if (resizing.includes('b')) {
          newHeight = Math.max(300, resizeStartSize.current.height + deltaY);
        }
        if (resizing.includes('t')) {
          newHeight = Math.max(300, resizeStartSize.current.height - deltaY);
          if (newHeight > 300) {
            newY = resizeStartSize.current.widgetY + deltaY;
          } else {
            newY = resizeStartSize.current.widgetY + (resizeStartSize.current.height - 300);
          }
        }

        setWidgetSize({ width: newWidth, height: newHeight });
        setWidgetPos({ x: newX, y: newY });
      }
    };
    const handleMouseUp = () => {
        if (isDragging || resizing) {
          if (eb.state === EventBus.OPEN) {
            eb.publish('ssh.session.widget.layout', { pos: widgetPos, size: widgetSize, pinnedFilesTab });
          }
        }
        setIsDragging(false);
        setResizing(null);
    };

    if (isDragging || resizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, resizing, widgetPos, widgetSize]);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Only left click for dragging
    if (e.target.closest('button') || e.target.closest('.no-drag')) return;
    setIsDragging(true);
    dragStartOffset.current = {
      x: e.clientX - widgetPos.x,
      y: e.clientY - widgetPos.y
    };
  };

  const handleResizeDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(type);
    resizeStartSize.current = {
        width: widgetSize.width,
        height: widgetSize.height,
        x: e.clientX,
        y: e.clientY,
        widgetX: widgetPos.x,
        widgetY: widgetPos.y
    };
  };

  const handleTitleDoubleClick = () => {
    setIsMaximized(!isMaximized);
  };

  useEffect(() => {
    const interval = setInterval(() => {
        setDetachedTabs(prev => {
            let changed = false;
            const next = new Set(prev);
            for (const id of prev) {
                if (detachedWindows.current[id] && detachedWindows.current[id].closed) {
                    next.delete(id);
                    delete detachedWindows.current[id];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const detachTab = (e, sessionId) => {
    if (e) e.stopPropagation();
    const tab = tabs.find(t => t.id === sessionId);
    const mode = tab ? tab.viewMode : 'terminal';
    const path = tab?.currentPath || '.';
    const serverId = tab?.serverId || '';
    const win = window.open(`${window.location.pathname}?sessionId=${sessionId}&mode=${mode}&serverId=${serverId}${mode === 'files' ? `&path=${encodeURIComponent(path)}` : ''}`, `term_${sessionId}`, 'width=800,height=600');
    if (win) {
        detachedWindows.current[sessionId] = win;
        setDetachedTabs(prev => new Set(prev).add(sessionId));
    }
  };

  const attachTab = (e, sessionId) => {
    if (e) e.stopPropagation();
    if (detachedWindows.current[sessionId]) {
        detachedWindows.current[sessionId].close();
        delete detachedWindows.current[sessionId];
    }
    setDetachedTabs(prev => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
    });
  };

  const handleDragEnd = () => {
    setDraggedGroupId(null);
    setDragOverGroupId(null);
    setDraggedTabIndex(null);
    setDragOverTabIndex(null);
  };

  const handleTabDragStart = (e, index) => {
    e.dataTransfer.setData('tabIndex', index);
    e.dataTransfer.setData('dragType', 'tab');
    e.dataTransfer.effectAllowed = 'move';
    setDraggedTabIndex(index);
  };

  const handleTabDrop = (e, targetIndex) => {
    e.preventDefault();
    const dragType = e.dataTransfer.getData('dragType');
    const sourceIndex = e.dataTransfer.getData('tabIndex');
    handleDragEnd();

    if (dragType !== 'tab' || sourceIndex === '' || sourceIndex === targetIndex.toString()) return;
    
    setTabs(prev => {
      const sourceIdx = parseInt(sourceIndex, 10);
      if (prev[sourceIdx].serverId !== prev[targetIndex].serverId) return prev;
      
      const newTabs = [...prev];
      const [movedTab] = newTabs.splice(sourceIdx, 1);
      newTabs.splice(targetIndex, 0, movedTab);
      
      // Синхронизируем порядок с бэкендом
      if (eb.state === EventBus.OPEN) {
        eb.send('ssh.session.reorder', { order: newTabs.map(t => t.id) });
      }
      
      return newTabs;
    });
  };

  const handleGroupDragStart = (e, serverId) => {
    e.dataTransfer.setData('serverId', serverId);
    e.dataTransfer.setData('dragType', 'group');
    e.dataTransfer.effectAllowed = 'move';
    setDraggedGroupId(serverId);
  };

  const handleGroupDrop = (e, targetServerId) => {
    e.preventDefault();
    const dragType = e.dataTransfer.getData('dragType');
    const sourceServerId = e.dataTransfer.getData('serverId');
    handleDragEnd();
    
    if (dragType !== 'group' || !sourceServerId || sourceServerId === targetServerId) return;

    setTabs(prev => {
      const sourceTabs = prev.filter(t => t.serverId === sourceServerId);
      const remainingTabs = prev.filter(t => t.serverId !== sourceServerId);
      
      const targetIndex = remainingTabs.findIndex(t => t.serverId === targetServerId);
      if (targetIndex === -1) return prev;
      
      const newTabs = [...remainingTabs];
      newTabs.splice(targetIndex, 0, ...sourceTabs);
      
      // Синхронизируем порядок с бэкендом
      if (eb.state === EventBus.OPEN) {
        eb.send('ssh.session.reorder', { order: newTabs.map(t => t.id) });
      }
      
      return newTabs;
    });
  };

  useEffect(() => {
    if (!userId) return;
    const progressHandler = (err, msg) => {
      if (msg && msg.body) {
        const { sessionId, message } = msg.body;
        setTabs(prev => prev.map(t => 
          t.id === sessionId ? { ...t, progressMessage: message, status: message === 'Готово' ? 'connected' : 'connecting' } : t
        ));
      }
    };

    const sessionCreatedHandler = (err, msg) => {
      if (msg && msg.body) {
        const { sessionId, serverName, serverId, name, isDocker, viewMode } = msg.body;
        if (serverId) {
          setHistory(prev => {
            const next = prev.filter(id => id !== serverId);
            return [serverId, ...next].slice(0, 20);
          });
        }
        setTabs(prev => {
          const existing = prev.find(t => t.id === sessionId);
          if (existing) {
            return prev.map(t => t.id === sessionId ? { 
                ...t, 
                status: 'connected', 
                serverId, 
                name: name || t.name, 
                isDocker: isDocker !== undefined ? isDocker : t.isDocker,
                viewMode: viewMode || t.viewMode
            } : t);
          }

          if (isDocker) {
            const hasDockerView = prev.some(t => t.serverId === serverId && t.viewMode === 'docker');
            if (!hasDockerView) {
              return prev;
            }
          }

          return [...prev, { 
            id: sessionId, 
            name: name || serverName, 
            status: 'connected', 
            serverId, 
            isDocker: !!isDocker,
            viewMode: viewMode || 'terminal'
          }];
        });
      }
    };

    const sessionTerminatedHandler = (err, msg) => {
      if (msg && msg.body) {
        const { sessionId, byUser } = msg.body;
        setTabs(prev => {
          const tab = prev.find(t => t.id === sessionId);
          if (tab && tab.status === 'connected' && !byUser) {
            // Если сессия закрыта по таймауту, переводим в состояние restorable
            return prev.map(t => t.id === sessionId ? { ...t, status: 'restorable', progressMessage: 'Сессия уснула' } : t);
          }

          const index = prev.findIndex(t => t.id === sessionId);
          if (index === -1) return prev;
          
          const newTabs = prev.filter(t => t.id !== sessionId);
          
          setActiveTab(current => {
            if (current === sessionId) {
              if (newTabs.length > 0) {
                const nextActive = newTabs[index - 1] || newTabs[0];
                return nextActive.id;
              }
              return null;
            }
            return current;
          });
          
          return newTabs;
        });
      }
    };

    const sessionReorderedHandler = (err, msg) => {
      if (msg && msg.body && msg.body.order) {
        const newOrder = msg.body.order;
        setTabs(prev => {
          const tabMap = new Map(prev.map(t => [t.id, t]));
          const orderedTabs = [];
          newOrder.forEach(id => {
            if (tabMap.has(id)) {
              orderedTabs.push(tabMap.get(id));
              tabMap.delete(id);
            }
          });
          tabMap.forEach(t => orderedTabs.push(t));
          
          if (JSON.stringify(orderedTabs.map(t => t.id)) === JSON.stringify(prev.map(t => t.id))) {
            return prev;
          }
          return orderedTabs;
        });
      }
    };

    const widgetLayoutHandler = (err, msg) => {
      if (msg && msg.body && !isDragging && !resizing) {
    const { pos, size, pinnedFilesTab: remotePinnedTab } = msg.body;
    // console.log('[DEBUG_LOG] Received layout from remote:', { pos, size, remotePinnedTab });
    if (pos) setWidgetPos(pos);
    if (size) setWidgetSize(size);
    if (remotePinnedTab !== undefined) {
      const remoteStr = JSON.stringify(remotePinnedTab);
      const currentStr = JSON.stringify(pinnedFilesTab);
      
      if (currentStr !== remoteStr) {
        // console.log('[DEBUG_LOG] Updating pinnedFilesTab from remote');
        window._lastRemotePinnedTab = remoteStr;
        setPinnedFilesTab(remotePinnedTab);
      }
    }
      }
    };

    const viewModeSyncHandler = (err, msg) => {
      if (msg && msg.body && msg.body.sessionId && msg.body.viewMode) {
        const { sessionId, viewMode, serverId } = msg.body;
        setTabs(prev => {
          const currentTab = prev.find(t => t.id === sessionId);
          const oldViewMode = currentTab ? currentTab.viewMode : null;

          const idsToRemove = [];
          if ((oldViewMode === 'docker' || oldViewMode === 'files') && viewMode !== oldViewMode) {
            prev.forEach(t => {
              if (t.serverId === serverId && t.isDocker) {
                idsToRemove.push(t.id);
              }
            });
          }

          const nextTabs = prev.map(t => {
            if (t.id === sessionId) {
              return { ...t, viewMode };
            }
            if (viewMode === 'docker' && t.serverId === serverId && t.viewMode === 'docker') {
              return { ...t, viewMode: 'terminal' };
            }
            return t;
          }).filter(t => !idsToRemove.includes(t.id));

          if (idsToRemove.length > 0) {
            setActiveTab(current => {
              if (idsToRemove.includes(current)) {
                return sessionId;
              }
              return current;
            });
          }

          return nextTabs;
        });
      }
    };

    const setupEB = () => {
      if (!userId) return;
      console.log('Setting up EventBus handlers and syncing sessions for user:', userId);
      setConnected(true);
      eb.send('ssh.session.list', {}, (err, res) => {
        if (err) {
            console.error('Failed to list sessions:', err);
            return;
        }
        if (res && res.body) {
          console.log('Received active sessions from backend:', res.body);
          const params = new URLSearchParams(window.location.search);
          const urlTabId = params.get('tab');
          const urlPath = params.get('path');
          const urlMode = params.get('mode');
          const urlServerId = params.get('server');

          const backendSessions = res.body.map(s => {
            const isFiles = s.viewMode === 'files';
            let path = '.';
            if (isFiles && urlTabId === s.id && urlPath) {
                path = urlPath;
            }
            return { 
              id: s.id, 
              name: s.name || s.serverName || s.id, 
              status: s.status || 'connected',
              serverId: s.serverId,
              viewMode: s.viewMode || 'terminal',
              isDocker: s.isDocker || false,
              currentPath: path
            };
          });
          
          setTabs(prev => {
            const merged = backendSessions.map(b => {
              const existing = prev.find(p => p.id === b.id);
              // Если локально мы уже перешли в статус connecting, а бэкенд все еще говорит restorable,
              // сохраняем наш статус connecting, чтобы избежать "прыжков" и повторных запросов.
              if (existing && existing.status === 'connecting' && b.status === 'restorable') {
                return { ...b, status: 'connecting', progressMessage: existing.progressMessage || 'Восстановление...' };
              }
              return b;
            });
            
            // Добавляем те, что есть только в prev (например, только что созданные и еще не дошедшие до бэкенда)
            const onlyInPrev = prev.filter(p => p.status === 'connecting' && !backendSessions.find(b => b.id === p.id));
            const result = [...merged, ...onlyInPrev];
            
            console.log('Syncing tabs. Prev count:', prev.length, 'New count:', result.length);
            return result;
          });
          setSessionsLoaded(true);

          if (urlTabId && backendSessions.find(b => b.id === urlTabId)) {
            setActiveTab(urlTabId);
            setIsTerminalVisible(true);
            if (urlMode) {
              setTabs(prev => prev.map(t => t.id === urlTabId ? { ...t, viewMode: urlMode } : t));
            }
          } else if (urlServerId) {
             const existingTab = backendSessions.find(b => b.serverId === urlServerId && !b.isDocker);
             if (existingTab) {
                setActiveTab(existingTab.id);
                setIsTerminalVisible(true);
                if (urlMode) {
                    setTabs(prev => prev.map(t => t.id === existingTab.id ? { ...t, viewMode: urlMode } : t));
                }
             }
          } else if (!activeTab && backendSessions.length > 0) {
            setActiveTab(backendSessions[0].id);
          }
        }
      });

      eb.send('ssh.servers.list', {}, (err, res) => {
        if (!err && res && res.body) {
          setAvailableServers(res.body);
          
          const params = new URLSearchParams(window.location.search);
          const urlTabId = params.get('tab');
          const urlServerId = params.get('server');
          const urlMode = params.get('mode') || 'terminal';
          const urlPath = params.get('path') || '.';

          if (urlServerId) {
            eb.send('ssh.session.list', {}, (errList, resList) => {
              if (!errList && resList && resList.body) {
                const currentSessions = resList.body;
                const hasTab = currentSessions.some(s => (s.id === urlTabId) || (s.serverId === urlServerId && !s.isDocker));
                
                if (!hasTab) {
                  const server = res.body.find(s => s.id === urlServerId);
                  if (server) {
                    // Используем setTimeout чтобы стейт успел обновиться
                    setTimeout(() => createSession(urlServerId, null, null, urlMode, urlPath), 100);
                  }
                }
              }
            });
          }
        }
      });

    };

    const unsubs = [
      registerHandler(`ssh.out.${userId}.ssh.session.progress`, progressHandler),
      registerHandler(`ssh.out.${userId}.ssh.session.created`, sessionCreatedHandler),
      registerHandler(`ssh.out.${userId}.ssh.session.terminated`, sessionTerminatedHandler),
      registerHandler(`ssh.out.${userId}.ssh.session.reordered`, sessionReorderedHandler),
      registerHandler(`ssh.out.${userId}.ssh.widget.layout`, widgetLayoutHandler),
      registerHandler(`ssh.out.${userId}.ssh.viewmode.sync`, viewModeSyncHandler)
    ];

    const checkAuth = () => {
      fetch('/api/user')
        .then(res => {
          if (res.status === 401) {
            setUser(null);
            setUserId(null);
          }
        })
        .catch(() => {});
    };

    const unsubOpen = subscribeEb('open', setupEB);
    const unsubClose = subscribeEb('close', () => {
      setConnected(false);
      setSessionsLoaded(false);
      checkAuth();
    });
    const unsubError = subscribeEb('error', (err) => console.error('EB Error:', err));

    return () => {
      unsubOpen();
      unsubClose();
      unsubError();
      unsubs.forEach(unsub => unsub());
    };
  }, [userId]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (connected && eb.state === EventBus.OPEN) {
        if (detachedSessionId) {
          eb.send('ssh.session.keepalive', { sessionId: detachedSessionId });
        } else {
          tabs.forEach(tab => {
            if (tab.status === 'connected') {
              eb.send('ssh.session.keepalive', { sessionId: tab.id });
            }
          });
        }
      }
    }, 60000); // Каждую минуту при 3-минутном таймауте
    return () => clearInterval(interval);
  }, [tabs, connected, detachedSessionId]);

  const refreshSessions = () => {
    if (eb.state !== EventBus.OPEN) return;
    eb.send('ssh.session.list', {}, (err, res) => {
      if (!err && res && res.body) {
        console.log('Refreshing sessions from backend:', res.body);
        const backendSessions = res.body.map(s => ({
          id: s.id,
          name: s.name || s.serverName || s.id,
          status: s.status || 'connected',
          serverId: s.serverId,
          viewMode: s.viewMode || 'terminal',
          isDocker: s.isDocker || false,
          currentPath: '.'
        }));

        setTabs(prev => {
          const newTabs = backendSessions.map(bs => {
            const existing = prev.find(p => p.id === bs.id);
            if (existing) {
              return { ...bs, currentPath: existing.currentPath || '.' };
            }
            return bs;
          });

          // Сохраняем сессии в статусе 'connecting' или 'error', которых еще нет в списке с бэкенда
          const stillPending = prev.filter(p => 
            (p.status === 'connecting' || p.status === 'error') && !backendSessions.find(bs => bs.id === p.id)
          );

          return [...newTabs, ...stillPending];
        });
      }
    });
  };

  const handleSessionError = (sessionId, err) => {
    setTabs(prev => prev.map(t =>
      t.id === sessionId ? { ...t, status: 'error', progressMessage: err.message || 'unknown error' } : t
    ));
    if (err.message && err.message.includes('Превышен лимит открытых')) {
      refreshSessions();
    }
  };

  const createSession = (serverId, command = null, customName = null, viewMode = 'terminal', initialPath = '.', activate = true) => {
    if (eb.state !== EventBus.OPEN) {
      console.error('Cannot create session: EventBus is not connected');
      return;
    }
    const server = availableServers.find(s => s.id === serverId);
    const sessionId = `sess_${serverId}_${Date.now()}`;
    const isDocker = command && command.startsWith('docker exec');
    
    setTabs(prev => [...prev, { 
        id: sessionId, 
        name: customName || (server ? server.name : serverId), 
        serverId: serverId,
        status: 'connecting', 
        progressMessage: 'Запуск подключения...',
        viewMode: viewMode,
        isDocker: !!isDocker,
        command: command,
        currentPath: initialPath
    }]);

    if (activate) {
        setActiveTab(sessionId);
        setIsTerminalVisible(true);
        setTabSearch('');
    }

    const config = { 
        sessionId, 
        serverId, 
        command, 
        name: customName || (server ? server.name : serverId),
        viewMode: viewMode
    };
    setTimeout(() => {
      eb.send('ssh.session.create', config, (err, res) => {
        if (err) {
          handleSessionError(sessionId, err);
        }
      });
    }, 50); // Даем время на монтирование компонента SshTerminal
  };

  const retrySession = (sessionId) => {
    const tab = tabs.find(t => t.id === sessionId);
    if (!tab) return;

    setTabs(prev => prev.map(t => 
      t.id === sessionId ? { ...t, status: 'connecting', progressMessage: 'Повторное подключение...' } : t
    ));

    const config = { 
        sessionId, 
        serverId: tab.serverId, 
        command: tab.command, 
        name: tab.name, 
        viewMode: tab.viewMode 
    };
    setTimeout(() => {
      eb.send('ssh.session.create', config, (err, res) => {
        if (err) {
          handleSessionError(sessionId, err);
        }
      });
    }, 50);
  };

  const restoreSession = (sessionId) => {
    if (eb.state !== EventBus.OPEN) {
        console.warn('Cannot restore session: EventBus not open', sessionId);
        return;
    }
    
    // Предотвращаем множественные одновременные запросы на восстановление одного ID
    if (restoringRef.current.has(sessionId)) {
        console.log('Restoration already in progress for', sessionId);
        return;
    }

    // Проверяем текущий статус таба. Мы используем текущее состояние tabs из замыкания компонента.
    const currentTab = tabs.find(t => t.id === sessionId);
    if (!currentTab || currentTab.status !== 'restorable') {
        return;
    }

    console.log('Marking session as connecting for restoration:', sessionId);
    restoringRef.current.add(sessionId);
    setTabs(prev => prev.map(t => 
        t.id === sessionId ? { ...t, status: 'connecting', progressMessage: 'Восстановление сессии...' } : t
    ));

    console.log('Sending ssh.session.restore for', sessionId);
    
    // Гарантированная очистка через 15 секунд, если бэкенд молчит
    const timeout = setTimeout(() => {
        if (restoringRef.current.has(sessionId)) {
            console.warn('Restoration timeout reached for', sessionId);
            restoringRef.current.delete(sessionId);
            setTabs(prev => prev.map(t => 
                (t.id === sessionId && t.status === 'connecting') ? { ...t, status: 'error', progressMessage: 'Таймаут восстановления' } : t
            ));
        }
    }, 15000);

    eb.send('ssh.session.restore', { sessionId }, (err, res) => {
        console.log('Received response for ssh.session.restore:', sessionId, { err, res });
        clearTimeout(timeout);
        restoringRef.current.delete(sessionId);
        
        if (err) {
            handleSessionError(sessionId, err);
        }
    });
  };

  useEffect(() => {
    if (connected && sessionsLoaded && !detachedSessionId) {
        if (activeTab) {
            const tab = tabs.find(t => t.id === activeTab);
            if (tab) {
                if (tab.status === 'restorable') {
                    restoreSession(activeTab);
                }
            } else if (availableServers.length > 0) {
                // Если активный таб не найден в списке, значит мы перешли по истории ("Назад") 
                // к сессии, которая была закрыта. Пробуем восстановить по serverId из URL.
                const params = new URLSearchParams(window.location.search);
                const urlTabId = params.get('tab');
                const urlServerId = params.get('server');
                
                if (activeTab === urlTabId && urlServerId) {
                    const existingTab = tabs.find(t => t.serverId === urlServerId && !t.isDocker);
                    if (existingTab) {
                        console.log('Переключение на существующий таб для сервера:', urlServerId);
                        setActiveTab(existingTab.id);
                    } else {
                        const urlMode = params.get('mode') || 'terminal';
                        const urlPath = params.get('path') || '.';
                        console.log('Воссоздание сессии из истории для сервера:', urlServerId);
                        createSession(urlServerId, null, null, urlMode, urlPath);
                    }
                }
            }
        }

        // Также восстанавливаем закрепленный таб, если он в статусе restorable и видим (активен FilesView в основном окне)
        if (pinnedFilesTab && activeTab !== pinnedFilesTab.sessionId) {
            const activeTabData = tabs.find(t => t.id === activeTab);
            if (activeTabData && activeTabData.viewMode === 'files') {
                const pinnedTab = tabs.find(t => t.id === pinnedFilesTab.sessionId);
                if (pinnedTab && pinnedTab.status === 'restorable') {
                    restoreSession(pinnedFilesTab.sessionId);
                }
            }
        }
    }
  }, [activeTab, connected, tabs, availableServers, sessionsLoaded, pinnedFilesTab, detachedSessionId]);

  useEffect(() => {
    if (connected && detachedSessionId) {
        restoreSession(detachedSessionId);
    }
  }, [connected, detachedSessionId]);


  const setViewMode = (sessionId, viewMode) => {
    const currentTab = tabs.find(t => t.id === sessionId);
    if (!currentTab) return;

    if (viewMode === 'docker' || viewMode === 'files') {
      const existingTab = tabs.find(t => t.serverId === currentTab.serverId && t.viewMode === viewMode && t.id !== sessionId);
      if (existingTab) {
        setActiveTab(existingTab.id);
        return;
      }
    }

    const idsToRemove = [];
    if ((currentTab.viewMode === 'docker' || currentTab.viewMode === 'files') && viewMode !== currentTab.viewMode) {
      tabs.forEach(t => {
        if (t.serverId === currentTab.serverId && t.isDocker) {
          idsToRemove.push(t.id);
        }
      });
    }

    if (idsToRemove.length > 0 && eb.state === EventBus.OPEN) {
      idsToRemove.forEach(id => {
        eb.send('ssh.session.terminate', { sessionId: id });
      });
    }

    setTabs(prev => {
      const nextTabs = prev.map(t => {
        if (t.id === sessionId) return { ...t, viewMode };
        if ((viewMode === 'docker' || viewMode === 'files') && t.serverId === currentTab.serverId && t.viewMode === viewMode) {
          return { ...t, viewMode: 'terminal' };
        }
        return t;
      }).filter(t => !idsToRemove.includes(t.id));

      if (idsToRemove.length > 0) {
        setActiveTab(current => {
          if (idsToRemove.includes(current)) {
            return sessionId;
          }
          return current;
        });
      }

      return nextTabs;
    });
    if (eb.state === EventBus.OPEN) {
      eb.send('ssh.session.viewmode.set', { sessionId, viewMode });
      eb.publish('ssh.session.viewmode.sync', { sessionId, viewMode, serverId: currentTab.serverId });
    }
  };

  const handleModeAuxClick = (e, mode) => {
    if (e.button === 1) { // Middle click
      e.preventDefault();
      const currentTab = tabs.find(t => t.id === activeTab);
      if (!currentTab) return;
      
      const existingTab = (mode === 'docker' || mode === 'files') 
        ? tabs.find(t => t.serverId === currentTab.serverId && t.viewMode === mode)
        : null;

      if (!existingTab) {
        createSession(currentTab.serverId, null, null, mode, '.', false);
      }
    }
  };

  const closeTab = (e, sessionId) => {
    if (e) e.stopPropagation();
    const tabToClose = tabs.find(t => t.id === sessionId);
    if (!tabToClose) return;

    if (eb.state === EventBus.OPEN) {
      eb.send('ssh.session.terminate', { sessionId });
    }

    setTabs(prev => {
      const isDockerView = tabToClose.viewMode === 'docker';
      const idsToRemove = [sessionId];
      
      if (isDockerView) {
        prev.forEach(t => {
          if (t.serverId === tabToClose.serverId && t.isDocker) {
            idsToRemove.push(t.id);
          }
        });
      }

      const index = prev.findIndex(t => t.id === sessionId);
      const newTabs = prev.filter(t => !idsToRemove.includes(t.id));
      
      setActiveTab(current => {
        if (idsToRemove.includes(current)) {
          if (newTabs.length > 0) {
            const nextIdx = Math.min(index, newTabs.length - 1);
            return newTabs[nextIdx].id;
          }
          return null;
        }
        return current;
      });
      
      return newTabs;
    });
  };

  const closeGroup = (e, serverId) => {
    if (e) e.stopPropagation();
    const groupTabs = tabs.filter(t => (t.serverId || 'unknown') === serverId);
    
    if (eb.state === EventBus.OPEN) {
      groupTabs.forEach(t => {
        eb.send('ssh.session.terminate', { sessionId: t.id });
      });
    }

    setTabs(prev => {
      const newTabs = prev.filter(t => (t.serverId || 'unknown') !== serverId);
      
      setActiveTab(current => {
        const currentTab = prev.find(t => t.id === current);
        if (currentTab && (currentTab.serverId || 'unknown') === serverId) {
          if (newTabs.length > 0) {
            return newTabs[0].id;
          }
          return null;
        }
        return current;
      });
      
      return newTabs;
    });
  };

  const renderTabGroups = (tabsToRender) => {
    const groups = {};
    tabsToRender.forEach(({tab, originalIndex}) => {
      const sId = tab.serverId || 'unknown';
      if (!groups[sId]) {
        const server = availableServers.find(s => s.id === sId);
        groups[sId] = {
          serverId: sId,
          serverName: server ? server.name : sId,
          items: []
        };
      }
      groups[sId].items.push({ tab, originalIndex });
    });

    return Object.values(groups).map(group => {
      const isGroupOver = dragOverGroupId === group.serverId;
      const isGroupDragged = draggedGroupId === group.serverId;

      return (
        <div 
          key={group.serverId} 
          className={`tab-group ${isGroupOver ? 'drag-over' : ''}`}
          style={{ opacity: isGroupDragged ? 0.5 : 1 }}
          onDragOver={(e) => {
            if (draggedGroupId && draggedGroupId !== group.serverId) {
              e.preventDefault();
              setDragOverGroupId(group.serverId);
            }
          }}
          onDragLeave={() => setDragOverGroupId(null)}
        >
          <div 
            draggable
            onDragStart={(e) => handleGroupDragStart(e, group.serverId)}
            onDragEnd={handleDragEnd}
            onDrop={(e) => handleGroupDrop(e, group.serverId)}
            className="tab-group-header"
          >
            <span className="text-ellipsis">
              {group.serverName}
            </span>
            <span className="tab-count">
              {group.items.length}
            </span>
            <span 
              className="tab-group-close no-drag" 
              onClick={(e) => closeGroup(e, group.serverId)}
              title="Закрыть все подключения в этой группе"
            >
              &times;
            </span>
          </div>
          {(() => {
            const dockerViewTab = group.items.find(item => item.tab.viewMode === 'docker');
            const others = group.items.filter(item => item.tab.viewMode !== 'docker' && !item.tab.isDocker);
            const dockerTerminals = group.items.filter(item => item.tab.isDocker && item.tab.viewMode !== 'docker');
            
            const sortedItems = dockerViewTab 
                ? [...others, dockerViewTab, ...dockerTerminals]
                : group.items;

            return sortedItems.map(({ tab, originalIndex }) => {
              const isTabOver = dragOverTabIndex === originalIndex;
              const isTabDragged = draggedTabIndex === originalIndex;

              return (
                <div 
                  key={tab.id} 
                  draggable 
                  onDragStart={(e) => handleTabDragStart(e, originalIndex)} 
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => {
                    if (draggedTabIndex !== null && draggedTabIndex !== originalIndex) {
                      if (tabs[draggedTabIndex]?.serverId === group.serverId) {
                        e.preventDefault();
                        setDragOverTabIndex(originalIndex);
                      }
                    }
                  }}
                  onDragLeave={() => setDragOverTabIndex(null)}
                  onDrop={(e) => handleTabDrop(e, originalIndex)} 
                  onClick={() => setActiveTab(tab.id)} 
                  className={`tab-item no-drag ${activeTab === tab.id ? 'active' : ''} ${isTabOver ? 'drag-over' : ''} ${tab.isDocker && tab.viewMode !== 'docker' ? 'nested' : ''}`}
                  style={{ opacity: isTabDragged ? 0.5 : 1 }}
                >
                  <div className="tab-item-main">
                    <span className="tab-item-view-icon" title={tab.viewMode === 'docker' ? 'Docker mode' : (tab.viewMode === 'files' ? 'Files mode' : (tab.isDocker ? 'Docker terminal' : 'Terminal mode'))}>
                      {tab.viewMode === 'docker' ? '🐳' : (tab.viewMode === 'files' ? '📁' : (tab.isDocker ? '📦' : '❯'))}
                    </span>
                    <span className="tab-item-name" style={{ opacity: activeTab === tab.id ? 1 : 0.7 }}>
                      {tab.isDocker && tab.name && (
                        <span className="tab-container-name" style={{ marginRight: '4px' }}>
                          {tab.name}
                        </span>
                      )}
                      {(() => {
                        const timestamp = tab.id.split('_').pop();
                        if (!isNaN(timestamp) && timestamp.length > 10) {
                          return new Date(parseInt(timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        }
                        return 'Сессия';
                      })()}
                      {tab.status === 'connecting' && ' (подключение...)'}
                      {tab.status === 'restorable' && ' (сон)'}
                      {tab.status === 'error' && ' (ошибка)'}
                    </span>
                  </div>
                  <div className="tab-item-actions">
                    {activeTab === tab.id && (
                      <span 
                        onClick={(e) => detachedTabs.has(tab.id) ? attachTab(e, tab.id) : detachTab(e, tab.id)} 
                        className="tab-action-icon no-drag" 
                        title={detachedTabs.has(tab.id) ? "Attach to main window" : "Open in new window"}
                      >
                        {detachedTabs.has(tab.id) ? '⇊' : '↗'}
                      </span>
                    )}
                    <span 
                      onClick={(e) => closeTab(e, tab.id)} 
                      className="tab-close-icon no-drag" 
                      title="Закрыть соединение"
                    >
                      &times;
                    </span>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      );
    });
  };

  if (loading) {
    return (
        <div className="loading-screen">
            <MatrixBackground />
            <div className="spinner"></div>
        </div>
    );
  }

  if (!user) {
    return (
        <div className="login-screen">
            <MatrixBackground />
            <LoginForm onLogin={handleLogin} />
        </div>
    );
  }

  if (detachedSessionId) {
    return (
        <div className="terminal-viewport full-screen">
            {detachedMode === 'docker' ? (
                <DockerView 
                    sessionId={detachedSessionId} 
                    userId={userId} 
                    status="connected" 
                    serverName={availableServers.find(s => s.id === detachedServerId)?.name || detachedServerId}
                    onRestore={() => restoreSession(detachedSessionId)}
                    onOpenTerminal={(name, containerId) => createSession(detachedServerId, `docker exec -it ${containerId} sh -c "command -v bash >/dev/null && exec bash || exec sh"`, name)}
                />
            ) : detachedMode === 'files' ? (
                <FilesView 
                    sessionId={detachedSessionId} 
                    userId={userId} 
                    status="connected" 
                    path={detachedPath}
                    onRestore={() => restoreSession(detachedSessionId)}
                    onPathChange={(path) => {
                        const url = new URL(window.location);
                        url.searchParams.set('path', path);
                        window.history.replaceState({}, '', url);
                    }}
                />
            ) : (
                <SshTerminal 
                    sessionId={detachedSessionId} 
                    userId={userId} 
                    status="connected" 
                    onRestore={() => restoreSession(detachedSessionId)}
                />
            )}
        </div>
    );
  }

  const activeTabData = tabs.find(t => t.id === activeTab);
  const pinnedTabData = pinnedFilesTab ? tabs.find(t => t.id === pinnedFilesTab.sessionId) : null;
  const pinnedServerName = pinnedTabData ? (availableServers.find(s => s.id === pinnedTabData.serverId)?.name || pinnedTabData.serverId) : '';

  return (
    <div className="app-container">
      <MatrixBackground />

      {/* Floating Action Button */}
      <div 
        onClick={() => setIsTerminalVisible(!isTerminalVisible)}
        title="Toggle Terminals"
        className="fab"
      >
        {tabs.length}
      </div>

      {isTerminalVisible && (
        <div 
          className={`terminal-window ${isEmpty ? 'is-empty' : ''} ${isMaximized && !isEmpty ? 'is-maximized' : ''}`}
          style={{
            width: isEmpty ? '250px' : `${widgetSize.width}px`,
            height: isEmpty ? '450px' : `${widgetSize.height}px`,
            transform: `translate(${widgetPos.x}px, ${widgetPos.y}px)`
          }}
        >
          {/* Header (Drag Handle) */}
          <div 
            onMouseDown={handleMouseDown}
            onDoubleClick={handleTitleDoubleClick}
            onAuxClick={(e) => {
              if (e.button === 1 && isSidebarCollapsed) {
                setIsSidebarCollapsed(false);
              }
            }}
            className="terminal-header"
          >
            <div className="terminal-header-sidebar-tools no-drag">
                <button 
                    onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                    onAuxClick={(e) => {
                        if (e.button === 1) {
                            setIsSidebarCollapsed(false);
                        }
                    }}
                    title={isSidebarCollapsed ? "Развернуть список" : "Свернуть список"}
                    className={`sidebar-toggle no-drag ${isEmpty ? 'hidden' : ''}`}
                    disabled={isEmpty}
                >
                {isSidebarCollapsed ? '☰' : '◂'}
                </button>
            </div>
            <div className="terminal-header-center">
              <span 
                className={`terminal-header-title ${isEmpty ? 'is-empty' : ''}`}
              >
                {isEmpty ? 'SEARCH SERVERS' : (() => {
                  if (!activeTabData) return 'TERMINALS';
                  const server = availableServers.find(s => s.id === activeTabData.serverId);
                  const hostName = server ? server.name : activeTabData.serverId;
                  if (activeTabData.viewMode === 'docker') {
                    return `docker - ${hostName}`;
                  }
                  if (activeTabData.viewMode === 'files') {
                    return `files - ${hostName}`;
                  }
                  if (activeTabData.isDocker) {
                    return `docker - ${hostName} - ${activeTabData.name}`;
                  }
                  return activeTabData.name || 'TERMINALS';
                })()}
              </span>
              {!isEmpty && activeTab && !activeTabData?.isDocker && (
                <div className="header-tabs no-drag">
                  <button 
                    className={`header-tab ${activeTabData?.viewMode === 'terminal' ? 'active' : ''}`}
                    onClick={() => setViewMode(activeTab, 'terminal')}
                    onAuxClick={(e) => handleModeAuxClick(e, 'terminal')}
                  >TERMINAL</button>
                  <button 
                    className={`header-tab ${activeTabData?.viewMode === 'docker' ? 'active' : ''}`}
                    onClick={() => setViewMode(activeTab, 'docker')}
                    onAuxClick={(e) => handleModeAuxClick(e, 'docker')}
                  >DOCKER</button>
                  <button 
                    className={`header-tab ${activeTabData?.viewMode === 'files' ? 'active' : ''}`}
                    onClick={() => setViewMode(activeTab, 'files')}
                    onAuxClick={(e) => {
                        if (e.button === 1) {
                            setPinnedFilesTab({ 
                                sessionId: activeTab, 
                                serverId: activeTabData.serverId,
                                path: activeTabData.currentPath || '.' 
                            });
                        }
                    }}
                  >FILES</button>
                {activeTabData?.viewMode === 'files' && (
                  <div className="files-tools no-drag">
                    <TasksWidget 
                        tasks={tasks} 
                        setTasks={setTasks} 
                        showTasks={showTasks} 
                        setShowTasks={setShowTasks} 
                    />
                  </div>
                )}
                </div>
              )}
            </div>
            {!isEmpty && (
              <div className="terminal-header-user-info">
                  <span className="terminal-header-user-label">USER:</span>
                  <span className="terminal-header-user-name">{user.toUpperCase()}</span>
                  <button 
                      onClick={handleLogout}
                      className="logout-button no-drag"
                      title="Выйти"
                  >LOGOUT</button>
              </div>
            )}
            <button 
                onClick={() => setIsTerminalVisible(false)}
                className="close-button no-drag"
            >&times;</button>
          </div>
          
          <div className="main-content">
            {/* Sidebar */}
            <div 
              className="sidebar"
              style={{ 
                width: isSidebarCollapsed ? '0' : '250px', 
                borderRight: (isEmpty || isSidebarCollapsed) ? 'none' : '1px solid #444', 
              }}
            >
              {/* Tab Search */}
              <div className="sidebar-search-container">
                <input 
                  ref={searchInputRef}
                  type="text" 
                  placeholder="Поиск..." 
                  value={tabSearch}
                  onChange={e => setTabSearch(e.target.value)}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setTimeout(() => setIsInputFocused(false), 200)}
                  className="sidebar-search-input"
                />
              </div>

              {/* Unified List */}
              <div className="sidebar-list">
                {tabSearch ? (
                  <>
                    {/* Filtered Tabs */}
                    {renderTabGroups(
                      tabs.map((tab, originalIndex) => ({tab, originalIndex}))
                        .filter(({tab}) => tab.name.toLowerCase().includes(tabSearch.toLowerCase()))
                    )}
                    {/* Filtered History */}
                    {availableServers
                      .filter(server => history.includes(server.id) && server.name.toLowerCase().includes(tabSearch.toLowerCase()))
                      .sort((a, b) => history.indexOf(a.id) - history.indexOf(b.id))
                      .map(server => (
                        <div 
                          key={`hist-${server.id}`} 
                          onClick={() => createSession(server.id)} 
                          className="server-item history no-drag"
                        >
                          <span className="server-icon">+</span>
                          {server.name}
                        </div>
                      ))}
                    {/* Filtered Remaining Servers */}
                    {availableServers
                      .filter(server => !history.includes(server.id) && server.name.toLowerCase().includes(tabSearch.toLowerCase()))
                      .map(server => (
                        <div 
                          key={`srv-${server.id}`} 
                          onClick={() => createSession(server.id)} 
                          className="server-item new no-drag"
                        >
                          <span className="server-icon">+</span>
                          {server.name}
                        </div>
                      ))}
                    {tabs.filter(t => t.name.toLowerCase().includes(tabSearch.toLowerCase())).length === 0 && availableServers.filter(s => s.name.toLowerCase().includes(tabSearch.toLowerCase())).length === 0 && (
                      <div className="sidebar-empty-message">Ничего не найдено</div>
                    )}
                  </>
                ) : (isInputFocused || isEmpty) ? (
                  <>
                    {/* All Servers Mode (History First) */}
                    {[...availableServers].sort((a, b) => {
                      const aIdx = history.indexOf(a.id);
                      const bIdx = history.indexOf(b.id);
                      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                      if (aIdx !== -1) return -1;
                      if (bIdx !== -1) return 1;
                      return 0;
                    }).map(server => {
                      const isHistory = history.includes(server.id);
                      return (
                        <div 
                          key={`srv-${server.id}`} 
                          onClick={() => createSession(server.id)} 
                          className={`server-item no-drag ${isHistory ? 'history' : 'new'}`}
                        >
                          <span className="server-icon">+</span>
                          {server.name}
                        </div>
                      );
                    })}
                    {availableServers.length === 0 && (
                      <div className="sidebar-empty-message">Нет доступных серверов</div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Active Tabs Mode */}
                    {renderTabGroups(tabs.map((tab, originalIndex) => ({tab, originalIndex})))}
                  </>
                )}
              </div>
            </div>

            {/* Terminal Viewport */}
            {!isEmpty && (
              <div className="terminal-viewport">
                {tabs.map(tab => (
                  <div key={tab.id} style={{ display: activeTab === tab.id ? 'block' : 'none', height: '100%' }}>
                    {detachedTabs.has(tab.id) ? (
                      <div className="terminal-detached-message">
                        <div className="terminal-status-title">Терминал открыт в отдельном окне</div>
                        <button 
                          onClick={(e) => attachTab(e, tab.id)}
                          className="retry-button"
                        >Вернуть в это окно</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: (tab.status === 'connected' || tab.status === 'restorable') ? 'block' : 'none', height: '100%' }}>
                          {tab.viewMode === 'docker' ? (
                            <DockerView 
                                sessionId={tab.id} 
                                userId={userId} 
                                status={tab.status}
                                serverName={availableServers.find(s => s.id === tab.serverId)?.name || tab.serverId}
                                onRestore={() => restoreSession(tab.id)}
                                onOpenTerminal={(name, containerId) => createSession(tab.serverId, `docker exec -it ${containerId} sh -c "command -v bash >/dev/null && exec bash || exec sh"`, name)}
                            />
                          ) : tab.viewMode === 'files' ? (
                            <FilesView 
                                sessionId={tab.id}
                                userId={userId}
                                status={tab.status}
                                path={tab.currentPath}
                                serverId={tab.serverId}
                                serverName={availableServers.find(s => s.id === tab.serverId)?.name || tab.serverId}
                                onRestore={() => restoreSession(tab.id)}
                                onPathChange={(path) => {
                                  if (tab.currentPath !== path) {
                                    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, currentPath: path } : t));
                                  }
                                  updateUrl(tab.id, 'files', path, tab.serverId);
                                }}
                                pinnedTab={pinnedFilesTab}
                                pinnedStatus={pinnedTabData?.status}
                                pinnedServerId={pinnedFilesTab?.serverId}
                                pinnedServerName={pinnedServerName}
                                onPinPathChange={(path) => setPinnedFilesTab(prev => prev ? { ...prev, path } : null)}
                                onPinRestore={() => pinnedTabData && restoreSession(pinnedTabData.id)}
                                onPinClose={() => setPinnedFilesTab(null)}
                                onPinToggle={(data) => {
                                    if (pinnedFilesTab?.sessionId === data.sessionId) {
                                        setPinnedFilesTab(null);
                                    } else {
                                        setPinnedFilesTab(data);
                                    }
                                }}
                                tasks={tasks} 
                                setTasks={setTasks} 
                                showTasks={showTasks} 
                                setShowTasks={setShowTasks} 
                            />
                          ) : (
                            <SshTerminal sessionId={tab.id} userId={userId} status={tab.status} onRestore={() => restoreSession(tab.id)} />
                          )}
                        </div>
                        {tab.status === 'restorable' && tab.viewMode !== 'docker' && tab.viewMode !== 'files' && (
                          <div className="terminal-error-state">
                            <div className="terminal-status-title">Сессия уснула</div>
                            <div className="terminal-error-message">Соединение было закрыто из-за неактивности.</div>
                            <button 
                              onClick={() => restoreSession(tab.id)}
                              className="retry-button"
                            >Разбудить сессию</button>
                          </div>
                        )}
                        {tab.status === 'connecting' && (
                          <div className="terminal-loading-state">
                            <div className="spinner"></div>
                            <div style={{ marginTop: '20px', color: '#aaa' }}>{tab.progressMessage}</div>
                          </div>
                        )}
                        {tab.status === 'error' && (
                          <div className="terminal-error-state">
                            <div className="terminal-status-title">
                              {tab.progressMessage && tab.progressMessage.includes('лимит') ? 'Лимит превышен' : 'Ошибка подключения'}
                            </div>
                            <div className="terminal-error-message">{tab.progressMessage}</div>
                            <RetryTimer onRetry={() => retrySession(tab.id)} />
                            <button 
                              onClick={() => closeTab(null, tab.id)}
                              className="logout-button"
                            >Закрыть вкладку</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Resize handles */}
          {!isEmpty && !isMaximized && (
            <>
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'r')}
                className="resize-handle resize-handle-r"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'b')}
                className="resize-handle resize-handle-b"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'l')}
                className="resize-handle resize-handle-l"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 't')}
                className="resize-handle resize-handle-t"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'rb')}
                className="resize-handle resize-handle-rb"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'lt')}
                className="resize-handle resize-handle-lt"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'lb')}
                className="resize-handle resize-handle-lb"
              />
              <div 
                onMouseDown={(e) => handleResizeDown(e, 'rt')}
                className="resize-handle resize-handle-rt"
              />
            </>
          )}
        </div>
      )}


      {!connected && <div className="disconnected-banner">Disconnected from server</div>}
    </div>
  );
}


export default App;
