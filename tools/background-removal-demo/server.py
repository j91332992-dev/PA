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
from urllib.parse import parse_qs, unquote, urlparse
from mimetypes import guess_type

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT
MODEL_DIR = ROOT / ".models"
os.environ.setdefault("REMBG_HOME", str(MODEL_DIR))
os.environ.setdefault("HF_HOME", str(MODEL_DIR / "huggingface"))

TAXONOMY_PATH = ROOT.parent.parent / "web" / "public" / "dev" / "garment-taxonomy.json"
CLASSIFIER_MODEL = os.getenv("GARMENT_CLASSIFIER_MODEL", "patrickjohncyh/fashion-clip")

HOST = os.getenv("BG_DEMO_HOST", "127.0.0.1")
PORT = int(os.getenv("BG_DEMO_PORT", "8790"))
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_IMAGE_EDGE = 2400

MODEL_OPTIONS = {
    "birefnet-general-lite": {
        "label": "BiRefNet Lite 범용",
        "description": "노트북 로컬 서버에서 CPU로 실행하는 시연용 모델",
    },
}
DEFAULT_MODEL = "birefnet-general-lite"

_session_cache: dict[str, object] = {}
_session_lock = Lock()
_inference_lock = Lock()
_rembg_remove = None
_rembg_new_session = None
_clip_processor = None
_clip_model = None
_clip_torch = None
_clip_inference_lock = Lock()
_taxonomy_cache: dict[str, list[dict[str, str]]] | None = None


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def load_rembg():
    global _rembg_remove, _rembg_new_session
    if _rembg_remove is None or _rembg_new_session is None:
        from rembg import new_session, remove

        _rembg_new_session = new_session
        _rembg_remove = remove
    return _rembg_remove, _rembg_new_session


def get_session(model_name: str):
    if model_name not in MODEL_OPTIONS:
        raise RequestError(400, "지원하지 않는 모델입니다.")

    with _session_lock:
        if model_name not in _session_cache:
            _, new_session = load_rembg()
            print(f"[MODEL] loading {model_name}", flush=True)
            _session_cache[model_name] = new_session(
                model_name,
                providers=["CPUExecutionProvider"],
            )
            print(f"[MODEL] ready {model_name}", flush=True)
        return _session_cache[model_name]


def load_taxonomy() -> dict[str, list[dict[str, str]]]:
    global _taxonomy_cache
    if _taxonomy_cache is None:
        try:
            payload = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
            fields = {key: payload[key] for key in ("categories", "colors", "seasons")}
            if not all(isinstance(items, list) and items for items in fields.values()):
                raise ValueError("taxonomy fields are empty")
            _taxonomy_cache = fields
        except Exception as exc:
            raise RequestError(500, "옷 속성 목록을 읽지 못했습니다.") from exc
    return _taxonomy_cache


def load_classifier():
    global _clip_processor, _clip_model, _clip_torch
    if _clip_processor is None or _clip_model is None or _clip_torch is None:
        try:
            import torch
            from transformers import AutoModelForZeroShotImageClassification, AutoProcessor

            torch.set_num_threads(max(1, min(os.cpu_count() or 2, 8)))
            local_snapshots = sorted(
                (
                    MODEL_DIR / "fashion-clip" / "models--patrickjohncyh--fashion-clip" / "snapshots"
                ).glob("*")
            )
            local_source = next(
                (
                    snapshot
                    for snapshot in reversed(local_snapshots)
                    if (snapshot / "config.json").is_file() and (snapshot / "model.safetensors").is_file()
                ),
                None,
            )
            model_source = str(local_source) if local_source else CLASSIFIER_MODEL
            local_only = local_source is not None
            print(f"[CLASSIFIER] loading {model_source}", flush=True)
            _clip_processor = AutoProcessor.from_pretrained(
                model_source,
                cache_dir=None if local_only else str(MODEL_DIR / "fashion-clip"),
                local_files_only=local_only,
            )
            _clip_model = AutoModelForZeroShotImageClassification.from_pretrained(
                model_source,
                cache_dir=None if local_only else str(MODEL_DIR / "fashion-clip"),
                local_files_only=local_only,
            )
            _clip_model.to("cpu")
            _clip_model.eval()
            _clip_torch = torch
            print(f"[CLASSIFIER] ready {CLASSIFIER_MODEL} on CPU", flush=True)
        except Exception as exc:
            raise RequestError(
                503,
                "FashionCLIP 분류 모델을 준비하지 못했습니다. 분류용 의존성과 모델 다운로드를 확인하세요.",
            ) from exc
    return _clip_processor, _clip_model, _clip_torch


