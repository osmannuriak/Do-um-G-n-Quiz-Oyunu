/**
 * Dogum Gunu Quiz - sunucu
 * ------------------------
 * Tek dosyada: Express (statik dosyalar + basit REST API) + Socket.IO (gercek zamanli oyun).
 *
 * Veri saklama:
 *  - Quiz'ler SUNUCUDA SAKLANMAZ. Hazirlayanin tarayicisinda (IndexedDB) durur ve
 *    oda kurulurken sunucuya gonderilir. Boylece sunucu yeniden baslasa da quiz kaybolmaz.
 *  - Odalar (oyun oturumlari) ve odaya ait gorseller sadece bellekte tutulur. Biten veya
 *    uzun suredir hareketsiz odalar otomatik temizlenir.
 *  - Sunucu oyun sirasinda yeniden baslarsa, yoneticinin tarayicisi quiz'i ve son puan
 *    durumunu tekrar gonderip odayi ayni kodla geri kurar (/api/rooms/restore); oyuncular
 *    otomatik olarak yeniden baglanir.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid, customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 3000;

// Oda kodu icin karistirilmasi kolay harfleri (O,0,I,1) disarida birakan alfabe
const roomCodeGen = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const TIME_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const DEFAULT_TIME = 20;
const MAX_OPTIONS = 6; // editorde izin verilen ust sinir
const MAX_OPTIONS_LIVE = 8; // dogum gunu sahibi canli ozel cevap eklerse ulasabilecegi ust sinir
const MAX_QUESTIONS = 100;
const MAX_RESULT_PHOTOS = 3; // dogru / yanlis cevap gorseli sayisi (her biri icin)
const MAX_IMAGE_BYTES = 1_500_000; // tek bir gorselin cozulmus boyutu
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// (Ortam degiskenleri sadece testlerde sureleri kisaltmak icin.)
const FINISHED_ROOM_TTL = Number(process.env.FINISHED_ROOM_TTL_MS) || 30 * 60 * 1000; // bitmis oda 30 dk sonra silinir
const IDLE_ROOM_TTL = Number(process.env.IDLE_ROOM_TTL_MS) || 4 * 60 * 60 * 1000; // 4 saat hareketsiz oda silinir
const CLEANUP_EVERY = Number(process.env.CLEANUP_EVERY_MS) || 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------------------

// Fisher-Yates karistirma: her siralamanin olasiligi esit.
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(list) {
  if (!list || !list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

function cleanName(value, max, fallback) {
  return String(value || '').trim().slice(0, max) || fallback;
}

// ---------------------------------------------------------------------------
// Quiz dogrulama (quiz istemciden gelir, sunucu sadece dogrular)
// ---------------------------------------------------------------------------

// Gorseli { mime, buf } (data URI) ya da { url } (http linki) olarak dondurur.
function parseImage(value, label) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (/^https?:\/\//i.test(str)) return { url: str.slice(0, 2000) };
  const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(str);
  if (!m || !ALLOWED_IMAGE_TYPES.has(m[1].toLowerCase())) {
    throw new Error(`${label} geçersiz bir formatta.`);
  }
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`${label} çok büyük. Lütfen daha küçük bir görsel seç.`);
  }
  return { mime: m[1].toLowerCase(), buf };
}

function sanitizeQuestion(q, index) {
  const label = `${index + 1}. soru`;
  const text = String((q && q.text) || '').trim().slice(0, 300);
  const type = q.type === 'numeric' ? 'numeric' : (q.type === 'ranking' ? 'ranking' : 'choice');
  let timeLimit = parseInt(q.timeLimit, 10);
  if (!TIME_OPTIONS.includes(timeLimit)) timeLimit = DEFAULT_TIME;
  const image = parseImage(q.imageUrl, `${label} görseli`);
  const doublePoints = q.doublePoints === true;

  if (!text) throw new Error(`${label}: soru metni boş olamaz.`);

  if (type === 'numeric') {
    const unit = String(q.unit || '').trim().slice(0, 16);
    return { text, type, options: [], unit, timeLimit, image, doublePoints };
  }

  const options = Array.isArray(q.options)
    ? q.options.map((o) => String(o || '').trim().slice(0, 80)).filter((o) => o.length > 0)
    : [];
  if (options.length < 2 || options.length > MAX_OPTIONS) {
    throw new Error(`${label}: 2 ile ${MAX_OPTIONS} arasında dolu seçenek olmalı.`);
  }
  return { text, type, options, unit: '', timeLimit, image, doublePoints };
}

function photoList(list, legacySingle, label) {
  const raw = Array.isArray(list) ? list : (legacySingle ? [legacySingle] : []);
  return raw
    .filter(Boolean)
    .slice(0, MAX_RESULT_PHOTOS)
    .map((v, i) => parseImage(v, `${label} ${i + 1}`))
    .filter(Boolean);
}

function sanitizeQuiz(input) {
  if (!input || typeof input !== 'object') throw new Error('Quiz verisi eksik.');
  const title = String(input.title || '').trim().slice(0, 120);
  if (!title) throw new Error('Quiz başlığı boş olamaz.');
  const questionsRaw = Array.isArray(input.questions) ? input.questions : [];
  if (questionsRaw.length < 1) throw new Error('En az bir soru eklemelisin.');
  if (questionsRaw.length > MAX_QUESTIONS) throw new Error(`En fazla ${MAX_QUESTIONS} soru olabilir.`);
  return {
    title,
    questions: questionsRaw.map(sanitizeQuestion),
    correctPhotos: photoList(input.correctPhotos, input.correctPhotoUrl, 'Doğru cevap görseli'),
    wrongPhotos: photoList(input.wrongPhotos, input.wrongPhotoUrl, 'Yanlış cevap görseli'),
  };
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Oda (oyun oturumu) - sadece bellekte
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const rooms = new Map();

// Gorselin piksel boyutunu dosya basligindan okur (JPEG/PNG/GIF/WebP). Okunamazsa null.
// Istemci bu boyutla gorsel yuklenmeden yerini ayirir, sayfa duzeni ziplamaz.
function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === 'image/webp' && buf.length > 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
        if (isSof) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* bozuk baslik: boyutsuz gecilir */ }
  return null;
}

