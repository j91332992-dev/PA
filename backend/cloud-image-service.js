'use strict';

// Cloud-only image path.  This module deliberately has no local-disk fallback:
// with the required environment variables it stores originals and results in
// Supabase Storage so a user's PC never has to remain on.
const crypto = require('crypto');

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const BUCKET = String(process.env.SUPABASE_GARMENT_BUCKET || 'garments');
const PROCESSOR_URL = String(process.env.IMAGE_PROCESSOR_URL || '').replace(/\/$/, '');
const PROCESSOR_TOKEN = String(process.env.IMAGE_PROCESSOR_TOKEN || '');

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY && PROCESSOR_URL && PROCESSOR_TOKEN);
}
function appError(status, message) { const error = new Error(message); error.status = status; return error; }
function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function safePart(value) { return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_'); }
function objectUrl(objectPath) { return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath.split('/').map(encodeURIComponent).join('/')}`; }
function storageHeaders(extra = {}) { return { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, ...extra }; }

async function readRaw(req) {
  const chunks = []; let size = 0;
  return new Promise((resolve, reject) => {
    req.on('data', chunk => { size += chunk.length; if (size > MAX_UPLOAD_BYTES) { req.resume(); reject(appError(413, '사진은 12MB 이하만 업로드할 수 있습니다.')); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function multipartImage(raw, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw appError(415, '사진 업로드 형식이 올바르지 않습니다.');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  let cursor = raw.indexOf(boundary);
  while (cursor >= 0) {
    const start = cursor + boundary.length;
    const next = raw.indexOf(boundary, start);
    if (next < 0) break;
    const part = raw.subarray(start, next);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd >= 0) {
      const header = part.subarray(0, headerEnd).toString('utf8');
      if (/name="image"/i.test(header)) {
        let image = part.subarray(headerEnd + 4);
        if (image.subarray(image.length - 2).equals(Buffer.from('\r\n'))) image = image.subarray(0, image.length - 2);
        const filename = /filename="([^"]*)"/i.exec(header)?.[1] || 'upload';
        const mime = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || 'application/octet-stream';
        if (!/^image\/(jpeg|png|webp)$/i.test(mime)) throw appError(415, 'JPG, PNG, WEBP 사진만 업로드할 수 있습니다.');
        if (!image.length) throw appError(400, '빈 사진 파일입니다.');
        return { image, filename, mime };
      }
    }
    cursor = next;
  }
  throw appError(400, 'image 필드를 찾지 못했습니다.');
}

async function uploadObject(objectPath, bytes, mime) {
  const response = await fetch(objectUrl(objectPath), { method: 'POST', headers: storageHeaders({ 'content-type': mime, 'x-upsert': 'true' }), body: bytes });
  if (!response.ok) throw appError(502, `Supabase Storage 원본 업로드에 실패했습니다. (${response.status})`);
}
async function downloadObject(objectPath) {
  const response = await fetch(objectUrl(objectPath), { headers: storageHeaders() });
  if (!response.ok) throw appError(404, '저장된 사진을 찾지 못했습니다.');
  return response;
}

function callbackPath(garmentId) { return `/api/internal/image-jobs/${encodeURIComponent(garmentId)}`; }
async function requestProcessing(job) {
  // Do not hold the browser request open for model loading/inference.  The
  // Python worker reports ready/failed through the protected callback.
  const response = await fetch(`${PROCESSOR_URL}/process`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${PROCESSOR_TOKEN}` }, body: JSON.stringify(job), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw appError(502, `사진 처리 서비스를 시작하지 못했습니다. (${response.status})`);
}

