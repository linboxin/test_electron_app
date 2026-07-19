const fs = require('fs/promises');
const WebSocket = require('ws');

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const description = options.description ?? 'condition';
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (options.retryErrors === false || error.fatal === true) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

async function waitForJson(file, predicate = (value) => Boolean(value), options = {}) {
  return waitFor(async () => {
    const value = await readJson(file);
    return value && predicate(value) ? value : null;
  }, { ...options, description: options.description ?? file });
}

class RpcClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    socket.on('message', (data) => this.onMessage(String(data)));
    socket.on('close', () => this.failPending(new Error('ACP connection closed')));
  }

  static connect(registration, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${registration.port}`, {
        headers: { authorization: `Bearer ${registration.token}` }
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Timed out connecting to ACP'));
      }, timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once('open', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        resolve(new RpcClient(socket));
      });
      socket.once('error', fail);
      socket.once('unexpected-response', (_request, response) => {
        fail(new Error(`ACP connection rejected with HTTP ${response.statusCode}`));
      });
    });
  }

  request(method, params, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message = params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };
      this.socket.send(JSON.stringify(message));
    });
  }

  async waitForNotification(method, predicate = () => true, timeoutMs = 5_000) {
    return waitFor(() => this.notifications.find(
      (notification) => notification.method === method && predicate(notification.params)
    ), { timeoutMs, description: `${method} notification` });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }

  onMessage(raw) {
    const message = JSON.parse(raw);
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      this.notifications.push(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { RpcClient, readJson, waitFor, waitForJson };
