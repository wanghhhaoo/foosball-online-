// 一个够用的 WebSocket 服务端实现（RFC 6455），不依赖任何第三方库。
// 支持：握手、文本/二进制帧、分片、ping/pong、close、最大消息长度。
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

class Conn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.buf = Buffer.alloc(0);
    this.frag = null;      // 分片中的消息 { op, parts, size }
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.on('end', () => this._closed());
  }
  get bufferedAmount() { return this.socket.writableLength; }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        if (hi !== 0) return this._fail(1009);
        len = lo; off = 10;
      }
      if (!masked) return this._fail(1002);           // 浏览器发来的帧必须带掩码
      if (len > this.maxPayload) return this._fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
      if (this.readyState === CLOSED) return;
    }
  }
  _frame(fin, op, payload) {
    if (op === 0x8) {                                 // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      if (this.readyState === OPEN) this._send(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      this.readyState = CLOSING;
      this.socket.end();
      this.emit('closing', code);
      return;
    }
    if (op === 0x9) { this._send(0xA, payload); return; }  // ping -> pong
    if (op === 0xA) { this.emit('pong'); return; }
    if (op === 0x1 || op === 0x2) {
      if (this.frag) return this._fail(1002);
      if (fin) return this.emit('message', payload, op === 0x2);
      this.frag = { op, parts: [payload], size: payload.length };
      return;
    }
    if (op === 0x0) {                                 // 分片的后续部分
      if (!this.frag) return this._fail(1002);
      this.frag.parts.push(payload); this.frag.size += payload.length;
      if (this.frag.size > this.maxPayload) return this._fail(1009);
      if (fin) { const f = this.frag; this.frag = null; this.emit('message', Buffer.concat(f.parts), f.op === 0x2); }
      return;
    }
    this._fail(1002);
  }
  _send(op, data) {
    if (this.socket.destroyed) return;
    const len = data.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | op;
    this.socket.write(Buffer.concat([head, data]));
  }
  send(text) { if (this.readyState === OPEN) this._send(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { if (this.readyState === OPEN) this._send(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(0x8, p);
    this.readyState = CLOSING;
    this.socket.end();
    setTimeout(() => this.terminate(), 2000).unref();
  }
  terminate() { this.socket.destroy(); this._closed(); }
  _fail(code) { this.close(code); this.terminate(); }
  _closed() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }
}

// 挂到一个 http.Server 上，接管指定路径的 upgrade 请求
function attach(server, { path = '/ws', maxPayload = 65536 } = {}, onConnection) {
  server.on('upgrade', (req, socket) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) {}
    const key = req.headers['sec-websocket-key'];
    const ok = pathname === path && /websocket/i.test(req.headers.upgrade || '') && typeof key === 'string' && key.length >= 16 && req.headers['sec-websocket-version'] === '13';
    if (!ok) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    onConnection(new Conn(socket, maxPayload), req);
  });
}

module.exports = { attach, CONNECTING, OPEN, CLOSING, CLOSED };
