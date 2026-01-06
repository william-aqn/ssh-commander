import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { eb, subscribeEb, EventBus } from '../services/eventBus';

const SshTerminal = ({ sessionId, userId, status, onRestore }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);

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
    fitAddon.fit();
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const handler = (err, msg) => {
      if (msg && msg.body && msg.body.sessionId === sessionId) {
        term.write(msg.body.data);
      }
    };

    const setupHandlers = () => {
      eb.registerHandler(`ssh.out.${userId}.ssh.command.out`, handler);
      
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
      if (eb.state === EventBus.OPEN) {
        eb.unregisterHandler(`ssh.out.${userId}.ssh.command.out`, handler);
      }
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId, userId, status]);

  return <div ref={terminalRef} className="ssh-terminal-container" />;
};

export default SshTerminal;
