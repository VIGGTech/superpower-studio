import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const OPCODES = {
  CONT: 0x00,
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
};

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_PAYLOAD_BYTES = 10 * 1024 * 1024;

export function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const fin = 0x80;
  const len = buf.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

export function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (!masked) {
    throw new Error('Client WebSocket frames must be masked');
  }

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const extendedLen = buffer.readBigUInt64BE(2);
    if (extendedLen > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
      throw new Error('WebSocket frame payload exceeds maximum allowed size');
    }
    payloadLen = Number(extendedLen);
    offset = 10;
  }

  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error('WebSocket frame payload exceeds maximum allowed size');
  }

  const totalLen = offset + 4 + payloadLen;
  if (buffer.length < totalLen) return null;

  const maskKey = buffer.subarray(offset, offset + 4);
  const maskedPayload = buffer.subarray(offset + 4, totalLen);
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    payload[i] = maskedPayload[i] ^ maskKey[i % 4];
  }

  return { fin, opcode, payload, bytesConsumed: totalLen };
}

export function createWebSocketServer({ validateUpgrade = () => true } = {}) {
  const emitter = new EventEmitter();
  const clients = new Set();

  function sendRaw(socket, frame) {
    if (!socket.destroyed && socket.writable) {
      try {
        socket.write(frame);
      } catch {
        clients.delete(socket);
      }
    }
  }

  function sendTo(client, payload) {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    sendRaw(client, encodeFrame(OPCODES.TEXT, Buffer.from(str, 'utf8')));
  }

  function broadcast(payload) {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const frame = encodeFrame(OPCODES.TEXT, Buffer.from(str, 'utf8'));
    for (const client of clients) {
      sendRaw(client, frame);
    }
  }

  function attach(httpServer, pathname = '/ws') {
    httpServer.on('upgrade', (req, socket, head) => {
      let reqPath;
      try {
        reqPath = new URL(req.url || '/', 'http://localhost').pathname;
      } catch {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      if (reqPath !== pathname) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key || !validateUpgrade(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }

      const accept = computeAcceptKey(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      clients.add(socket);
      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let fragOpcode = null;
      let fragChunks = [];

      function processBuffer() {
        while (buffer.length > 0) {
          let frame;
          try {
            frame = decodeFrame(buffer);
          } catch {
            sendRaw(socket, encodeFrame(OPCODES.CLOSE));
            socket.destroy();
            return;
          }
          if (!frame) break;
          buffer = buffer.subarray(frame.bytesConsumed);

          if (frame.opcode === OPCODES.CLOSE) {
            sendRaw(socket, encodeFrame(OPCODES.CLOSE));
            socket.end();
            return;
          }
          if (frame.opcode === OPCODES.PING) {
            sendRaw(socket, encodeFrame(OPCODES.PONG, frame.payload));
            continue;
          }
          if (frame.opcode === OPCODES.PONG) {
            continue;
          }
          if (frame.opcode === OPCODES.TEXT || frame.opcode === OPCODES.BINARY) {
            if (frame.fin) {
              emitter.emit('message', socket, frame.payload.toString('utf8'));
            } else {
              fragOpcode = frame.opcode;
              fragChunks = [frame.payload];
            }
          } else if (frame.opcode === OPCODES.CONT && fragOpcode !== null) {
            fragChunks.push(frame.payload);
            if (frame.fin) {
              const combined = Buffer.concat(fragChunks);
              fragOpcode = null;
              fragChunks = [];
              emitter.emit('message', socket, combined.toString('utf8'));
            }
          }
        }
      }

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      });

      const cleanup = () => {
        if (clients.delete(socket)) {
          emitter.emit('close', socket);
        }
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      emitter.emit('connection', socket, req);
      if (buffer.length > 0) processBuffer();
    });
  }

  function close() {
    for (const client of clients) {
      try {
        sendRaw(client, encodeFrame(OPCODES.CLOSE));
        client.destroy();
      } catch { /* ignore */ }
    }
    clients.clear();
  }

  return Object.assign(emitter, {
    attach,
    broadcast,
    sendTo,
    close,
    get clientCount() { return clients.size; },
  });
}
