"""Optional local Qwen3-TTS voice for the Mandarin teacher.

Install qwen-tts, torch and soundfile in a separate Python environment.
The model weights are downloaded on first run unless already cached.
"""

import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


MODEL_NAME = os.getenv("TEACHER_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
SPEAKER = os.getenv("TEACHER_TTS_SPEAKER", "Serena")
DEVICE = "cuda:0" if torch.cuda.is_available() else (
    "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cpu"
)
DTYPE = torch.float32 if DEVICE == "cpu" else torch.float16
print(f"Loading {MODEL_NAME} on {DEVICE}...")
MODEL = Qwen3TTSModel.from_pretrained(MODEL_NAME, device_map=DEVICE, dtype=DTYPE)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/synthesize":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4_000:
                raise ValueError("Invalid request size")
            data = json.loads(self.rfile.read(length))
            text = data.get("text", "") if isinstance(data, dict) else ""
            if not isinstance(text, str) or not text.strip() or len(text) > 600:
                raise ValueError("Invalid text")
            with torch.inference_mode():
                wavs, rate = MODEL.generate_custom_voice(
                    text=text, language="Chinese", speaker=SPEAKER
                )
            output = io.BytesIO()
            sf.write(output, wavs[0], rate, format="WAV", subtype="PCM_16")
            body = output.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    print("Qwen3-TTS: http://127.0.0.1:8766")
    HTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
