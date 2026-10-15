// Máy chủ cho bản web W-World (Node.js, không cần thư viện ngoài):
//   1. phục vụ các file của bản web (build/web) — trang mở ở http(s)://<máy chủ>/
//   2. máy chủ mai mối (signaling) qua WebSocket ở /ws: tạo phòng có mã 4 chữ + giới hạn người, chuyển tin bắt tay WebRTC.
// Logic game chạy ở trình duyệt chủ phòng; dữ liệu game đi thẳng giữa các trình duyệt (WebRTC).
//
//   node tools/server/server.js [--port 8080] [--web build/web]
// Không có --web: dùng thư mục web/ cạnh server.js nếu có (bản trên Render, do build.js tải về), không thì build/web.
// File nào có bản nén sẵn <tên>.gz (build.js tạo) thì gửi bản nén cho trình duyệt nhận gzip.
//
// Đặt sau proxy có HTTPS (Caddy, nginx, Render, Railway, Fly…) để trình duyệt dùng wss:// — WebRTC cần trang https.
// Giao thức giống tools/server/signaling.gd (xem chú thích ở đó).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = parseInt(process.env.PORT || arg("port", "8080"), 10);
const LOCAL_WEB = path.join(__dirname, "web");
const WEB = path.resolve(arg("web", fs.existsSync(path.join(LOCAL_WEB, "index.html")) ? LOCAL_WEB : path.join(__dirname, "..", "..", "build", "web")));
const MAX_LIMIT = 10;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".wasm": "application/wasm",
  ".pck": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".json": "application/json", ".css": "text/css", ".webmanifest": "application/manifest+json",
};

// ------------------------------------------------------------ phục vụ file tĩnh
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  // chạy riêng làm máy chủ phòng (không kèm bản web, vd. trên Render): trang chủ chỉ báo đang chạy,
  // cũng là chỗ game gọi để đánh thức máy chủ khi nó đang ngủ
  if ((p === "/" || p === "") && !fs.existsSync(path.join(WEB, "index.html"))) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin" });
    return res.end(`W-World room server OK — ${rooms.size} phòng đang mở
`);
  }
  if (p === "/" || p === "") p = "/index.html";
  const file = path.join(WEB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    // trình duyệt đã có bản này (ETag khớp) -> 304, khỏi tải lại hàng chục MB
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      // cho phép bản web dùng SharedArrayBuffer nếu sau này bật đa luồng
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
      "ETag": etag,
      "Vary": "Accept-Encoding",
    };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
    const gz = file + ".gz";
    fs.stat(gz, (gerr, gst) => {
      const useGz = !gerr && gst.isFile() && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      headers["Content-Length"] = useGz ? gst.size : st.size;
      if (useGz) headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(useGz ? gz : file).pipe(res);
    });
  });
});

// ------------------------------------------------------------ WebSocket tối giản (RFC 6455: chữ, ping/pong, đóng)
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);
  const conn = { socket, buf: Buffer.alloc(0), frags: [], room: "", id: 0, alive: true, onText: null, onClose: null };
  socket.on("data", (d) => { conn.buf = Buffer.concat([conn.buf, d]); wsParse(conn); });
  const done = () => { if (conn.alive) { conn.alive = false; conn.onClose && conn.onClose(); } };
  socket.on("close", done);
  socket.on("error", done);
  return conn;
}

function wsParse(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 4 * 1024 * 1024) { c.socket.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    let payload = c.buf.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = c.buf.subarray(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    c.buf = c.buf.subarray(need);
    if (op === 0x8) { wsSend(c, Buffer.alloc(0), 0x8); c.socket.end(); return; }
    if (op === 0x9) { wsSend(c, payload, 0xA); continue; }
    if (op === 0xA) continue;
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      c.frags.push(payload);
      if (fin) {
        const text = Buffer.concat(c.frags).toString("utf8");
        c.frags = [];
        c.onText && c.onText(text);
      }
    }
  }
}

function wsSend(c, data, op = 0x1) {
  if (!c.alive) return;
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  let head;
  if (body.length < 126) head = Buffer.from([0x80 | op, body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  c.socket.write(Buffer.concat([head, body]));
}

// ------------------------------------------------------------ phòng
const rooms = new Map(); // code -> {max, members: Map(peerId -> conn)}

function newCode() {
  for (;;) {
    let s = "";
    for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
}
const send = (c, m) => wsSend(c, JSON.stringify(m));
function broadcast(code, m, except) {
  const r = rooms.get(code);
  if (!r) return;
  for (const [pid, c] of r.members) if (pid !== except) send(c, m);
}
const count = (code) => { const r = rooms.get(code); broadcast(code, { t: "count", n: r.members.size, max: r.max }); };

function handle(c, m) {
  switch (m.t) {
    case "host": {
      if (c.room) return;
      const code = newCode();
      const max = Math.max(2, Math.min(MAX_LIMIT, parseInt(m.max, 10) || 4));
      rooms.set(code, { max, members: new Map([[1, c]]) });
      c.room = code; c.id = 1;
      send(c, { t: "hosted", code, id: 1, max });
      console.log(`room ${code} mở (tối đa ${max})`);
      break;
    }
    case "join": {
      const code = String(m.code || "").trim().toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(c, { t: "error", e: "web_no_room" });
      if (r.members.size >= r.max) return send(c, { t: "error", e: "web_full" });
      let pid;
      do { pid = 2 + crypto.randomInt(2147483640); } while (r.members.has(pid));
      r.members.set(pid, c);
      c.room = code; c.id = pid;
      send(c, { t: "joined", id: pid, code, max: r.max });
      send(r.members.get(1), { t: "peer", id: pid });
      send(c, { t: "peer", id: 1 });
      count(code);
      console.log(`room ${code}: +${pid} (${r.members.size}/${r.max})`);
      break;
    }
    case "offer": case "answer": case "cand": {
      const r = rooms.get(c.room);
      if (!r) return;
      const to = r.members.get(parseInt(m.to, 10));
      if (to) { m.from = c.id; send(to, m); }
      break;
    }
    case "ping":
      send(c, { t: "pong" });
      break;
  }
}

function drop(c) {
  const r = rooms.get(c.room);
  if (!r) return;
  if (c.id === 1) {
    broadcast(c.room, { t: "closed" }, 1);
    rooms.delete(c.room);
    console.log(`room ${c.room} đóng`);
  } else {
    r.members.delete(c.id);
    broadcast(c.room, { t: "left", id: c.id });
    count(c.room);
  }
}

server.on("upgrade", (req, socket) => {
  const c = wsAccept(req, socket);
  if (!c) return;
  c.onText = (text) => { try { const m = JSON.parse(text); if (m && typeof m === "object") handle(c, m); } catch (e) { /* bỏ qua tin hỏng */ } };
  c.onClose = () => drop(c);
});

server.listen(PORT, () => {
  console.log(`W-World web server: http://localhost:${PORT}/  (game: ${WEB})  phòng: ws://localhost:${PORT}/ws`);
});
