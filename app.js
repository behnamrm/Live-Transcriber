const $ = (id) => document.getElementById(id);

const LANGS = [
  ['en-US', 'English'], ['fa-IR', 'Persian'], ['de-DE', 'German'], ['fr-FR', 'French'],
  ['es-ES', 'Spanish'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese'], ['nl-NL', 'Dutch'],
  ['tr-TR', 'Turkish'], ['ar-SA', 'Arabic'], ['ru-RU', 'Russian'], ['hi-IN', 'Hindi'],
  ['zh-CN', 'Chinese'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
];
const DEFAULT_MODEL = 'gemini-flash-latest';
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS
const MAX_AUDIO_BYTES = 14 * 1024 * 1024; // inline requests are capped at ~20 MB after base64

const store = {
  get: (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
  },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let notes = store.get('notes', []);
let currentId = null;
let listening = false;
let recognition = null;
let pendingTranslation = '';
let translateTimer = null;
let saveTimer = null;

const VIEWS = ['record', 'notes', 'quiz', 'settings'];
const QUIZ_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      answer: { type: 'INTEGER' },
    },
    required: ['question', 'options', 'answer'],
  },
};
let quizAnswers = [];

function setStatus(msg, isError = false) {
  for (const el of document.querySelectorAll('.status')) {
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }
}

function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const btn of document.querySelectorAll('nav button')) {
    if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  if (name === 'quiz') renderQuiz();
  window.scrollTo(0, 0);
}

/* ---------- Gemini ---------- */

async function gemini(parts, generationConfig) {
  const key = store.get('geminiKey', '');
  if (!key) throw new Error('Add your free Gemini API key in the Settings tab first.');
  const model = store.get('geminiModel', '') || DEFAULT_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Gemini request failed (${res.status})`);
  return (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

const langName = (code) => (LANGS.find(([c]) => c === code) || [])[1] || code;

/* ---------- Live listening ---------- */

function appendText(el, chunk) {
  const sep = el.value && !/\s$/.test(el.value) ? ' ' : '';
  el.value += sep + chunk.trim();
  el.scrollTop = el.scrollHeight;
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus('Live listening is not supported in this browser. Use Chrome (Android/desktop) or Safari (iPhone).', true);
    return false;
  }
  recognition = new SR();
  recognition.lang = $('lang').value;
  recognition.continuous = !IS_MOBILE;
  recognition.interimResults = true;

  // Mobile browsers re-send the growing phrase as separate "final" results, which
  // doubles words. There we take one phrase per session and commit it when it ends.
  let phrase = '';
  const commit = (chunk) => {
    if (!chunk.trim()) return;
    appendText($('text'), chunk);
    queueTranslation(chunk);
    scheduleSave();
  };

  recognition.onresult = (e) => {
    if (IS_MOBILE) {
      phrase = e.results[e.results.length - 1][0].transcript;
      $('interim').textContent = phrase;
      return;
    }
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        commit(chunk);
      } else {
        interim += chunk;
      }
    }
    $('interim').textContent = interim;
  };
  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      listening = false;
      setStatus('Microphone permission was denied.', true);
    } else {
      setStatus(`Speech error: ${e.error}`, true);
    }
  };
  // Browsers end the session after a pause; keep going until the user stops.
  recognition.onend = () => {
    commit(phrase);
    phrase = '';
    $('interim').textContent = '';
    if (listening) {
      try { recognition.start(); } catch { setTimeout(() => listening && startRecognition(), 300); }
    } else {
      updateRecButton();
    }
  };
  try { recognition.start(); } catch (err) { setStatus(err.message, true); return false; }
  return true;
}

function updateRecButton() {
  $('recBtn').textContent = listening ? 'Stop' : 'Start listening';
  $('recBtn').classList.toggle('on', listening);
  $('lang').disabled = listening;
}

function toggleListening() {
  if (listening) {
    listening = false;
    recognition?.stop();
    setStatus('Stopped. Note saved.');
    saveCurrent();
  } else {
    listening = startRecognition();
    // Chrome on Android plays a restart sound that the phone's own mic picks up.
    if (listening) {
      setStatus(/Android/i.test(navigator.userAgent)
        ? 'Listening… Tip: set media volume to zero or use headphones for best results.'
        : 'Listening…');
    }
  }
  updateRecButton();
}

/* ---------- Live translation ---------- */

function queueTranslation(chunk) {
  if (!$('target').value) return;
  pendingTranslation += (pendingTranslation ? ' ' : '') + chunk.trim();
  clearTimeout(translateTimer);
  // Batch sentences so the free tier's requests-per-minute limit isn't hit.
  translateTimer = setTimeout(flushTranslation, 2500);
}

async function flushTranslation() {
  const chunk = pendingTranslation;
  const target = $('target').value;
  if (!chunk || !target) return;
  pendingTranslation = '';
  try {
    const out = await gemini([{
      text: `Translate the following speech transcript into ${langName(target)}. ` +
        `Output only the translation, nothing else.\n\n${chunk}`,
    }]);
    if (out) { appendText($('translation'), out); scheduleSave(); }
  } catch (err) {
    setStatus(`Translation failed: ${err.message}`, true);
  }
}

/* ---------- Fix mistakes / audio file ---------- */

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); } catch (err) { setStatus(err.message, true); }
  btn.disabled = false;
  btn.textContent = old;
}

function fixMistakes() {
  const text = $('text').value.trim();
  if (!text) return setStatus('Nothing to fix yet.');
  withBusy($('fixBtn'), 'Fixing…', async () => {
    const out = await gemini([{
      text: 'This is a raw speech-to-text transcript. Fix recognition mistakes, spelling, ' +
        'punctuation and capitalization, and split it into paragraphs. Keep the original ' +
        'language and meaning; do not summarize, add or remove content. ' +
        `Output only the corrected transcript.\n\n${text}`,
    }]);
    if (out) { $('text').value = out; saveCurrent(); setStatus('Transcript corrected.'); }
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function transcribeFile(file) {
  if (file.size > MAX_AUDIO_BYTES) {
    return setStatus('That file is too large (limit is about 14 MB). Try a shorter or more compressed recording.', true);
  }
  withBusy($('fileBtn'), 'Transcribing…', async () => {
    setStatus('Uploading and transcribing — this can take a minute.');
    const data = await fileToBase64(file);
    const out = await gemini([
      { inline_data: { mime_type: file.type || 'audio/mpeg', data } },
      {
        text: 'Transcribe this recording accurately in its spoken language, with correct ' +
          'punctuation and paragraphs. Output only the transcript.',
      },
    ]);
    if (!out) throw new Error('Gemini returned no transcript.');
    appendText($('text'), out);
    if (!$('title').value) $('title').value = file.name.replace(/\.[^.]+$/, '');
    queueTranslation(out);
    saveCurrent();
    setStatus('Audio file transcribed.');
  });
}

/* ---------- Notes ---------- */

function defaultTitle() {
  return `Note ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function saveCurrent() {
  const text = $('text').value;
  const translation = $('translation').value;
  if (!text.trim() && !translation.trim()) return;
  let note = notes.find((n) => n.id === currentId);
  if (!note) {
    note = { id: Date.now().toString(36), created: Date.now() };
    currentId = note.id;
    notes.unshift(note);
  }
  if (!$('title').value.trim()) $('title').value = defaultTitle();
  Object.assign(note, { title: $('title').value.trim(), text, translation, updated: Date.now() });
  store.set('notes', notes);
  renderNotes();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 800);
}