// Gorseli odanin bellegine koyar ve socket'ten base64 yerine gonderilecek URL'yi dondurur.
// URL, gorselin gercek en-boyunu da tasir (?w=..&h=..).
function storeImage(room, img) {
  if (!img) return '';
  if (img.url) return img.url;
  const id = nanoid(10);
  room.images.set(id, img);
  const size = imageSize(img.buf, img.mime);
  const ok = size && size.w > 0 && size.h > 0 && size.w < 20000 && size.h < 20000;
  return `/img/${room.code}/${id}` + (ok ? `?w=${size.w}&h=${size.h}` : '');
}

function createRoom(clean, ids = {}) {
  let code = ids.code;
  if (!code) {
    do { code = roomCodeGen(); } while (rooms.has(code));
  }
  const now = Date.now();
  const room = {
    code,
    quizTitle: clean.title,
    images: new Map(), // id -> { mime, buf }
    questions: [],
    correctPhotos: [],
    wrongPhotos: [],
    preload: [],
    adminToken: ids.adminToken || nanoid(16),
    birthdayToken: ids.birthdayToken || nanoid(16),
    adminSocketId: null,
    status: 'lobby', // lobby | birthday_turn | question_open | question_results | answer_reveal | leaderboard | paused | podium | badges | finished
    questionIndex: -1,
    birthday: null, // { id, name, socketId, connected }
    players: new Map(),
    previousRanking: [],
    currentQuestion: null,
    playedCount: 0, // puanlanmis soru sayisi
    createdAt: now,
    lastActivity: now,
    finishedAt: null,
  };
  room.questions = clean.questions.map((q) => {
    const { image, ...rest } = q;
    return { ...rest, imageUrl: storeImage(room, image) };
  });
  room.correctPhotos = clean.correctPhotos.map((img) => storeImage(room, img)).filter(Boolean);
  room.wrongPhotos = clean.wrongPhotos.map((img) => storeImage(room, img)).filter(Boolean);
  room.preload = [
    ...room.questions.map((q) => q.imageUrl),
    ...room.correctPhotos,
    ...room.wrongPhotos,
  ].filter(Boolean);
  rooms.set(code, room);
  return room;
}

function deleteRoom(room) {
  clearQuestionTimer(room);
  room.images.clear();
  room.players.clear();
  rooms.delete(room.code);
  io.in(room.code).socketsLeave(room.code);
}

function touch(room) {
  room.lastActivity = Date.now();
}

function newPlayer(id, name) {
  return {
    id, name, socketId: null, connected: false,
    score: 0, // 2 ondalik basamakli
    totalTimeMs: 0, // esitlikte siralama icin: cevap suresi toplami (cevapsiz soru = tam sure)
    correctCount: 0, answeredCount: 0, correctResponseMsSum: 0, lastResult: null,
    firstRank: null, // ilk sorudan sonraki sirasi (Yukselen Yildiz)
    uniqueSum: 0, uniqueCount: 0, // coktan secmelide azinlik secimi puani (Kendi Yolunda)
    slowSum: 0, // cevaplanan sorularda t/T toplami (Acele Etmeyen)
  };
}

function currentQuestionData(room) {
  if (room.questionIndex < 0 || room.questionIndex >= room.questions.length) return null;
  return room.questions[room.questionIndex];
}

function activePlayers(room) {
  return Array.from(room.players.values());
}

// Siralama: puan (yuksek once) -> toplam cevap suresi (kisa once) -> isim.
function rankedPlayers(room) {
  return activePlayers(room)
    .slice()
    .sort((a, b) => b.score - a.score || a.totalTimeMs - b.totalTimeMs || a.name.localeCompare(b.name, 'tr'));
}

function rankOf(room, playerId) {
  return rankedPlayers(room).findIndex((p) => p.id === playerId) + 1;
}

function leaderboardPayload(room, limit) {
  const ranked = rankedPlayers(room);
  const list = typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
  return list.map((p, i) => {
    const prevIndex = room.previousRanking.indexOf(p.id);
    const rank = i + 1;
    return {
      name: p.name,
      score: p.score,
      connected: p.connected,
      rank,
      rankDelta: prevIndex === -1 ? 0 : prevIndex + 1 - rank, // pozitif = yukari cikti
    };
  });
}

// En yuksek (ya da en dusuk) degere sahip TUM oyunculari dondurur (esitlikte hepsi kazanir).
function topBy(players, value, { lowest = false } = {}) {
  let best = null;
  let winners = [];
  for (const p of players) {
    const v = value(p);
    if (v === null || !Number.isFinite(v)) continue;
    const better = best === null || (lowest ? v < best - 1e-9 : v > best + 1e-9);
    if (better) { best = v; winners = [p]; } else if (Math.abs(v - best) <= 1e-9) winners.push(p);
  }
  return { best, winners };
}