def prepare_classifier_image(raw: bytes) -> Image.Image:
    try:
        source = Image.open(BytesIO(raw))
        source.load()
        source = ImageOps.exif_transpose(source).convert("RGBA")
    except Exception as exc:
        raise RequestError(415, "읽을 수 있는 JPG, PNG, WEBP 이미지가 아닙니다.") from exc

    # FashionCLIP was trained mostly on product photos with a clean background.
    # Composite the transparent cutout onto white so transparent pixels do not
    # become black evidence for the classifier.
    white = Image.new("RGBA", source.size, (255, 255, 255, 255))
    white.alpha_composite(source)
    return white.convert("RGB")


def classify_group(image_features, entries, processor, model, torch):
    prompts = [f"a product photo of {entry['prompt']}" for entry in entries]
    text_inputs = processor(text=prompts, return_tensors="pt", padding=True)
    text_inputs = {key: value.to("cpu") for key, value in text_inputs.items()}
    text_features = model.get_text_features(**text_inputs)
    text_features = text_features / text_features.norm(dim=-1, keepdim=True)
    logits = image_features @ text_features.T
    if hasattr(model, "logit_scale"):
        logits = logits * model.logit_scale.exp()
    scores = torch.softmax(logits[0], dim=-1).tolist()
    ranked = sorted(
        (
            {"label": entry["label"], "score": round(float(score), 4)}
            for entry, score in zip(entries, scores)
        ),
        key=lambda item: item["score"],
        reverse=True,
    )
    return {
        "top": ranked[0]["label"],
        "score": ranked[0]["score"],
        "candidates": ranked[:5],
    }


def classify_garment(raw: bytes) -> dict:
    started = time.perf_counter()
    image = prepare_classifier_image(raw)
    taxonomy = load_taxonomy()
    processor, model, torch = load_classifier()

    with _clip_inference_lock, torch.inference_mode():
        image_inputs = processor(images=image, return_tensors="pt")
        image_inputs = {key: value.to("cpu") for key, value in image_inputs.items()}
        image_features = model.get_image_features(**image_inputs)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        predictions = {
            "category": classify_group(image_features, taxonomy["categories"], processor, model, torch),
            "color": classify_group(image_features, taxonomy["colors"], processor, model, torch),
            "season": classify_group(image_features, taxonomy["seasons"], processor, model, torch),
        }

    return {
        "model": CLASSIFIER_MODEL,
        "engine": "FashionCLIP zero-shot",
        "provider": "CPU",
        "processingMs": round((time.perf_counter() - started) * 1000),
        "predictions": predictions,
        "note": "점수는 후보 간 상대 점수이며, 특히 계절은 최종 확인이 필요합니다.",
    }


