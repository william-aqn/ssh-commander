import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { eb, subscribeEb, EventBus, registerHandler } from '../services/eventBus';

const SshTerminal = ({ sessionId, serverId, userId, status, onRestore }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!serverId) return;

    const fetchComment = () => {
        eb.send('server.comment.get', { serverId }, (err, res) => {
            if (!err && res && res.body) {
                setComment(res.body.comment || '');
            }
        });
    };

    if (eb.state === EventBus.OPEN) {
        fetchComment();
    }
    const unsubOpen = subscribeEb('open', fetchComment);

    const unregisterNotify = registerHandler('server.comment.notify', (err, msg) => {
      if (msg && msg.body && msg.body.serverId === serverId) {
        setComment(msg.body.comment || '');
      }
    });

    return () => {
      unsubOpen();
      unregisterNotify();
    };
  }, [serverId]);

  const handleCommentChange = (e) => {
    const val = e.target.value.substring(0, 250);
    setComment(val);
    if (eb.state === EventBus.OPEN) {
        eb.send('server.comment.set', { serverId, comment: val });
    }
  };

  const handleMotdUpdate = () => {
    if (!comment.trim()) {
        if (!window.confirm('Очистить комментарий?')) {
            return;
        }
    } else if (!window.confirm('Обновить MOTD на сервере, используя текущий комментарий?')) {
        return;
    }

    if (eb.state === EventBus.OPEN) {
            eb.send('server.motd.set', { serverId, comment, sessionId }, (err, res) => {
                if (err) {
                    alert('Ошибка при обновлении MOTD: ' + (err.message || 'неизвестная ошибка'));
                }
            });
        } else {
            alert('EventBus не подключен');
        }
  };

  useEffect(() => {
    if (!userId || status !== 'connected') return;

    const term = new Terminal({
      cursorBlink: true,
      theme: { background: '#1e1e1e' },
      fontFamily: 'monospace',
      fontSize: 14
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.code === 'KeyW' && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        
        const msg = { sessionId, data: '\x17', userId };
        if (eb.state === EventBus.OPEN) {
          eb.publish('ssh.command.in', msg);
        }
        
        // Повторная отправка через небольшую задержку для надежности,
        // так как браузер может блокировать сокет в момент вызова алертов закрытия.
        setTimeout(() => {
          if (eb.state === EventBus.OPEN) {
            eb.publish('ssh.command.in', msg);
          }
        }, 50);

        return false;
      }
      return true;
    });

    fitAddon.fit();
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const handler = (err, msg) => {
      if (msg && msg.body && msg.body.sessionId === sessionId) {
        term.write(msg.body.data);
      }
    };

    const unregister = registerHandler(`ssh.out.${userId}.ssh.command.out`, handler);

    const setupHandlers = () => {
      // Запрашиваем историю при подключении
      eb.send('ssh.session.history', { sessionId }, (err, res) => {
        if (!err && res && res.body && res.body.history) {
          term.write(res.body.history);
        }
      });
    };

    const unsub = subscribeEb('open', setupHandlers);

    term.onData(data => {
      if (eb.state === EventBus.OPEN) {
        eb.publish('ssh.command.in', { sessionId, data });
      }
    });

    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    });
    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    return () => {
      unsub();
      unregister();
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId, userId, status]);

  return (
    <div className="ssh-terminal-container">
      <div ref={terminalRef} className="ssh-terminal-workspace" />
      <div className="ssh-terminal-status-bar">
        <span className="status-bar-label">Server Comment:</span>
        <input 
          type="text" 
          className="status-bar-input" 
          value={comment} 
          onChange={handleCommentChange}
          placeholder="Enter comment (max 250 chars)..."
          maxLength={250}
        />
        <button 
          className="status-bar-button" 
          onClick={handleMotdUpdate} 
          title="Set as Server MOTD"
        >
          MOTD
        </button>
      </div>
    </div>
  );
};

export default SshTerminal;
