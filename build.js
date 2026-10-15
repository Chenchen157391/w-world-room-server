// Bước build trên Render (npm run build): tải bản web W-World về thư mục web/ cạnh server.js
// rồi nén sẵn gzip các file lớn để server.js gửi bản nén (wasm 34 MB -> ~8 MB).
//   GAME_URL=https://github.com/<tài khoản>/<kho>/releases/latest/download/w-world-web.tar.gz node build.js
// Không đặt GAME_URL: bỏ qua, server chỉ chạy làm máy chủ phòng.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const url = (process.env.GAME_URL || "").trim();
const web = path.join(__dirname, "web");

async function main() {
  if (!url) {
    console.log("GAME_URL chưa đặt — chỉ chạy máy chủ phòng, không kèm game.");
    return;
  }
  console.log("Tải bản web:", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Tải thất bại: HTTP ${res.status}`);
  const tgz = path.join(__dirname, "game.tar.gz");
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  console.log(`Đã tải ${(fs.statSync(tgz).size / 1048576).toFixed(1)} MB`);

  fs.rmSync(web, { recursive: true, force: true });
  fs.mkdirSync(web, { recursive: true });
  // đường dẫn tương đối: GNU tar coi "C:\…" là máy:đường-dẫn khi thử trên Windows
  execFileSync("tar", ["-xzf", path.join("..", path.basename(tgz))], { cwd: web, stdio: "inherit" });
  fs.rmSync(tgz);
  if (!fs.existsSync(path.join(web, "index.html"))) throw new Error("Gói tải về không có index.html");

  for (const name of fs.readdirSync(web)) {
    if (!/\.(wasm|pck|js|html|webmanifest)$/.test(name)) continue;
    const f = path.join(web, name);
    const gz = zlib.gzipSync(fs.readFileSync(f), { level: 6 });
    fs.writeFileSync(f + ".gz", gz);
    console.log(`  ${name}: ${(fs.statSync(f).size / 1048576).toFixed(1)} MB -> gzip ${(gz.length / 1048576).toFixed(1)} MB`);
  }
  console.log("Xong: game nằm ở", web);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
