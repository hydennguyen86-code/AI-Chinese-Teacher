# Cô giáo tiếng Hoa 3D — bản thử nội bộ

Đây là bản thử độc lập, không thay đổi chatbot hiện có. Trình duyệt giao tiếp với ba phần chạy trên cùng máy: ứng dụng Python, mô hình hội thoại qua Ollama hoặc LM Studio, và `whisper.cpp` để chép lời tiếng Hoa. Avatar dùng ảnh `assets/mom_avatar.jpg` trong một lưới đầu 3D cong, có xoay nhẹ theo thời gian. Ảnh tham chiếu được xử lý ngay trên máy. Tệp ảnh riêng tư không nằm trong Git; sau khi tải mã nguồn, hãy sao chép ảnh của bạn thành `assets/mom_avatar.jpg` để bật avatar cá nhân. Đây là avatar 3D phủ texture ảnh, chưa phải model Live2D được rig đầy đủ; khẩu hình trong ảnh không đồng bộ theo âm vị. Mở `index.html` trực tiếp bằng `file://` chỉ để xem trước avatar; để trò chuyện phải chạy server và mở địa chỉ `http://127.0.0.1:8765/`.

## Cần có

- Python 3.9 trở lên và `pypinyin` trong `requirements.txt` để tạo pinyin từ chữ Hán. Nếu thiếu gói này, pinyin sẽ để trống thay vì lấy bản AI tự viết.
- Ollama hoặc LM Studio với một mô hình có thể nói tiếng Hoa.
- `whisper.cpp` server và một **mô hình đa ngôn ngữ**. Không dùng mô hình có đuôi `.en`.
- Trình duyệt có WebGL và quyền micro. Trên macOS hiện tại, Chrome đã được cấp quyền micro; quyền Microphone của ChatGPT đang tắt trong Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Microphone.

Trên macOS, giọng mặc định là `Tingting` qua lệnh `say`, được tạo thành tệp WAV ngay trên máy. Có thể chọn Qwen3-TTS local theo mục dưới.

## Chạy với Ollama

Trong terminal thứ nhất:

```sh
ollama pull qwen2.5:7b-instruct
ollama serve
```

Nếu Ollama đã tự chạy dưới nền thì bỏ qua `ollama serve`.

Trên Mac, cài `whisper.cpp` và tải mô hình `small` đa ngôn ngữ vào thư mục ứng dụng:

```sh
brew install whisper.cpp
mkdir -p models
curl --fail --location --output models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Chạy nhận giọng nói ở terminal thứ hai:

```sh
whisper-server -m models/ggml-small.bin -l zh --host 127.0.0.1 --port 8080
```

Trong terminal thứ ba:

```sh
cd mandarin-teacher
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
TEACHER_PROVIDER=ollama TEACHER_MODEL=qwen2.5:7b-instruct .venv/bin/python server.py
```

Mở `http://127.0.0.1:8765` trên chính máy đó. Bấm **Bắt đầu buổi học**, rồi bấm micro để nói. Nếu đang thử luồng AI trước khi cài micro hoặc whisper, có thể gõ một câu tiếng Hoa vào ô phía dưới.

## Dùng LM Studio

Trong LM Studio, tải và mở một mô hình nói được tiếng Hoa, bật local server trên cổng `1234`. Giữ `whisper.cpp` chạy như trên, rồi khởi động ứng dụng bằng tên model đang hiện trong LM Studio:

```sh
cd mandarin-teacher
TEACHER_PROVIDER=lmstudio TEACHER_MODEL='ten-model-trong-lm-studio' .venv/bin/python server.py
```

## Giọng cô hoàn toàn local với Qwen3-TTS

Phần này là tùy chọn và dùng môi trường Python riêng để không ảnh hưởng server chính. Hãy kiểm tra khả năng chạy mô hình trên CPU/GPU của máy trước khi dùng hằng ngày. Theo hướng dẫn [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), tạo môi trường Python 3.12 và cài `qwen-tts`; `torch` và `soundfile` cũng cần có trong môi trường đó. Ví dụ:

```sh
python3.12 -m venv .venv-tts
. .venv-tts/bin/activate
pip install qwen-tts soundfile
python tts_service.py
```

Lần đầu chạy có thể tải trọng số của mô hình `Qwen3-TTS-12Hz-0.6B-CustomVoice`. Sau khi mô hình nằm trên máy, dịch vụ chỉ lắng nghe ở `127.0.0.1:8766`. Khởi động server chính với `TEACHER_TTS=local`:

```sh
TEACHER_TTS=local TEACHER_PROVIDER=ollama TEACHER_MODEL=qwen2.5:7b-instruct .venv/bin/python server.py
```

Nếu chọn LM Studio, thay `TEACHER_PROVIDER` và `TEACHER_MODEL` như phần trên. Trong chế độ `TEACHER_TTS=local`, khi dịch vụ Qwen3-TTS không trả lời, giao diện chỉ hiện chữ và báo lỗi; nó không chuyển sang giọng đọc của trình duyệt.

## Phạm vi bản thử

- Mọi yêu cầu của ứng dụng chỉ gửi tới `127.0.0.1`; ứng dụng không lưu bản ghi âm hay hội thoại trên đĩa. Đóng trang sẽ xóa lịch sử hội thoại trong trang.
- Trên Mac, chế độ mặc định đọc bằng giọng `Tingting` của hệ điều hành qua `say`, xử lý local. Trên hệ khác, chế độ mặc định dùng `speechSynthesis` của trình duyệt và **chưa thể bảo đảm hoàn toàn offline**. `TEACHER_TTS=local` gọi dịch vụ Qwen3-TTS trên cùng máy nhưng vẫn cần kiểm tra thực tế theo phần cứng.
- Miệng avatar chuyển động gần đúng theo nhịp nói, chưa khớp từng âm vị. Khuôn mặt là nhân vật 3D cách điệu; có thể thay bằng mẫu VRM người thật hơn sau khi chọn phong cách và có tệp mô hình phù hợp.
- Bản chép lời chỉ dùng để luyện đối thoại, **không chấm thanh điệu hay kết luận phát âm đúng sai**. Lời sửa của AI cũng cần người lớn xem lại trong giai đoạn thử.
- Chưa có tự động ngắt lời cô khi con nói chồng lên. Con có thể bấm **Ngừng cô nói** rồi bấm micro.
- Chưa có kiểm thử thực tế trên máy đích; tốc độ phản hồi phụ thuộc RAM, GPU và mô hình chọn.

Nguồn giao diện kết nối: [Ollama chat API](https://docs.ollama.com/api/chat), [LM Studio local server](https://lmstudio.ai/docs/developer/core/server), [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server).
