from __future__ import annotations

import json
import os
import time
import traceback
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from threading import Lock
from urllib.parse import urlparse

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / ".models"
os.environ.setdefault("REMBG_HOME", str(MODEL_DIR))
os.environ.setdefault("HF_HOME", str(MODEL_DIR / "huggingface"))
TAXONOMY_PATH = ROOT.parents[1] / "web" / "public" / "dev" / "garment-taxonomy.json"
HOST = os.getenv("BG_DEMO_HOST", "127.0.0.1")
PORT = int(os.getenv("BG_DEMO_PORT", "8790"))
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_IMAGE_EDGE = 2400
BACKGROUND_MODEL = os.getenv("GARMENT_BACKGROUND_MODEL", "birefnet-general-lite")
CLASSIFIER_MODEL = "patrickjohncyh/fashion-clip"

_background_session = None
_remove = None
_classifier = None
_processor = None
_torch = None
_taxonomy = None
_load_lock = Lock()
_inference_lock = Lock()


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def read_multipart(handler: BaseHTTPRequestHandler) -> bytes:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        raise RequestError(400, "이미지 파일이 없습니다.")
    if length > MAX_UPLOAD_BYTES:
        raise RequestError(413, "사진은 12MB 이하만 업로드할 수 있습니다.")
    content_type = handler.headers.get("Content-Type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise RequestError(415, "사진 업로드 형식이 올바르지 않습니다.")
    body = handler.rfile.read(length)
    envelope = b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    message = BytesParser(policy=policy.default).parsebytes(envelope)
    for part in message.iter_parts():
        if part.get_param("name", header="content-disposition") == "image":
            raw = part.get_payload(decode=True) or b""
            if raw:
                return raw
    raise RequestError(400, "사진 파일을 찾지 못했습니다.")


def open_image(raw: bytes) -> Image.Image:
    try:
        image = Image.open(BytesIO(raw))
        image.load()
        return ImageOps.exif_transpose(image).convert("RGBA")
    except Exception as error:
        raise RequestError(415, "JPG, PNG, WEBP 사진만 사용할 수 있습니다.") from error


def load_background():
    global _background_session, _remove
    with _load_lock:
        if _background_session is None:
            from rembg import new_session, remove
            print(f"[BG] loading {BACKGROUND_MODEL}", flush=True)
            _background_session = new_session(BACKGROUND_MODEL, providers=["CPUExecutionProvider"])
            _remove = remove
            print("[BG] ready", flush=True)
    return _remove, _background_session


def load_taxonomy():
    global _taxonomy
    if _taxonomy is None:
        try:
            parsed = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
            _taxonomy = {key: parsed[key] for key in ("categories", "colors", "seasons")}
        except Exception as error:
            raise RequestError(500, "옷 분류 기준표를 읽지 못했습니다.") from error
    return _taxonomy


def load_classifier():
    global _classifier, _processor, _torch
    with _load_lock:
        if _classifier is None:
            try:
                import torch
                from transformers import AutoModelForZeroShotImageClassification, AutoProcessor
                torch.set_num_threads(max(1, min(os.cpu_count() or 2, 8)))
                cache_dir = MODEL_DIR / "fashion-clip"
                print(f"[CLASSIFY] loading {CLASSIFIER_MODEL}", flush=True)
                _processor = AutoProcessor.from_pretrained(CLASSIFIER_MODEL, cache_dir=str(cache_dir))
                _classifier = AutoModelForZeroShotImageClassification.from_pretrained(CLASSIFIER_MODEL, cache_dir=str(cache_dir))
                _classifier.to("cpu")
                _classifier.eval()
                _torch = torch
                print("[CLASSIFY] ready", flush=True)
            except Exception as error:
                raise RequestError(503, "옷 분류 모델을 준비하지 못했습니다. 인터넷 연결과 모델 다운로드를 확인하세요.") from error
    return _processor, _classifier, _torch


def remove_background(raw: bytes):
    started = time.perf_counter()
    image = open_image(raw)
    original = image.size
    if max(image.size) > MAX_IMAGE_EDGE:
        image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
    remove, session = load_background()
    with _inference_lock:
        result = remove(image, session=session, post_process_mask=True, force_return_bytes=False)
    output = result.convert("RGBA") if isinstance(result, Image.Image) else Image.open(BytesIO(result)).convert("RGBA")
    encoded = BytesIO()
    output.save(encoded, format="PNG", optimize=True)
    return encoded.getvalue(), {"model": BACKGROUND_MODEL, "processingMs": round((time.perf_counter() - started) * 1000), "width": output.width, "height": output.height, "originalWidth": original[0], "originalHeight": original[1]}


def rank(image_features, entries, processor, classifier, torch):
    prompts = [f"a product photo of {entry['prompt']}" for entry in entries]
    text_inputs = processor(text=prompts, return_tensors="pt", padding=True)
    text_features = classifier.get_text_features(**text_inputs)
    text_features = text_features / text_features.norm(dim=-1, keepdim=True)
    scores = torch.softmax((image_features @ text_features.T)[0], dim=-1).tolist()
    candidates = sorted(({"label": entry["label"], "score": round(float(score), 4)} for entry, score in zip(entries, scores)), key=lambda item: item["score"], reverse=True)
    return {"top": candidates[0]["label"], "score": candidates[0]["score"], "candidates": candidates[:3]}


def classify(raw: bytes):
    started = time.perf_counter()
    image = open_image(raw)
    white = Image.new("RGBA", image.size, (255, 255, 255, 255))
    white.alpha_composite(image)
    processor, classifier, torch = load_classifier()
    taxonomy = load_taxonomy()
    with _inference_lock, torch.inference_mode():
        image_inputs = processor(images=white.convert("RGB"), return_tensors="pt")
        image_features = classifier.get_image_features(**image_inputs)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        predictions = {"category": rank(image_features, taxonomy["categories"], processor, classifier, torch), "color": rank(image_features, taxonomy["colors"], processor, classifier, torch), "season": rank(image_features, taxonomy["seasons"], processor, classifier, torch)}
    return {"model": CLASSIFIER_MODEL, "engine": "FashionCLIP zero-shot", "processingMs": round((time.perf_counter() - started) * 1000), "predictions": predictions, "note": "자동 추천 결과이므로 등록 전에 확인하거나 수정할 수 있습니다."}


def send_json(handler, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[HTTP] {fmt % args}", flush=True)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            send_json(self, 200, {"ok": True, "backgroundModel": BACKGROUND_MODEL, "classifierModel": CLASSIFIER_MODEL})
            return
        send_json(self, 404, {"error": "경로를 찾지 못했습니다."})

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            raw = read_multipart(self)
            if path == "/api/remove":
                image, meta = remove_background(raw)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(image)))
                for key, value in meta.items():
                    self.send_header("X-" + key, str(value))
                self.end_headers()
                self.wfile.write(image)
            elif path == "/api/classify":
                send_json(self, 200, classify(raw))
            else:
                send_json(self, 404, {"error": "경로를 찾지 못했습니다."})
        except RequestError as error:
            send_json(self, error.status, {"error": str(error)})
        except Exception:
            traceback.print_exc()
            send_json(self, 500, {"error": "사진 처리 중 오류가 발생했습니다."})


if __name__ == "__main__":
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[BOOT] local garment image service http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
