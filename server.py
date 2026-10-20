"""Small localhost-only bridge for a Mandarin conversation teacher.

Requires Python 3.9+. The LLM and speech recognizer are separate local services.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from pypinyin import Style, lazy_pinyin
except ImportError:
    Style = None
    lazy_pinyin = None


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.getenv("TEACHER_PORT", "8765"))
PROVIDER = os.getenv("TEACHER_PROVIDER", "ollama").lower()
MODEL = os.getenv("TEACHER_MODEL", "qwen2.5:7b-instruct")
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
LM_STUDIO_URL = "http://127.0.0.1:1234/v1/chat/completions"
WHISPER_URL = "http://127.0.0.1:8080/inference"
DEFAULT_TTS = "macos" if sys.platform == "darwin" and shutil.which("say") and shutil.which("afconvert") else "browser"
TTS_MODE = os.getenv("TEACHER_TTS", DEFAULT_TTS).lower()
TTS_ENABLED = TTS_MODE in ("macos", "local")
TTS_URL = "http://127.0.0.1:8766/synthesize"
MAX_AUDIO_BYTES = 4_000_000
MAX_JSON_BYTES = 40_000


def service_ready(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.35):
            return True
    except OSError:
        return False

SYSTEM = """你是一位教已经学过基础普通话的儿童练习口语的虚拟老师。你是 AI，不要声称自己是真人。
每轮用自然、简单的普通话回答，最多两句，每句不超过20个汉字，并提出一个相关问题。一次只纠正一个重要的用词或语法错误；如果可能是语音识别出错，不要断言孩子说错。不要根据文字转写评价声调或发音。对儿童保持友善，避免成人话题，不询问姓名、住址、电话、学校或其他个人信息。不要建议孩子对父母保密。若谈话偏离学习，温和引导回到适龄话题。
仅返回一个 JSON 对象，不要 Markdown：{"reply_zh":"给孩子说的话，含一个问题","meaning_vi":"直接对孩子说的越南语逐句翻译，绝不能概述句子的功能","feedback_vi":"必要时一句越南语纠错；没有明确错误则为空字符串"}。例如 reply_zh 为「你最喜欢吃什么水果呢？」时，meaning_vi 必须是「Con thích ăn loại trái cây nào nhất?」，不是「Hỏi về sở thích ăn trái cây」。不要编造孩子没有说过的错误。"""
ANSWER_SCHEMA = {"type": "object", "properties": {
    key: {"type": "string"} for key in
    ("reply_zh", "meaning_vi", "feedback_vi")
}, "required": ["reply_zh", "meaning_vi", "feedback_vi"]}


def romanize(text: str) -> str:
    if lazy_pinyin is None:
        return ""
    value = " ".join(lazy_pinyin(text, style=Style.TONE))
    value = re.sub(r"\s+([，。！？,.?!])", r"\1", value)
    return value[:900]


def macos_speech(text: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="mandarin-teacher-") as folder:
        aiff = Path(folder) / "speech.aiff"
        wav = Path(folder) / "speech.wav"
        subprocess.run(["say", "-v", "Tingting", "-o", str(aiff), text],
                       check=True, timeout=40, capture_output=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff), str(wav)],
                       check=True, timeout=20, capture_output=True)
        return wav.read_bytes()


def post_json(url: str, payload: dict) -> dict:
    request = Request(url, json.dumps(payload, ensure_ascii=False).encode("utf-8"), {
        "Content-Type": "application/json",
    })
    with urlopen(request, timeout=90) as response:
        return json.load(response)


def teacher_reply(text: str, history: list[dict]) -> dict:
    messages = [{"role": "system", "content": SYSTEM}]
    for item in history[-8:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            messages.append({"role": role, "content": content[:500]})
    messages.append({"role": "user", "content": text[:500]})
    if PROVIDER == "ollama":
        data = post_json(OLLAMA_URL, {
            "model": MODEL, "messages": messages, "stream": False,
            "format": "json", "options": {"temperature": 0.3, "num_predict": 240},
        })
        raw = data.get("message", {}).get("content", "")
    elif PROVIDER == "lmstudio":
        data = post_json(LM_STUDIO_URL, {
            "model": MODEL, "messages": messages, "stream": False,
            "temperature": 0.3, "max_tokens": 240,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "teacher_reply", "schema": ANSWER_SCHEMA,
            }},
        })
        raw = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    else:
        raise ValueError("TEACHER_PROVIDER must be ollama or lmstudio")
    if not isinstance(raw, str):
        raise ValueError("Model returned no text")
    # Some local models wrap their JSON in a code block despite instructions.
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError("Model did not return a JSON object")
    answer = json.loads(match.group(0))
    if not isinstance(answer, dict) or not isinstance(answer.get("reply_zh"), str):
        raise ValueError("Model response is missing reply_zh")
    reply = answer["reply_zh"][:180]
    meaning = str(answer.get("meaning_vi", "")).strip()[:400]
    if re.match(r"(?i)^(hỏi về|nói về|giải thích|câu hỏi|câu trả lời|đề cập)", meaning):
        meaning = ""
    return {"reply_zh": reply, "pinyin": romanize(reply),
            "meaning_vi": meaning,
            "feedback_vi": str(answer.get("feedback_vi", ""))[:300]}


def transcribe(wav: bytes) -> str:
    boundary = "----teacher" + uuid.uuid4().hex
    pieces = []
    for name, value in (("response_format", "json"), ("language", "zh")):
        pieces.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                       f"{value}\r\n").encode())
    pieces.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
                   "filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode())
    pieces.extend((wav, b"\r\n", f"--{boundary}--\r\n".encode()))
    request = Request(WHISPER_URL, b"".join(pieces), {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    with urlopen(request, timeout=90) as response:
        data = json.load(response)
    value = data.get("text", "") if isinstance(data, dict) else ""
    return value.strip() if isinstance(value, str) else ""


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, maximum: int) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > maximum:
            raise ValueError("Invalid or oversized request")
        return self.rfile.read(length)

    def do_GET(self) -> None:
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/avatar.js": ("avatar.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8"),
                 "/assets/mom_avatar.jpg": ("assets/mom_avatar.jpg", "image/jpeg")}
        if self.path == "/api/status":
            self.send_json(200, {"provider": PROVIDER, "model": MODEL,
                                 "whisper": WHISPER_URL,
                                 "tts": TTS_MODE,
                                 "llm_ready": service_ready(11434 if PROVIDER == "ollama" else 1234),
                                 "whisper_ready": service_ready(8080),
                                 "tts_ready": service_ready(8766) if TTS_MODE == "local" else True})
            return
        item = files.get(self.path)
        if not item:
            self.send_error(404)
            return
        body = (ROOT / item[0]).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", item[1])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        try:
            if self.path == "/api/transcribe":
                if self.headers.get("Content-Type", "").split(";")[0] != "audio/wav":
                    raise ValueError("Expected audio/wav")
                wav = self.read_body(MAX_AUDIO_BYTES)
                if not wav.startswith(b"RIFF") or wav[8:12] != b"WAVE":
                    raise ValueError("Invalid WAV file")
                self.send_json(200, {"text": transcribe(wav)})
            elif self.path == "/api/chat":
                data = json.loads(self.read_body(MAX_JSON_BYTES))
                if not isinstance(data, dict):
                    raise ValueError("Expected JSON object")
                text = data.get("text", "")
                history = data.get("history", [])
                if not isinstance(text, str) or not text.strip() or not isinstance(history, list):
                    raise ValueError("Missing text or invalid history")
                self.send_json(200, teacher_reply(text.strip(), history))
            elif self.path == "/api/tts" and TTS_ENABLED:
                data = json.loads(self.read_body(MAX_JSON_BYTES))
                text = data.get("text", "") if isinstance(data, dict) else ""
                if not isinstance(text, str) or not text.strip() or len(text) > 600:
                    raise ValueError("Invalid TTS text")
                if TTS_MODE == "macos":
                    audio = macos_speech(text)
                else:
                    request = Request(TTS_URL, json.dumps({"text": text}, ensure_ascii=False).encode(),
                                      {"Content-Type": "application/json"})
                    with urlopen(request, timeout=120) as response:
                        audio = response.read(6_000_001)
                if len(audio) > 6_000_000 or not audio.startswith(b"RIFF"):
                    raise ValueError("Invalid TTS audio")
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(audio)
            else:
                self.send_error(404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except (HTTPError, URLError, TimeoutError) as exc:
            self.send_json(502, {"error": f"Local AI service unavailable: {exc}"})
        except Exception as exc:
            self.send_json(500, {"error": f"Unexpected server error: {exc}"})


if __name__ == "__main__":
    print(f"Mandarin teacher: http://{HOST}:{PORT} ({PROVIDER}, {MODEL})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
