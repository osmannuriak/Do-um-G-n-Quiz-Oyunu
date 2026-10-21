/**
 * Dogum Gunu Quiz - sunucu
 * ------------------------
 * Tek dosyada: Express (statik dosyalar + basit REST API) + Socket.IO (gercek zamanli oyun).
 * Veri saklama: Quiz'ler data/quizzes.json dosyasinda kalici tutulur.
 *               Odalar (oyun oturumlari) sadece bellekte tutulur; sunucu yeniden
 *               baslatildiginda devam eden oyunlar sifirlanir (quiz'ler kaybolmaz).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid, customAlphabet } = require('nanoid');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'quizzes.json');

// Oda kodu icin karistirilmasi kolay harfleri (O,0,I,1) disarida birakan alfabe
const roomCodeGen = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const TIME_OPTIONS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const DEFAULT_TIME = 20;
const MAX_OPTIONS = 6; // editorde izin verilen normal ust sinir
const MAX_OPTIONS_LIVE = 8; // dogum gunu sahibi canli olarak ozel cevap eklerse ulasabilecegi ust sinir
const MAX_IMAGE_CHARS = 2_200_000; // ~1.6MB'lik sikistirilmis gorsel icin base64 payi

// ---------------------------------------------------------------------------
// Quiz kalici depolama (basit JSON dosyasi)
// ---------------------------------------------------------------------------

function loadQuizzes() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function saveQuizzes(quizzes) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(quizzes, null, 2), 'utf8');
}

let quizzes = loadQuizzes();

function sanitizeImageField(value, label) {
  if (!value) return '';
  const str = String(value).trim();
  if (!str) return '';
  if (str.length > MAX_IMAGE_CHARS) {
    throw new Error(`${label} cok buyuk. Lutfen daha kucuk/sikistirilmis bir gorsel sec.`);
  }
  // Basit bir guvenlik: sadece data: URI veya http(s) linklerine izin ver.
  if (!/^data:image\//i.test(str) && !/^https?:\/\//i.test(str)) {
    throw new Error(`${label} gecersiz bir formatta.`);
  }
  return str;
}

function sanitizeQuestion(q) {
  const text = String(q.text || '').trim();
  const type = q.type === 'numeric' ? 'numeric' : (q.type === 'ranking' ? 'ranking' : 'choice');
  let timeLimit = parseInt(q.timeLimit, 10);
  if (!TIME_OPTIONS.includes(timeLimit)) timeLimit = DEFAULT_TIME;
  const imageUrl = sanitizeImageField(q.imageUrl, 'Soru gorseli');
  const doublePoints = q.doublePoints === true;

  if (!text) throw new Error('Soru metni bos olamaz.');

  if (type === 'numeric') {
    const unit = String(q.unit || '').trim().slice(0, 16);
    return {
      id: q.id && typeof q.id === 'string' ? q.id : nanoid(8),
      text,
      type,
      options: [],
      unit,
      timeLimit,
      imageUrl,
      doublePoints,
    };
  }

  const options = Array.isArray(q.options)
    ? q.options.map((o) => String(o || '').trim()).filter((o) => o.length > 0)
    : [];
  if (options.length < 2 || options.length > MAX_OPTIONS) {
    throw new Error(`Her sorunun 2 ile ${MAX_OPTIONS} arasinda secenegi olmalidir.`);
  }
  return {
    id: q.id && typeof q.id === 'string' ? q.id : nanoid(8),
    text,
    type,
    options,
    timeLimit,
    imageUrl,
    doublePoints,
  };
}

function sanitizeQuiz(input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Quiz basligi bos olamaz.');
  const questionsRaw = Array.isArray(input.questions) ? input.questions : [];
  if (questionsRaw.length < 1) throw new Error('En az bir soru eklemelisiniz.');
  const questions = questionsRaw.map(sanitizeQuestion);
  const correctPhotoUrl = sanitizeImageField(input.correctPhotoUrl, 'Dogru cevap fotografi');
  const wrongPhotoUrl = sanitizeImageField(input.wrongPhotoUrl, 'Yanlis cevap fotografi');
  return { title, questions, correctPhotoUrl, wrongPhotoUrl };
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function quizSummary(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    updatedAt: quiz.updatedAt,
  };
}

app.get('/api/quizzes', (req, res) => {
  const list = Object.values(quizzes)
    .map(quizSummary)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json(list);
});

app.get('/api/quizzes/:id', (req, res) => {
  const quiz = quizzes[req.params.id];
  if (!quiz) return res.status(404).json({ error: 'Quiz bulunamadi.' });
  res.json(quiz);
});

app.post('/api/quizzes', (req, res) => {
  try {
    const clean = sanitizeQuiz(req.body);
    const id = nanoid(10);
    const now = new Date().toISOString();
    const quiz = { id, ...clean, createdAt: now, updatedAt: now };
    quizzes[id] = quiz;
    saveQuizzes(quizzes);
    res.json(quiz);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/quizzes/:id', (req, res) => {
  const existing = quizzes[req.params.id];
  if (!existing) return res.status(404).json({ error: 'Quiz bulunamadi.' });
  try {
    const clean = sanitizeQuiz(req.body);
    const quiz = { ...existing, ...clean, updatedAt: new Date().toISOString() };
    quizzes[req.params.id] = quiz;
    saveQuizzes(quizzes);
    res.json(quiz);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/quizzes/:id', (req, res) => {
  if (!quizzes[req.params.id]) return res.status(404).json({ error: 'Quiz bulunamadi.' });
  delete quizzes[req.params.id];
  saveQuizzes(quizzes);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Oda (oyun oturumu) - sadece bellekte
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom(quiz) {
  let code;
  do {
    code = roomCodeGen();
  } while (rooms.has(code));

  const room = {
    code,
    quizId: quiz.id,
    quizTitle: quiz.title,
    // Sorularin ve seceneklerin DERIN kopyasi: oyun icinde (ozel cevap ekleme gibi)
    // yapilan degisiklikler kaydedilmis asil quiz'i etkilemesin.
    questions: quiz.questions.map((q) => ({ ...q, options: [...q.options] })),
    correctPhotoUrl: quiz.correctPhotoUrl || '',
    wrongPhotoUrl: quiz.wrongPhotoUrl || '',
    adminToken: nanoid(16),
    birthdayToken: nanoid(16),
    adminSocketId: null,
    status: 'lobby', // lobby | birthday_turn | question_open | question_results | finished
    questionIndex: -1,
    birthday: null, // { id, name, socketId, connected }
    players: new Map(), // id -> { id, name, socketId, connected, score, correctCount, lastResult }
    previousRanking: [], // onceki sorudaki siralamada oyuncu id dizisi
    currentQuestion: null, // { birthdayChoice, lockedAt, openAt, duration, answers: Map, timer }
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function currentQuestionData(room) {
  if (room.questionIndex < 0 || room.questionIndex >= room.questions.length) return null;
  return room.questions[room.questionIndex];
}

function activePlayers(room) {
  return Array.from(room.players.values());
}

function rankedPlayers(room) {
  return activePlayers(room)
    .slice()
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'tr'));
}

function leaderboardPayload(room, limit) {
  const ranked = rankedPlayers(room);
  const withDelta = ranked.map((p, i) => {
    const prevIndex = room.previousRanking.indexOf(p.id);
    const prevRank = prevIndex === -1 ? null : prevIndex + 1;
    const rank = i + 1;
    return {
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      rank,
      rankDelta: prevRank === null ? 0 : prevRank - rank, // pozitif = yukari cikti
    };
  });
  return typeof limit === 'number' ? withDelta.slice(0, limit) : withDelta;
}

// Final unvanlari: podyum (ilk 3) disinda, oyun boyunca verilen cevaplara
// gore eglenceli rozetler. Her biri yoksa (yeterli oyuncu/aday yoksa) atlanir.
function computeBadges(room) {
  const badges = [];
  const ranked = rankedPlayers(room);
  const totalQuestions = room.questions.length;

  // En Hizli Parmaklar: dogru cevaplarinin ortalama suresi en kisa olan.
  let fastest = null;
  let fastestAvg = Infinity;
  for (const p of ranked) {
    if ((p.correctCount || 0) > 0) {
      const avg = p.correctResponseMsSum / p.correctCount;
      if (avg < fastestAvg) {
        fastestAvg = avg;
        fastest = p;
      }
    }
  }
  if (fastest) badges.push({ emoji: '⚡', title: 'En Hizli Parmaklar', name: fastest.name });

  // Kahin Gozu: podyuma giremeyen (4. siradan asagisi) ama en cok dogru bilen.
  if (ranked.length > 3) {
    let kahin = null;
    let kahinCount = 0;
    for (const p of ranked.slice(3)) {
      if ((p.correctCount || 0) > kahinCount) {
        kahinCount = p.correctCount;
        kahin = p;
      }
    }
    if (kahin && kahinCount > 0) badges.push({ emoji: '🎯', title: 'Kahin Gozu', name: kahin.name });
  }

  // Pes Etmeyen: hicbir soruyu atlamadan sonuna kadar cevap veren ama en az puanli.
  if (totalQuestions > 0) {
    const finishers = ranked.filter((p) => (p.answeredCount || 0) >= totalQuestions);
    if (finishers.length > 0) {
      const persistent = finishers
        .slice()
        .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'tr'))[0];
      badges.push({ emoji: '🐢', title: 'Pes Etmeyen', name: persistent.name });
    }
  }

  return badges;
}

// Bir sorunun her sikkini kac oyuncunun isaretledigini sayar (Kahoot tarzi
// sonuc sutun grafigi icin). optionCount uzunlugunda bir sayi dizisi doner.
function answerDistribution(room, optionCount) {
  const counts = new Array(optionCount).fill(0);
  if (!room.currentQuestion) return counts;
  for (const ans of room.currentQuestion.answers.values()) {
    if (ans.choiceIndex >= 0 && ans.choiceIndex < optionCount) counts[ans.choiceIndex] += 1;
  }
  return counts;
}

// Sayi tahmini sorularinda, kim hangi sayiyi yazmis ve gercek sayiya ne kadar
// yakinmis listesini (en yakindan en uzaga dogru siralanmis) dondurur.
function numericGuessesPayload(room) {
  if (!room.currentQuestion || room.currentQuestion.birthdayValue === null) return [];
  const correctValue = room.currentQuestion.birthdayValue;
  const list = [];
  for (const [playerId, ans] of room.currentQuestion.answers.entries()) {
    const player = room.players.get(playerId);
    if (!player) continue;
    list.push({ name: player.name, value: ans.value, distance: Math.abs(ans.value - correctValue) });
  }
  list.sort((a, b) => a.distance - b.distance);
  return list;
}

// Siralama sorularinda, kim hangi sirayi yazmis ve gercek siraya ne kadar
// yakinmis listesini (en yakindan en uzaga dogru siralanmis) dondurur.
function rankingGuessesPayload(room) {
  if (!room.currentQuestion || !room.currentQuestion.birthdayOrder) return [];
  const correctOrder = room.currentQuestion.birthdayOrder;
  const list = [];
  for (const [playerId, ans] of room.currentQuestion.answers.entries()) {
    const player = room.players.get(playerId);
    if (!player) continue;
    list.push({ name: player.name, order: ans.order.slice(), distance: rankingDistance(correctOrder, ans.order) });
  }
  list.sort((a, b) => a.distance - b.distance);
  return list;
}

function computePoints(answeredAt, openAt, durationSeconds, doublePoints) {
  const elapsedMs = Math.max(0, answeredAt - openAt);
  const durationMs = durationSeconds * 1000;
  const ratio = Math.min(1, elapsedMs / durationMs);
  const base = Math.round(1000 - ratio * 500); // anlik dogru cevap: 1000, sure sonunda dogru cevap: 500
  return doublePoints ? base * 2 : base;
}

function clearQuestionTimer(room) {
  if (room.currentQuestion && room.currentQuestion.timer) {
    clearTimeout(room.currentQuestion.timer);
    room.currentQuestion.timer = null;
  }
}

function startQuestion(room) {
  room.questionIndex += 1;
  if (room.questionIndex >= room.questions.length) {
    finishGame(room);
    return;
  }
  room.currentQuestion = {
    birthdayChoice: null,
    birthdayValue: null, // sayi tahmini sorularinda dogum gunu sahibinin yazdigi gercek sayi
    birthdayOrder: null, // siralama sorularinda dogum gunu sahibinin belirledigi gercek sira (orijinal indekslerin permutasyonu)
    lockedAt: null,
    openAt: null,
    duration: currentQuestionData(room).timeLimit,
    doublePoints: !!currentQuestionData(room).doublePoints,
    answers: new Map(), // playerId -> { choiceIndex, answeredAt } veya { value, answeredAt } veya { order, answeredAt }
    timer: null,
  };
  room.status = 'birthday_turn';
  syncRoom(room);
}

function openQuestionForAnswers(room) {
  room.currentQuestion.lockedAt = Date.now();
  room.currentQuestion.openAt = Date.now();
  room.status = 'question_open';

  const durationMs = room.currentQuestion.duration * 1000;
  room.currentQuestion.timer = setTimeout(() => {
    finalizeQuestion(room);
  }, durationMs);

  syncRoom(room);
}

function lockWithIndex(room, choiceIndex) {
  room.currentQuestion.birthdayChoice = choiceIndex;
  openQuestionForAnswers(room);
}

function lockBirthdayAnswer(room, choiceIndex) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'birthday_turn' || q.type !== 'choice') return;
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= q.options.length) return;
  lockWithIndex(room, choiceIndex);
}

// Dogum gunu sahibi, hazirlanmis siklarda dogru cevabi bulamazsa kendi
// metnini yeni bir sik olarak ekleyip onu dogru cevap olarak kilitleyebilir.
function lockBirthdayCustomAnswer(room, socket, text) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'birthday_turn' || q.type !== 'choice') return;
  const clean = String(text || '').trim().slice(0, 80);
  if (!clean) return err(socket, 'Lutfen bir cevap metni yaz.');
  if (q.options.length >= MAX_OPTIONS_LIVE) {
    return err(socket, 'Bu soruya daha fazla sik eklenemez.');
  }
  q.options.push(clean);
  lockWithIndex(room, q.options.length - 1);
}

// Sayi tahmini sorularinda dogum gunu sahibi, hazirlanmis siklar yerine
// gercek/dogru sayiyi kendisi canli olarak yazar.
function lockBirthdayNumeric(room, socket, rawValue) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'birthday_turn' || q.type !== 'numeric') return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return err(socket, 'Lutfen gecerli bir sayi gir.');
  room.currentQuestion.birthdayValue = value;
  openQuestionForAnswers(room);
}

// order, 0..n-1 degerlerinin tekrarsiz bir permutasyonu mu diye kontrol eder
// (siralama sorularinda hem dogum gunu sahibinin hem oyuncularin gonderdigi sira icin kullanilir).
function isValidPermutation(order, n) {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set();
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

// Siralama sorularinda dogum gunu sahibi, secenekleri gercek/dogru siraya
// kendisi canli olarak dizer (order: orijinal secenek indekslerinin, ilk siradan
// son siraya dogru permutasyonu).
function lockBirthdayRanking(room, socket, order) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'birthday_turn' || q.type !== 'ranking') return;
  if (!isValidPermutation(order, q.options.length)) return err(socket, 'Gecersiz siralama.');
  room.currentQuestion.birthdayOrder = order.slice();
  openQuestionForAnswers(room);
}

function submitPlayerAnswer(room, playerId, choiceIndex) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'question_open' || q.type !== 'choice') return;
  const player = room.players.get(playerId);
  if (!player) return;
  if (room.currentQuestion.answers.has(playerId)) return; // ayni cevap iki kez islenemez
  if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= q.options.length) return;

  const now = Date.now();
  const deadline = room.currentQuestion.openAt + room.currentQuestion.duration * 1000;
  if (now > deadline) return; // sure dolduktan sonra gelen cevap kabul edilmez

  room.currentQuestion.answers.set(playerId, { choiceIndex, answeredAt: now });
  player.answeredCount = (player.answeredCount || 0) + 1;
  syncRoom(room);

  const connectedPlayers = activePlayers(room).filter((p) => p.connected);
  if (connectedPlayers.length > 0 && connectedPlayers.every((p) => room.currentQuestion.answers.has(p.id))) {
    clearQuestionTimer(room);
    finalizeQuestion(room);
  }
}

// Sayi tahmini sorularinda oyuncunun tahmini sayiyi gondermesi.
function submitPlayerNumericAnswer(room, playerId, rawValue) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'question_open' || q.type !== 'numeric') return;
  const player = room.players.get(playerId);
  if (!player) return;
  if (room.currentQuestion.answers.has(playerId)) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;

  const now = Date.now();
  const deadline = room.currentQuestion.openAt + room.currentQuestion.duration * 1000;
  if (now > deadline) return;

  room.currentQuestion.answers.set(playerId, { value, answeredAt: now });
  player.answeredCount = (player.answeredCount || 0) + 1;
  syncRoom(room);

  const connectedPlayers = activePlayers(room).filter((p) => p.connected);
  if (connectedPlayers.length > 0 && connectedPlayers.every((p) => room.currentQuestion.answers.has(p.id))) {
    clearQuestionTimer(room);
    finalizeQuestion(room);
  }
}

// Siralama sorularinda oyuncunun tahmini sirayi gondermesi.
function submitPlayerRankingAnswer(room, playerId, order) {
  const q = currentQuestionData(room);
  if (!q || room.status !== 'question_open' || q.type !== 'ranking') return;
  const player = room.players.get(playerId);
  if (!player) return;
  if (room.currentQuestion.answers.has(playerId)) return;
  if (!isValidPermutation(order, q.options.length)) return;

  const now = Date.now();
  const deadline = room.currentQuestion.openAt + room.currentQuestion.duration * 1000;
  if (now > deadline) return;

  room.currentQuestion.answers.set(playerId, { order: order.slice(), answeredAt: now });
  player.answeredCount = (player.answeredCount || 0) + 1;
  syncRoom(room);

  const connectedPlayers = activePlayers(room).filter((p) => p.connected);
  if (connectedPlayers.length > 0 && connectedPlayers.every((p) => room.currentQuestion.answers.has(p.id))) {
    clearQuestionTimer(room);
    finalizeQuestion(room);
  }
}

function finalizeChoiceQuestion(room) {
  const correctIndex = room.currentQuestion.birthdayChoice;
  const { openAt, duration, answers, doublePoints } = room.currentQuestion;

  for (const player of room.players.values()) {
    const ans = answers.get(player.id);
    if (!ans) {
      player.lastResult = { choiceIndex: null, correct: false, points: 0 };
      continue;
    }
    const correct = ans.choiceIndex === correctIndex;
    const points = correct ? computePoints(ans.answeredAt, openAt, duration, doublePoints) : 0;
    player.score += points;
    if (correct) {
      player.correctCount = (player.correctCount || 0) + 1;
      player.correctResponseMsSum = (player.correctResponseMsSum || 0) + Math.max(0, ans.answeredAt - openAt);
    }
    player.lastResult = { choiceIndex: ans.choiceIndex, correct, points };
  }
}

// Sayi tahmini puanlamasi: en yakin tahmin en yuksek puani alir, uzaklik
// arttikca puan azalir; esit uzaklikta hizli cevaplayan one gecer (sira ona gore belirlenir).
function finalizeNumericQuestion(room) {
  const correctValue = room.currentQuestion.birthdayValue;
  const { answers, doublePoints } = room.currentQuestion;

  const answered = Array.from(answers.entries()).map(([playerId, ans]) => ({
    playerId,
    value: ans.value,
    distance: Math.abs(ans.value - correctValue),
    answeredAt: ans.answeredAt,
  }));
  answered.sort((a, b) => a.distance - b.distance || a.answeredAt - b.answeredAt);

  const n = answered.length;
  const answeredIds = new Set();
  answered.forEach((a, i) => {
    answeredIds.add(a.playerId);
    const player = room.players.get(a.playerId);
    if (!player) return;
    const ratio = n > 1 ? i / (n - 1) : 0;
    let points = Math.round(1000 - ratio * 500);
    if (doublePoints) points *= 2;
    player.score += points;
    const exact = a.distance === 0;
    if (exact) {
      player.correctCount = (player.correctCount || 0) + 1;
      player.correctResponseMsSum = (player.correctResponseMsSum || 0) + Math.max(0, a.answeredAt - room.currentQuestion.openAt);
    }
    player.lastResult = { value: a.value, distance: a.distance, rank: i + 1, correct: exact, points };
  });

  for (const player of room.players.values()) {
    if (!answeredIds.has(player.id)) {
      player.lastResult = { value: null, distance: null, rank: null, correct: false, points: 0 };
    }
  }
}

// order (orijinal indekslerin ilk siradan son siraya permutasyonu) icin,
// her orijinal indeksin hangi pozisyonda oldugunu veren tersini hesaplar.
function positionMap(order) {
  const pos = new Array(order.length);
  order.forEach((origIdx, i) => { pos[origIdx] = i; });
  return pos;
}

function rankingDistance(correctOrder, guessOrder) {
  const truePos = positionMap(correctOrder);
  const guessPos = positionMap(guessOrder);
  let distance = 0;
  for (let i = 0; i < truePos.length; i++) distance += Math.abs(truePos[i] - guessPos[i]);
  return distance;
}

// Siralama puanlamasi: siralama farki (pozisyon farklarinin toplami) en kucuk
// olan en yuksek puani alir, fark arttikca puan azalir; esitlikte hizli cevaplayan one gecer.
function finalizeRankingQuestion(room) {
  const correctOrder = room.currentQuestion.birthdayOrder;
  const { answers, doublePoints } = room.currentQuestion;

  const answered = Array.from(answers.entries()).map(([playerId, ans]) => ({
    playerId,
    order: ans.order,
    distance: rankingDistance(correctOrder, ans.order),
    answeredAt: ans.answeredAt,
  }));
  answered.sort((a, b) => a.distance - b.distance || a.answeredAt - b.answeredAt);

  const n = answered.length;
  const answeredIds = new Set();
  answered.forEach((a, i) => {
    answeredIds.add(a.playerId);
    const player = room.players.get(a.playerId);
    if (!player) return;
    const ratio = n > 1 ? i / (n - 1) : 0;
    let points = Math.round(1000 - ratio * 500);
    if (doublePoints) points *= 2;
    player.score += points;
    const exact = a.distance === 0;
    if (exact) {
      player.correctCount = (player.correctCount || 0) + 1;
      player.correctResponseMsSum = (player.correctResponseMsSum || 0) + Math.max(0, a.answeredAt - room.currentQuestion.openAt);
    }
    player.lastResult = { order: a.order, distance: a.distance, rank: i + 1, correct: exact, points };
  });

  for (const player of room.players.values()) {
    if (!answeredIds.has(player.id)) {
      player.lastResult = { order: null, distance: null, rank: null, correct: false, points: 0 };
    }
  }
}

function finalizeQuestion(room) {
  if (room.status !== 'question_open') return;
  clearQuestionTimer(room);
  room.previousRanking = rankedPlayers(room).map((p) => p.id);

  const q = currentQuestionData(room);
  if (q.type === 'numeric') {
    finalizeNumericQuestion(room);
  } else if (q.type === 'ranking') {
    finalizeRankingQuestion(room);
  } else {
    finalizeChoiceQuestion(room);
  }

  room.status = 'question_results';
  syncRoom(room);
}

function finishGame(room) {
  clearQuestionTimer(room);
  room.status = 'finished';
  room.currentQuestion = null;
  syncRoom(room);
}

// ---------------------------------------------------------------------------
// Durum senkronizasyonu (her role'e uygun veri)
// ---------------------------------------------------------------------------

function baseState(room) {
  return {
    code: room.code,
    title: room.quizTitle,
    status: room.status,
    questionIndex: room.questionIndex,
    totalQuestions: room.questions.length,
    birthdayName: room.birthday ? room.birthday.name : null,
    birthdayConnected: room.birthday ? room.birthday.connected : false,
    playerCount: room.players.size,
  };
}

function stateForAdmin(room) {
  const state = baseState(room);
  state.role = 'admin';
  state.birthdayToken = room.birthdayToken;
  state.players = activePlayers(room)
    .map((p) => ({ id: p.id, name: p.name, connected: p.connected, score: p.score }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  state.answeredCount = room.currentQuestion ? room.currentQuestion.answers.size : 0;

  if (room.status === 'question_open' || room.status === 'question_results') {
    const q = currentQuestionData(room);
    state.question = {
      text: q.text,
      type: q.type,
      unit: q.unit || '',
      options: q.options,
      imageUrl: q.imageUrl,
      duration: q.timeLimit,
      openAt: room.currentQuestion.openAt,
      doublePoints: q.doublePoints,
    };
  }
  if (room.status === 'question_results') {
    if (state.question.type === 'numeric') {
      state.question.correctValue = room.currentQuestion.birthdayValue;
      state.question.guesses = numericGuessesPayload(room);
    } else if (state.question.type === 'ranking') {
      state.question.correctOrder = room.currentQuestion.birthdayOrder;
      state.question.guesses = rankingGuessesPayload(room);
    } else {
      state.question.correctIndex = room.currentQuestion.birthdayChoice;
      state.question.distribution = answerDistribution(room, state.question.options.length);
    }
    state.leaderboard = leaderboardPayload(room);
  }
  if (room.status === 'finished') {
    state.leaderboard = leaderboardPayload(room);
    state.badges = computeBadges(room);
  }
  return state;
}

function stateForBirthday(room) {
  const state = baseState(room);
  state.role = 'birthday';
  const q = currentQuestionData(room);

  if (room.status === 'birthday_turn' && q) {
    state.question = { text: q.text, type: q.type, unit: q.unit || '', options: q.options, imageUrl: q.imageUrl, doublePoints: q.doublePoints };
    state.locked = false;
  } else if (room.status === 'question_open' && q) {
    state.question = { text: q.text, type: q.type, unit: q.unit || '', options: q.options, imageUrl: q.imageUrl, doublePoints: q.doublePoints };
    state.locked = true;
    state.myChoice = room.currentQuestion.birthdayChoice;
    state.myValue = room.currentQuestion.birthdayValue;
    state.answeredCount = room.currentQuestion.answers.size;
    state.playerTotal = activePlayers(room).filter((p) => p.connected).length;
  } else if (room.status === 'question_results' && q) {
    state.question = { text: q.text, type: q.type, unit: q.unit || '', options: q.options, imageUrl: q.imageUrl, doublePoints: q.doublePoints };
    if (q.type === 'numeric') {
      state.question.correctValue = room.currentQuestion.birthdayValue;
      state.question.guesses = numericGuessesPayload(room);
    } else if (q.type === 'ranking') {
      state.question.correctOrder = room.currentQuestion.birthdayOrder;
      state.question.guesses = rankingGuessesPayload(room);
    } else {
      state.question.correctIndex = room.currentQuestion.birthdayChoice;
      state.question.distribution = answerDistribution(room, q.options.length);
    }
    state.myChoice = room.currentQuestion.birthdayChoice;
    state.myValue = room.currentQuestion.birthdayValue;
    const correctCount = Array.from(room.players.values()).filter((p) => p.lastResult && p.lastResult.correct).length;
    state.correctGuessers = correctCount;
    state.leaderboard = leaderboardPayload(room, 5);
  } else if (room.status === 'finished') {
    state.leaderboard = leaderboardPayload(room);
    state.badges = computeBadges(room);
  }
  return state;
}

function stateForPlayer(room, playerId) {
  const state = baseState(room);
  state.role = 'player';
  const player = room.players.get(playerId);
  const q = currentQuestionData(room);

  if (room.status === 'birthday_turn') {
    // Soru henuz doğum günü sahibi tarafindan cevaplanmadi: oyuncular soruyu goremez.
  } else if (room.status === 'question_open' && q) {
    const already = room.currentQuestion.answers.get(playerId);
    state.question = {
      text: q.text,
      type: q.type,
      unit: q.unit || '',
      options: q.options,
      imageUrl: q.imageUrl,
      duration: q.timeLimit,
      openAt: room.currentQuestion.openAt,
      doublePoints: q.doublePoints,
    };
    state.hasAnswered = !!already;
    state.myChoice = already ? already.choiceIndex : null;
    state.myValue = already ? already.value : null;
    state.myOrder = already ? already.order : null;
  } else if (room.status === 'question_results' && q) {
    state.question = { text: q.text, type: q.type, unit: q.unit || '', options: q.options, imageUrl: q.imageUrl, doublePoints: q.doublePoints };
    if (q.type === 'numeric') {
      state.question.correctValue = room.currentQuestion.birthdayValue;
      state.question.guesses = numericGuessesPayload(room);
    } else if (q.type === 'ranking') {
      state.question.correctOrder = room.currentQuestion.birthdayOrder;
      state.question.guesses = rankingGuessesPayload(room);
    } else {
      state.question.correctIndex = room.currentQuestion.birthdayChoice;
      state.question.distribution = answerDistribution(room, q.options.length);
    }
    state.myResult = player ? player.lastResult : null;
    state.myScore = player ? player.score : 0;
    state.leaderboard = leaderboardPayload(room, 5);
    if (player && player.lastResult) {
      const won = (q.type === 'numeric' || q.type === 'ranking') ? player.lastResult.rank === 1 : player.lastResult.correct;
      state.resultPhotoUrl = won ? room.correctPhotoUrl : room.wrongPhotoUrl;
    }
  } else if (room.status === 'finished') {
    state.leaderboard = leaderboardPayload(room);
    state.myScore = player ? player.score : 0;
    state.myCorrectCount = player ? player.correctCount || 0 : 0;
    state.badges = computeBadges(room);
  }
  return state;
}

function syncRoom(room) {
  if (room.adminSocketId) {
    io.to(room.adminSocketId).emit('sync', stateForAdmin(room));
  }
  if (room.birthday && room.birthday.connected) {
    io.to(room.birthday.socketId).emit('sync', stateForBirthday(room));
  }
  for (const player of room.players.values()) {
    if (player.connected) {
      io.to(player.socketId).emit('sync', stateForPlayer(room, player.id));
    }
  }
}

function syncOne(socket) {
  const { code, role, playerId } = socket.data;
  const room = rooms.get(code);
  if (!room) return;
  if (role === 'admin') socket.emit('sync', stateForAdmin(room));
  else if (role === 'birthday') socket.emit('sync', stateForBirthday(room));
  else if (role === 'player') socket.emit('sync', stateForPlayer(room, playerId));
}

// ---------------------------------------------------------------------------
// HTTP: oda olusturma (REST) - gercek zamanli olmayan tek islem
// ---------------------------------------------------------------------------

app.post('/api/rooms', (req, res) => {
  const quiz = quizzes[req.body.quizId];
  if (!quiz) return res.status(404).json({ error: 'Quiz bulunamadi.' });
  if (!quiz.questions || quiz.questions.length < 1) {
    return res.status(400).json({ error: 'Quiz en az bir soru icermeli.' });
  }
  const room = createRoom(quiz);
  res.json({ code: room.code, adminToken: room.adminToken, birthdayToken: room.birthdayToken });
});

// Basit varlik kontrolu (katilma ekrani oda var mi diye sorar)
app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'Oda bulunamadi.' });
  res.json({
    code: room.code,
    title: room.quizTitle,
    status: room.status,
    birthdayTaken: !!room.birthday,
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 20e6 });

function err(socket, message) {
  socket.emit('errorMsg', { message });
}

io.on('connection', (socket) => {
  socket.data = {};

  // --- Yonetici (admin) ---
  socket.on('admin:join', ({ code, token }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return err(socket, 'Oda bulunamadi.');
    if (room.adminToken !== token) return err(socket, 'Gecersiz yonetici anahtari.');
    room.adminSocketId = socket.id;
    socket.join(room.code);
    socket.data = { code: room.code, role: 'admin' };
    syncOne(socket);
  });

  socket.on('admin:start', () => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    if (!room.birthday) return err(socket, 'Once dogum gunu sahibinin katilmasi gerekiyor.');
    if (room.status !== 'lobby') return;
    startQuestion(room);
  });

  socket.on('admin:next', () => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    if (room.status !== 'question_results') return;
    startQuestion(room);
  });

  socket.on('admin:end', () => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    finishGame(room);
  });

  socket.on('admin:cancelRoom', () => {
    const room = roomOf(socket, 'admin');
    if (!room) return;
    if (room.status !== 'lobby') return; // sadece oyun baslamadan once iptal edilebilir
    clearQuestionTimer(room);
    io.to(room.code).emit('roomCancelled');
    rooms.delete(room.code);
  });

  // --- Dogum gunu sahibi ---
  socket.on('birthday:join', ({ code, token, name, savedId }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return err(socket, 'Oda bulunamadi.');
    if (room.birthdayToken !== token) return err(socket, 'Gecersiz davet baglantisi.');

    if (room.birthday && room.birthday.id !== savedId) {
      return err(socket, 'Dogum gunu sahibi rolu zaten baska biri tarafindan alindi.');
    }

    if (room.birthday) {
      room.birthday.socketId = socket.id;
      room.birthday.connected = true;
    } else {
      const cleanName = String(name || 'Dogum gunu cocugu').trim().slice(0, 30) || 'Dogum gunu cocugu';
      room.birthday = { id: savedId || nanoid(10), name: cleanName, socketId: socket.id, connected: true };
    }
    socket.join(room.code);
    socket.data = { code: room.code, role: 'birthday' };
    socket.emit('joined', { id: room.birthday.id });
    syncRoom(room);
  });

  socket.on('birthday:lock', ({ choiceIndex }) => {
    const room = roomOf(socket, 'birthday');
    if (!room) return;
    lockBirthdayAnswer(room, choiceIndex);
  });

  socket.on('birthday:lockCustom', ({ text }) => {
    const room = roomOf(socket, 'birthday');
    if (!room) return;
    lockBirthdayCustomAnswer(room, socket, text);
  });

  socket.on('birthday:lockNumeric', ({ value }) => {
    const room = roomOf(socket, 'birthday');
    if (!room) return;
    lockBirthdayNumeric(room, socket, value);
  });

  socket.on('birthday:lockRanking', ({ order }) => {
    const room = roomOf(socket, 'birthday');
    if (!room) return;
    lockBirthdayRanking(room, socket, order);
  });

  // --- Normal oyuncular ---
  socket.on('player:join', ({ code, name, savedId }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return err(socket, 'Oda bulunamadi.');

    let player = savedId ? room.players.get(savedId) : null;
    if (!player) {
      const cleanName = String(name || '').trim().slice(0, 24);
      if (!cleanName) return err(socket, 'Lutfen bir isim gir.');
      const id = nanoid(10);
      player = { id, name: cleanName, socketId: socket.id, connected: true, score: 0, correctCount: 0, answeredCount: 0, correctResponseMsSum: 0, lastResult: null };
      room.players.set(id, player);
    } else {
      player.socketId = socket.id;
      player.connected = true;
    }
    socket.join(room.code);
    socket.data = { code: room.code, role: 'player', playerId: player.id };
    socket.emit('joined', { id: player.id });
    syncRoom(room);
  });

  socket.on('player:answer', ({ choiceIndex }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    submitPlayerAnswer(room, socket.data.playerId, choiceIndex);
  });

  socket.on('player:answerNumeric', ({ value }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    submitPlayerNumericAnswer(room, socket.data.playerId, value);
  });

  socket.on('player:answerRanking', ({ order }) => {
    const room = roomOf(socket, 'player');
    if (!room) return;
    submitPlayerRankingAnswer(room, socket.data.playerId, order);
  });

  socket.on('resync', () => syncOne(socket));

  socket.on('disconnect', () => {
    const { code, role, playerId } = socket.data || {};
    const room = rooms.get(code);
    if (!room) return;
    if (role === 'admin' && room.adminSocketId === socket.id) {
      room.adminSocketId = null;
    } else if (role === 'birthday' && room.birthday && room.birthday.socketId === socket.id) {
      room.birthday.connected = false;
      syncRoom(room);
    } else if (role === 'player') {
      const player = room.players.get(playerId);
      if (player && player.socketId === socket.id) {
        player.connected = false;
        syncRoom(room);
      }
    }
  });
});

function roomOf(socket, expectedRole) {
  const { code, role } = socket.data || {};
  if (!code || role !== expectedRole) return null;
  return rooms.get(code) || null;
}

server.listen(PORT, () => {
  console.log(`Dogum gunu quiz sunucusu http://localhost:${PORT} adresinde calisiyor`);
});