function loadNote(note) {
  currentId = note ? note.id : null;
  $('title').value = note?.title || '';
  $('text').value = note?.text || '';
  $('translation').value = note?.translation || '';
  pendingTranslation = '';
  quizAnswers = [];
}

function renderNotes() {
  const box = $('notes');
  box.textContent = '';
  if (!notes.length) {
    box.textContent = 'No notes yet.';
    return;
  }
  for (const note of notes) {
    const row = document.createElement('div');
    row.className = 'note';
    const open = document.createElement('button');
    open.className = 'open';
    const t = document.createElement('div');
    t.className = 't';
    t.dir = 'auto';
    t.textContent = note.title;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = new Date(note.updated || note.created).toLocaleString();
    open.append(t, d);
    open.onclick = () => {
      if (listening) return;
      loadNote(note);
      showView('record');
    };
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.onclick = () => {
      if (!confirm(`Delete "${note.title}"?`)) return;
      notes = notes.filter((n) => n.id !== note.id);
      store.set('notes', notes);
      if (currentId === note.id) loadNote(null);
      renderNotes();
    };
    row.append(open, del);
    box.append(row);
  }
}

function noteAsMarkdown() {
  const title = $('title').value.trim() || defaultTitle();
  let md = `# ${title}\n\n${$('text').value.trim()}\n`;
  const tr = $('translation').value.trim();
  if (tr) md += `\n## Translation\n\n${tr}\n`;
  return { title, md };
}