// Final unvanlari. Herkes (ilk 3 dahil) kazanabilir, bir kisi birden fazla rozet alabilir,
// esitlikte rozet esit olanlarin hepsine verilir. Hak eden yoksa rozet gosterilmez.
function computeBadges(room) {
  const badges = [];
  const ranked = rankedPlayers(room);
  if (!ranked.length) return badges;
  const add = (emoji, title, desc, winners) => {
    if (winners.length) badges.push({ emoji, title, desc, names: winners.map((p) => p.name) });
  };

  // Yukselen Yildiz: ilk sorudan sonraki sira - final sirasi (en cok tirmanan; en az 1 basamak).
  const finalRank = new Map(ranked.map((p, i) => [p.id, i + 1]));
  const rise = topBy(ranked, (p) => (p.firstRank == null ? null : p.firstRank - finalRank.get(p.id)));
  if (rise.best > 0) add('🚀', 'Yükselen Yıldız', 'Oyun boyunca sıralamada en çok basamak tırmanan', rise.winners);

  // Kendi Yolunda: coktan secmelide, sectigi sikki secenlerin orani ne kadar dusukse o kadar puan.
  const unique = topBy(ranked, (p) => (p.uniqueCount > 0 ? p.uniqueSum / p.uniqueCount : null));
  if (unique.best > 0) add('🦄', 'Kendi Yolunda', 'Çoğunluğun seçmediği şıkları en çok işaretleyen', unique.winners);

  // Acele Etmeyen: cevaplanan sorularda t/T ortalamasi en yuksek; sorularin yarisindan azina
  // cevap veren aday olamaz.
  const played = Math.max(1, room.playedCount);
  const slow = topBy(ranked, (p) => (p.answeredCount > 0 && p.answeredCount >= played / 2 ? p.slowSum / p.answeredCount : null));
  add('🐢', 'Acele Etmeyen', 'Cevaplarını en uzun düşünerek veren', slow.winners);

  // Gonullerin Sampiyonu: sonuncu (puan ve toplam sure tamamen esitse hepsi).
  const last = ranked[ranked.length - 1];
  add('💖', 'Gönüllerin Şampiyonu', 'Sıralamada sonuncu olan',
    ranked.filter((p) => p.score === last.score && p.totalTimeMs === last.totalTimeMs));
  return badges;
}

// Her sikki kac oyuncunun isaretledigi (sutun grafigi icin), gosterilen sik sirasiyla.
function answerDistribution(room) {
  const cq = room.currentQuestion;
  if (!cq) return [];
  const counts = new Map(cq.options.map((o) => [o.id, 0]));
  for (const ans of cq.answers.values()) {
    if (counts.has(ans.optionId)) counts.set(ans.optionId, counts.get(ans.optionId) + 1);
  }
  return cq.options.map((o) => counts.get(o.id));
}

// ---------------------------------------------------------------------------
// Puanlama (soru basina tam sayi; sure sunucuda, soru acildigi andan ms hassasiyetle)
// ---------------------------------------------------------------------------

function round2(x) {
  return Math.round(x * 100) / 100;
}

// Her sorudan alinan puan en yakin tam sayiya yuvarlanir (sure yine ms hassasiyetle olculur).
function roundPoints(x) {
  return Math.round(x);
}

// Siralamada ters sirali cift sayisi (Kendall tau mesafesi).
function discordantPairs(correctOrder, guessOrder) {
  const truePos = new Map(correctOrder.map((id, i) => [id, i]));
  const seq = guessOrder.map((id) => truePos.get(id));
  let count = 0;
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      if (seq[i] > seq[j]) count++;
    }
  }
  return count;
}

// Dogru yerinde olmayan kutu sayisi (oyuncuya gosterilen "fark").
function misplacedCount(correctOrder, guessOrder) {
  return guessOrder.filter((id, i) => id !== correctOrder[i]).length;
}

// Bir cevabin puanini ve sonuc bilgisini hesaplar. t = cevap suresi (sn), T = soru suresi (sn).
function scoreAnswer(cq, ans) {
  const T = cq.duration;
  const t = Math.min(T, Math.max(0, ans.elapsedMs / 1000));
  const speed = 1 - t / T;
  const multiplier = cq.doublePoints ? 2 : 1;

  if (cq.type === 'choice') {
    const correct = ans.optionId === cq.birthdayOptionId;
    const points = correct ? 1000 * (1 - 0.5 * (t / T)) : 0;
    return { exact: correct, points: roundPoints(points * multiplier), extra: { optionId: ans.optionId } };
  }
  if (cq.type === 'numeric') {
    const correctValue = cq.birthdayValue;
    const diff = Math.abs(ans.value - correctValue);
    const accuracy = Math.max(0, 1 - diff / Math.max(Math.abs(correctValue), 1));
    const points = 1000 * accuracy * (0.75 + 0.25 * speed);
    return { exact: diff === 0, points: roundPoints(points * multiplier), extra: { value: ans.value, diff: round2(diff) } };
  }
  // ranking
  const n = cq.birthdayOrder.length;
  const totalPairs = (n * (n - 1)) / 2;
  const wrongPairs = discordantPairs(cq.birthdayOrder, ans.order);
  const accuracy = totalPairs > 0 ? 1 - wrongPairs / totalPairs : 1;
  const points = 1000 * accuracy * (0.75 + 0.25 * speed);
  return {
    exact: wrongPairs === 0,
    points: roundPoints(points * multiplier),
    extra: { order: ans.order, misplaced: misplacedCount(cq.birthdayOrder, ans.order) },
  };
}

