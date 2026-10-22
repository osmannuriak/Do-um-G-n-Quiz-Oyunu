/**
 * Dogum Gunu Quiz - istemci
 * -------------------------
 * Tek sayfa uygulama. Sunucudan gelen "sync" olayi oda durumunu tasir, ekran o veriye
 * gore cizilir.
 *  - Quiz'ler hazirlayanin tarayicisinda (IndexedDB) saklanir, her degisiklik otomatik kaydedilir.
 *  - Oda kurulurken quiz sunucuya gonderilir. Sunucu yeniden baslarsa yonetici tarayicisi
 *    odayi geri kurar, herkes otomatik yeniden baglanir.
 *  - localStorage sadece kucuk oturum bilgileri (rol, kod, anahtar) icin kullanilir.
 */

(function () {
  const $app = document.getElementById('app');
  const $conn = document.getElementById('conn-banner');
  const socket = io({ reconnectionDelayMax: 4000 });

  const TIME_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  const MAX_RESULT_PHOTOS = 3;

  let view = 'home';
  let latestSync = null;
  let lastSyncJson = '';
  let editorQuiz = null;
  let quizList = [];
  let pendingCode = null;
  let pendingBirthdayToken = null;
  let session = null; // { role, code, token?, savedId?, name? } aktif oda oturumu
  let joinError = '';
  let busy = false;
  const confettiFired = {};

  // Soru sayaci icin yerel bitis zamani (sunucunun gonderdigi kalan sureden hesaplanir).
  let deadline = null;
  let lastTickKey = null;
  let lastResultSoundKey = null;

  // Siralama sorusunda henuz gonderilmemis yerel sira (sik id'leri) ve hangi soruya ait oldugu.
  let rankingWorkingOrder = null;
  let rankingWorkingKey = null;

  // Ozel cevap formu acik mi (hangi soru icin)
  let customFormKey = null;
  // Oyuncunun tikladigi ama sunucudan onayi henuz gelmemis cevap (anlik geri bildirim icin)
  let pendingAnswerKey = null;

  // ---------- yardimcilar ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* dolu/kapali */ } }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* yok say */ } }
  function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function onAll(sel, ev, fn) { $app.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn)); }
  function makeId() { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  let toastTimer = null;
  function showToast(msg, kind) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3200);
  }

  function setConnBanner(text) {
    if (!$conn) return;
    $conn.textContent = text || '';
    $conn.classList.toggle('show', !!text);
  }

  function copyText(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast('Kopyalandı!', 'ok')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Kopyalandı!', 'ok'); } catch (e) { /* yok say */ }
    ta.remove();
  }

  function doubleBadge(q) {
    return q && q.doublePoints ? ' <span class="badge badge-double">⭐ 2x PUAN</span>' : '';
  }

  function questionKey(s) { return s ? s.code + '-' + s.questionIndex : ''; }

  // ---------- ekran cizimi (gecis animasyonu + girdi koruma) ----------

  let lastScreenKey = null;

  function captureInputs() {
    const fields = [];
    $app.querySelectorAll('input[id], textarea[id]').forEach((el) => {
      if (el.type === 'file') return;
      fields.push({ id: el.id, value: el.value, checked: el.checked });
    });
    const active = document.activeElement;
    let focus = null;
    if (active && active.id && $app.contains(active)) {
      focus = { id: active.id, start: null, end: null };
      try { focus.start = active.selectionStart; focus.end = active.selectionEnd; } catch (e) { /* number input */ }
    }
    return { fields, focus };
  }

  function restoreInputs(saved) {
    for (const f of saved.fields) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = f.checked;
      else el.value = f.value;
    }
    if (saved.focus) {
      const el = document.getElementById(saved.focus.id);
      if (el) {
        el.focus({ preventScroll: true });
        try { if (saved.focus.start != null) el.setSelectionRange(saved.focus.start, saved.focus.end); } catch (e) { /* yok say */ }
      }
    }
  }

  // Ekran (rol/durum/soru) degistiyse kisa bir giris animasyonu oynar; ayni ekran yeniden
  // ciziliyorsa animasyon yok ve yazilmakta olan metinler korunur.
  function paint(html, screenKey) {
    const isNew = screenKey !== lastScreenKey;
    const saved = isNew ? null : captureInputs();
    $app.innerHTML = `<div class="screen${isNew ? ' screen-enter' : ''}">${html}</div>`;
    if (saved) restoreInputs(saved);
    if (isNew) window.scrollTo(0, 0);
    lastScreenKey = screenKey;
  }

  // ---------- ses efektleri ----------
  // Kucuk sesler Web Audio ile bir kere uretilip bellekte tutulur (dosya indirme yok, gecikme yok).
  // Tek kanal: yeni ses baslamadan once calan ses durdurulur, sesler ust uste binmez.

  const Sound = (function () {
    let ctx = null;
    const buffers = {};
    let current = null;
    let currentName = null;

    function build(notes, volume) {
      const sr = ctx.sampleRate;
      const total = Math.max(...notes.map((n) => n[1] + n[2])) + 0.02;
      const buf = ctx.createBuffer(1, Math.ceil(total * sr), sr);
      const data = buf.getChannelData(0);
      for (const [freq, start, dur] of notes) {
        const s0 = Math.floor(start * sr);
        const len = Math.floor(dur * sr);
        for (let i = 0; i < len && s0 + i < data.length; i++) {
          const t = i / sr;
          const env = Math.min(1, t / 0.006) * Math.exp(-t * (5 / dur));
          const wave = Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t);
          data[s0 + i] += wave * env * volume;
        }
      }
      return buf;
    }

    function init() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try { ctx = new Ctx(); } catch (e) { ctx = null; return; }
      // iOS'ta ses motorunu acmak icin sessiz bir ornek cal.
      try {
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, 1, 22050);
        silent.connect(ctx.destination);
        silent.start(0);
      } catch (e) { /* yok say */ }
      buffers.tick = build([[1250, 0, 0.045]], 0.22);
      buffers.tock = build([[880, 0, 0.045]], 0.22);
      buffers.win = build([[523.25, 0, 0.14], [659.25, 0.09, 0.14], [783.99, 0.18, 0.16], [1046.5, 0.27, 0.3]], 0.16);
      buffers.fail = build([[392, 0, 0.2], [311.13, 0.16, 0.36]], 0.17);
    }

    function stop() {
      if (!current) return;
      try { current.stop(); } catch (e) { /* zaten durdu */ }
      try { current.disconnect(); } catch (e) { /* yok say */ }
      current = null;
      currentName = null;
    }

    function play(name) {
      if (!ctx || !buffers[name]) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      stop();
      const src = ctx.createBufferSource();
      src.buffer = buffers[name];
      src.connect(ctx.destination);
      src.onended = () => {
        if (current === src) { current = null; currentName = null; }
        try { src.disconnect(); } catch (e) { /* yok say */ }
      };
      src.start();
      current = src;
      currentName = name;
    }

    function isTicking() { return currentName === 'tick' || currentName === 'tock'; }
    function stopTicking() { if (isTicking()) stop(); }

    return { init, play, stop, stopTicking };
  })();

  // Tarayicilar sesi ancak bir kullanici etkilesiminden sonra calar; ilk dokunusta hazirla.
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((ev) => document.addEventListener(ev, Sound.init, { passive: true }));

  function handleSoundsOnSync(s) {
    if (s.role !== 'player') return;
    if (s.status !== 'question_open' || s.hasAnswered) Sound.stopTicking();
    if (s.status === 'question_results') {
      const key = questionKey(s);
      if (lastResultSoundKey !== key) {
        lastResultSoundKey = key;
        const r = s.myResult || {};
        Sound.play(r.won ? 'win' : 'fail');
      }
    }
  }

  // ---------- gorsel on yukleme ----------

  const preloaded = new Set();
  function preloadImages(urls) {
    for (const url of urls || []) {
      if (!url || preloaded.has(url)) continue;
      preloaded.add(url);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    }
  }

  // ---------- gorsel sikistirma (tarayicida, max 800px, WebP / JPEG) ----------

  let webpSupported = null;
  function canEncodeWebp() {
    if (webpSupported === null) {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
      } catch (e) { webpSupported = false; }
    }
    return webpSupported;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Görsel açılamadı.')); };
      img.src = url;
    });
  }

  async function compressImage(file, maxDim = 800) {
    if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('Lütfen bir görsel dosyası seç.');
    const img = await loadImageFromFile(file);
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const type = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(img, 0, 0, width, height);
    let dataUrl = canvas.toDataURL(type, 0.8);
    if (dataUrl.length > 1_400_000) dataUrl = canvas.toDataURL(type, 0.6);
    canvas.width = canvas.height = 0; // bellegi birak
    return dataUrl;
  }

  function bindImageInput(inputId, onPicked) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener('change', async () => {
      const files = Array.from(el.files || []);
      if (!files.length) return;
      showToast('Görsel hazırlanıyor...', 'info');
      const results = [];
      for (const file of files) {
        try {
          results.push(await compressImage(file));
        } catch (e) {
          showToast(e.message || 'Görsel yüklenemedi.');
        }
      }
      if (results.length) onPicked(results);
    });
  }

  // ---------- quiz deposu (IndexedDB; yoksa localStorage) ----------

  const QuizStore = (function () {
    const DB_NAME = 'dogum-gunu-quiz';
    const STORE = 'quizzes';
    const LS_KEY = 'bq_quizzes_fallback';
    let dbPromise = null;
    let usingFallback = false;
    let persistAsked = false;

    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        if (!window.indexedDB) { usingFallback = true; resolve(null); return; }
        let req;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { usingFallback = true; resolve(null); return; }
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { usingFallback = true; resolve(null); };
        req.onblocked = () => { usingFallback = true; resolve(null); };
      });
      return dbPromise;
    }

    function run(mode, fn) {
      return openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = fn(store);
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error || new Error('Kayıt hatası'));
        tx.onabort = () => reject(tx.error || new Error('Kayıt iptal oldu (depolama dolu olabilir).'));
      }));
    }

    function lsAll() { return lsGet(LS_KEY) || {}; }
    function lsWrite(map) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) {
        throw new Error('Tarayıcı depolama alanı dolu. Quizi indirip yedekle.');
      }
    }

    async function all() {
      const db = await openDb();
      if (!db) return Object.values(lsAll());
      return run('readonly', (s) => s.getAll());
    }
    async function get(id) {
      if (!id) return null;
      const db = await openDb();
      if (!db) return lsAll()[id] || null;
      return (await run('readonly', (s) => s.get(id))) || null;
    }
    async function put(quiz) {
      const db = await openDb();
      if (!persistAsked && navigator.storage && navigator.storage.persist) {
        persistAsked = true;
        navigator.storage.persist().catch(() => {});
      }
      if (!db) { const map = lsAll(); map[quiz.id] = quiz; lsWrite(map); return; }
      await run('readwrite', (s) => s.put(quiz));
    }
    async function remove(id) {
      const db = await openDb();
      if (!db) { const map = lsAll(); delete map[id]; lsWrite(map); return; }
      await run('readwrite', (s) => s.delete(id));
    }
    function isFallback() { return usingFallback; }
    return { all, get, put, remove, isFallback };
  })();

  // ---------- quiz modeli ----------

  function newQuestion() {
    return { text: '', type: 'choice', options: ['', ''], unit: '', timeLimit: 20, imageUrl: '', doublePoints: false };
  }

  function newQuiz() {
    const now = Date.now();
    return { id: makeId(), title: '', questions: [newQuestion()], correctPhotos: [], wrongPhotos: [], createdAt: now, updatedAt: now };
  }

  // Eski surumlerin, indirilen dosyalarin ve sunucunun eski quiz formatini da kabul eder.
  function normalizeQuiz(raw) {
    const q = raw && raw.quiz && typeof raw.quiz === 'object' ? raw.quiz : raw;
    if (!q || typeof q !== 'object' || !Array.isArray(q.questions)) throw new Error('Bu dosya geçerli bir quiz dosyası değil.');
    const photos = (list, single) => (Array.isArray(list) ? list : (single ? [single] : []))
      .filter((s) => typeof s === 'string' && s).slice(0, MAX_RESULT_PHOTOS);
    const questions = q.questions.map((x) => {
      const type = x && (x.type === 'numeric' || x.type === 'ranking') ? x.type : 'choice';
      let options = Array.isArray(x && x.options) ? x.options.map((o) => String(o == null ? '' : o)) : [];
      if (type === 'numeric') options = [];
      else while (options.length < 2) options.push('');
      const t = parseInt(x && x.timeLimit, 10);
      return {
        text: String((x && x.text) || ''),
        type,
        options: options.slice(0, 6),
        unit: String((x && x.unit) || ''),
        timeLimit: TIME_OPTIONS.includes(t) ? t : 20,
        imageUrl: x && typeof x.imageUrl === 'string' ? x.imageUrl : '',
        doublePoints: !!(x && x.doublePoints === true),
      };
    });
    const now = Date.now();
    return {
      id: typeof q.id === 'string' && q.id ? q.id : makeId(),
      title: String(q.title || ''),
      questions: questions.length ? questions : [newQuestion()],
      correctPhotos: photos(q.correctPhotos, q.correctPhotoUrl),
      wrongPhotos: photos(q.wrongPhotos, q.wrongPhotoUrl),
      createdAt: Number(q.createdAt) || now,
      updatedAt: Number(q.updatedAt) || now,
    };
  }

  function isQuizEmpty(q) {
    return !q.title.trim() && !q.correctPhotos.length && !q.wrongPhotos.length &&
      q.questions.every((x) => !x.text.trim() && !x.imageUrl && x.options.every((o) => !o.trim()));
  }

  function validateQuiz(q) {
    if (!q) return 'Quiz bulunamadı.';
    if (!q.title.trim()) return 'Quiz başlığı boş olamaz.';
    if (!q.questions.length) return 'En az bir soru eklemelisin.';
    for (let i = 0; i < q.questions.length; i++) {
      const x = q.questions[i];
      if (!x.text.trim()) return `${i + 1}. soruda metin boş.`;
      if (x.type !== 'numeric' && x.options.filter((o) => o.trim()).length < 2) return `${i + 1}. soruda en az 2 dolu seçenek olmalı.`;
    }
    return null;
  }

  function quizForServer(q) {
    return {
      title: q.title.trim(),
      correctPhotos: q.correctPhotos,
      wrongPhotos: q.wrongPhotos,
      questions: q.questions.map((x) => ({
        text: x.text.trim(),
        type: x.type,
        options: x.type === 'numeric' ? [] : x.options.map((o) => o.trim()).filter(Boolean),
        unit: x.unit || '',
        timeLimit: x.timeLimit,
        imageUrl: x.imageUrl || '',
        doublePoints: !!x.doublePoints,
      })),
    };
  }

  // ---------- otomatik kayit ----------

  let saveTimer = null;
  let saveStatusText = '';

  function setSaveStatus(text) {
    saveStatusText = text;
    const el = document.getElementById('autosave-status');
    if (el) el.textContent = text;
  }

  function scheduleSave() {
    if (!editorQuiz) return;
    setSaveStatus('Kaydediliyor…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!editorQuiz) return;
    editorQuiz.updatedAt = Date.now();
    try {
      await QuizStore.put(editorQuiz);
      setSaveStatus('✓ Bu cihaza kaydedildi');
    } catch (e) {
      setSaveStatus('⚠️ Kaydedilemedi');
      showToast((e && e.message) || 'Quiz kaydedilemedi. Lütfen "Quizi İndir" ile yedek al.');
    }
  }

  // Sayfa kapanirken/arka plana alinirken bekleyen kaydi hemen yap.
  window.addEventListener('pagehide', () => { if (saveTimer) flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) flushSave(); });

  // Editorde yazilan her sey otomatik kaydedilir (tek, kalici dinleyici).
  function onEditorFieldChange(e) {
    if (view !== 'adminQuizEditor' || !editorQuiz) return;
    if (!e.target.closest('.editor') || e.target.type === 'file' || e.target.dataset.field === 'qtype') return;
    syncEditorFromDOM();
    scheduleSave();
  }
  $app.addEventListener('input', onEditorFieldChange);
  $app.addEventListener('change', onEditorFieldChange);

  // ---------- indir / yukle ----------

  function fileSafeName(title) {
    const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u' };
    const base = String(title || '').replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => map[c]).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || 'dogum-gunu-quiz';
  }

  function downloadQuiz(quiz) {
    const data = JSON.stringify({ format: 'dogum-gunu-quiz', version: 2, exportedAt: new Date().toISOString(), quiz });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileSafeName(quiz.title) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    showToast('Quiz dosyası indiriliyor ⬇️', 'ok');
  }

  function readFileText(file) {
    if (file.text) return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Dosya okunamadı.'));
      r.readAsText(file);
    });
  }

  async function importQuizFile(file) {
    if (!file) return;
    try {
      let parsed;
      try { parsed = JSON.parse(await readFileText(file)); } catch (e) { throw new Error('Dosya okunamadı (geçerli bir quiz dosyası değil).'); }
      const quiz = normalizeQuiz(parsed);
      const existing = await QuizStore.get(quiz.id);
      if (existing && !confirm(`"${existing.title || 'Başlıksız quiz'}" bu cihazda zaten var. Üzerine yazılsın mı?\n\n(İptal dersen ayrı bir kopya olarak eklenir.)`)) {
        quiz.id = makeId();
      }
      quiz.updatedAt = Date.now();
      await QuizStore.put(quiz);
      showToast('Quiz yüklendi ✅', 'ok');
      goAdminQuizList();
    } catch (e) {
      showToast(e.message || 'Quiz yüklenemedi.');
    }
  }

  // ---------- oda oturumu, yeniden baglanma, geri kurma ----------

  function startSession(s) {
    session = s;
    emitJoin();
  }

  function emitJoin() {
    if (!session || !socket.connected) return;
    const { role, code, token, savedId, name } = session;
    if (role === 'admin') socket.emit('admin:join', { code, token });
    else if (role === 'birthday') socket.emit('birthday:join', { code, token, savedId, name });
    else if (role === 'player') socket.emit('player:join', { code, savedId, name });
  }

  function endSession() {
    session = null;
    latestSync = null;
    lastSyncJson = '';
    deadline = null;
    Sound.stop();
    clearTimeout(rejoinTimer);
  }

  let rejoinTimer = null;
  function scheduleRejoin(ms) {
    clearTimeout(rejoinTimer);
    rejoinTimer = setTimeout(emitJoin, ms);
  }

  // Yonetici her guncellemede son durumu saklar; sunucu yeniden baslarsa oda bununla geri kurulur.
  function saveSnapshot(s) {
    if (!session || session.role !== 'admin') return;
    lsSet('bq_snapshot_' + s.code, {
      code: s.code,
      adminToken: session.token,
      birthdayToken: s.birthdayToken,
      status: s.status,
      questionIndex: s.questionIndex,
      birthday: s.birthdayId ? { id: s.birthdayId, name: s.birthdayName } : null,
      players: s.players,
    });
  }

  let restoring = false;
  async function restoreRoom() {
    if (restoring || !session) return;
    restoring = true;
    const code = session.code;
    setConnBanner('Sunucu yeniden başladı — oda geri kuruluyor…');
    try {
      const meta = lsGet('bq_admin_' + code) || {};
      const snapshot = lsGet('bq_snapshot_' + code);
      const quiz = meta.quizId ? await QuizStore.get(meta.quizId) : null;
      if (!quiz || !snapshot) {
        setConnBanner('');
        endSession();
        showToast('Bu oda artık yok ve geri kurmak için gereken quiz bu cihazda bulunamadı.');
        goAdminQuizList();
        return;
      }
      const res = await fetch('/api/rooms/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quiz: quizForServer(quiz), snapshot }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConnBanner('');
        endSession();
        showToast(data.error || 'Oda geri kurulamadı.');
        goAdminQuizList();
        return;
      }
      emitJoin();
    } catch (e) {
      // Sunucu henuz ayakta degil: biraz sonra tekrar dene.
      scheduleRejoin(4000);
    } finally {
      restoring = false;
    }
  }

  // ---------- soru sayaci + tik-tak ----------

  setInterval(() => {
    const s = latestSync;
    if (!s || s.status !== 'question_open' || !deadline) return;
    const remain = Math.max(0, (deadline - Date.now()) / 1000);
    const remainInt = Math.ceil(remain);
    const ring = document.getElementById('timer-ring');
    if (ring) {
      const total = (s.question && s.question.duration) || 1;
      ring.style.setProperty('--pct', Math.max(0, Math.min(100, (remain / total) * 100)) + '%');
      ring.classList.toggle('urgent', remainInt <= 5);
      const txt = document.getElementById('timer-text');
      if (txt && txt.textContent !== String(remainInt)) txt.textContent = remainInt;
    }
    // Tik-tak sadece oyuncuda, son 5 saniyede ve henuz cevap verilmemisken.
    const waiting = s.role === 'player' && !s.hasAnswered && pendingAnswerKey !== questionKey(s);
    if (waiting && remainInt >= 1 && remainInt <= 5) {
      const key = questionKey(s) + '-' + remainInt;
      if (key !== lastTickKey) {
        lastTickKey = key;
        Sound.play(remainInt % 2 ? 'tick' : 'tock');
      }
    } else {
      Sound.stopTicking();
    }
  }, 200);

  // ---------- socket olaylari ----------

  socket.on('connect', () => {
    setConnBanner('');
    emitJoin();
  });

  socket.on('disconnect', () => {
    if (session) setConnBanner('Bağlantı koptu, yeniden bağlanılıyor…');
  });

  function roleView(role) {
    return role === 'admin' ? 'adminRoom' : role === 'birthday' ? 'birthdayRoom' : 'playerRoom';
  }

  socket.on('sync', (state) => {
    if (!session || state.code !== session.code) return;
    setConnBanner('');
    const json = JSON.stringify(state);
    const targetView = roleView(state.role);
    if (json === lastSyncJson && view === targetView) return; // degisiklik yok, yeniden cizme
    lastSyncJson = json;

    deadline = state.status === 'question_open' && state.question && state.question.remainingMs != null
      ? Date.now() + state.question.remainingMs
      : null;
    if (state.status !== 'question_open' || state.hasAnswered) pendingAnswerKey = null;

    latestSync = state;
    joinError = '';
    if (state.preload) preloadImages(state.preload);
    if (state.role === 'admin') saveSnapshot(state);
    view = targetView;
    handleSoundsOnSync(state);
    render();
  });

  socket.on('joined', ({ id, name }) => {
    if (!session) return;
    session.savedId = id;
    if (name) session.name = name;
    if (session.role === 'player') lsSet('bq_player_' + session.code, { id, name: session.name });
    if (session.role === 'birthday') lsSet('bq_birthday_' + session.code, { id, token: session.token, name: session.name });
  });

  socket.on('roomMissing', () => {
    if (!session) return;
    // Oyun bitmisse ve oda temizlendiyse son ekran kalsin.
    if (latestSync && latestSync.status === 'finished') { setConnBanner(''); return; }
    if (session.role === 'admin') { restoreRoom(); return; }
    // Ilk kez katilmaya calisiyorsa (kayitli oturum yok) bu gercekten yanlis bir koddur.
    if (!session.savedId && !latestSync) {
      const role = session.role;
      endSession();
      joinError = role === 'birthday' ? 'Oda bulunamadı. Bağlantı eski olabilir.' : 'Oda bulunamadı. Kodu kontrol et.';
      view = role === 'birthday' ? 'birthdayJoin' : 'playerJoin';
      render();
      return;
    }
    // Sunucu yeniden basladi: yonetici odayi geri kurana kadar bekle ve tekrar dene.
    setConnBanner('Sunucu yeniden başladı — oyun geri yükleniyor, lütfen bekle…');
    scheduleRejoin(3000);
  });

  socket.on('errorMsg', ({ message }) => {
    showToast(message);
    busy = false;
    if (!latestSync && session) {
      const role = session.role;
      endSession();
      joinError = message;
      if (role === 'birthday') view = 'birthdayJoin';
      else if (role === 'player') view = 'playerJoin';
      else { goAdminQuizList(); return; }
      render();
    } else if (latestSync) {
      render(); // devre disi kalan butonlari geri ac
    }
  });

  socket.on('roomCancelled', () => {
    const wasAdmin = session && session.role === 'admin';
    if (session) {
      lsDel('bq_snapshot_' + session.code);
      lsDel('bq_admin_' + session.code);
    }
    endSession();
    if (wasAdmin) {
      showToast('Oda iptal edildi.', 'info');
      goAdminQuizList();
    } else {
      view = 'roomCancelled';
      render();
    }
  });

  // ---------- baslangic yonlendirme ----------

  async function boot() {
    const role = qs('role');
    const code = (qs('code') || '').toUpperCase();
    const token = qs('token');

    if (role === 'admin' && code && token) {
      const meta = lsGet('bq_admin_' + code) || {};
      lsSet('bq_admin_' + code, { ...meta, token });
      view = 'adminRoom';
      render();
      startSession({ role: 'admin', code, token });
      return;
    }
    if (role === 'birthday' && code && token) {
      pendingCode = code;
      pendingBirthdayToken = token;
      const saved = lsGet('bq_birthday_' + code);
      if (saved && saved.id) {
        view = 'birthdayRoom';
        render();
        startSession({ role: 'birthday', code, token, savedId: saved.id, name: saved.name });
      } else {
        view = 'birthdayJoin';
        render();
      }
      return;
    }
    if (code) {
      pendingCode = code;
      const saved = lsGet('bq_player_' + code);
      if (saved && saved.id) {
        view = 'playerRoom';
        render();
        startSession({ role: 'player', code, savedId: saved.id, name: saved.name });
      } else {
        view = 'playerJoin';
        render();
      }
      return;
    }
    // Hazirlanmakta olan bir quiz varsa kaldigi yerden editorde ac.
    const editingId = lsGet('bq_editing');
    if (editingId) {
      const quiz = await QuizStore.get(editingId).catch(() => null);
      if (quiz) {
        openEditor(normalizeQuiz(quiz));
        return;
      }
      lsDel('bq_editing');
    }
    view = 'home';
    render();
  }

  // ---------- render dispatch ----------

  function render() {
    if (view === 'home') return renderHome();
    if (view === 'playerJoin') return renderPlayerJoin();
    if (view === 'birthdayJoin') return renderBirthdayJoin();
    if (view === 'adminQuizList') return renderAdminQuizList();
    if (view === 'adminQuizEditor') return renderAdminQuizEditor();
    if (view === 'adminRoom') return renderAdminRoom();
    if (view === 'birthdayRoom') return renderBirthdayRoom();
    if (view === 'playerRoom') return renderPlayerRoom();
    if (view === 'roomCancelled') return renderRoomCancelled();
    return renderHome();
  }

  function roomScreenKey(s) {
    return view + '-' + s.status + '-' + s.questionIndex;
  }

  function connectingScreen(text) {
    paint(`<div class="card center stack"><div class="emoji pulse" style="font-size:2.2rem">🔌</div><p class="muted">${esc(text)}</p></div>`, 'connecting-' + view);
  }

  // ---------- ANA SAYFA ----------

  function renderHome() {
    paint(`
      <div class="hero">
        <div class="emoji">🎉🎂🎈</div>
        <h1>Doğum Günü Quiz</h1>
        <p class="muted">Sorular doğum günü çocuğu hakkında — doğru cevabı o anlık belirliyor!</p>
      </div>
      <div class="stack">
        <button class="btn-primary btn-block btn-lg" id="go-admin"><span class="btn-icon">🛠️</span>Quiz Oluştur / Yönet</button>
        <button class="btn-secondary btn-block btn-lg" id="go-join"><span class="btn-icon">🎮</span>Odaya Katıl</button>
      </div>
    `, 'home');
    on('go-admin', 'click', goAdminQuizList);
    on('go-join', 'click', () => { view = 'playerJoin'; render(); });
  }

  function renderRoomCancelled() {
    paint(`
      <div class="hero">
        <div class="emoji">🚫</div>
        <h2>Oda iptal edildi</h2>
        <p class="muted">Yönetici bu odayı iptal etti.</p>
      </div>
      <button class="btn-primary btn-block btn-lg" id="cancelled-home">Ana sayfaya dön</button>
    `, 'cancelled');
    on('cancelled-home', 'click', () => { history.pushState({}, '', '/'); view = 'home'; render(); });
  }

  // ---------- OYUNCU KATILMA ----------

  function renderPlayerJoin() {
    paint(`
      <div class="hero">
        <div class="emoji">🎮</div>
        <h2>Odaya Katıl</h2>
      </div>
      <div class="card stack">
        <div>
          <label for="join-code">Oda Kodu</label>
          <input type="text" id="join-code" class="code-input" maxlength="6" autocomplete="off" placeholder="ABC123" value="${esc(pendingCode || '')}">
        </div>
        <div>
          <label for="join-name">İsmin</label>
          <input type="text" id="join-name" maxlength="24" autocomplete="off" placeholder="Adını yaz">
        </div>
        ${joinError ? `<p class="error-text">${esc(joinError)}</p>` : ''}
        <button class="btn-primary btn-block btn-lg" id="join-submit">Katıl 🚀</button>
        <button class="btn-ghost" id="join-back">← Ana sayfa</button>
      </div>
    `, 'playerJoin');
    const codeEl = document.getElementById('join-code');
    codeEl.addEventListener('input', () => { codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
    on('join-submit', 'click', () => {
      const code = codeEl.value.trim().toUpperCase();
      const name = document.getElementById('join-name').value.trim();
      if (code.length !== 6) return showToast('Oda kodu 6 karakter olmalı.');
      if (!name) return showToast('Lütfen bir isim yaz.');
      pendingCode = code;
      joinError = '';
      history.replaceState({}, '', '/?code=' + code);
      startSession({ role: 'player', code, name });
    });
    on('join-back', 'click', () => { view = 'home'; render(); });
  }

  // ---------- DOGUM GUNU SAHIBI KATILMA ----------

  function renderBirthdayJoin() {
    paint(`
      <div class="hero">
        <div class="emoji bounce">🎂</div>
        <h2>Bugün senin günün!</h2>
        <p class="muted">Bu özel bağlantı sadece doğum günü çocuğu için. Sorulara gizlice sen cevap vereceksin.</p>
      </div>
      <div class="card stack">
        <div>
          <label for="bday-name">İsmin</label>
          <input type="text" id="bday-name" maxlength="30" autocomplete="off" placeholder="Adını yaz">
        </div>
        ${joinError ? `<p class="error-text">${esc(joinError)}</p>` : ''}
        <button class="btn-primary btn-block btn-lg" id="bday-submit">Hazırım 🎉</button>
      </div>
    `, 'birthdayJoin');
    on('bday-submit', 'click', () => {
      const name = document.getElementById('bday-name').value.trim();
      if (!name) return showToast('Lütfen ismini yaz.');
      joinError = '';
      startSession({ role: 'birthday', code: pendingCode, token: pendingBirthdayToken, name });
    });
  }

  // ---------- ADMIN: QUIZ LISTESI ----------

  async function goAdminQuizList() {
    await leaveEditor();
    view = 'adminQuizList';
    try {
      quizList = (await QuizStore.all()).map(normalizeQuiz).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      quizList = [];
      showToast('Kayıtlı quizler okunamadı.');
    }
    if (view === 'adminQuizList') render();
  }

  function formatTime(ms) {
    try {
      return new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function renderAdminQuizList() {
    paint(`
      <div class="row">
        <button class="btn-ghost" id="back-home">← Ana sayfa</button>
        <div class="spacer"></div>
      </div>
      <h2>Quiz'lerim</h2>
      <div class="row wrap">
        <button class="btn-primary" id="new-quiz" style="flex:1 1 160px">+ Yeni Quiz</button>
        <label class="btn btn-secondary file-btn" style="flex:1 1 160px">⬆️ Quizi Yükle
          <input type="file" id="quiz-import-file" accept=".json,application/json" hidden>
        </label>
      </div>
      ${QuizStore.isFallback() ? '<p class="warn-text">⚠️ Bu tarayıcıda gelişmiş depolama kapalı; büyük görseller kaydedilemeyebilir. Quizi mutlaka indirip yedekle.</p>' : ''}
      <div class="stack" id="quiz-list">
        ${quizList.length ? quizList.map((q) => `
          <div class="card stack quiz-card">
            <div>
              <strong>${esc(q.title || 'Başlıksız quiz')}</strong>
              <div class="muted">${q.questions.length} soru · son kayıt ${esc(formatTime(q.updatedAt))}</div>
            </div>
            <div class="row wrap">
              <button class="small-btn btn-secondary edit-quiz" data-id="${esc(q.id)}">Düzenle</button>
              <button class="small-btn btn-success make-room" data-id="${esc(q.id)}">Oda Kur 🚪</button>
              <button class="small-btn btn-secondary download-quiz" data-id="${esc(q.id)}">İndir ⬇️</button>
              <button class="small-btn btn-danger del-quiz" data-id="${esc(q.id)}">Sil</button>
            </div>
          </div>
        `).join('') : '<p class="muted center">Henüz quiz yok. "Yeni Quiz" ile başla!</p>'}
      </div>
      <p class="muted center">Quizlerin bu cihazın tarayıcısında saklanır; sunucu yeniden başlasa da silinmez. Başka cihaza taşımak için <b>İndir</b> → diğer cihazda <b>Quizi Yükle</b>.</p>
    `, 'list');
    on('back-home', 'click', () => { view = 'home'; render(); });
    on('new-quiz', 'click', () => openEditor(newQuiz()));
    on('quiz-import-file', 'change', (e) => importQuizFile(e.target.files && e.target.files[0]));
    const byId = (id) => quizList.find((q) => q.id === id);
    onAll('.edit-quiz', 'click', (e) => { const q = byId(e.currentTarget.dataset.id); if (q) openEditor(q); });
    onAll('.make-room', 'click', (e) => createRoomFor(e.currentTarget.dataset.id, e.currentTarget));
    onAll('.download-quiz', 'click', (e) => { const q = byId(e.currentTarget.dataset.id); if (q) downloadQuiz(q); });
    onAll('.del-quiz', 'click', async (e) => {
      const q = byId(e.currentTarget.dataset.id);
      if (!q || !confirm(`"${q.title || 'Başlıksız quiz'}" silinsin mi? Bu geri alınamaz.`)) return;
      await QuizStore.remove(q.id);
      goAdminQuizList();
    });
  }

  async function createRoomFor(quizId, btn) {
    if (busy) return;
    const quiz = quizList.find((q) => q.id === quizId) || normalizeQuiz(await QuizStore.get(quizId));
    const problem = validateQuiz(quiz);
    if (problem) return showToast(problem);
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Kuruluyor…'; }
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quiz: quizForServer(quiz) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Oda kurulamadı.');
      lsSet('bq_admin_' + data.code, { token: data.adminToken, quizId });
      lsDel('bq_snapshot_' + data.code);
      history.pushState({}, '', `/?code=${data.code}&role=admin&token=${data.adminToken}`);
      latestSync = null;
      view = 'adminRoom';
      render();
      startSession({ role: 'admin', code: data.code, token: data.adminToken });
    } catch (e) {
      showToast(e.message === 'Failed to fetch' ? 'Sunucuya ulaşılamadı, tekrar dene.' : e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Oda Kur 🚪'; }
    } finally {
      busy = false;
    }
  }

  // ---------- ADMIN: QUIZ EDITORU ----------

  function openEditor(quiz) {
    editorQuiz = quiz;
    lsSet('bq_editing', quiz.id);
    setSaveStatus('✓ Bu cihaza kaydedildi');
    view = 'adminQuizEditor';
    render();
    scheduleSave();
  }

  // Editorden cikarken bekleyen kaydi yap; hic doldurulmamis yeni quiz'i listede birakma.
  async function leaveEditor() {
    if (!editorQuiz) return;
    if (view === 'adminQuizEditor') syncEditorFromDOM();
    const quiz = editorQuiz;
    await flushSave();
    if (isQuizEmpty(quiz)) await QuizStore.remove(quiz.id).catch(() => {});
    editorQuiz = null;
    lsDel('bq_editing');
  }

  function syncEditorFromDOM() {
    if (!editorQuiz) return;
    const titleEl = document.getElementById('quiz-title');
    if (titleEl) editorQuiz.title = titleEl.value;
    editorQuiz.questions.forEach((q, qi) => {
      const field = (name, extra = '') => $app.querySelector(`[data-field="${name}"][data-qidx="${qi}"]${extra}`);
      const textEl = field('qtext');
      if (textEl) q.text = textEl.value;
      const timeEl = field('qtime');
      if (timeEl) q.timeLimit = parseInt(timeEl.value, 10) || 20;
      const doubleEl = field('qdouble');
      if (doubleEl) q.doublePoints = doubleEl.checked;
      const unitEl = field('qunit');
      if (unitEl) q.unit = unitEl.value;
      q.options.forEach((opt, oi) => {
        const optEl = field('qopt', `[data-oidx="${oi}"]`);
        if (optEl) q.options[oi] = optEl.value;
      });
    });
  }

  // Yapisal degisiklik (soru/sik ekleme, gorsel vb.) sonrasi: model -> ekran + kayit
  function editorChanged() {
    renderAdminQuizEditor();
    scheduleSave();
  }

  function photoGroupEditor(group, label, list) {
    return `
      <div>
        <label>${esc(label)} <span class="muted">(${list.length}/${MAX_RESULT_PHOTOS})</span></label>
        <div class="photo-grid">
          ${list.map((src, i) => `
            <div class="image-preview-wrap">
              <img src="${esc(src)}" alt="">
              <button type="button" class="image-preview-remove remove-photo" data-group="${group}" data-idx="${i}" aria-label="Görseli kaldır">✕</button>
            </div>`).join('')}
        </div>
        ${list.length < MAX_RESULT_PHOTOS ? `<input type="file" accept="image/*" multiple id="${group}-photos-file" class="file-input">` : ''}
      </div>`;
  }

  function questionImageEditor(q, qi) {
    return `
      <div>
        <label>Soru görseli (isteğe bağlı)</label>
        <div class="image-upload-box">
          ${q.imageUrl ? `
            <div class="image-preview-wrap">
              <img src="${esc(q.imageUrl)}" alt="">
              <button type="button" class="image-preview-remove remove-qimg" data-qidx="${qi}" aria-label="Görseli kaldır">✕</button>
            </div>` : `<input type="file" accept="image/*" id="qimg-${qi}-file" class="file-input">`}
        </div>
      </div>`;
  }

  function renderAdminQuizEditor() {
    if (!editorQuiz) { view = 'adminQuizList'; return goAdminQuizList(); }
    paint(`
      <div class="editor stack">
        <div class="row">
          <button class="btn-ghost" id="editor-back">← Listeye dön</button>
          <div class="spacer"></div>
          <span class="autosave" id="autosave-status">${esc(saveStatusText)}</span>
        </div>
        <h2>Quiz Hazırla</h2>
        <div class="card stack">
          <div>
            <label for="quiz-title">Quiz Başlığı</label>
            <input type="text" id="quiz-title" maxlength="120" placeholder="Örn: Ayşe'nin Doğum Günü Quiz'i" value="${esc(editorQuiz.title)}">
          </div>
        </div>
        <div class="card stack">
          <strong>🎉😢 Sonuç Görselleri (isteğe bağlı)</strong>
          <p class="muted">Her sorudan sonra, oyuncunun sonucuna göre bu gruptan rastgele biri gösterilir.</p>
          ${photoGroupEditor('correct', 'Doğru cevap görselleri (mutlu / 👍)', editorQuiz.correctPhotos)}
          ${photoGroupEditor('wrong', 'Yanlış cevap görselleri (üzgün)', editorQuiz.wrongPhotos)}
        </div>
        <div class="stack">
          ${editorQuiz.questions.map((q, qi) => renderQuestionEditor(q, qi, editorQuiz.questions.length)).join('')}
        </div>
        <button class="btn-secondary btn-block" id="add-question">+ Soru Ekle</button>
        <button class="btn-primary btn-block" id="save-quiz">Kaydet ve Listeye Dön ✅</button>
        <button class="btn-ghost btn-block" id="download-current">Quizi İndir (yedek) ⬇️</button>
        <p class="muted center">Her değişiklik otomatik olarak bu cihaza kaydedilir. Doğru cevabı burada seçmiyorsun — oyun sırasında doğum günü çocuğu belirleyecek.</p>
      </div>
    `, 'editor-' + editorQuiz.id);
    bindQuizEditorEvents();
  }

  function renderQuestionEditor(q, qi, total) {
    const isNumeric = q.type === 'numeric';
    const isRanking = q.type === 'ranking';
    const opts = q.options.map((opt, oi) => `
      <div class="opt-input-row">
        <input type="text" data-field="qopt" data-qidx="${qi}" data-oidx="${oi}" maxlength="80" placeholder="${isRanking ? 'Öğe' : 'Seçenek'} ${oi + 1}" value="${esc(opt)}">
        ${q.options.length > 2 ? `<button type="button" class="small-btn btn-danger remove-opt" data-qidx="${qi}" data-oidx="${oi}" aria-label="Sil">✕</button>` : ''}
      </div>`).join('');
    return `
      <div class="question-editor-item">
        <div class="row">
          <strong>Soru ${qi + 1}</strong>
          <div class="spacer"></div>
          <button type="button" class="small-btn btn-ghost move-q" data-qidx="${qi}" data-dir="-1" ${qi === 0 ? 'disabled' : ''} aria-label="Yukarı">↑</button>
          <button type="button" class="small-btn btn-ghost move-q" data-qidx="${qi}" data-dir="1" ${qi === total - 1 ? 'disabled' : ''} aria-label="Aşağı">↓</button>
          <button type="button" class="small-btn btn-danger remove-question" data-qidx="${qi}" ${total <= 1 ? 'disabled' : ''}>Sil</button>
        </div>
        <label>Soru Metni</label>
        <textarea data-field="qtext" data-qidx="${qi}" rows="2" maxlength="300" placeholder="Örn: En sevdiğim renk hangisidir?">${esc(q.text)}</textarea>
        <div style="margin-top:8px">
          <label>Soru Tipi</label>
          <select data-field="qtype" data-qidx="${qi}">
            <option value="choice" ${!isNumeric && !isRanking ? 'selected' : ''}>Çoktan Seçmeli</option>
            <option value="numeric" ${isNumeric ? 'selected' : ''}>🔢 Sayı Tahmini</option>
            <option value="ranking" ${isRanking ? 'selected' : ''}>🔀 Sıralama</option>
          </select>
        </div>
        ${isNumeric ? `
        <div style="margin-top:8px">
          <label>Birim (isteğe bağlı)</label>
          <input type="text" data-field="qunit" data-qidx="${qi}" maxlength="16" placeholder="Örn: yaş, kg, km" value="${esc(q.unit || '')}">
          <p class="muted" style="margin-top:4px">Oyuncular bir sayı girer; doğum günü çocuğu gerçek sayıyı oyun sırasında yazar. En yakın tahmin en çok puanı alır.</p>
        </div>` : `
        <label style="margin-top:8px">${isRanking ? 'Sıralanacak Öğeler (2-6)' : 'Seçenekler (2-6)'}</label>
        ${isRanking ? '<p class="muted" style="margin-top:2px">Doğum günü çocuğu oyun sırasında bu öğeleri doğru sıraya dizecek.</p>' : '<p class="muted" style="margin-top:2px">Şıklar oyunda her seferinde karışık sırayla gösterilir.</p>'}
        ${opts}
        ${q.options.length < 6 ? `<button type="button" class="small-btn btn-secondary add-opt" data-qidx="${qi}">+ ${isRanking ? 'Öğe' : 'Seçenek'}</button>` : ''}
        `}
        <div style="margin-top:10px">
          <label>Cevap Süresi</label>
          <select data-field="qtime" data-qidx="${qi}">
            ${TIME_OPTIONS.map((t) => `<option value="${t}" ${q.timeLimit === t ? 'selected' : ''}>${t} saniye</option>`).join('')}
          </select>
        </div>
        <div style="margin-top:10px">${questionImageEditor(q, qi)}</div>
        <label class="row check-row">
          <input type="checkbox" data-field="qdouble" data-qidx="${qi}" ${q.doublePoints ? 'checked' : ''}>
          <span>⭐ Bu soru çift puan (2x) olsun</span>
        </label>
      </div>`;
  }

  function bindQuizEditorEvents() {
    const qidx = (e) => parseInt(e.currentTarget.dataset.qidx, 10);
    on('editor-back', 'click', goAdminQuizList);
    on('save-quiz', 'click', async () => {
      syncEditorFromDOM();
      const problem = validateQuiz(editorQuiz);
      await flushSave();
      if (problem) return showToast(problem + ' (Taslak olarak kaydedildi.)');
      showToast('Quiz kaydedildi ✅', 'ok');
      goAdminQuizList();
    });
    on('download-current', 'click', async () => {
      syncEditorFromDOM();
      await flushSave();
      downloadQuiz(editorQuiz);
    });
    on('add-question', 'click', () => {
      syncEditorFromDOM();
      editorQuiz.questions.push(newQuestion());
      editorChanged();
    });
    onAll('[data-field="qtype"]', 'change', (e) => {
      syncEditorFromDOM();
      const q = editorQuiz.questions[qidx(e)];
      const val = e.currentTarget.value;
      q.type = val === 'numeric' || val === 'ranking' ? val : 'choice';
      if (q.type === 'numeric') q.options = [];
      else while (q.options.length < 2) q.options.push('');
      editorChanged();
    });
    onAll('.remove-question', 'click', (e) => {
      syncEditorFromDOM();
      if (editorQuiz.questions.length <= 1) return;
      if (!confirm(`${qidx(e) + 1}. soru silinsin mi?`)) return;
      editorQuiz.questions.splice(qidx(e), 1);
      editorChanged();
    });
    onAll('.move-q', 'click', (e) => {
      syncEditorFromDOM();
      const qi = qidx(e);
      const ni = qi + parseInt(e.currentTarget.dataset.dir, 10);
      if (ni < 0 || ni >= editorQuiz.questions.length) return;
      const [item] = editorQuiz.questions.splice(qi, 1);
      editorQuiz.questions.splice(ni, 0, item);
      editorChanged();
    });
    onAll('.add-opt', 'click', (e) => {
      syncEditorFromDOM();
      const q = editorQuiz.questions[qidx(e)];
      if (q.options.length >= 6) return;
      q.options.push('');
      editorChanged();
    });
    onAll('.remove-opt', 'click', (e) => {
      syncEditorFromDOM();
      const q = editorQuiz.questions[qidx(e)];
      if (q.options.length <= 2) return;
      q.options.splice(parseInt(e.currentTarget.dataset.oidx, 10), 1);
      editorChanged();
    });

    // Sonuc gorselleri (her grup en fazla 3)
    ['correct', 'wrong'].forEach((group) => {
      const key = group === 'correct' ? 'correctPhotos' : 'wrongPhotos';
      bindImageInput(`${group}-photos-file`, (dataUrls) => {
        syncEditorFromDOM();
        const room = MAX_RESULT_PHOTOS - editorQuiz[key].length;
        if (dataUrls.length > room) showToast(`En fazla ${MAX_RESULT_PHOTOS} görsel eklenebilir; ilk ${room} tanesi eklendi.`, 'info');
        editorQuiz[key].push(...dataUrls.slice(0, Math.max(0, room)));
        editorChanged();
      });
    });
    onAll('.remove-photo', 'click', (e) => {
      syncEditorFromDOM();
      const key = e.currentTarget.dataset.group === 'correct' ? 'correctPhotos' : 'wrongPhotos';
      editorQuiz[key].splice(parseInt(e.currentTarget.dataset.idx, 10), 1);
      editorChanged();
    });

    // Soru gorselleri
    editorQuiz.questions.forEach((q, qi) => {
      bindImageInput(`qimg-${qi}-file`, (dataUrls) => {
        syncEditorFromDOM();
        editorQuiz.questions[qi].imageUrl = dataUrls[0];
        editorChanged();
      });
    });
    onAll('.remove-qimg', 'click', (e) => {
      syncEditorFromDOM();
      editorQuiz.questions[qidx(e)].imageUrl = '';
      editorChanged();
    });
  }

  // ---------- ortak oyun bilesenleri ----------

  function renderOptions(options, { selected = null, correctId = null, disabled = false } = {}) {
    return options.map((opt, i) => {
      let cls = `option-btn opt-${i % 6}`;
      if (correctId != null) {
        if (opt.id === correctId) cls += ' correct';
        else if (opt.id === selected) cls += ' wrong';
        else cls += ' dim';
      } else if (opt.id === selected) {
        cls += ' selected';
      }
      return `<button type="button" class="${cls}" data-opt="${esc(opt.id)}" ${disabled ? 'disabled' : ''}>${esc(opt.text)}</button>`;
    }).join('');
  }

  function bindOptions(containerId, handler) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.option-btn');
      if (!btn || btn.disabled) return;
      handler(btn.dataset.opt, btn, el);
    });
  }

  function renderDistribution(options, distribution, correctId) {
    if (!distribution || !options.length) return '';
    const max = Math.max(1, ...distribution);
    return `<div class="dist-chart">${options.map((opt, i) => {
      const count = distribution[i] || 0;
      const pct = Math.round((count / max) * 100);
      const correctCls = opt.id === correctId ? ' dist-correct' : '';
      return `<div class="dist-row">
        <div class="dist-label">${opt.id === correctId ? '✅ ' : ''}${esc(opt.text)}</div>
        <div class="dist-bar-track"><div class="dist-bar opt-${i % 6}${correctCls}" style="width:${pct}%"></div></div>
        <div class="dist-count">${count}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function numericInputBox({ inputId, btnId, unit, placeholder, btnLabel }) {
    return `<div class="numeric-input-box">
      <input type="number" step="any" inputmode="decimal" id="${inputId}" placeholder="${esc(placeholder || 'Bir sayı yaz')}">
      ${unit ? `<span class="numeric-unit">${esc(unit)}</span>` : ''}
      <button type="button" class="btn-primary" id="${btnId}">${btnLabel}</button>
    </div>`;
  }

  function optionText(options, id) {
    const o = options.find((x) => x.id === id);
    return o ? o.text : '?';
  }

  function renderGuessesList(guesses, question) {
    if (!guesses || !guesses.length) return '<p class="muted center">Kimse cevap vermedi.</p>';
    const unit = question.unit ? ' ' + esc(question.unit) : '';
    return `<div class="guess-list">${guesses.map((g, i) => `
      <div class="guess-row ${i === 0 ? 'guess-best' : ''}">
        <div class="guess-rank">#${i + 1}</div>
        <div class="guess-name">${esc(g.name)}</div>
        <div class="guess-value">${question.type === 'ranking'
          ? (g.order || []).map((id) => esc(optionText(question.options, id))).join(' → ')
          : esc(g.value) + unit}</div>
        <div class="guess-distance">fark: ${g.distance}</div>
      </div>`).join('')}</div>`;
  }

  function renderOrderList(options, order) {
    if (!order) return '';
    return `<ol class="order-list">${order.map((id) => `<li>${esc(optionText(options, id))}</li>`).join('')}</ol>`;
  }

  function getRankingOrder(key, options) {
    const ids = options.map((o) => o.id);
    const valid = rankingWorkingOrder && rankingWorkingOrder.length === ids.length && ids.every((id) => rankingWorkingOrder.includes(id));
    if (rankingWorkingKey !== key || !valid) {
      rankingWorkingKey = key;
      rankingWorkingOrder = ids;
    }
    return rankingWorkingOrder;
  }

  function renderRankingArranger(options, order, { disabled = false } = {}) {
    return `<div class="rank-list">${order.map((id, pos) => `
      <div class="rank-row">
        <div class="rank-pos">${pos + 1}</div>
        <div class="rank-text">${esc(optionText(options, id))}</div>
        <div class="rank-arrows">
          <button type="button" class="small-btn btn-ghost rank-up" data-pos="${pos}" ${disabled || pos === 0 ? 'disabled' : ''} aria-label="Yukarı">▲</button>
          <button type="button" class="small-btn btn-ghost rank-down" data-pos="${pos}" ${disabled || pos === order.length - 1 ? 'disabled' : ''} aria-label="Aşağı">▼</button>
        </div>
      </div>`).join('')}</div>`;
  }

  function bindRankingArranger(containerId, rerender) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.rank-up, .rank-down');
      if (!btn || btn.disabled || !rankingWorkingOrder) return;
      const pos = parseInt(btn.dataset.pos, 10);
      const other = btn.classList.contains('rank-up') ? pos - 1 : pos + 1;
      if (other < 0 || other >= rankingWorkingOrder.length) return;
      const order = rankingWorkingOrder;
      [order[pos], order[other]] = [order[other], order[pos]];
      rerender();
    });
  }

  function renderLeaderboard(list) {
    if (!list || !list.length) return '<p class="muted center">Henüz kimse puan almadı.</p>';
    return `<div class="leaderboard">${list.map((p) => {
      const deltaCls = p.rankDelta > 0 ? 'up' : p.rankDelta < 0 ? 'down' : 'same';
      const deltaTxt = p.rankDelta > 0 ? '▲' + p.rankDelta : p.rankDelta < 0 ? '▼' + Math.abs(p.rankDelta) : '–';
      return `<div class="lb-row">
        <div class="lb-rank">#${p.rank}</div>
        <div class="dot ${p.connected ? '' : 'off'}"></div>
        <div class="lb-name">${esc(p.name)}</div>
        <div class="lb-delta ${deltaCls}">${deltaTxt}</div>
        <div class="lb-score">${p.score}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function renderPodium(list) {
    const [a, b, c] = list || [];
    const step = (p, cls, label) => (p
      ? `<div class="step ${cls}"><div class="bar">${label}</div><div class="name">${esc(p.name)}</div><div class="muted">${p.score} puan</div></div>`
      : '<div class="step"></div>');
    return `<div class="podium">${step(b, 'p2', '2')}${step(a, 'p1', '1')}${step(c, 'p3', '3')}</div>`;
  }

  function renderBadges(badges) {
    if (!badges || !badges.length) return '';
    return `<div class="badges-box">
      <h3>🎖️ Final Unvanları</h3>
      <div class="badges-list">${badges.map((b) => `
        <div class="badge-row">
          <span class="badge-emoji">${b.emoji}</span>
          <span class="badge-title">${esc(b.title)}</span>
          <span class="badge-name">${esc(b.name)}</span>
        </div>`).join('')}</div>
    </div>`;
  }

  function questionImage(q) {
    return q.imageUrl ? `<img class="question-image" src="${esc(q.imageUrl)}" alt="" decoding="async">` : '';
  }

  // Sonuc ekraninda sorunun tipine gore dogru cevap + dagilim / tahmin listesi
  function renderQuestionResultBody(q, { selected = null, correctLabel = 'Gerçek' } = {}) {
    const unit = q.unit ? ' ' + esc(q.unit) : '';
    if (q.type === 'numeric') {
      return `<p class="answer-reveal">${correctLabel} sayı: <strong>${esc(q.correctValue)}${unit}</strong></p>${renderGuessesList(q.guesses, q)}`;
    }
    if (q.type === 'ranking') {
      return `<p class="answer-reveal">${correctLabel} sıra:</p>${renderOrderList(q.options, q.correctOrder)}${renderGuessesList(q.guesses, q)}`;
    }
    return `<div class="options-grid">${renderOptions(q.options, { selected, correctId: q.correctId, disabled: true })}</div>
      ${renderDistribution(q.options, q.distribution, q.correctId)}`;
  }

  function launchConfetti() {
    const layer = document.getElementById('confetti-layer');
    if (!layer) return;
    const colors = ['#ff5d9e', '#8b5cf6', '#ffc83d', '#4fc3f7', '#2ecc71'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 70; i++) {
      const d = document.createElement('div');
      d.className = 'confetti-piece';
      d.style.left = Math.random() * 100 + 'vw';
      const size = 6 + Math.random() * 6;
      d.style.width = size + 'px';
      d.style.height = size + 'px';
      d.style.background = colors[i % colors.length];
      d.style.animationDuration = (2.5 + Math.random() * 2) + 's';
      d.style.animationDelay = (Math.random() * 0.6) + 's';
      frag.appendChild(d);
    }
    layer.appendChild(frag);
    setTimeout(() => { layer.innerHTML = ''; }, 5500);
  }

  function maybeFireConfetti(code) {
    if (confettiFired[code]) return;
    confettiFired[code] = true;
    launchConfetti();
  }

  function timerRing(q) {
    const secs = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : q.duration;
    return `<div class="timer-ring${secs <= 5 ? ' urgent' : ''}" id="timer-ring" style="--pct:100%"><span id="timer-text">${secs}</span></div>`;
  }

  // ---------- ADMIN: ODA EKRANI ----------

  function adminEndButton(s) {
    if (s.status === 'finished') return '';
    return '<button class="btn-ghost btn-block" id="admin-end">Oyunu Erken Bitir</button>';
  }

  function nextButtonLabel(s) {
    return s.questionIndex + 1 >= s.totalQuestions ? 'Final Sıralamasını Göster 🎉' : 'Sonraki Soru ➡️';
  }

  function renderAdminRoom() {
    const s = latestSync;
    if (!s) return connectingScreen('Odaya bağlanılıyor...');
    const origin = location.origin;
    const playerLink = `${origin}/?code=${s.code}`;
    const birthdayLink = `${origin}/?code=${s.code}&role=birthday&token=${s.birthdayToken}`;

    let body = '';
    if (s.status === 'lobby') {
      body = `
        <div class="room-code-box">
          <div class="muted">ODA KODU</div>
          <div class="code">${esc(s.code)}</div>
        </div>
        <div class="stack">
          <div>
            <label>🎮 Oyuncu bağlantısı (herkesle paylaş)</label>
            <div class="link-row"><span class="url">${esc(playerLink)}</span>
              <button class="small-btn btn-secondary" id="copy-player">Kopyala</button></div>
          </div>
          <div>
            <label>🎂 Doğum günü çocuğu bağlantısı (SADECE ona gönder)</label>
            <div class="link-row"><span class="url">${esc(birthdayLink)}</span>
              <button class="small-btn btn-secondary" id="copy-bday">Kopyala</button></div>
          </div>
        </div>
        <div class="card">
          <div class="row"><strong>Katılımcılar</strong><div class="spacer"></div><span class="badge">${s.playerCount} oyuncu</span></div>
          <p class="row" style="margin-top:8px">
            <span class="dot ${s.birthdayConnected ? '' : 'off'}"></span>
            🎂 Doğum günü çocuğu: ${s.birthdayName ? esc(s.birthdayName) : '<span class="muted">henüz katılmadı</span>'}
          </p>
          <div class="participant-list" style="margin-top:8px">
            ${s.players.map((p) => `<div class="participant"><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(p.name)}</div>`).join('') || '<p class="muted">Henüz oyuncu yok.</p>'}
          </div>
        </div>
        <button class="btn-success btn-block btn-lg" id="start-game" ${s.birthdayName ? '' : 'disabled'}>Oyunu Başlat 🚀</button>
        ${!s.birthdayName ? '<p class="muted center">Başlatmak için doğum günü çocuğunun katılması gerekiyor.</p>' : ''}
        <button class="btn-ghost btn-block" id="cancel-room">Odayı İptal Et</button>
      `;
    } else if (s.status === 'birthday_turn') {
      body = `
        <div class="card center stack">
          <div class="emoji pulse" style="font-size:2.4rem">🎂🤔</div>
          <h3>${s.questionIndex + 1}. soru — ${esc(s.birthdayName)} düşünüyor...</h3>
          <p class="muted">Soru, önce yalnızca doğum günü çocuğunun ekranında görünüyor.</p>
          ${!s.birthdayConnected ? '<p class="error-text">⚠️ Doğum günü çocuğunun bağlantısı koptu, bekleniyor...</p>' : ''}
        </div>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'question_open' && s.question) {
      const q = s.question;
      body = `
        <div class="question-card">
          <div class="row">
            <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions}</span>${doubleBadge(q)}
            <div class="spacer"></div>
            ${timerRing(q)}
          </div>
          <p class="question-text">${esc(q.text)}</p>
          ${questionImage(q)}
          ${q.type === 'numeric'
            ? `<p class="muted center">🔢 Sayı tahmini${q.unit ? ' (' + esc(q.unit) + ')' : ''} — oyuncular bir sayı yazıyor.</p>`
            : `${q.type === 'ranking' ? '<p class="muted center">🔀 Sıralama sorusu — oyuncular öğeleri sıralıyor.</p>' : ''}
               <div class="options-grid">${renderOptions(q.options, { disabled: true })}</div>`}
        </div>
        <div class="card">
          <p class="muted">Cevaplayan: ${s.answeredCount} / ${s.playerCount}</p>
          <div class="progress-bar"><div style="width:${s.playerCount ? (100 * s.answeredCount / s.playerCount) : 0}%"></div></div>
        </div>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'question_results' && s.question) {
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — Sonuç</span>${doubleBadge(s.question)}
          <p class="question-text" style="margin-top:10px">${esc(s.question.text)}</p>
          ${renderQuestionResultBody(s.question)}
        </div>
        <h3>🏆 Sıralama</h3>
        ${renderLeaderboard(s.leaderboard)}
        <button class="btn-primary btn-block btn-lg" id="next-question">${nextButtonLabel(s)}</button>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'paused') {
      body = `
        <div class="card center stack">
          <div class="emoji" style="font-size:2.2rem">🔄</div>
          <h3>Oyun geri yüklendi</h3>
          <p class="muted">Sunucu yeniden başladı ama puanlar korundu. Herkes yeniden bağlanınca kaldığın yerden devam et.</p>
          <p class="muted">Bağlı oyuncu: ${s.players.filter((p) => p.connected).length} / ${s.playerCount} · Doğum günü çocuğu: ${s.birthdayConnected ? 'bağlı ✅' : 'bekleniyor…'}</p>
        </div>
        <h3>🏆 Sıralama</h3>
        ${renderLeaderboard(s.leaderboard)}
        <button class="btn-primary btn-block btn-lg" id="next-question">${s.questionIndex + 1 >= s.totalQuestions ? 'Final Sıralamasını Göster 🎉' : `${s.questionIndex + 2}. sorudan devam et ➡️`}</button>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'finished') {
      maybeFireConfetti(s.code);
      body = `
        <div class="hero"><div class="emoji">🏆🎉</div><h2>Oyun Bitti!</h2></div>
        ${renderPodium(s.leaderboard)}
        ${renderBadges(s.badges)}
        <h3>Tüm Oyuncular</h3>
        ${renderLeaderboard(s.leaderboard)}
        <button class="btn-primary btn-block btn-lg" id="back-to-list">Quiz Listesine Dön</button>
      `;
    }

    paint(`
      <div class="row"><strong>${esc(s.title)}</strong><div class="spacer"></div><span class="badge">Oda ${esc(s.code)}</span></div>
      ${body}
    `, roomScreenKey(s));

    on('copy-player', 'click', () => copyText(playerLink));
    on('copy-bday', 'click', () => copyText(birthdayLink));
    on('start-game', 'click', () => socket.emit('admin:start'));
    on('next-question', 'click', (e) => { e.currentTarget.disabled = true; socket.emit('admin:next'); });
    on('admin-end', 'click', () => { if (confirm('Oyunu şimdi bitirmek istediğine emin misin?')) socket.emit('admin:end'); });
    on('cancel-room', 'click', () => { if (confirm('Bu oda tamamen iptal edilsin mi? Herkes odadan çıkarılacak.')) socket.emit('admin:cancelRoom'); });
    on('back-to-list', 'click', () => {
      lsDel('bq_snapshot_' + s.code);
      lsDel('bq_admin_' + s.code);
      endSession();
      history.pushState({}, '', '/');
      goAdminQuizList();
    });
  }

  // ---------- DOGUM GUNU SAHIBI: ODA EKRANI ----------

  function renderBirthdayRoom() {
    const s = latestSync;
    if (!s) return connectingScreen('Bağlanılıyor...');
    let body = '';
    const qKey = questionKey(s);

    if (s.status === 'lobby') {
      body = `
        <div class="card center stack">
          <div class="emoji bounce" style="font-size:2.4rem">🎉</div>
          <h3>Hoş geldin, ${esc(s.birthdayName)}!</h3>
          <p class="muted">Yönetici oyunu başlatınca sorular burada görünecek. ${s.playerCount} arkadaşın hazır bekliyor.</p>
        </div>
      `;
    } else if (s.status === 'birthday_turn' && s.question) {
      const q = s.question;
      let answerUi;
      if (q.type === 'numeric') {
        answerUi = `
          <p class="muted">Gerçek/doğru sayıyı yaz. Süre sınırsız.</p>
          ${numericInputBox({ inputId: 'bday-numeric-input', btnId: 'bday-numeric-submit', unit: q.unit, placeholder: 'Gerçek sayı', btnLabel: 'Kilitle 🔒' })}`;
      } else if (q.type === 'ranking') {
        const order = getRankingOrder(qKey + '-bday', q.options);
        answerUi = `
          <p class="muted">Öğeleri doğru sıraya diz (▲▼). Süre sınırsız.</p>
          <div id="bday-ranking">${renderRankingArranger(q.options, order)}</div>
          <button type="button" class="btn-primary btn-block" id="bday-ranking-submit" style="margin-top:10px">Sıralamamı Kilitle 🔒</button>`;
      } else {
        const formOpen = customFormKey === qKey;
        answerUi = `
          <p class="muted">Senin için doğru olan şıkkı seç. Süre sınırsız.</p>
          <div class="options-grid" id="bday-options">${renderOptions(q.options)}</div>
          <div class="custom-answer-box">
            <button type="button" class="custom-answer-toggle" id="custom-answer-toggle">Doğru cevap şıklarda yok, kendim yazayım ✏️</button>
            <div class="custom-answer-form" id="custom-answer-form" ${formOpen ? '' : 'hidden'}>
              <input type="text" id="custom-answer-text" maxlength="80" autocomplete="off" placeholder="Doğru cevabı yaz">
              <button type="button" class="btn-primary" id="custom-answer-submit">Ekle ve Kilitle 🔒</button>
            </div>
          </div>`;
      }
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — sadece sen görüyorsun 🤫</span>${doubleBadge(q)}
          <p class="question-text" style="margin-top:10px">${esc(q.text)}</p>
          ${questionImage(q)}
          ${answerUi}
        </div>
      `;
    } else if (s.status === 'question_open') {
      body = `
        <div class="card center stack">
          <div class="emoji pulse" style="font-size:2.2rem">🔒</div>
          <h3>Cevabın kilitlendi!</h3>
          <p class="muted">Şimdi arkadaşların cevaplıyor...</p>
          <p>${s.answeredCount} / ${s.playerTotal} cevapladı</p>
          <div class="progress-bar"><div style="width:${s.playerTotal ? (100 * s.answeredCount / s.playerTotal) : 0}%"></div></div>
        </div>
      `;
    } else if (s.status === 'question_results' && s.question) {
      const q = s.question;
      const best = q.guesses && q.guesses.length ? q.guesses[0] : null;
      let summary;
      if (q.type === 'choice') summary = `<p>🎯 <strong>${s.correctGuessers}</strong> kişi senin cevabını bildi!</p>`;
      else if (best) summary = `<p>🏅 En yakın: <strong>${esc(best.name)}</strong> (fark: ${best.distance})</p>`;
      else summary = '<p class="muted">Kimse cevap vermedi.</p>';
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — Sonuç</span>${doubleBadge(q)}
          <p class="question-text" style="margin-top:10px">${esc(q.text)}</p>
          ${renderQuestionResultBody(q, { correctLabel: 'Senin belirlediğin' })}
        </div>
        <div class="card center">
          ${summary}
          <p class="muted">Sıradaki soruya yönetici geçecek.</p>
        </div>
        <h3>🏆 İlk 5</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    } else if (s.status === 'paused') {
      body = `
        <div class="card center stack">
          <div class="emoji pulse" style="font-size:2.2rem">🔄</div>
          <h3>Oyun birazdan kaldığı yerden devam edecek</h3>
          <p class="muted">Bağlantı yenilendi, puanlar korundu.</p>
        </div>
        <h3>🏆 İlk 5</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    } else if (s.status === 'finished') {
      maybeFireConfetti(s.code);
      body = `
        <div class="hero"><div class="emoji">🎂🎉🥳</div><h2>İyi ki doğdun!</h2></div>
        ${renderBadges(s.badges)}
        <h3>Final Sıralaması</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    }

    paint(`<div class="row"><strong>${esc(s.title)}</strong></div>${body}`, roomScreenKey(s));

    bindOptions('bday-options', (optionId, btn, container) => {
      container.querySelectorAll('.option-btn').forEach((b) => { b.disabled = true; });
      btn.classList.add('selected');
      socket.emit('birthday:lock', { optionId });
    });
    on('custom-answer-toggle', 'click', () => {
      customFormKey = customFormKey === qKey ? null : qKey;
      const form = document.getElementById('custom-answer-form');
      if (!form) return;
      form.hidden = customFormKey !== qKey;
      if (!form.hidden) { const input = document.getElementById('custom-answer-text'); if (input) input.focus(); }
    });
    on('custom-answer-submit', 'click', () => {
      const input = document.getElementById('custom-answer-text');
      const text = input ? input.value.trim() : '';
      if (!text) return showToast('Lütfen bir cevap metni yaz.');
      socket.emit('birthday:lockCustom', { text });
    });
    on('bday-numeric-submit', 'click', () => {
      const input = document.getElementById('bday-numeric-input');
      const raw = input ? input.value : '';
      if (raw === '' || !Number.isFinite(Number(raw))) return showToast('Lütfen geçerli bir sayı yaz.');
      socket.emit('birthday:lockNumeric', { value: Number(raw) });
    });
    bindRankingArranger('bday-ranking', renderBirthdayRoom);
    on('bday-ranking-submit', 'click', () => {
      if (rankingWorkingOrder) socket.emit('birthday:lockRanking', { order: rankingWorkingOrder.slice() });
    });
  }

  // ---------- OYUNCU: ODA EKRANI ----------

  function renderPlayerRoom() {
    const s = latestSync;
    if (!s) return connectingScreen('Odaya bağlanılıyor...');
    let body = '';
    const qKey = questionKey(s);

    if (s.status === 'lobby') {
      body = `
        <div class="card center stack">
          <div class="emoji bounce" style="font-size:2.4rem">⏳</div>
          <h3>Lobide bekleniyor...</h3>
          <p class="muted">${s.playerCount} oyuncu katıldı. Yönetici başlatınca oyun açılacak.</p>
          <p class="muted">🔊 Sesleri duymak için telefonunun sessiz modunu kapat ve ekrana bir kez dokun.</p>
        </div>
      `;
    } else if (s.status === 'birthday_turn') {
      body = `
        <div class="card center stack">
          <div class="emoji pulse" style="font-size:2.4rem">🎂🤔</div>
          <h3>${esc(s.birthdayName || 'Doğum günü çocuğu')} düşünüyor...</h3>
          <p class="muted">Soru birazdan senin ekranında da açılacak!</p>
        </div>
      `;
    } else if (s.status === 'question_open' && s.question) {
      const q = s.question;
      let answerUi;
      if (q.type === 'numeric') {
        answerUi = s.hasAnswered
          ? `<p class="answer-reveal">Tahminin: <strong>${esc(s.myValue)}${q.unit ? ' ' + esc(q.unit) : ''}</strong></p>`
          : numericInputBox({ inputId: 'player-numeric-input', btnId: 'player-numeric-submit', unit: q.unit, placeholder: 'Tahminin', btnLabel: 'Gönder ✅' });
      } else if (q.type === 'ranking') {
        const order = s.hasAnswered && s.myOrder ? s.myOrder : getRankingOrder(qKey + '-player', q.options);
        answerUi = `
          <div id="player-ranking">${renderRankingArranger(q.options, order, { disabled: s.hasAnswered })}</div>
          ${s.hasAnswered ? '' : '<button type="button" class="btn-primary btn-block" id="player-ranking-submit" style="margin-top:10px">Sıralamamı Gönder ✅</button>'}`;
      } else {
        answerUi = `<div class="options-grid" id="player-options">${renderOptions(q.options, { selected: s.myChoice, disabled: s.hasAnswered })}</div>`;
      }
      body = `
        <div class="question-card">
          <div class="row">
            <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions}</span>${doubleBadge(q)}
            <div class="spacer"></div>
            ${timerRing(q)}
          </div>
          <p class="question-text">${esc(q.text)}</p>
          ${questionImage(q)}
          ${answerUi}
          ${s.hasAnswered ? '<p class="muted center" style="margin-top:10px">Cevabın kilitlendi, sonuçlar bekleniyor...</p>' : ''}
        </div>
      `;
    } else if (s.status === 'question_results' && s.question) {
      const q = s.question;
      const r = s.myResult || { won: false, points: 0 };
      const answered = q.type === 'numeric' ? r.value != null : q.type === 'ranking' ? r.order != null : r.optionId != null;
      let bannerText;
      if (!answered) bannerText = '⌛ Süre doldu, cevap vermedin';
      else if (q.type === 'choice') bannerText = r.correct ? '🎉 Doğru bildin!' : '❌ Yanlış cevap';
      else if (r.won) bannerText = q.type === 'numeric' ? '🎉 En yakın tahmin seninki!' : '🎉 En yakın sıralama seninki!';
      else bannerText = `📏 Fark: ${r.distance}${q.type === 'numeric' && q.unit ? ' ' + esc(q.unit) : ''} · ${r.rank}. en yakın`;
      body = `
        <div class="result-banner ${r.won ? 'correct' : 'wrong'}">
          ${bannerText}
          <span class="points">+${r.points} puan · Toplam: ${s.myScore}</span>
        </div>
        ${s.resultPhotoUrl ? `<img class="result-photo" src="${esc(s.resultPhotoUrl)}" alt="" decoding="async">` : ''}
        <div class="question-card">
          <p class="question-text">${esc(q.text)}</p>
          ${renderQuestionResultBody(q, { selected: r.optionId })}
        </div>
        <h3>🏆 İlk 5</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    } else if (s.status === 'paused') {
      body = `
        <div class="card center stack">
          <div class="emoji pulse" style="font-size:2.2rem">🔄</div>
          <h3>Oyun birazdan kaldığı yerden devam edecek</h3>
          <p class="muted">Puanın korundu: <strong>${s.myScore}</strong></p>
        </div>
        <h3>🏆 İlk 5</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    } else if (s.status === 'finished') {
      maybeFireConfetti(s.code);
      body = `
        <div class="hero"><div class="emoji">🏁🎉</div><h2>Oyun Bitti!</h2></div>
        <div class="card center">
          <p>Senin puanın: <strong>${s.myScore}</strong></p>
          <p class="muted">${s.myCorrectCount} tam isabet</p>
        </div>
        ${renderPodium(s.leaderboard)}
        ${renderBadges(s.badges)}
        <h3>Final Sıralaması</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    }

    paint(`<div class="row"><strong>${esc(s.title)}</strong></div>${body}`, roomScreenKey(s));

    const markAnswered = () => {
      pendingAnswerKey = qKey;
      Sound.stopTicking();
    };
    bindOptions('player-options', (optionId, btn, container) => {
      if (s.hasAnswered || pendingAnswerKey === qKey) return;
      markAnswered();
      container.querySelectorAll('.option-btn').forEach((b) => { b.disabled = true; });
      btn.classList.add('selected');
      socket.emit('player:answer', { optionId });
    });
    on('player-numeric-submit', 'click', (e) => {
      const input = document.getElementById('player-numeric-input');
      const raw = input ? input.value : '';
      if (raw === '' || !Number.isFinite(Number(raw))) return showToast('Lütfen geçerli bir sayı yaz.');
      markAnswered();
      e.currentTarget.disabled = true;
      socket.emit('player:answerNumeric', { value: Number(raw) });
    });
    if (!s.hasAnswered) bindRankingArranger('player-ranking', renderPlayerRoom);
    on('player-ranking-submit', 'click', (e) => {
      if (!rankingWorkingOrder) return;
      markAnswered();
      e.currentTarget.disabled = true;
      socket.emit('player:answerRanking', { order: rankingWorkingOrder.slice() });
    });
  }

  boot();
})();
