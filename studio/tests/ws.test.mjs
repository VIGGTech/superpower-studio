import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

import {
  OPCODES,
  computeAcceptKey,
  encodeFrame,
  decodeFrame,
  createWebSocketServer,
} from '../lib/ws.mjs';

function encodeClientFrame(opcode, payloadBuf) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.subarray(offset, offset + len), bytesConsumed: offset + len };
}

test('RFC 6455 accept key and frame encode/decode roundtrips', () => {
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  for (const size of [0, 12, 126, 2048, 70000]) {
    const text = 'x'.repeat(size);
    const serverWire = encodeFrame(OPCODES.TEXT, Buffer.from(text));
    const parsedServer = decodeServerFrame(serverWire);
    assert.equal(parsedServer.opcode, OPCODES.TEXT);
    assert.equal(parsedServer.payload.toString('utf8'), text);

    const clientWire = encodeClientFrame(OPCODES.TEXT, Buffer.from(text));
    const parsedClient = decodeFrame(clientWire);
    assert.equal(parsedClient.opcode, OPCODES.TEXT);
    assert.equal(parsedClient.payload.toString('utf8'), text);
  }

  // Reject unmasked client frame
  const unmasked = encodeFrame(OPCODES.TEXT, Buffer.from('hi'));
  assert.throws(() => decodeFrame(unmasked), /masked/i);

  // Reject oversized 64-bit frame (> 10MB)
  const huge = Buffer.alloc(14);
  huge[0] = 0x81;
  huge[1] = 0x80 | 127;
  huge.writeBigUInt64BE(BigInt(20 * 1024 * 1024), 2);
  assert.throws(() => decodeFrame(huge), /maximum/i);
});

test('WebSocketServer validates upgrades, handles messages, pings, and broadcasts', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wsServer = createWebSocketServer({
    validateUpgrade(req) {
      return req.headers['x-test-auth'] === 'valid';
    },
  });
  wsServer.attach(server, '/ws');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // 1. Rejected upgrade without auth header
    const rejected = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let raw = '';
      sock.on('data', (c) => { raw += c.toString('utf8'); });
      sock.on('end', () => resolve(raw));
      sock.on('error', reject);
    });
    assert.match(rejected, /^HTTP\/1\.1 403 /);

    // 2. Accepted upgrade + broadcast + client message
    const receivedOnServer = [];
    wsServer.on('message', (_client, data) => receivedOnServer.push(data));

    const clientResult = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nX-Test-Auth: valid\r\n\r\n`
        );
      });
      let upgraded = false;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = buf.subarray(0, idx).toString('utf8');
          assert.match(head, /^HTTP\/1\.1 101 /);
          buf = buf.subarray(idx + 4);
          upgraded = true;
          sock.write(encodeClientFrame(OPCODES.TEXT, Buffer.from(JSON.stringify({ hello: 'server' }))));
          setTimeout(() => wsServer.broadcast({ type: 'ping_broadcast', ok: true }), 20);
        }
        const frame = decodeServerFrame(buf);
        if (frame && frame.opcode === OPCODES.TEXT) {
          sock.end();
          resolve(JSON.parse(frame.payload.toString('utf8')));
        }
      });
      sock.on('error', reject);
    });

    assert.deepEqual(clientResult, { type: 'ping_broadcast', ok: true });
    assert.equal(receivedOnServer.length, 1);
    assert.deepEqual(JSON.parse(receivedOnServer[0]), { hello: 'server' });
  } finally {
    wsServer.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