function clearQuestionTimer(room) {
  if (room.currentQuestion && room.currentQuestion.timer) {
    clearTimeout(room.currentQuestion.timer);
    room.currentQuestion.timer = null;
  }
}

// ---------------------------------------------------------------------------
// Oyun akisi
//   lobby -> birthday_turn (yonetici) -> question_open (OTOMATIK: dogum gunu cocugu cevaplayinca)
//   -> question_results (OTOMATIK: sure bitince / herkes cevaplayinca) -> answer_reveal (yonetici)
//   -> leaderboard (yonetici) -> sonraki soru ya da podium (yonetici) -> finished: tam liste (yonetici)
// ---------------------------------------------------------------------------

const ENDED = new Set(['podium', 'badges', 'finished']);

function startQuestion(room) {
  clearQuestionTimer(room);
  room.questionIndex += 1;
  if (room.questionIndex >= room.questions.length) {
    showPodium(room);
    return;
  }
  const q = currentQuestionData(room);
  room.currentQuestion = {
    type: q.type,
    // Siklar her soruda yeniden karistirilir; dogru cevap index ile degil sik kimligi (id) ile tutulur.
    options: q.type === 'numeric' ? [] : shuffle(q.options.map((text, i) => ({ id: 'o' + i, text }))),
    birthdayOptionId: null, // coktan secmeli
    birthdayValue: null, // sayi tahmini
    birthdayOrder: null, // siralama (sik id'leri)
    openAt: null, // duvar saati (kalan sureyi istemciye bildirmek icin)
    openMono: null, // monoton saat (cevap suresini olcmek icin)
    duration: q.timeLimit,
    doublePoints: !!q.doublePoints,
    answers: new Map(), // playerId -> { optionId | value | order, elapsedMs }
    timer: null,
  };
  room.status = 'birthday_turn';
  touch(room);
  syncRoom(room);
}

function openQuestionForAnswers(room) {
  const cq = room.currentQuestion;
  cq.openAt = Date.now();
  cq.openMono = performance.now();
  room.status = 'question_open';
  cq.timer = setTimeout(() => finalizeQuestion(room), cq.duration * 1000 + 150); // kucuk ag payi
  touch(room);
  syncRoom(room);
}

function canBirthdayLock(room, type) {
  return room.status === 'birthday_turn' && room.currentQuestion && room.currentQuestion.type === type;
}

function lockBirthdayChoice(room, optionId) {
  if (!canBirthdayLock(room, 'choice')) return;
  const cq = room.currentQuestion;
  if (!cq.options.some((o) => o.id === optionId)) return;
  cq.birthdayOptionId = optionId;
  openQuestionForAnswers(room);
}

// Dogru cevap siklarda yoksa dogum gunu sahibi kendisi yazar; yeni sik diger siklarin
// arasina RASTGELE bir yere eklenir (her zaman en sonda durmaz). Kaydedilmis quiz degismez.
function lockBirthdayCustom(room, socket, text) {
  if (!canBirthdayLock(room, 'choice')) return;
  const cq = room.currentQuestion;
  const clean = String(text || '').trim().slice(0, 80);
  if (!clean) return err(socket, 'Lütfen bir cevap metni yaz.');
  const same = cq.options.find((o) => o.text.toLocaleLowerCase('tr') === clean.toLocaleLowerCase('tr'));
  if (same) {
    cq.birthdayOptionId = same.id;
  } else {
    if (cq.options.length >= MAX_OPTIONS_LIVE) return err(socket, 'Bu soruya daha fazla şık eklenemez.');
    const option = { id: 'c' + nanoid(6), text: clean };
    const pos = Math.floor(Math.random() * (cq.options.length + 1));
    cq.options.splice(pos, 0, option);
    cq.birthdayOptionId = option.id;
  }
  openQuestionForAnswers(room);
}

function lockBirthdayNumeric(room, socket, rawValue) {
  if (!canBirthdayLock(room, 'numeric')) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) return err(socket, 'Lütfen geçerli bir sayı gir.');
  room.currentQuestion.birthdayValue = value;
  openQuestionForAnswers(room);
}