function exportNote() {
  const { title, md } = noteAsMarkdown();
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Quiz ---------- */

const currentNote = () => notes.find((n) => n.id === currentId);

function renderQuiz() {
  const note = currentNote();
  const quiz = note?.quiz || [];
  $('quizNote').textContent = note
    ? `From: ${note.title}`
    : 'Record or open a note first, then make a quiz from it.';
  $('quizBtn').textContent = quiz.length ? 'Make a new quiz' : 'Make quiz';
  const box = $('quiz');
  box.textContent = '';
  let answered = 0;
  let correct = 0;
  quiz.forEach((q, qi) => {
    const chosen = quizAnswers[qi];
    const done = chosen !== undefined;
    if (done) answered++;
    if (chosen === q.answer) correct++;
    const wrap = document.createElement('div');
    wrap.className = 'q';
    wrap.dir = 'auto';
    const p = document.createElement('p');
    p.textContent = `${qi + 1}. ${q.question}`;
    wrap.append(p);
    q.options.forEach((opt, oi) => {
      const btn = document.createElement('button');
      btn.textContent = opt;
      btn.disabled = done;
      if (done && oi === q.answer) btn.className = 'right';
      else if (done && oi === chosen) btn.className = 'wrong';
      btn.onclick = () => { quizAnswers[qi] = oi; renderQuiz(); };
      wrap.append(btn);
    });
    box.append(wrap);
  });
  $('score').textContent = answered ? `Score: ${correct} / ${quiz.length}` : '';
}

async function makeQuiz() {
  saveCurrent();
  const note = currentNote();
  if (!note || !note.text.trim()) return setStatus('Record or open a note with some text first.', true);
  await withBusy($('quizBtn'), 'Making quiz…', async () => {
    setStatus('');
    const raw = await gemini([{
      text: `Write ${$('quizCount').value} multiple-choice questions that test understanding of the ` +
        'text below. Each question has exactly 4 options and one correct answer; "answer" is the ' +
        'zero-based index of the correct option. Write the questions in the same language as ' +
        `the text.\n\n${note.text}`,
    }], { responseMimeType: 'application/json', responseSchema: QUIZ_SCHEMA });
    let quiz = [];
    try { quiz = JSON.parse(raw); } catch {}
    quiz = (Array.isArray(quiz) ? quiz : []).filter((q) =>
      q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length > 1 &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
    if (!quiz.length) throw new Error('Gemini did not return a usable quiz. Try again.');
    note.quiz = quiz;
    store.set('notes', notes);
    quizAnswers = [];
  });
  renderQuiz();
}

async function copyFrom(el) {
  if (!el.value.trim()) return setStatus('Nothing to copy yet.');
  try {
    await navigator.clipboard.writeText(el.value);
    setStatus('Copied.');
  } catch { setStatus('Could not copy — select the text and copy manually.', true); }
}

/* ---------- Wiring ---------- */

function init() {
  for (const [code, name] of LANGS) $('lang').add(new Option(name, code));
  $('target').add(new Option('Off', ''));
  for (const [code, name] of LANGS) $('target').add(new Option(name, code));
  $('lang').value = store.get('lang', 'en-US');
  $('target').value = store.get('target', '');
  $('apiKey').value = store.get('geminiKey', '');
  $('model').value = store.get('geminiModel', '');
  $('translationBox').hidden = !$('target').value;

  $('lang').onchange = () => store.set('lang', $('lang').value);
  $('target').onchange = () => {
    store.set('target', $('target').value);
    $('translationBox').hidden = !$('target').value && !$('translation').value;
  };
  $('apiKey').onchange = () => store.set('geminiKey', $('apiKey').value.trim());
  $('model').onchange = () => store.set('geminiModel', $('model').value.trim());
  for (const btn of document.querySelectorAll('nav button')) btn.onclick = () => showView(btn.dataset.view);
  $('quizBtn').onclick = makeQuiz;

  $('recBtn').onclick = toggleListening;
  $('fixBtn').onclick = fixMistakes;
  $('fileBtn').onclick = () => $('file').click();
  $('file').onchange = () => {
    if ($('file').files[0]) transcribeFile($('file').files[0]);
    $('file').value = '';
  };
  $('copyBtn').onclick = () => copyFrom($('text'));
  $('copyTrBtn').onclick = () => copyFrom($('translation'));
  $('exportBtn').onclick = exportNote;
  $('shareBtn').hidden = !navigator.share;
  $('shareBtn').onclick = () => {
    const { title, md } = noteAsMarkdown();
    navigator.share({ title, text: md }).catch(() => {});
  };
  $('newBtn').onclick = () => {
    if (listening) toggleListening();
    saveCurrent();
    loadNote(null);
    setStatus('');
  };
  for (const id of ['title', 'text', 'translation']) $(id).oninput = scheduleSave;

  renderNotes();
  showView('record');
}

init();
