/**
 * Dogum Gunu Quiz - istemci
 * -------------------------
 * Tek sayfa uygulama. Sunucudan gelen "sync" olayi her oda durumunu tasir,
 * ekran o veriye gore yeniden ciziliyor. localStorage sayfa yenilenince
 * (admin / dogum gunu sahibi / oyuncu) ayni role geri donebilmek icin kullanilir.
 */

(function () {
  const $app = document.getElementById('app');
  const socket = io();

  let view = 'home';
  let latestSync = null;
  let editorQuiz = null;
  let quizList = [];
  let pendingCode = null;
  let pendingBirthdayToken = null;
  let joining = { role: null, code: null, token: null, name: null };
  let confettiFired = {};
  let joinError = '';
  const TIME_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

  // ---------- yardimcilar ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function onAll(sel, ev, fn) { document.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn)); }

  let toastTimer = null;
  function showToast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3200);
  }

  function copyText(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast('Kopyalandı!')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Kopyalandı!'); } catch (e) {}
    ta.remove();
  }

  function optionShape(i) { return ['▲', '◆', '●', '■', '★', '♥'][i] || '?'; }

  function doubleBadge(q) {
    return q && q.doublePoints ? ' <span class="badge" style="background:var(--pink)">⭐ 2x PUAN</span>' : '';
  }

  // Secilen gorsel dosyasini tarayicida kucultup (max 900px genislik, JPEG %72
  // kalite) base64 data URI'ya cevirir. Boylece hem yukleme hizli olur hem de
  // sunucuya/soket baglantisina asiri buyuk veri gitmez.
  function fileToCompressedDataUrl(file, maxDim = 900, quality = 0.72) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        return reject(new Error('Lütfen bir görsel dosyası seç.'));
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Dosya okunamadı.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Görsel açılamadı.'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
            else { width = Math.round(width * (maxDim / height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Bir dosya input'unu dinler, secilen gorseli sikistirip hedef nesnenin
  // belirtilen alanina yazar, onizlemeyi gunceller. onDone sonrasi cagrilir.
  function bindImageInput(inputId, onPicked) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener('change', async () => {
      const file = el.files && el.files[0];
      if (!file) return;
      try {
        showToast('Görsel hazırlanıyor...');
        const dataUrl = await fileToCompressedDataUrl(file);
        onPicked(dataUrl);
      } catch (e) {
        showToast(e.message || 'Görsel yüklenemedi.');
      }
    });
  }

  function imageUploadBox({ idPrefix, label, value }) {
    return `
      <div>
        <label>${esc(label)}</label>
        <div class="image-upload-box">
          ${value ? `
            <div class="image-preview-wrap">
              <img src="${esc(value)}" alt="">
              <button type="button" class="image-preview-remove" id="${idPrefix}-remove">✕</button>
            </div>
          ` : `<input type="file" accept="image/*" id="${idPrefix}-file">`}
        </div>
      </div>`;
  }

  function renderOptions(options, { selected = null, correctIndex = null, disabled = false, clickable = false } = {}) {
    return options.map((opt, i) => {
      let cls = `option-btn opt-${i}`;
      if (correctIndex !== null && correctIndex !== undefined) {
        if (i === correctIndex) cls += ' correct';
        else if (i === selected) cls += ' wrong';
        else cls += ' dim';
      } else if (i === selected) {
        cls += ' selected';
      }
      return `<button type="button" class="${cls}" data-opt="${i}" ${disabled ? 'disabled' : ''}>` +
        `<span class="shape">${optionShape(i)}</span><span>${esc(opt)}</span></button>`;
    }).join('');
  }

  function bindOptions(containerId, handler) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.option-btn');
      if (!btn || btn.disabled) return;
      handler(parseInt(btn.dataset.opt, 10));
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
    const [a, b, c] = list;
    const step = (p, cls, label) => p
      ? `<div class="step ${cls}"><div class="bar">${label}</div><div class="name">${esc(p.name)}</div><div class="muted">${p.score} puan</div></div>`
      : '<div class="step"></div>';
    return `<div class="podium">${step(b, 'p2', '2')}${step(a, 'p1', '1')}${step(c, 'p3', '3')}</div>`;
  }

  function launchConfetti() {
    const layer = document.getElementById('confetti-layer');
    if (!layer) return;
    const colors = ['#ff5d9e', '#8b5cf6', '#ffc83d', '#4fc3f7', '#2ecc71'];
    for (let i = 0; i < 90; i++) {
      const d = document.createElement('div');
      d.className = 'confetti-piece';
      d.style.left = Math.random() * 100 + 'vw';
      const size = 6 + Math.random() * 6;
      d.style.width = size + 'px';
      d.style.height = size + 'px';
      d.style.background = colors[Math.floor(Math.random() * colors.length)];
      d.style.animationDuration = (2.5 + Math.random() * 2) + 's';
      d.style.animationDelay = (Math.random() * 0.6) + 's';
      layer.appendChild(d);
      setTimeout(() => d.remove(), 5500);
    }
  }

  function maybeFireConfetti(code) {
    if (confettiFired[code]) return;
    confettiFired[code] = true;
    launchConfetti();
  }

  // Soru sayaci: 200ms'de bir, acik bir soru varsa timer gostergesini gunceller.
  setInterval(() => {
    const ring = document.getElementById('timer-ring');
    if (!ring || !latestSync || !latestSync.question || !latestSync.question.openAt) return;
    const { openAt, duration } = latestSync.question;
    const remain = Math.max(0, duration - (Date.now() - openAt) / 1000);
    const pct = Math.max(0, Math.min(100, (remain / duration) * 100));
    ring.style.setProperty('--pct', pct + '%');
    const txt = document.getElementById('timer-text');
    if (txt) txt.textContent = Math.ceil(remain);
  }, 200);

  // ---------- socket olaylari ----------

  socket.on('sync', (state) => {
    latestSync = state;
    joinError = '';
    if (state.role === 'admin') view = 'adminRoom';
    else if (state.role === 'birthday') view = 'birthdayRoom';
    else if (state.role === 'player') view = 'playerRoom';
    render();
  });

  socket.on('joined', ({ id }) => {
    if (joining.role === 'player') lsSet('bq_player_' + joining.code, { id });
    if (joining.role === 'birthday') lsSet('bq_birthday_' + joining.code, { id, token: joining.token, name: joining.name });
  });

  socket.on('errorMsg', ({ message }) => {
    showToast(message);
    if (!latestSync) {
      joinError = message;
      if (view === 'birthdayRoom') view = 'birthdayJoin';
      if (view === 'playerRoom') view = 'playerJoin';
      render();
    }
  });

  socket.on('connect', () => {
    // Baglanti (yeniden) kurulunca, zaten bir odadaysak durumu tazele.
    if (latestSync) socket.emit('resync');
  });

  socket.on('roomCancelled', () => {
    const wasAdmin = latestSync && latestSync.role === 'admin';
    latestSync = null;
    if (wasAdmin) {
      showToast('Oda iptal edildi.');
      goAdminQuizList();
    } else {
      view = 'roomCancelled';
      render();
    }
  });

  // ---------- baslangic yonlendirme ----------

  function boot() {
    const role = qs('role');
    const code = qs('code');
    const token = qs('token');

    if (role === 'admin' && code && token) {
      lsSet('bq_admin_' + code.toUpperCase(), { token });
      joining = { role: 'admin', code: code.toUpperCase(), token };
      socket.emit('admin:join', { code, token });
      view = 'adminRoom';
      render();
      return;
    }
    if (role === 'birthday' && code && token) {
      pendingCode = code.toUpperCase();
      pendingBirthdayToken = token;
      const saved = lsGet('bq_birthday_' + pendingCode);
      if (saved && saved.id) {
        joining = { role: 'birthday', code: pendingCode, token, name: saved.name };
        socket.emit('birthday:join', { code: pendingCode, token, savedId: saved.id, name: saved.name });
      }
      view = 'birthdayJoin';
      render();
      return;
    }
    if (code) {
      pendingCode = code.toUpperCase();
      const saved = lsGet('bq_player_' + pendingCode);
      if (saved && saved.id) {
        joining = { role: 'player', code: pendingCode };
        socket.emit('player:join', { code: pendingCode, savedId: saved.id });
      }
      view = 'playerJoin';
    }
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
    renderHome();
  }

  // ---------- ANA SAYFA ----------

  function renderHome() {
    $app.innerHTML = `
      <div class="hero">
        <div class="emoji">🎉🎂🎈</div>
        <h1>Doğum Günü Quiz</h1>
        <p class="muted">Sorular doğum günü çocuğu hakkında — doğru cevabı o anlık belirliyor!</p>
      </div>
      <div class="stack">
        <button class="btn-primary btn-block btn-lg" id="go-admin"><span class="btn-icon">🛠️</span>Quiz Oluştur / Yönet</button>
        <button class="btn-secondary btn-block btn-lg" id="go-join"><span class="btn-icon">🎮</span>Odaya Katıl</button>
      </div>
    `;
    on('go-admin', 'click', goAdminQuizList);
    on('go-join', 'click', () => { view = 'playerJoin'; render(); });
  }

  // ---------- ODA IPTAL EDILDI ----------

  function renderRoomCancelled() {
    $app.innerHTML = `
      <div class="hero">
        <div class="emoji">🚫</div>
        <h2>Oda iptal edildi</h2>
        <p class="muted">Yönetici bu odayı iptal etti.</p>
      </div>
      <button class="btn-primary btn-block btn-lg" id="cancelled-home">Ana sayfaya dön</button>
    `;
    on('cancelled-home', 'click', () => { view = 'home'; render(); });
  }

  // ---------- OYUNCU KATILMA ----------

  function renderPlayerJoin() {
    $app.innerHTML = `
      <div class="hero">
        <div class="emoji">🎮</div>
        <h2>Odaya Katıl</h2>
      </div>
      <div class="card stack">
        <div>
          <label>Oda Kodu</label>
          <input type="text" id="join-code" class="code-input" maxlength="6" placeholder="ABC123" value="${esc(pendingCode || '')}">
        </div>
        <div>
          <label>İsmin</label>
          <input type="text" id="join-name" maxlength="24" placeholder="Adını yaz">
        </div>
        ${joinError ? `<p class="muted" style="color:#ff8b8b">${esc(joinError)}</p>` : ''}
        <button class="btn-primary btn-block btn-lg" id="join-submit">Katıl 🚀</button>
        <button class="btn-ghost" id="join-back">← Ana sayfa</button>
      </div>
    `;
    const codeEl = document.getElementById('join-code');
    codeEl.addEventListener('input', () => { codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
    on('join-submit', 'click', () => {
      const code = codeEl.value.trim().toUpperCase();
      const name = document.getElementById('join-name').value.trim();
      if (code.length !== 6) return showToast('Oda kodu 6 karakter olmalı.');
      if (!name) return showToast('Lütfen bir isim yaz.');
      joining = { role: 'player', code, name };
      socket.emit('player:join', { code, name });
    });
    on('join-back', 'click', () => { view = 'home'; render(); });
  }

  // ---------- DOGUM GUNU SAHIBI KATILMA ----------

  function renderBirthdayJoin() {
    $app.innerHTML = `
      <div class="hero">
        <div class="emoji bounce">🎂</div>
        <h2>Bugün senin günün!</h2>
        <p class="muted">Bu özel bağlantı sadece doğum günü çocuğu için. Sorulara gizlice sen cevap vereceksin.</p>
      </div>
      <div class="card stack">
        <div>
          <label>İsmin</label>
          <input type="text" id="bday-name" maxlength="30" placeholder="Adını yaz">
        </div>
        ${joinError ? `<p class="muted" style="color:#ff8b8b">${esc(joinError)}</p>` : ''}
        <button class="btn-primary btn-block btn-lg" id="bday-submit">Hazırım 🎉</button>
      </div>
    `;
    on('bday-submit', 'click', () => {
      const name = document.getElementById('bday-name').value.trim();
      if (!name) return showToast('Lütfen ismini yaz.');
      joining = { role: 'birthday', code: pendingCode, token: pendingBirthdayToken, name };
      socket.emit('birthday:join', { code: pendingCode, token: pendingBirthdayToken, name });
    });
  }

  // ---------- ADMIN: QUIZ LISTESI ----------

  function goAdminQuizList() {
    view = 'adminQuizList';
    render();
    fetch('/api/quizzes').then((r) => r.json()).then((list) => {
      quizList = list;
      if (view === 'adminQuizList') render();
    });
  }

  function renderAdminQuizList() {
    $app.innerHTML = `
      <div class="row">
        <button class="btn-ghost" id="back-home">← Ana sayfa</button>
        <div class="spacer"></div>
      </div>
      <h2>Quiz'lerim</h2>
      <button class="btn-primary btn-block" id="new-quiz">+ Yeni Quiz</button>
      <div class="stack" id="quiz-list">
        ${quizList.length ? quizList.map((q) => `
          <div class="card row wrap" data-id="${q.id}">
            <div style="flex:1 1 140px">
              <strong>${esc(q.title)}</strong>
              <div class="muted">${q.questionCount} soru</div>
            </div>
            <button class="small-btn btn-secondary edit-quiz" data-id="${q.id}">Düzenle</button>
            <button class="small-btn btn-success make-room" data-id="${q.id}">Oda Kur 🚪</button>
            <button class="small-btn btn-danger del-quiz" data-id="${q.id}">Sil</button>
          </div>
        `).join('') : '<p class="muted center">Henüz quiz yok. "Yeni Quiz" ile başla!</p>'}
      </div>
    `;
    on('back-home', 'click', () => { view = 'home'; render(); });
    on('new-quiz', 'click', () => {
      editorQuiz = {
        title: '',
        correctPhotoUrl: '',
        wrongPhotoUrl: '',
        questions: [{ text: '', options: ['', ''], timeLimit: 20, imageUrl: '', doublePoints: false }],
      };
      view = 'adminQuizEditor';
      render();
    });
    onAll('.edit-quiz', 'click', async (e) => {
      const id = e.target.dataset.id;
      const res = await fetch('/api/quizzes/' + id);
      editorQuiz = await res.json();
      view = 'adminQuizEditor';
      render();
    });
    onAll('.make-room', 'click', (e) => createRoomFor(e.target.dataset.id));
    onAll('.del-quiz', 'click', async (e) => {
      if (!confirm('Bu quiz silinsin mi?')) return;
      await fetch('/api/quizzes/' + e.target.dataset.id, { method: 'DELETE' });
      goAdminQuizList();
    });
  }

  async function createRoomFor(quizId) {
    const res = await fetch('/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quizId }),
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Oda kurulamadı.');
    lsSet('bq_admin_' + data.code, { token: data.adminToken });
    history.pushState({}, '', `/?code=${data.code}&role=admin&token=${data.adminToken}`);
    joining = { role: 'admin', code: data.code, token: data.adminToken };
    socket.emit('admin:join', { code: data.code, token: data.adminToken });
    view = 'adminRoom';
    render();
  }

  // ---------- ADMIN: QUIZ EDITORU ----------

  function syncEditorFromDOM() {
    const titleEl = document.getElementById('quiz-title');
    if (titleEl) editorQuiz.title = titleEl.value;
    editorQuiz.questions.forEach((q, qi) => {
      const textEl = document.querySelector(`[data-field="qtext"][data-qidx="${qi}"]`);
      if (textEl) q.text = textEl.value;
      const timeEl = document.querySelector(`[data-field="qtime"][data-qidx="${qi}"]`);
      if (timeEl) q.timeLimit = parseInt(timeEl.value, 10);
      const doubleEl = document.querySelector(`[data-field="qdouble"][data-qidx="${qi}"]`);
      if (doubleEl) q.doublePoints = doubleEl.checked;
      q.options.forEach((opt, oi) => {
        const optEl = document.querySelector(`[data-field="qopt"][data-qidx="${qi}"][data-oidx="${oi}"]`);
        if (optEl) q.options[oi] = optEl.value;
      });
    });
  }

  function renderAdminQuizEditor() {
    $app.innerHTML = `
      <div class="row">
        <button class="btn-ghost" id="editor-back">← Listeye dön</button>
        <div class="spacer"></div>
      </div>
      <h2>${editorQuiz.id ? 'Quiz Düzenle' : 'Yeni Quiz'}</h2>
      <div class="card stack">
        <div>
          <label>Quiz Başlığı</label>
          <input type="text" id="quiz-title" placeholder="Örn: Ayşe'nin Doğum Günü Quiz'i" value="${esc(editorQuiz.title)}">
        </div>
      </div>
      <div class="card stack">
        <strong>🎉😢 Sonuç Fotoğrafları (isteğe bağlı)</strong>
        <p class="muted">Oyuncular bir soruya doğru/yanlış cevap verince bu fotoğraflar gösterilir.</p>
        ${imageUploadBox({ idPrefix: 'correct-photo', label: 'Doğru cevap fotoğrafı (mutlu/👍)', value: editorQuiz.correctPhotoUrl })}
        ${imageUploadBox({ idPrefix: 'wrong-photo', label: 'Yanlış cevap fotoğrafı (üzgün)', value: editorQuiz.wrongPhotoUrl })}
      </div>
      <div id="questions-wrap" class="stack">
        ${editorQuiz.questions.map((q, qi) => renderQuestionEditor(q, qi, editorQuiz.questions.length)).join('')}
      </div>
      <button class="btn-secondary btn-block" id="add-question">+ Soru Ekle</button>
      <div class="row">
        <button class="btn-primary btn-block" id="save-quiz">Kaydet 💾</button>
      </div>
      <p class="muted center">Not: Doğru cevabı burada seçmiyorsun — oyun sırasında doğum günü çocuğu belirleyecek.</p>
    `;
    bindQuizEditorEvents();
  }

  function renderQuestionEditor(q, qi, total) {
    const opts = q.options.map((opt, oi) => `
      <div class="opt-input-row">
        <span>${optionShape(oi)}</span>
        <input type="text" data-field="qopt" data-qidx="${qi}" data-oidx="${oi}" maxlength="80" placeholder="Seçenek ${oi + 1}" value="${esc(opt)}">
        ${q.options.length > 2 ? `<button type="button" class="small-btn btn-danger remove-opt" data-qidx="${qi}" data-oidx="${oi}">✕</button>` : ''}
      </div>`).join('');
    return `
      <div class="question-editor-item" data-qidx="${qi}">
        <div class="row">
          <strong>Soru ${qi + 1}</strong>
          <div class="spacer"></div>
          <button type="button" class="small-btn btn-ghost move-up" data-qidx="${qi}" ${qi === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="small-btn btn-ghost move-down" data-qidx="${qi}" ${qi === total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="small-btn btn-danger remove-question" data-qidx="${qi}" ${total <= 1 ? 'disabled' : ''}>Sil</button>
        </div>
        <label>Soru Metni</label>
        <textarea data-field="qtext" data-qidx="${qi}" rows="2" maxlength="200" placeholder="Örn: En sevdiğim renk hangisidir?">${esc(q.text)}</textarea>
        <label style="margin-top:8px">Seçenekler (2-6)</label>
        ${opts}
        ${q.options.length < 6 ? `<button type="button" class="small-btn btn-secondary add-opt" data-qidx="${qi}">+ Seçenek</button>` : ''}
        <div style="margin-top:10px">
          <label>Cevap Süresi</label>
          <select data-field="qtime" data-qidx="${qi}">
            ${TIME_OPTIONS.map((t) => `<option value="${t}" ${q.timeLimit === t ? 'selected' : ''}>${t} saniye</option>`).join('')}
          </select>
        </div>
        <div style="margin-top:10px">
          ${imageUploadBox({ idPrefix: `qimg-${qi}`, label: 'Soru görseli (isteğe bağlı, cihazdan seç)', value: q.imageUrl })}
        </div>
        <label class="row" style="margin-top:10px; gap:8px; cursor:pointer">
          <input type="checkbox" data-field="qdouble" data-qidx="${qi}" ${q.doublePoints ? 'checked' : ''} style="width:20px;height:20px">
          <span>⭐ Bu soru çift puan (2x) olsun</span>
        </label>
      </div>`;
  }

  function bindQuizEditorEvents() {
    on('editor-back', 'click', goAdminQuizList);
    on('add-question', 'click', () => {
      syncEditorFromDOM();
      editorQuiz.questions.push({ text: '', options: ['', ''], timeLimit: 20, imageUrl: '', doublePoints: false });
      renderAdminQuizEditor();
    });
    on('save-quiz', 'click', saveQuiz);
    onAll('.remove-question', 'click', (e) => {
      syncEditorFromDOM();
      const qi = parseInt(e.currentTarget.dataset.qidx, 10);
      if (editorQuiz.questions.length <= 1) return;
      editorQuiz.questions.splice(qi, 1);
      renderAdminQuizEditor();
    });
    onAll('.move-up', 'click', (e) => moveQuestion(parseInt(e.currentTarget.dataset.qidx, 10), -1));
    onAll('.move-down', 'click', (e) => moveQuestion(parseInt(e.currentTarget.dataset.qidx, 10), 1));
    onAll('.add-opt', 'click', (e) => {
      syncEditorFromDOM();
      const qi = parseInt(e.currentTarget.dataset.qidx, 10);
      if (editorQuiz.questions[qi].options.length >= 6) return;
      editorQuiz.questions[qi].options.push('');
      renderAdminQuizEditor();
    });
    onAll('.remove-opt', 'click', (e) => {
      syncEditorFromDOM();
      const qi = parseInt(e.currentTarget.dataset.qidx, 10);
      const oi = parseInt(e.currentTarget.dataset.oidx, 10);
      if (editorQuiz.questions[qi].options.length <= 2) return;
      editorQuiz.questions[qi].options.splice(oi, 1);
      renderAdminQuizEditor();
    });

    // Quiz seviyesi sonuc fotograflari
    bindImageInput('correct-photo-file', (dataUrl) => {
      syncEditorFromDOM();
      editorQuiz.correctPhotoUrl = dataUrl;
      renderAdminQuizEditor();
    });
    on('correct-photo-remove', 'click', () => {
      syncEditorFromDOM();
      editorQuiz.correctPhotoUrl = '';
      renderAdminQuizEditor();
    });
    bindImageInput('wrong-photo-file', (dataUrl) => {
      syncEditorFromDOM();
      editorQuiz.wrongPhotoUrl = dataUrl;
      renderAdminQuizEditor();
    });
    on('wrong-photo-remove', 'click', () => {
      syncEditorFromDOM();
      editorQuiz.wrongPhotoUrl = '';
      renderAdminQuizEditor();
    });

    // Soru gorselleri (her soru icin ayri dosya input'u)
    editorQuiz.questions.forEach((q, qi) => {
      bindImageInput(`qimg-${qi}-file`, (dataUrl) => {
        syncEditorFromDOM();
        editorQuiz.questions[qi].imageUrl = dataUrl;
        renderAdminQuizEditor();
      });
      on(`qimg-${qi}-remove`, 'click', () => {
        syncEditorFromDOM();
        editorQuiz.questions[qi].imageUrl = '';
        renderAdminQuizEditor();
      });
    });
  }

  function moveQuestion(qi, dir) {
    syncEditorFromDOM();
    const ni = qi + dir;
    if (ni < 0 || ni >= editorQuiz.questions.length) return;
    const [item] = editorQuiz.questions.splice(qi, 1);
    editorQuiz.questions.splice(ni, 0, item);
    renderAdminQuizEditor();
  }

  async function saveQuiz() {
    syncEditorFromDOM();
    if (!editorQuiz.title.trim()) return showToast('Quiz başlığı boş olamaz.');
    for (const q of editorQuiz.questions) {
      if (!q.text.trim()) return showToast('Tüm sorularda metin olmalı.');
      if (q.options.filter((o) => o.trim()).length < 2) return showToast('Her soruda en az 2 dolu seçenek olmalı.');
    }
    const payload = {
      title: editorQuiz.title.trim(),
      correctPhotoUrl: editorQuiz.correctPhotoUrl || '',
      wrongPhotoUrl: editorQuiz.wrongPhotoUrl || '',
      questions: editorQuiz.questions.map((q) => ({
        text: q.text.trim(), options: q.options.filter((o) => o.trim()), timeLimit: q.timeLimit, imageUrl: q.imageUrl, doublePoints: !!q.doublePoints,
      })),
    };
    const url = editorQuiz.id ? '/api/quizzes/' + editorQuiz.id : '/api/quizzes';
    const method = editorQuiz.id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || 'Kaydedilemedi.');
    showToast('Quiz kaydedildi ✅');
    goAdminQuizList();
  }

  // ---------- ADMIN: ODA EKRANI ----------

  function renderAdminRoom() {
    const s = latestSync;
    if (!s) { $app.innerHTML = '<p class="center muted">Odaya bağlanılıyor...</p>'; return; }
    const origin = location.origin;
    const playerLink = `${origin}/?code=${s.code}`;
    const birthdayLink = `${origin}/?code=${s.code}&role=birthday&token=${s.birthdayToken}`;

    let body = '';
    if (s.status === 'lobby') {
      body = `
        <div class="room-code-box">
          <div class="muted">ODA KODU</div>
          <div class="code">${s.code}</div>
        </div>
        <div class="stack">
          <div>
            <label>🎮 Oyuncu bağlantısı (herkesle paylaş)</label>
            <div class="link-row"><span class="url" id="player-link">${esc(playerLink)}</span>
              <button class="small-btn btn-secondary" id="copy-player">Kopyala</button></div>
          </div>
          <div>
            <label>🎂 Doğum günü çocuğu bağlantısı (SADECE ona gönder)</label>
            <div class="link-row"><span class="url" id="bday-link">${esc(birthdayLink)}</span>
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
          ${!s.birthdayConnected ? '<p style="color:#ff8b8b">⚠️ Doğum günü çocuğunun bağlantısı koptu, bekleniyor...</p>' : ''}
        </div>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'question_open') {
      body = `
        <div class="question-card">
          <div class="row">
            <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions}</span>${doubleBadge(s.question)}
            <div class="spacer"></div>
            <div class="timer-ring" id="timer-ring" style="--pct:100%"><span id="timer-text">${s.question.duration}</span></div>
          </div>
          <p class="question-text">${esc(s.question.text)}</p>
          ${s.question.imageUrl ? `<img class="question-image" src="${esc(s.question.imageUrl)}" alt="">` : ''}
          <div class="options-grid">${renderOptions(s.question.options)}</div>
        </div>
        <div class="card">
          <p class="muted">Cevaplayan: ${s.answeredCount} / ${s.playerCount}</p>
          <div class="progress-bar"><div style="width:${s.playerCount ? (100 * s.answeredCount / s.playerCount) : 0}%"></div></div>
        </div>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'question_results') {
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — Sonuç</span>${doubleBadge(s.question)}
          <p class="question-text" style="margin-top:10px">${esc(s.question.text)}</p>
          <div class="options-grid">${renderOptions(s.question.options, { correctIndex: s.question.correctIndex })}</div>
        </div>
        <h3>🏆 Sıralama</h3>
        ${renderLeaderboard(s.leaderboard)}
        <button class="btn-primary btn-block btn-lg" id="next-question">
          ${s.questionIndex + 1 >= s.totalQuestions ? 'Final Sıralamasını Göster 🎉' : 'Sonraki Soru ➡️'}
        </button>
        ${adminEndButton(s)}
      `;
    } else if (s.status === 'finished') {
      maybeFireConfetti(s.code);
      body = `
        <div class="hero"><div class="emoji">🏆🎉</div><h2>Oyun Bitti!</h2></div>
        ${renderPodium(s.leaderboard)}
        <h3>Tüm Oyuncular</h3>
        ${renderLeaderboard(s.leaderboard)}
        <button class="btn-primary btn-block btn-lg" id="back-to-list">Quiz Listesine Dön</button>
      `;
    }

    $app.innerHTML = `
      <div class="row"><strong>${esc(s.title)}</strong><div class="spacer"></div><span class="badge">Oda ${s.code}</span></div>
      ${body}
    `;

    on('copy-player', 'click', () => copyText(playerLink));
    on('copy-bday', 'click', () => copyText(birthdayLink));
    on('start-game', 'click', () => socket.emit('admin:start'));
    on('next-question', 'click', () => socket.emit('admin:next'));
    on('admin-end', 'click', () => { if (confirm('Oyunu şimdi bitirmek istediğine emin misin?')) socket.emit('admin:end'); });
    on('cancel-room', 'click', () => { if (confirm('Bu oda tamamen iptal edilsin mi? Herkes odadan çıkarılacak.')) socket.emit('admin:cancelRoom'); });
    on('back-to-list', 'click', goAdminQuizList);
  }

  function adminEndButton(s) {
    if (s.status === 'finished') return '';
    return '<button class="btn-ghost btn-block" id="admin-end">Oyunu Erken Bitir</button>';
  }

  // ---------- DOGUM GUNU SAHIBI: ODA EKRANI ----------

  function renderBirthdayRoom() {
    const s = latestSync;
    if (!s) { $app.innerHTML = '<p class="center muted">Bağlanılıyor...</p>'; return; }
    let body = '';

    if (s.status === 'lobby') {
      body = `
        <div class="card center stack">
          <div class="emoji bounce" style="font-size:2.4rem">🎉</div>
          <h3>Hoş geldin, ${esc(s.birthdayName)}!</h3>
          <p class="muted">Yönetici oyunu başlatınca sorular burada görünecek. ${s.playerCount} arkadaşın hazır bekliyor.</p>
        </div>
      `;
    } else if (s.status === 'birthday_turn' && s.question) {
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — sadece sen görüyorsun 🤫</span>${doubleBadge(s.question)}
          <p class="question-text" style="margin-top:10px">${esc(s.question.text)}</p>
          ${s.question.imageUrl ? `<img class="question-image" src="${esc(s.question.imageUrl)}" alt="">` : ''}
          <p class="muted">Senin için doğru olan şıkkı seç. Süre sınırsız.</p>
          <div class="options-grid" id="bday-options">${renderOptions(s.question.options)}</div>
          <div class="custom-answer-box">
            <button type="button" class="custom-answer-toggle" id="custom-answer-toggle">Doğru cevap şıklarda yok, kendim yazayım ✏️</button>
            <div class="custom-answer-form" id="custom-answer-form" style="display:none">
              <input type="text" id="custom-answer-text" maxlength="80" placeholder="Doğru cevabı yaz">
              <button type="button" class="btn-primary" id="custom-answer-submit">Ekle ve Cevabımı Kilitle 🔒</button>
            </div>
          </div>
        </div>
      `;
    } else if (s.status === 'question_open' && s.question) {
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
      body = `
        <div class="question-card">
          <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions} — Sonuç</span>${doubleBadge(s.question)}
          <p class="question-text" style="margin-top:10px">${esc(s.question.text)}</p>
          <div class="options-grid">${renderOptions(s.question.options, { selected: s.myChoice, correctIndex: s.question.correctIndex })}</div>
        </div>
        <div class="card center">
          <p>🎯 <strong>${s.correctGuessers}</strong> kişi senin seçtiğin cevabı buldu!</p>
          <p class="muted">Sıradaki soruya yönetici geçecek.</p>
        </div>
        <h3>🏆 İlk 5</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    } else if (s.status === 'finished') {
      maybeFireConfetti(s.code);
      body = `
        <div class="hero"><div class="emoji">🎂🎉🥳</div><h2>İyi ki doğdun!</h2></div>
        <h3>Final Sıralaması</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    }

    $app.innerHTML = `<div class="row"><strong>${esc(s.title)}</strong></div>${body}`;

    bindOptions('bday-options', (idx) => socket.emit('birthday:lock', { choiceIndex: idx }));
    on('custom-answer-toggle', 'click', () => {
      const form = document.getElementById('custom-answer-form');
      if (form) form.style.display = form.style.display === 'none' ? 'flex' : 'none';
    });
    on('custom-answer-submit', 'click', () => {
      const input = document.getElementById('custom-answer-text');
      const text = input ? input.value.trim() : '';
      if (!text) return showToast('Lütfen bir cevap metni yaz.');
      socket.emit('birthday:lockCustom', { text });
    });
  }

  // ---------- OYUNCU: ODA EKRANI ----------

  function renderPlayerRoom() {
    const s = latestSync;
    if (!s) { $app.innerHTML = '<p class="center muted">Odaya bağlanılıyor...</p>'; return; }
    let body = '';

    if (s.status === 'lobby') {
      body = `
        <div class="card center stack">
          <div class="emoji bounce" style="font-size:2.4rem">⏳</div>
          <h3>Lobide bekleniyor...</h3>
          <p class="muted">${s.playerCount} oyuncu katıldı. Yönetici başlatınca oyun açılacak.</p>
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
      body = `
        <div class="question-card">
          <div class="row">
            <span class="badge">Soru ${s.questionIndex + 1}/${s.totalQuestions}</span>${doubleBadge(s.question)}
            <div class="spacer"></div>
            <div class="timer-ring" id="timer-ring" style="--pct:100%"><span id="timer-text">${s.question.duration}</span></div>
          </div>
          <p class="question-text">${esc(s.question.text)}</p>
          ${s.question.imageUrl ? `<img class="question-image" src="${esc(s.question.imageUrl)}" alt="">` : ''}
          <div class="options-grid" id="player-options">${renderOptions(s.question.options, { selected: s.myChoice, disabled: s.hasAnswered })}</div>
          ${s.hasAnswered ? '<p class="muted center" style="margin-top:10px">Cevabın kilitlendi, sonuçlar bekleniyor...</p>' : ''}
        </div>
      `;
    } else if (s.status === 'question_results' && s.question) {
      const r = s.myResult || { correct: false, points: 0, choiceIndex: null };
      body = `
        <div class="result-banner ${r.correct ? 'correct' : 'wrong'}">
          ${r.correct ? '🎉 Doğru bildin!' : (r.choiceIndex === null ? '⌛ Cevap vermedin' : '❌ Yanlış cevap')}
          <span class="points">+${r.points} puan · Toplam: ${s.myScore}</span>
        </div>
        <div class="question-card">
          <p class="question-text">${esc(s.question.text)}</p>
          <div class="options-grid">${renderOptions(s.question.options, { selected: r.choiceIndex, correctIndex: s.question.correctIndex })}</div>
          ${s.resultPhotoUrl ? `<img class="result-photo" src="${esc(s.resultPhotoUrl)}" alt="">` : ''}
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
          <p class="muted">${s.myCorrectCount} doğru cevap</p>
        </div>
        ${renderPodium(s.leaderboard)}
        <h3>Final Sıralaması</h3>
        ${renderLeaderboard(s.leaderboard)}
      `;
    }

    $app.innerHTML = `<div class="row"><strong>${esc(s.title)}</strong></div>${body}`;

    bindOptions('player-options', (idx) => {
      if (s.hasAnswered) return;
      socket.emit('player:answer', { choiceIndex: idx });
    });
  }

  render();
  boot();
})();