async function handle(req, res, context) {
  const url = new URL(req.url, 'http://x');
  const imageRoute = url.pathname.match(/^\/api\/garments\/([^/]+)\/image$/);
  const callbackRoute = url.pathname.match(/^\/api\/internal\/image-jobs\/([^/]+)$/);
  const statusRoute = url.pathname === '/api/garments/image/status';
  if (!imageRoute && !callbackRoute && !statusRoute) return false;
  if (!configured()) {
    if (imageRoute) { sendJson(res, 503, { error: '클라우드 사진 처리가 아직 설정되지 않았습니다.' }); return true; }
    return false;
  }
  try {
    if (statusRoute) { sendJson(res, 200, { ok: true, mode: 'cloud', provider: 'Cloud AI 처리', profile: process.env.IMAGE_PROCESSING_PROFILE || 'fast' }); return true; }
    if (callbackRoute) {
      if (req.method !== 'POST' || String(req.headers.authorization || '') !== `Bearer ${PROCESSOR_TOKEN}`) throw appError(401, '사진 처리 콜백 인증에 실패했습니다.');
      const payload = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
      const garment = context.findGarment(decodeURIComponent(callbackRoute[1]));
      if (!garment) throw appError(404, '사진 처리 대상 옷을 찾지 못했습니다.');
      if (payload.status === 'ready') {
        garment.processedImagePath = String(payload.processedImagePath || '');
        garment.imageProcessingStatus = 'ready'; garment.processingError = '';
        garment.classification = payload.classification || {};
        garment.classificationConfidence = payload.classificationConfidence || {};
        garment.imageUrl = `/api/garments/${encodeURIComponent(garment.id)}/image`;
      } else { garment.imageProcessingStatus = 'failed'; garment.processingError = String(payload.error || '사진 처리에 실패했습니다.').slice(0, 300); }
      await context.persist(); context.emit('garment.image.updated', garment, garment.imageProcessingStatus === 'ready' ? 'info' : 'warning', garment.wardrobeId);
      sendJson(res, 200, { ok: true }); return true;
    }
    const user = context.needUser(req); const garment = context.findGarment(decodeURIComponent(imageRoute[1]));
    if (!garment || garment.wardrobeId !== context.wardrobeFor(user)?.id) throw appError(404, '내 옷장에서 옷을 찾을 수 없습니다.');
    if (req.method === 'GET') {
      const objectPath = garment.processedImagePath || garment.originalImagePath;
      if (!objectPath) throw appError(404, '사진이 아직 없습니다.');
      const upstream = await downloadObject(objectPath);
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'image/png', 'cache-control': 'private, max-age=300' });
      if (!upstream.body) return res.end();
      const bytes = Buffer.from(await upstream.arrayBuffer()); res.end(bytes); return true;
    }
    if (req.method !== 'POST') throw appError(405, 'GET 또는 POST 요청만 사용할 수 있습니다.');
    const contentType = String(req.headers['content-type'] || ''); if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw appError(415, '사진 업로드 형식이 올바르지 않습니다.');
    const file = multipartImage(await readRaw(req), contentType);
    const extension = file.mime === 'image/png' ? 'png' : file.mime === 'image/webp' ? 'webp' : 'jpg';
    const originalImagePath = `${safePart(garment.wardrobeId)}/${safePart(garment.id)}/original-${crypto.randomUUID()}.${extension}`;
    const processedImagePath = `${safePart(garment.wardrobeId)}/${safePart(garment.id)}/processed-${crypto.randomUUID()}.png`;
    await uploadObject(originalImagePath, file.image, file.mime);
    Object.assign(garment, { originalImagePath, processedImagePath, imageProcessingStatus: 'processing', processingError: '', imageUrl: `/api/garments/${encodeURIComponent(garment.id)}/image` });
    await context.persist(); context.emit('garment.image.processing', garment, 'info', garment.wardrobeId);
    const callbackUrl = `${String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}${callbackPath(garment.id)}`;
    requestProcessing({ garmentId: garment.id, originalImagePath, processedImagePath, callbackUrl, profile: process.env.IMAGE_PROCESSING_PROFILE || 'fast' }).catch(async error => {
      garment.imageProcessingStatus = 'failed'; garment.processingError = error.message.slice(0, 300); await context.persist().catch(() => {}); context.emit('garment.image.updated', garment, 'warning', garment.wardrobeId);
    });
    sendJson(res, 202, { garmentId: garment.id, status: 'processing', imageUrl: garment.imageUrl }); return true;
  } catch (error) { sendJson(res, error.status || 500, { error: error.message || '사진 처리 중 오류가 발생했습니다.' }); return true; }
}

module.exports = { configured, handle, multipartImage };
