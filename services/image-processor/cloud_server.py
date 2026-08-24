"""Cloud worker for Smart Wardrobe garment images.

It is intentionally a separate HTTP process. Node stores the original in
Supabase Storage and immediately returns ``processing``; this worker reads the
object, processes it, uploads a PNG, then calls the protected Node callback.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "background-removal-demo"))
from server import RequestError, classify, open_image, remove_background  # noqa: E402

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8791"))
TOKEN = os.getenv("IMAGE_PROCESSOR_TOKEN", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = os.getenv("SUPABASE_GARMENT_BUCKET", "garments")
PROFILE = os.getenv("IMAGE_PROCESSING_PROFILE", "fast").lower()
MAX_BODY = 128 * 1024


def configured() -> bool:
    return bool(TOKEN and SUPABASE_URL and SUPABASE_KEY)


def response(handler, status: int, payload: dict):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def object_url(path: str) -> str:
    from urllib.parse import quote
    return f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/" + "/".join(quote(x, safe="") for x in path.split("/"))


def storage_headers(content_type: str | None = None) -> dict[str, str]:
    headers = {"apikey": SUPABASE_KEY, "authorization": f"Bearer {SUPABASE_KEY}"}
    if content_type:
        headers["content-type"] = content_type
    return headers


def storage_get(path: str) -> bytes:
    with urlopen(Request(object_url(path), headers=storage_headers()), timeout=60) as result:
        return result.read()


def storage_put(path: str, value: bytes):
    headers = storage_headers("image/png")
    headers["x-upsert"] = "true"
    with urlopen(Request(object_url(path), data=value, method="POST", headers=headers), timeout=60):
        pass


def fast_classify(raw: bytes) -> dict:
    """No second multi-hundred-MB model in free demo mode.

    It returns a reliable color hint only; category/season remain editable and
    are explicitly labelled as low-confidence rather than fabricated.
    """
    image = open_image(raw).convert("RGB")
    sample = image.resize((1, 1)).getpixel((0, 0))
    r, g, b = sample
    if max(sample) - min(sample) < 18:
        color = "화이트" if sum(sample) > 520 else "블랙" if sum(sample) < 180 else "그레이"
    elif b > r * 1.15 and b > g * 1.05:
        color = "네이비"
    elif r > b * 1.2 and r > g * 1.08:
        color = "레드"
    elif g > r * 1.08 and g > b * 1.05:
        color = "그린"
    else:
        color = "베이지"
    return {"model": "fast-color-heuristic", "engine": "Pillow CPU", "processingMs": 1,
            "predictions": {"category": {"top": "", "score": 0}, "color": {"top": color, "score": 0.45}, "season": {"top": "", "score": 0}},
            "note": "무료 빠른 처리 모드: 색상만 자동 추천하며 종류·계절은 사용자가 확인합니다."}


def callback(url: str, payload: dict):
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=raw, method="POST", headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
    with urlopen(request, timeout=45):
        pass


def process(job: dict):
    started = time.perf_counter()
    raw = storage_get(str(job["originalImagePath"]))
    image, removal_meta = remove_background(raw)
    storage_put(str(job["processedImagePath"]), image)
    if str(job.get("profile") or PROFILE).lower() == "quality":
        classification = classify(raw)
    else:
        classification = fast_classify(raw)
    predictions = classification.get("predictions", {})
    confidence = {key: value.get("score", 0) for key, value in predictions.items() if isinstance(value, dict)}
    callback(str(job["callbackUrl"]), {"status": "ready", "processedImagePath": job["processedImagePath"], "classification": classification, "classificationConfidence": confidence, "processingMs": round((time.perf_counter() - started) * 1000), "removal": removal_meta})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[HTTP] " + fmt % args, flush=True)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/health":
            return response(self, 200, {"ok": True, "configured": configured(), "profile": PROFILE, "backgroundModel": os.getenv("GARMENT_BACKGROUND_MODEL", "birefnet-general-lite")})
        response(self, 404, {"error": "경로를 찾지 못했습니다."})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/process":
            return response(self, 404, {"error": "경로를 찾지 못했습니다."})
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            return response(self, 401, {"error": "사진 처리 인증에 실패했습니다."})
        if not configured():
            return response(self, 503, {"error": "Cloud Storage 환경변수가 설정되지 않았습니다."})
        try:
            length = min(int(self.headers.get("content-length", "0")), MAX_BODY)
            job = json.loads(self.rfile.read(length) or b"{}")
            for key in ("garmentId", "originalImagePath", "processedImagePath", "callbackUrl"):
                if not job.get(key):
                    raise RequestError(400, f"{key} 값이 필요합니다.")
            # Acknowledge promptly; the actual inference runs in this worker
            # thread, keeping the Node/Web request non-blocking.
            response(self, HTTPStatus.ACCEPTED, {"ok": True, "status": "processing", "garmentId": job["garmentId"]})
            try:
                process(job)
            except Exception as error:
                traceback.print_exc()
                try:
                    callback(str(job["callbackUrl"]), {"status": "failed", "error": str(error)})
                except Exception:
                    traceback.print_exc()
        except RequestError as error:
            response(self, error.status, {"error": str(error)})
        except (ValueError, HTTPError) as error:
            response(self, 400, {"error": str(error)})
        except Exception:
            traceback.print_exc()
            response(self, 500, {"error": "사진 처리 요청을 시작하지 못했습니다."})


if __name__ == "__main__":
    print(f"[BOOT] Smart Wardrobe image processor http://{HOST}:{PORT} profile={PROFILE}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
