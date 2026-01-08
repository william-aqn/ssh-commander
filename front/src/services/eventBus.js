import EventBus from '@vertx/eventbus-bridge-client.js';

export let eb = new EventBus('/eventbus');

const ebHandlers = {
  open: new Set(),
  close: new Set(),
  error: new Set()
};

const busHandlers = new Set();

const setupEb = (instance) => {
  instance.onopen = () => {
    console.log('EventBus connected');
    ebHandlers.open.forEach(cb => cb());
    
    // Re-register all handlers when bus is open
    busHandlers.forEach(({ address, handler }) => {
        try {
            eb.registerHandler(address, handler);
        } catch (e) {
            console.error('Failed to register handler', address, e);
        }
    });
  };
  instance.onclose = (e) => {
    console.warn('EventBus closed', e);
    ebHandlers.close.forEach(cb => cb(e));
    // Auto-reconnect
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      eb = new EventBus('/eventbus');
      setupEb(eb);
    }, 2000);
  };
  instance.onerror = (e) => {
    console.error('EventBus error', e);
    ebHandlers.error.forEach(cb => cb(e));
  };
};

setupEb(eb);

export const subscribeEb = (event, cb) => {
  ebHandlers[event].add(cb);
  if (event === 'open' && eb.state === EventBus.OPEN) {
    cb();
  }
  return () => ebHandlers[event].delete(cb);
};

export const registerHandler = (address, handler) => {
    const item = { address, handler };
    busHandlers.add(item);
    
    if (eb.state === EventBus.OPEN) {
        try {
            eb.registerHandler(address, handler);
        } catch (e) {
            console.error('Immediate registration failed', address, e);
        }
    }
    
    return () => {
        busHandlers.delete(item);
        if (eb.state === EventBus.OPEN) {
            try {
                eb.unregisterHandler(address, handler);
            } catch (e) {
                // Ignore errors on unregister
            }
        }
    };
};

export { EventBus };
