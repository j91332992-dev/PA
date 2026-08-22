'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL_ROOT = path.join(ROOT, 'tools', 'background-removal-demo');
const IMAGE_ROOT = path.join(ROOT, 'data', 'garment-images');
// Keep the heavyweight Python packages outside a synced project folder. On
// Windows this avoids OneDrive holding wheel files open during installation.
const PYTHON = process.env.GARMENT_IMAGE_PYTHON || path.join(process.env.LOCALAPPDATA || TOOL_ROOT, 'SmartWardrobe', 'garment-ai', process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python');
const TOOL_PORT = Number(process.env.GARMENT_IMAGE_PORT || 8790);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
let child = null;
let starting = null;

function appError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function health() {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port: TOOL_PORT, path: '/api/health', timeout: 700 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function startTool() {
  if (await health()) return;
  if (starting) return starting;
  starting = (async () => {
    if (!fs.existsSync(PYTHON)) throw appError(503, '사진 기능 준비가 필요합니다. Python 처리 환경을 설치하세요.');
    const script = path.join(TOOL_ROOT, 'server.py');
    if (!fs.existsSync(script)) throw appError(503, '사진 처리 프로그램을 찾지 못했습니다.');
    child = spawn(PYTHON, [script], {
      cwd: TOOL_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BG_DEMO_PORT: String(TOOL_PORT), PYTHONUNBUFFERED: '1' },
    });
    child.stdout.on('data', chunk => process.stdout.write(`[GARMENT-AI] ${chunk}`));
    child.stderr.on('data', chunk => process.stderr.write(`[GARMENT-AI] ${chunk}`));
    child.once('exit', () => { child = null; });
    child.once('error', error => console.error(`[GARMENT-AI] ${error.message}`));
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (await health()) return;
      await wait(250);
    }
    throw appError(503, '사진 AI 서버 시작 시간이 초과되었습니다. 모델 설치 상태를 확인하세요.');
  })().finally(() => { starting = null; });
  return starting;
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.resume();
        reject(appError(413, '사진은 12MB 이하만 업로드할 수 있습니다.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function callTool(endpoint, raw, contentType) {
  await startTool();
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: TOOL_PORT, path: endpoint, method: 'POST', headers: { 'content-type': contentType, 'content-length': raw.length } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(180000, () => request.destroy(appError(504, '사진 처리 시간이 초과되었습니다.')));
    request.on('error', reject);
    request.end(raw);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function toolError(result) {
  try { return JSON.parse(result.body.toString('utf8')).error || '사진 처리에 실패했습니다.'; } catch { return '사진 처리에 실패했습니다.'; }
}

async function handle(req, res, context) {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname.startsWith('/api/garments/images/') && req.method === 'GET') {
    const name = pathname.slice('/api/garments/images/'.length);
    if (!/^[0-9a-f-]{36}\.png$/i.test(name)) { sendJson(res, 404, { error: '사진을 찾지 못했습니다.' }); return true; }
    const imagePath = path.join(IMAGE_ROOT, name);
    if (!fs.existsSync(imagePath)) { sendJson(res, 404, { error: '사진을 찾지 못했습니다.' }); return true; }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' });
    fs.createReadStream(imagePath).pipe(res);
    return true;
  }
  if (!['/api/garments/image', '/api/garments/classify', '/api/garments/image/status'].includes(pathname)) return false;
  try {
    context.needUser(req);
    if (pathname === '/api/garments/image/status') {
      await startTool();
      sendJson(res, 200, { ok: true, provider: '노트북 로컬 AI', backgroundModel: 'BiRefNet Lite', classifier: 'FashionCLIP' });
      return true;
    }
    if (req.method !== 'POST') throw appError(405, 'POST 요청만 사용할 수 있습니다.');
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw appError(415, '사진 업로드 형식이 올바르지 않습니다.');
    const raw = await rawBody(req);
    const endpoint = pathname.endsWith('/classify') ? '/api/classify' : '/api/remove';
    const result = await callTool(endpoint, raw, contentType);
    if (result.status !== 200) throw appError(result.status, toolError(result));
    if (endpoint === '/api/classify') {
      sendJson(res, 200, JSON.parse(result.body.toString('utf8')));
      return true;
    }
    if (!String(result.headers['content-type'] || '').startsWith('image/png')) throw appError(502, '배경 제거 결과가 PNG가 아닙니다.');
    fs.mkdirSync(IMAGE_ROOT, { recursive: true });
    const name = `${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(IMAGE_ROOT, name), result.body);
    sendJson(res, 201, { imageUrl: `/api/garments/images/${name}`, model: result.headers['x-model'] || 'birefnet-general-lite', processingMs: Number(result.headers['x-processingms'] || 0) });
    return true;
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || '사진 처리 중 오류가 발생했습니다.' });
    return true;
  }
}

module.exports = { handle };
