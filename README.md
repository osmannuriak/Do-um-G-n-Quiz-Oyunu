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
- **Veri saklama**: Quiz'ler sunucuda **saklanmaz**; hazırlayanın
  tarayıcısında (IndexedDB) durur ve her değişiklik otomatik kaydedilir.
  Oda kurulurken quiz (görseller dahil) sunucuya gönderilir. Sunucu yeniden
  başlasa bile quiz kaybolmaz; oyun sırasında yeniden başlarsa yöneticinin
  tarayıcısı odayı aynı kodla ve son puanlarla geri kurar, herkes otomatik
  yeniden bağlanır. Biten/hareketsiz odalar bellekten temizlenir.
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
2. Başlık yaz, soruları ekle (metin, 2-6 şık / sayı / sıralama, isteğe bağlı
   görsel, cevap süresi). Doğru cevabı burada seçmiyorsun. Her şey otomatik
   olarak bu tarayıcıya kaydedilir; yedek için **"Quizi İndir"**, başka
   cihazda açmak için **"Quizi Yükle"** kullan.
3. Listeden **"Oda Kur"** butonuna bas (quizi hazırladığın cihazdan).
4. Açılan odada iki bağlantı görürsün:
   - **Oyuncu bağlantısı** → herkesle paylaş (WhatsApp grubu vb.).
   - **Doğum günü çocuğu bağlantısı** → SADECE doğum günü sahibine gönder.
5. Herkes katılınca **"Oyunu Başlat"**a bas. Her soru şöyle ilerler:
   1. Yönetici yeni soruya geçer → soru önce doğum günü çocuğuna gelir.
   2. Doğum günü çocuğu cevaplayınca soru herkese **otomatik** açılır, süre başlar.
   3. Süre bitince ya da herkes cevaplayınca **otomatik** sonuç ekranı: doğru/yanlış
      görseli + o sorudan alınan puan + güncel sıralama.
   4. Yönetici → doğru cevap ekranı. 5. Yönetici → ilk 5. 6. Yönetici → sonraki soru.
   Son soruda ilk 5 gösterilmez (sürpriz kaçmasın): doğru cevap ekranından
   direkt podyuma (ilk 3) geçilir → yönetici geçince rozetler → tüm sıralama.

   Rozetler (herkes kazanabilir, eşitlikte hepsine verilir): 🚀 Yükselen Yıldız,
   🦄 Kendi Yolunda, 🐢 Acele Etmeyen, 💖 Gönüllerin Şampiyonu.

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

   > Veri kalıcılığı: Ücretsiz planda disk kalıcı değildir; bu yüzden
   > quiz'ler sunucuda değil, hazırlayanın tarayıcısında tutulur.

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

## Puanlama (soru başına tam sayı)

Cevap süresi sunucuda, soru açıldığı andan milisaniye hassasiyetle ölçülür
(t = cevap süresi, T = soru süresi); her sorudan alınan puan en yakın tam
sayıya yuvarlanır. Toplam puan eşitse toplam cevap süresi
kısa olan üstte olur. Cevap vermeyen 0 puan alır; çift puanlı sorularda 2x.

- **Çoktan seçmeli:** doğruysa `1000 × (1 − 0,5 × t/T)`, yanlışsa 0.
- **Sayı tahmini:** `A = max(0, 1 − |tahmin − doğru| / max(|doğru|, 1))`,
  puan `1000 × A × (0,75 + 0,25 × (1 − t/T))`.
- **Sıralama:** `A = 1 − ters sıralı çift / toplam çift` (Kendall tau),
  puan `1000 × A × (0,75 + 0,25 × (1 − t/T))`. Sıralama kutuları
  sürükle-bırak ile (telefonda dokunarak) dizilir.

## Ek özellikler

- Soru görselleri ve sonuç görselleri (doğru/yanlış için 3'er tane) doğrudan
  cihazdan seçilir; tarayıcıda küçültülüp (max 800px, WebP/JPEG) kaydedilir.
  Oyunda görseller socket üzerinden değil, önbelleğe alınabilir URL ile sunulur
  ve önceden yüklenir. Her sonuçta ilgili gruptan eşit olasılıkla rastgele biri
  gösterilir.
- Şıklar her soruda rastgele karıştırılır (Fisher-Yates); doğru cevap şık
  kimliğiyle takip edilir.
- Sesler: son 5 saniyede tik-tak, doğruda kısa başarı, yanlış/sürede kısa
  başarısızlık sesi (Web Audio ile üretilir, dosya indirmez, üst üste binmez).
- Ekran geçişleri kısa CSS (transform/opacity) animasyonlarıyla yapılır.
- Soru süresi 10 ile 60 saniye arasında 5'er saniyelik adımlarla seçilebilir.
- Her soruda 2 ile 6 arasında şık olabilir.
- Lobide, oyun başlamadan önce oda tamamen iptal edilebilir (herkes
  bilgilendirilir).
- Doğum günü sahibi, hazırlanmış şıklarda doğru cevabı bulamazsa canlı
  olarak kendi cevabını yeni bir şık şeklinde ekleyip kilitleyebilir (bu,
  sadece o oda/oyun için geçerlidir, kayıtlı quiz'i değiştirmez).
- Her sorudan sonra doğum günü sahibinin ekranında da ilk 5 sıralaması
  gösterilir.

