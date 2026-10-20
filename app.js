const el = (id) => document.getElementById(id);
const avatar = new window.TeacherAvatar(el('avatar'));
const previewOnly = location.protocol === 'file:';
const history = [];
let sessionStarted = false;
let busy = false;
let recorder = null;
let currentSpeech = null;
let currentAudio = null;
let audioUrl = null;
let ttsMode = 'browser';
let speechRequest = 0;

function state(message, active = false) {
  el('state').textContent = message;
  el('state-dot').style.background = active ? '#ec8643' : '#41a983';
}

function addBubble(kind, text, extra = '') {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${kind}`;
  const main = document.createElement('span');
  main.textContent = text;
  bubble.appendChild(main);
  if (extra) {
    const note = document.createElement('small');
    note.textContent = extra;
    bubble.appendChild(note);
  }
  el('dialogue').prepend(bubble);
}

function stopSpeaking() {
  speechRequest++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  currentSpeech = null;
  if (currentAudio) currentAudio.pause();
  currentAudio = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  avatar.setTalking(false);
  el('stop-speech').disabled = true;
  if (!busy) state('Đang nghe con');
}

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) {
    el('hint').textContent = 'Trình duyệt này chưa có giọng đọc; con vẫn có thể đọc lời cô trên màn hình.';
    return;
  }
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(v => v.lang.toLowerCase() === 'zh-cn') ||
                voices.find(v => v.lang.toLowerCase().startsWith('zh'));
  if (!voice) {
    el('hint').textContent = 'Chưa tìm thấy giọng tiếng Hoa trên máy. Hãy cài giọng 中文/Chinese trong hệ điều hành.';
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.87;
  utterance.onstart = () => {
    if (currentSpeech !== utterance) return;
    state('Cô đang nói', true);
    avatar.setTalking(true);
    el('stop-speech').disabled = false;
  };
  const finish = () => {
    if (currentSpeech !== utterance) return;
    currentSpeech = null;
    avatar.setTalking(false);
    el('stop-speech').disabled = true;
    state('Đến lượt con nói');
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  currentSpeech = utterance;
  speechSynthesis.speak(utterance);
}

async function speak(text) {
  stopSpeaking();
  const requestId = speechRequest;
  if (ttsMode === 'local' || ttsMode === 'macos') {
    state('Cô đang tạo giọng nói', true);
    try {
      const response = await fetch('/api/tts', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text})});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (requestId !== speechRequest) return;
      audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      currentAudio = audio;
      audio.onplay = () => {
        if (currentAudio !== audio) return;
        state('Cô đang nói', true); avatar.setTalking(true);
        el('stop-speech').disabled = false;
      };
      const finish = () => {
        if (currentAudio !== audio) return;
        currentAudio = null;
        URL.revokeObjectURL(audioUrl); audioUrl = null;
        avatar.setTalking(false); el('stop-speech').disabled = true;
        state('Đến lượt con nói');
      };
      audio.onended = finish; audio.onerror = finish;
      await audio.play();
      return;
    } catch (error) {
      if (requestId !== speechRequest) return;
      if (currentAudio) currentAudio.pause();
      currentAudio = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = null;
      avatar.setTalking(false);
      el('hint').textContent = `Giọng local chưa chạy (${error.message}); con vẫn đọc được câu của cô trên màn hình.`;
      state('Đến lượt con nói');
      return;
    }
  }
  if (requestId === speechRequest) browserSpeak(text);
}

async function jsonPost(path, payload, type = 'application/json') {
  const response = await fetch(path, {method: 'POST', headers: {'Content-Type': type},
    body: type === 'application/json' ? JSON.stringify(payload) : payload});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function sendText(text) {
  if (busy || !text.trim()) return;
  busy = true;
  el('mic').disabled = true;
  stopSpeaking();
  addBubble('child', text.trim());
  state('Cô đang suy nghĩ', true);
  try {
    const answer = await jsonPost('/api/chat', {text: text.trim(), history});
    history.push({role: 'user', content: text.trim()},
                 {role: 'assistant', content: answer.reply_zh});
    if (history.length > 16) history.splice(0, history.length - 16);
    el('teacher-zh').textContent = answer.reply_zh;
    el('teacher-pinyin').textContent = answer.pinyin || '';
    el('teacher-vi').textContent = answer.meaning_vi || '';
    addBubble('teacher', answer.reply_zh,
      [answer.pinyin, answer.feedback_vi].filter(Boolean).join(' · '));
    state('Đến lượt con nói');
    speak(answer.reply_zh);
  } catch (error) {
    state('Kết nối AI có lỗi', true);
    el('hint').textContent = `Chưa nhận được trả lời: ${error.message}`;
  } finally {
    busy = false;
    el('mic').disabled = !sessionStarted;
  }
}

function wavFromChunks(chunks, sampleRate) {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const input = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const targetRate = 16000;
  const sampleCount = Math.round(input.length * targetRate / sampleRate);
  const wav = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(wav);
  const ascii = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, sampleCount * 2, true);
  for (let i = 0; i < sampleCount; i++) {
    const pos = i * sampleRate / targetRate;
    const a = input[Math.floor(pos)] || 0;
    const b = input[Math.min(Math.floor(pos) + 1, input.length - 1)] || 0;
    const sample = Math.max(-1, Math.min(1, a + (b - a) * (pos % 1)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([wav], {type: 'audio/wav'});
}

async function startRecording() {
  if (busy || recorder) return;
  stopSpeaking();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: false});
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silent = context.createGain(); silent.gain.value = 0;
    const chunks = [];
    let speechSeen = false, lastLoud = Date.now();
    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(chunk);
      let energy = 0;
      for (let i = 0; i < chunk.length; i++) energy += chunk[i] * chunk[i];
      if (Math.sqrt(energy / chunk.length) > 0.012) { speechSeen = true; lastLoud = Date.now(); }
      if (speechSeen && Date.now() - lastLoud > 1200) stopRecording();
    };
    source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    recorder = {stream, context, source, processor, silent, chunks, started: Date.now(),
      timeout: setTimeout(stopRecording, 14000)};
    el('mic').textContent = '■ Dừng và gửi';
    state('Đang nghe con nói', true);
  } catch (error) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    const permissionError = error.name === 'NotAllowedError' ||
      /permission denied/i.test(error.message);
    el('hint').textContent = permissionError
      ? 'macOS chưa cho trình duyệt này dùng micro. Trên máy này Chrome đã có quyền; hãy mở http://127.0.0.1:8765/ bằng Chrome. Nếu dùng trình duyệt trong ChatGPT, vào Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Microphone và bật ChatGPT.'
      : `Không mở được micro: ${error.message}`;
    state('Micro bị hệ thống chặn', true);
  }
}

async function stopRecording() {
  const capture = recorder;
  if (!capture) return;
  recorder = null;
  clearTimeout(capture.timeout);
  capture.processor.disconnect(); capture.source.disconnect(); capture.silent.disconnect();
  capture.stream.getTracks().forEach(track => track.stop());
  const wav = wavFromChunks(capture.chunks, capture.context.sampleRate);
  await capture.context.close();
  el('mic').textContent = '🎙 Bấm để nói';
  if (Date.now() - capture.started < 350) { state('Đến lượt con nói'); return; }
  busy = true; el('mic').disabled = true; state('Đang nhận diện tiếng Hoa', true);
  try {
    const result = await jsonPost('/api/transcribe', wav, 'audio/wav');
    if (!result.text) {
      state('Chưa nghe rõ');
      el('hint').textContent = 'Con thử nói lại gần micro hơn nhé.';
    } else {
      busy = false;
      await sendText(result.text);
    }
  } catch (error) {
    state('Nhận diện giọng nói có lỗi', true);
    el('hint').textContent = `Kiểm tra whisper.cpp: ${error.message}`;
  } finally {
    busy = false;
    el('mic').disabled = !sessionStarted;
  }
}

el('start').addEventListener('click', () => {
  if (previewOnly) { speak(el('teacher-zh').textContent); return; }
  sessionStarted = true;
  el('start').disabled = true;
  el('mic').disabled = false;
  state('Đến lượt con nói');
  speak(el('teacher-zh').textContent);
});
el('mic').addEventListener('click', () => recorder ? stopRecording() : startRecording());
el('stop-speech').addEventListener('click', stopSpeaking);
el('text-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (previewOnly) return;
  const input = el('text-input');
  if (!sessionStarted) { sessionStarted = true; el('start').disabled = true; el('mic').disabled = false; }
  const value = input.value;
  input.value = '';
  sendText(value);
});
if (previewOnly) {
  el('preview-warning').hidden = false;
  el('start').textContent = 'Nghe cô chào';
  el('text-input').disabled = true;
  el('text-form').querySelector('button').disabled = true;
  el('runtime').textContent = 'Bản xem trước 3D · chưa kết nối AI';
  state('Xem trước khuôn mặt 3D');
} else {
  fetch('/api/status').then(r => r.json()).then(data => {
    ttsMode = data.tts;
    const llm = data.llm_ready ? `${data.provider} sẵn sàng` : `${data.provider} chưa chạy`;
    const whisper = data.whisper_ready ? 'nhận giọng nói sẵn sàng' : 'whisper.cpp chưa chạy';
    el('runtime').textContent = `${llm} · ${whisper} · TTS ${data.tts}`;
    if (!data.whisper_ready) {
      el('hint').textContent = 'Micro có thể mở, nhưng whisper.cpp chưa chạy ở cổng 8080 nên chưa nhận được lời nói. Xem README để khởi động dịch vụ này.';
    }
  }).catch(() => { el('runtime').textContent = 'Chưa đọc được cấu hình AI'; });
}