def parse_bool(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def read_multipart(handler: BaseHTTPRequestHandler) -> tuple[bytes, str, str]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0:
        raise RequestError(400, "이미지 파일이 없습니다.")
    if content_length > MAX_UPLOAD_BYTES:
        raise RequestError(413, "파일이 12MB를 초과했습니다.")

    content_type = handler.headers.get("Content-Type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise RequestError(415, "multipart/form-data 업로드만 지원합니다.")

    body = handler.rfile.read(content_length)
    envelope = (
        b"Content-Type: "
        + content_type.encode("utf-8")
        + b"\r\nMIME-Version: 1.0\r\n\r\n"
        + body
    )
    message = BytesParser(policy=policy.default).parsebytes(envelope)

    for part in message.iter_parts():
        if part.get_param("name", header="content-disposition") != "image":
            continue
        raw = part.get_payload(decode=True) or b""
        if not raw:
            raise RequestError(400, "이미지 파일이 비어 있습니다.")
        filename = part.get_filename() or "image"
        return raw, part.get_content_type(), filename

    raise RequestError(400, "image 필드를 찾을 수 없습니다.")


def remove_background(raw: bytes, model_name: str, alpha_matting: bool) -> tuple[bytes, tuple[int, int], tuple[int, int], float]:
    started = time.perf_counter()
    try:
        source = Image.open(BytesIO(raw))
        source.load()
        source = ImageOps.exif_transpose(source).convert("RGBA")
    except Exception as exc:
        raise RequestError(415, "읽을 수 있는 JPG, PNG, WEBP 이미지가 아닙니다.") from exc

    original_size = source.size
    if max(source.size) > MAX_IMAGE_EDGE:
        source.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)

    session = get_session(model_name)
    remove, _ = load_rembg()
    with _inference_lock:
        result = remove(
            source,
            session=session,
            post_process_mask=True,
            alpha_matting=alpha_matting,
            force_return_bytes=False,
        )

    if isinstance(result, Image.Image):
        output = result.convert("RGBA")
    else:
        output = Image.open(BytesIO(result)).convert("RGBA")

    encoded = BytesIO()
    output.save(encoded, format="PNG", optimize=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return encoded.getvalue(), original_size, output.size, elapsed_ms


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


def send_bytes(handler: BaseHTTPRequestHandler, data: bytes, content_type: str, headers: dict[str, str] | None = None):
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(data)


class DemoHandler(BaseHTTPRequestHandler):
    server_version = "ClothCutoutLab/0.1"

    def log_message(self, fmt: str, *args):
        print(f"[{self.address_string()}] {fmt % args}", flush=True)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            send_json(
                self,
                HTTPStatus.OK,
                {
                    "ok": True,
                    "engine": "rembg",
                    "defaultModel": DEFAULT_MODEL,
                    "models": [
                        {"id": model_id, **details}
                        for model_id, details in MODEL_OPTIONS.items()
                    ],
                    "modelCache": sorted(_session_cache),
                    "storage": "memory-only",
                },
            )
            return

        self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/classify":
            try:
                raw, _, _ = read_multipart(self)
                send_json(self, HTTPStatus.OK, classify_garment(raw))
            except RequestError as exc:
                send_json(self, exc.status, {"error": str(exc)})
            except Exception:
                traceback.print_exc()
                send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "옷 속성 분류 중 오류가 발생했습니다."})
            return

        if parsed.path != "/api/remove":
            send_json(self, HTTPStatus.NOT_FOUND, {"error": "경로를 찾을 수 없습니다."})
            return

        try:
            query = parse_qs(parsed.query)
            model_name = query.get("model", [DEFAULT_MODEL])[0]
            alpha_matting = parse_bool(query.get("matting", ["0"])[0])
            raw, _, filename = read_multipart(self)
            output, original_size, output_size, elapsed_ms = remove_background(
                raw,
                model_name,
                alpha_matting,
            )
            print(
                f"[REMOVE] {filename} model={model_name} "
                f"input={original_size[0]}x{original_size[1]} "
                f"output={output_size[0]}x{output_size[1]} "
                f"time={elapsed_ms:.0f}ms",
                flush=True,
            )
            send_bytes(
                self,
                output,
                "image/png",
                {
                    "X-Model": model_name,
                    "X-Process-Ms": f"{elapsed_ms:.0f}",
                    "X-Image-Width": str(output_size[0]),
                    "X-Image-Height": str(output_size[1]),
                    "X-Original-Width": str(original_size[0]),
                    "X-Original-Height": str(original_size[1]),
                },
            )
        except RequestError as exc:
            send_json(self, exc.status, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "배경 제거 중 오류가 발생했습니다."})

    def serve_static(self, url_path: str):
        relative = unquote(url_path).lstrip("/") or "index.html"
        candidate = (STATIC_DIR / relative).resolve()
        static_root = STATIC_DIR.resolve()
        if not candidate.is_relative_to(static_root) or not candidate.is_file():
            candidate = STATIC_DIR / "index.html"

        data = candidate.read_bytes()
        content_type = guess_type(str(candidate))[0] or "application/octet-stream"
        send_bytes(self, data, f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), DemoHandler)
    print(f"[BOOT] Cloth Cutout Lab http://localhost:{PORT}", flush=True)
    print(f"[BOOT] models={MODEL_DIR}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[BOOT] stopped", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