function isValidOrder(cq, order) {
  if (!Array.isArray(order) || order.length !== cq.options.length) return false;
  const ids = new Set(cq.options.map((o) => o.id));
  const seen = new Set();
  for (const id of order) {
    if (!ids.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function lockBirthdayRanking(room, socket, order) {
  if (!canBirthdayLock(room, 'ranking')) return;
  if (!isValidOrder(room.currentQuestion, order)) return err(socket, 'Geçersiz sıralama.');
  room.currentQuestion.birthdayOrder = order.slice();
  openQuestionForAnswers(room);
}

// Tum cevap tipleri icin ortak kabul: sure, tekrar ve oyuncu kontrolu burada.
function acceptAnswer(room, playerId, build) {
  if (room.status !== 'question_open') return;
  const player = room.players.get(playerId);
  const cq = room.currentQuestion;
  if (!player || !cq || cq.answers.has(playerId)) return;
  const elapsedMs = performance.now() - cq.openMono;
  if (elapsedMs > cq.duration * 1000 + 150) return; // sure doldu
  const ans = build(cq);
  if (!ans) return;
  ans.elapsedMs = Math.max(0, elapsedMs);
  cq.answers.set(playerId, ans);
  touch(room);

  const connected = activePlayers(room).filter((p) => p.connected);
  if (connected.length > 0 && connected.every((p) => cq.answers.has(p.id))) {
    finalizeQuestion(room);
  } else {
    // Sadece ilgilenenlere (yonetici, dogum gunu sahibi, cevaplayan) kucuk guncelleme.
    syncStaff(room);
    syncPlayer(room, player);
  }
}

function finalizeQuestion(room) {
  if (room.status !== 'question_open') return;
  clearQuestionTimer(room);
  room.previousRanking = rankedPlayers(room).map((p) => p.id);
  const cq = room.currentQuestion;
  const durationMs = cq.duration * 1000;
  // Kendi Yolunda icin: her sikki kac kisinin sectigi (bir kez hesaplanir).
  const counts = cq.type === 'choice' ? answerDistribution(room) : null;
  const distribution = counts ? new Map(cq.options.map((o, i) => [o.id, counts[i]])) : null;
  const answeredTotal = cq.answers.size;

  for (const player of room.players.values()) {
    const ans = cq.answers.get(player.id);
    if (!ans) {
      player.totalTimeMs += durationMs;
      player.lastResult = { answered: false, exact: false, won: false, points: 0 };
    } else {
      const res = scoreAnswer(cq, ans);
      const elapsed = Math.min(durationMs, ans.elapsedMs);
      player.score += res.points;
      player.totalTimeMs += elapsed;
      player.answeredCount += 1;
      player.slowSum += elapsed / durationMs;
      if (distribution && distribution.has(ans.optionId)) {
        player.uniqueSum += 1 - distribution.get(ans.optionId) / answeredTotal;
        player.uniqueCount += 1;
      }
      if (res.exact) {
        player.correctCount += 1;
        player.correctResponseMsSum += elapsed;
      }
      player.lastResult = { answered: true, exact: res.exact, won: res.exact, points: res.points, ...res.extra };
    }
    // "Dogru" gorseli sadece dogru / tam isabet yapana; esit olasilikla rastgele.
    player.lastResult.photoUrl = pickRandom(player.lastResult.won ? room.correctPhotos : room.wrongPhotos);
  }
  room.playedCount += 1;
  // Yukselen Yildiz icin: oyuncunun oynadigi ilk sorudan sonraki sirasi.
  rankedPlayers(room).forEach((p, i) => { if (p.firstRank == null) p.firstRank = i + 1; });
  room.status = 'question_results';
  touch(room);
  syncRoom(room);
}

// Yoneticinin "ileri" butonu: duruma gore bir sonraki ekrana gecer.
function advance(room) {
  switch (room.status) {
    case 'question_results': room.status = 'answer_reveal'; break;
    case 'answer_reveal':
      // Son sorudan sonra ilk 5 gosterilmez (surpriz kacmasin): direkt podyum.
      if (room.questionIndex + 1 >= room.questions.length) { showPodium(room); return; }
      room.status = 'leaderboard';
      break;
    case 'leaderboard':
    case 'paused':
      startQuestion(room);
      return;
    case 'podium': room.status = 'badges'; break;
    case 'badges': room.status = 'finished'; break;
    default: return;
  }
  touch(room);
  syncRoom(room);
}

function showPodium(room) {
  clearQuestionTimer(room);
  room.status = 'podium';
  room.currentQuestion = null;
  room.finishedAt = Date.now();
  touch(room);
  syncRoom(room);
}

// ---------------------------------------------------------------------------
// Durum senkronizasyonu (her role sadece ihtiyaci olan veri)
// ---------------------------------------------------------------------------

function baseState(room) {
  const state = {
    code: room.code,
    title: room.quizTitle,
    status: room.status,
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    birthdayName: room.birthday ? room.birthday.name : null,
    birthdayConnected: room.birthday ? room.birthday.connected : false,
    playerCount: room.players.size,
  };
  // Gorsellerin onceden yuklenmesi icin URL listesi (oyun icindeki mesajlari sisirmemek
  // icin sadece bekleme anlarinda gonderilir).
  if (room.status === 'lobby' || room.status === 'paused' || room.status === 'birthday_turn') {
    state.preload = room.preload;
  }
  return state;
}

function questionPayload(room, { timer = false, reveal = false } = {}) {
  const q = currentQuestionData(room);
  const cq = room.currentQuestion;
  if (!q || !cq) return null;
  const out = {
    text: q.text,
    type: q.type,
    unit: q.unit || '',
    options: cq.options, // [{ id, text }] karistirilmis sirada
    imageUrl: q.imageUrl,
    doublePoints: q.doublePoints,
    duration: cq.duration,
  };
  if (timer && cq.openAt) {
    // Istemci saatine guvenmemek icin kalan sure gonderilir.
    out.remainingMs = Math.max(0, cq.openAt + cq.duration * 1000 - Date.now());
  }
  if (reveal) {
    if (q.type === 'numeric') out.correctValue = cq.birthdayValue;
    else if (q.type === 'ranking') out.correctOrder = cq.birthdayOrder;
    else {
      out.correctId = cq.birthdayOptionId;
      out.distribution = answerDistribution(room);
    }
  }
  return out;
}

function exactCount(room) {
  return activePlayers(room).filter((p) => p.lastResult && p.lastResult.exact).length;
}

function stateForAdmin(room) {
  const state = baseState(room);
  state.role = 'admin';
  state.birthdayToken = room.birthdayToken;
  state.birthdayId = room.birthday ? room.birthday.id : null;
  // Istatistikler yoneticiye gider: sunucu yeniden baslarsa puanlar bunlarla geri kurulur.
  state.players = activePlayers(room)
    .map((p) => ({
      id: p.id, name: p.name, connected: p.connected, score: p.score, totalTimeMs: p.totalTimeMs,
      correctCount: p.correctCount, answeredCount: p.answeredCount, correctResponseMsSum: p.correctResponseMsSum,
      firstRank: p.firstRank, uniqueSum: p.uniqueSum, uniqueCount: p.uniqueCount, slowSum: p.slowSum,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  state.answeredCount = room.currentQuestion ? room.currentQuestion.answers.size : 0;
  state.playedCount = room.playedCount;

  const s = room.status;
  if (s === 'question_open') state.question = questionPayload(room, { timer: true });
  if (s === 'question_results') {
    state.question = questionPayload(room);
    state.exactCount = exactCount(room);
  }
  if (s === 'answer_reveal') state.question = questionPayload(room, { reveal: true });
  if (s === 'leaderboard' || s === 'paused') state.leaderboard = leaderboardPayload(room, 5);
  if (s === 'podium') state.leaderboard = leaderboardPayload(room, 3);
  if (s === 'badges') state.badges = computeBadges(room);
  if (s === 'finished') state.leaderboard = leaderboardPayload(room);
  return state;
}

function stateForBirthday(room) {
  const state = baseState(room);
  state.role = 'birthday';
  const cq = room.currentQuestion;
  const s = room.status;

  if (s === 'birthday_turn') {
    state.question = questionPayload(room);
  } else if (s === 'question_open') {
    state.answeredCount = cq.answers.size;
    state.playerTotal = activePlayers(room).filter((p) => p.connected).length;
  } else if (s === 'question_results') {
    state.question = questionPayload(room);
    state.exactCount = exactCount(room);
  } else if (s === 'answer_reveal') {
    state.question = questionPayload(room, { reveal: true });
  } else if (s === 'leaderboard' || s === 'paused') {
    state.leaderboard = leaderboardPayload(room, 5);
  } else if (s === 'podium') {
    state.leaderboard = leaderboardPayload(room, 3);
  } else if (s === 'badges') {
    state.badges = computeBadges(room);
  } else if (s === 'finished') {
    state.leaderboard = leaderboardPayload(room);
  }
  return state;
}

function stateForPlayer(room, playerId) {
  const state = baseState(room);
  state.role = 'player';
  const player = room.players.get(playerId);
  const cq = room.currentQuestion;
  const s = room.status;
  if (player) {
    state.myScore = player.score;
    if (s !== 'lobby') state.myRank = rankOf(room, playerId);
  }

  if (s === 'question_open') {
    // Dogum gunu sahibinin sectigi cevap burada ASLA gonderilmez.
    const mine = cq.answers.get(playerId);
    state.question = questionPayload(room, { timer: true });
    state.hasAnswered = !!mine;
    state.myChoice = mine ? mine.optionId : null;
    state.myValue = mine ? mine.value : null;
    state.myOrder = mine ? mine.order : null;
  } else if (s === 'question_results') {
    // Dogru cevap henuz gosterilmez; sadece kendi sonucu (gorsel + puan + sira).
    const q = currentQuestionData(room);
    state.question = { text: q.text, type: q.type, unit: q.unit || '', doublePoints: q.doublePoints };
    state.myResult = player ? player.lastResult : null;
    state.resultPhotoUrl = player && player.lastResult ? player.lastResult.photoUrl : '';
  } else if (s === 'answer_reveal') {
    state.question = questionPayload(room, { reveal: true });
    state.myChoice = player && player.lastResult ? player.lastResult.optionId || null : null;
  } else if (s === 'leaderboard' || s === 'paused') {
    state.leaderboard = leaderboardPayload(room, 5);
  } else if (s === 'podium') {
    state.leaderboard = leaderboardPayload(room, 3);
  } else if (s === 'badges') {
    state.badges = computeBadges(room);
  } else if (s === 'finished') {
    state.leaderboard = leaderboardPayload(room);
    state.myCorrectCount = player ? player.correctCount : 0;
  }
  return state;
}

function syncStaff(room) {
  if (room.adminSocketId) io.to(room.adminSocketId).emit('sync', stateForAdmin(room));
  if (room.birthday && room.birthday.connected) io.to(room.birthday.socketId).emit('sync', stateForBirthday(room));
}

function syncPlayer(room, player) {
  if (player.connected && player.socketId) io.to(player.socketId).emit('sync', stateForPlayer(room, player.id));
}

function syncRoom(room) {
  syncStaff(room);
  for (const player of room.players.values()) syncPlayer(room, player);
}

// Oyuncu katilip ayrildiginda: lobide herkes oyuncu sayisini gorur, oyun sirasinda
// sadece yonetici ve dogum gunu sahibinin bilmesi yeterli.
function syncAfterPresenceChange(room) {
  if (room.status === 'lobby') syncRoom(room);
  else syncStaff(room);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Oda kurma: quiz (gorseller dahil) yoneticinin tarayicisindan gelir.
app.post('/api/rooms', (req, res) => {
  try {
    const clean = sanitizeQuiz(req.body && req.body.quiz);
    const room = createRoom(clean);
    res.json({ code: room.code, adminToken: room.adminToken, birthdayToken: room.birthdayToken });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Sunucu yeniden baslayip oda kaybolduysa yoneticinin tarayicisi odayi ayni kod ve
// anahtarlarla, son bilinen puan durumuyla geri kurar.
app.post('/api/rooms/restore', (req, res) => {
  const snap = (req.body && req.body.snapshot) || {};
  const code = String(snap.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code) || typeof snap.adminToken !== 'string' || typeof snap.birthdayToken !== 'string') {
    return res.status(400).json({ error: 'Geçersiz oda bilgisi.' });
  }
  const existing = rooms.get(code);
  if (existing) {
    if (existing.adminToken === snap.adminToken) return res.json({ ok: true, alreadyRunning: true });
    return res.status(409).json({ error: 'Bu oda kodu şu an kullanımda.' });
  }
  let clean;
  try {
    clean = sanitizeQuiz(req.body.quiz);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const room = createRoom(clean, {
    code,
    adminToken: snap.adminToken.slice(0, 40),
    birthdayToken: snap.birthdayToken.slice(0, 40),
  });
  applySnapshot(room, snap);
  console.log(`Oda geri kuruldu: ${code} (${room.status}, soru ${room.questionIndex + 1})`);
  res.json({ ok: true });
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : 0;
}

function applySnapshot(room, snap) {
  if (snap.birthday && snap.birthday.id) {
    room.birthday = {
      id: String(snap.birthday.id).slice(0, 20),
      name: cleanName(snap.birthday.name, 30, 'Doğum günü çocuğu'),
      socketId: null,
      connected: false,
    };
  }
  const players = Array.isArray(snap.players) ? snap.players.slice(0, 200) : [];
  for (const p of players) {
    if (!p || !p.id) continue;
    const player = newPlayer(String(p.id).slice(0, 20), cleanName(p.name, 24, 'Oyuncu'));
    player.score = Math.round(num(p.score));
    player.totalTimeMs = num(p.totalTimeMs);
    player.correctCount = Math.round(num(p.correctCount));
    player.answeredCount = Math.round(num(p.answeredCount));
    player.correctResponseMsSum = num(p.correctResponseMsSum);
    player.firstRank = Number.isInteger(p.firstRank) && p.firstRank > 0 ? p.firstRank : null;
    player.uniqueSum = num(p.uniqueSum);
    player.uniqueCount = Math.round(num(p.uniqueCount));
    player.slowSum = num(p.slowSum);
    room.players.set(player.id, player);
  }
  const total = room.questions.length;
  const qi = Number.isInteger(snap.questionIndex) ? snap.questionIndex : -1;
  if (ENDED.has(snap.status)) {
    room.status = snap.status;
    room.questionIndex = total - 1;
    room.finishedAt = Date.now();
  } else if (snap.status === 'lobby' || qi < 0) {
    room.status = 'lobby';
  } else {
    // Yarim kalan soru tekrar sorulur; puani verilmis son sorudan devam edilir.
    const scored = ['question_results', 'answer_reveal', 'leaderboard', 'paused'];
    const lastDone = scored.includes(snap.status) ? qi : qi - 1;
    room.questionIndex = Math.max(-1, Math.min(lastDone, total - 1));
    room.status = 'paused';
  }
  room.playedCount = Number.isInteger(snap.playedCount) ? Math.min(snap.playedCount, total) : Math.max(0, room.questionIndex + 1);
}

// Gorseller socket uzerinden base64 olarak degil, buradan URL ile (tarayici onbellegine
// alinabilir sekilde) sunulur.
app.get('/img/:code/:id', (req, res) => {
  const room = rooms.get(req.params.code);
  const img = room && room.images.get(req.params.id);
  if (!img) return res.status(404).end();
  res.set('Content-Type', img.mime);
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.send(img.buf);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

const server = http.createServer(app);
// Istemciden gelen mesajlar artik kucuk (gorseller HTTP ile gidiyor), siniri dusuk tut.
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });

function err(socket, message) {
  socket.emit('errorMsg', { message });
}

function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

function roomOf(socket, expectedRole) {
  const { code, role } = socket.data || {};
  if (!code || role !== expectedRole) return null;
  return rooms.get(code) || null;
}

// Basit oran sinirlama: bir socket saniyede 20'den fazla olay gonderirse fazlasi yok sayilir.
function rateLimited(socket) {
  const now = Date.now();
  const rl = socket.data.rl || (socket.data.rl = { start: now, count: 0 });
  if (now - rl.start > 1000) { rl.start = now; rl.count = 0; }
  rl.count += 1;
  return rl.count > 20;
}

io.on('connection', (socket) => {
  socket.data = {};
  const handle = (event, fn) => socket.on(event, (payload) => {
    if (rateLimited(socket)) return;
    try {
      fn(payload && typeof payload === 'object' ? payload : {});
    } catch (e) {
      console.error(`"${event}" islenirken hata:`, e);
    }
  });

  // --- Yonetici ---
  handle('admin:join', ({ code, token }) => {
    const room = findRoom(code);
    if (!room) return socket.emit('roomMissing', { code: String(code || '').toUpperCase() });
    if (room.adminToken !== token) return err(socket, 'Geçersiz yönetici anahtarı.');
    room.adminSocketId = socket.id;
    socket.join(room.code);
    socket.data = { code: room.code, role: 'admin' };
    touch(room);
    socket.emit('sync', stateForAdmin(room));
  });

  handle('admin:start', () => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    if (!room.birthday) return err(socket, 'Önce doğum günü çocuğunun katılması gerekiyor.');
    if (room.status !== 'lobby') return;
    startQuestion(room);
  });

  // Yoneticinin tek "ileri" butonu. "from": butona basildigi andaki ekran; cift dokunma
  // ya da gecikmeli mesaj yuzunden iki ekran birden atlanmasin.
  handle('admin:next', ({ from }) => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    if (from && from !== room.status) return;
    const startsQuestion = (room.status === 'leaderboard' || room.status === 'paused') &&
      room.questionIndex + 1 < room.questions.length;
    if (startsQuestion && !room.birthday) return err(socket, 'Önce doğum günü çocuğunun katılması gerekiyor.');
    advance(room);
  });

  handle('admin:end', () => {
    const room = roomOf(socket, 'admin');
    if (!room || ENDED.has(room.status) || room.status === 'lobby') return;
    showPodium(room);
  });

  handle('admin:cancelRoom', () => {
    const room = roomOf(socket, 'admin');
    if (!room || room.status !== 'lobby') return; // sadece oyun baslamadan once
    io.to(room.code).emit('roomCancelled');
    deleteRoom(room);
  });

  // --- Dogum gunu sahibi ---
  handle('birthday:join', ({ code, token, name, savedId }) => {
    const room = findRoom(code);
    if (!room) return socket.emit('roomMissing', { code: String(code || '').toUpperCase() });
    if (room.birthdayToken !== token) return err(socket, 'Geçersiz davet bağlantısı.');
    if (room.birthday && room.birthday.id !== savedId) {
      return err(socket, 'Doğum günü çocuğu rolü zaten başka biri tarafından alındı.');
    }
    if (!room.birthday) {
      room.birthday = { id: nanoid(10), name: cleanName(name, 30, 'Doğum günü çocuğu') };
    }
    room.birthday.socketId = socket.id;
    room.birthday.connected = true;
    socket.join(room.code);
    socket.data = { code: room.code, role: 'birthday' };
    touch(room);
    socket.emit('joined', { id: room.birthday.id, name: room.birthday.name });
    if (room.status === 'lobby') syncRoom(room);
    else syncStaff(room);
  });

  handle('birthday:lock', ({ optionId }) => {
    const room = roomOf(socket, 'birthday');
    if (room) lockBirthdayChoice(room, optionId);
  });

  handle('birthday:lockCustom', ({ text }) => {
    const room = roomOf(socket, 'birthday');
    if (room) lockBirthdayCustom(room, socket, text);
  });

  handle('birthday:lockNumeric', ({ value }) => {
    const room = roomOf(socket, 'birthday');
    if (room) lockBirthdayNumeric(room, socket, value);
  });

  handle('birthday:lockRanking', ({ order }) => {
    const room = roomOf(socket, 'birthday');
    if (room) lockBirthdayRanking(room, socket, order);
  });

  // --- Oyuncular ---
  handle('player:join', ({ code, name, savedId }) => {
    const room = findRoom(code);
    if (!room) return socket.emit('roomMissing', { code: String(code || '').toUpperCase() });

    let player = savedId ? room.players.get(String(savedId)) : null;
    if (!player) {
      const clean = String(name || '').trim().slice(0, 24);
      if (!clean) return err(socket, 'Lütfen bir isim gir.');
      if (room.players.size >= 200) return err(socket, 'Oda dolu.');
      player = newPlayer(nanoid(10), clean);
      room.players.set(player.id, player);
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    socket.data = { code: room.code, role: 'player', playerId: player.id };
    touch(room);
    socket.emit('joined', { id: player.id, name: player.name });
    syncAfterPresenceChange(room);
    if (room.status !== 'lobby') syncPlayer(room, player);
  });

  handle('player:answer', ({ optionId }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    acceptAnswer(room, socket.data.playerId, (cq) =>
      (cq.type === 'choice' && cq.options.some((o) => o.id === optionId) ? { optionId } : null));
  });

  handle('player:answerNumeric', ({ value }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    const n = Number(value);
    acceptAnswer(room, socket.data.playerId, (cq) =>
      (cq.type === 'numeric' && Number.isFinite(n) && Math.abs(n) <= 1e12 ? { value: n } : null));
  });

  handle('player:answerRanking', ({ order }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    acceptAnswer(room, socket.data.playerId, (cq) =>
      (cq.type === 'ranking' && isValidOrder(cq, order) ? { order: order.slice() } : null));
  });

  socket.on('disconnect', () => {
    const { code, role, playerId } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room) return;
    if (role === 'admin' && room.adminSocketId === socket.id) {
      room.adminSocketId = null;
    } else if (role === 'birthday' && room.birthday && room.birthday.socketId === socket.id) {
      room.birthday.connected = false;
      syncStaff(room);
    } else if (role === 'player') {
      const player = room.players.get(playerId);
      if (player && player.socketId === socket.id) {
        player.connected = false;
        syncAfterPresenceChange(room);
      }
    }
  });
});

// Biten ve uzun suredir hareketsiz odalari (gorselleriyle birlikte) bellekten temizle.
setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const finishedLongAgo = ENDED.has(room.status) && now - room.finishedAt > FINISHED_ROOM_TTL;
    const idle = now - room.lastActivity > IDLE_ROOM_TTL;
    if (finishedLongAgo || idle) deleteRoom(room);
  }
}, CLEANUP_EVERY).unref();

server.listen(PORT, () => {
  console.log(`Dogum gunu quiz sunucusu http://localhost:${PORT} adresinde calisiyor`);
});
