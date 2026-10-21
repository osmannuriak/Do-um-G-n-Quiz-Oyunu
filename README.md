# 🎂 Doğum Günü Quiz

Kahoot benzeri, gerçek zamanlı doğum günü quiz oyunu. Farkı: soruların doğru
cevabını **doğum günü sahibi oyun sırasında anlık olarak** belirliyor; diğer
oyuncular tahmin ediyor, hızlı ve doğru tahmin eden daha çok puan kazanıyor.

## Nasıl çalışıyor (3 rol)

- **Yönetici**: Quiz hazırlar, soruları ekler, oda kurar, oyunu başlatıp
  sırasıyla ilerletir. Doğru cevapları o belirlemez.
- **Doğum günü sahibi**: Sadece kendisine gönderilen özel bağlantıyla girer.
  Her soruyu önce tek başına görür, kendince doğru olan şıkkı seçer. Seçimi
  kilitlenince soru diğer herkese açılır.
- **Oyuncular**: Oda kodu/bağlantısıyla telefonlarından katılır, süre içinde
  tahmin eder. Hızlı + doğru tahmin daha çok puan kazandırır.

## Teknik yapı (neden bu kadar basit)

- **Node.js + Express + Socket.IO** — tek sunucu, tek process, gerçek zamanlı
  iletişim için harici bir servise (Supabase vb.) ihtiyaç yok.
- **Veri saklama**: Quiz'ler `data/quizzes.json` dosyasında kalıcı tutulur.
  Devam eden oyun odaları ise sadece bellekte tutulur (bir parti/davet için
  zaten yeterli; sunucu yeniden başlarsa quiz'ler kaybolmaz, o an açık olan
  oyun sıfırlanır).
- **Arayüz**: Tek sayfa, saf HTML/CSS/JavaScript — derleme (build) adımı yok,
  bu yüzden her yere kolay deploy edilir.

## Yerelde çalıştırma

```bash
npm install
npm start
```

Sonra tarayıcıda `http://localhost:3000` adresini aç. Aynı Wi-Fi'deki başka
telefonlardan katılmak için bilgisayarının yerel ağ IP'sini kullan (örn.
`http://192.168.1.23:3000`).

## Oyun nasıl kurulur

1. Ana sayfadan **"Quiz Oluştur / Yönet"** → **"Yeni Quiz"**.
2. Başlık yaz, soruları ekle (metin, 2-4 şık, isteğe bağlı görsel URL'si,
   cevap süresi). Doğru cevabı burada seçmiyorsun.
3. Quiz'i kaydet, listeden **"Oda Kur"** butonuna bas.
4. Açılan odada iki bağlantı görürsün:
   - **Oyuncu bağlantısı** → herkesle paylaş (WhatsApp grubu vb.).
   - **Doğum günü çocuğu bağlantısı** → SADECE doğum günü sahibine gönder.
5. Herkes katılınca **"Oyunu Başlat"**a bas. Her sorudan sonra
   **"Sonraki Soru"** ile devam et.

## 🌍 Herkesin telefonundan online oynanabilmesi için (deploy)

Bu uygulama şu an senin bilgisayarında/bu ortamda çalışıyor — arkadaşların
farklı yerlerden (aynı Wi-Fi'de olmadan) katılabilsin diye küçük, ücretsiz
bir sunucuya yüklemen gerekiyor. En kolay ve WebSocket'i (gerçek zamanlı
bağlantı) sorunsuz destekleyen seçenek **Render.com**:

1. Bu proje klasörünü bir GitHub reposuna yükle (veya Render'ın "upload"
   seçeneğini kullan).
2. [render.com](https://render.com) üzerinde ücretsiz hesap aç, **"New +" →
   "Web Service"** de, reponu seç.
3. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Deploy edince Render sana `https://senin-projen.onrender.com` gibi bir
   adres verir. Bu adresi tarayıcıda açtığında uygulama çalışır; bu adres
   üzerinden oluşturduğun oda bağlantıları artık herkesin telefonunda (iOS,
   Android, fark etmeksizin) tarayıcıdan açılır.

   > Not: Render'ın ücretsiz planında sunucu bir süre kullanılmazsa uykuya
   > geçer ve ilk istekte birkaç saniye "uyanma" süresi olabilir. Partiden
   > 5-10 dakika önce siteyi bir kere açıp uyandırman yeterli.

   > Veri kalıcılığı notu: Ücretsiz planda disk kalıcı değildir, yani
   > `data/quizzes.json` sunucu yeniden deploy edildiğinde sıfırlanabilir.
   > Parti günü quiz'i baştan girmek istemiyorsan, Render'da küçük bir
   > "Persistent Disk" eklemen ya da parti öncesi quiz'i hazır tutman yeterli.

Alternatifler (aynı mantıkla çalışır, hepsi Node.js + WebSocket destekler):
**Railway.app**, **Fly.io**, **Glitch.com**. Hepsinde adım aynı: repoyu bağla,
`npm install` ile kur, `npm start` ile çalıştır.

## Proje yapısı

```
server.js              → Express + Socket.IO sunucusu, tüm oyun mantığı
public/
  index.html
  css/style.css        → mobil öncelikli, doğum günü temalı arayüz
  js/app.js             → istemci (tüm ekranlar, socket olayları)
data/quizzes.json       → kaydedilen quiz'ler (otomatik oluşur)
.env.example            → kullanılabilecek tek değişken: PORT
```

## Uygulanan güvenlik/doğruluk kuralları

- Doğum günü sahibi cevap vermeden oyuncular soruyu göremez.
- Doğru cevap, sonuç ekranına kadar hiçbir oyuncuya gönderilmez (sunucu
  taraflı gizleme — tarayıcı konsolundan bile görünmez).
- Puanlama ve süre kontrolü tamamen sunucu tarafında hesaplanır.
- Her oyuncu bir soruya yalnızca bir kez cevap verebilir.
- Doğum günü sahibi rolü özel bağlantı/anahtar ile korunur; aynı rolü başka
  biri çalamaz.
- Sayfa yenilenince oyuncu/doğum günü sahibi/yönetici kaldığı yerden devam
  eder (localStorage ile kimlik hatırlanır).

