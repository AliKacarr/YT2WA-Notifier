# YouTube → WhatsApp Botu

YouTube kanallarındaki yeni videoları takip eden ve seçilen WhatsApp gruplarına otomatik olarak anket veya mesaj gönderen Node.js uygulaması.

Web panelinden birden fazla kanal ekleyebilir; her kanal için hedef grup, gönderim biçimi ve çalışma saatlerini ayrı ayrı belirleyebilirsiniz.

> Bu proje WhatsApp'ın resmî Business API'sini değil, Baileys bağlı cihaz oturumunu kullanır. Kullanım sorumluluğu size aittir.

## Özellikler

- Birden fazla YouTube kanalı ve WhatsApp grubu desteği
- Aynı kanal veya grubun birden fazla otomasyonda kullanılabilmesi
- Kanal bazında anket veya normal mesaj gönderimi
- Türkiye saatine göre birden fazla saat ve dakika hassasiyetli çalışma aralığı
- Aralık bazında 15 saniye veya 1 dakika kontrol sıklığı
- Günlük tahmini YouTube API kullanım göstergesi
- Tekrar gönderimi engelleyen MongoDB olay kaydı ve kararlı WhatsApp mesaj kimliği
- WhatsApp hazır olana kadar güvenli bekletme; başlayan gönderimlerde çift mesajı önleyen at-most-once teslimat
- QR kod ile WhatsApp bağlantısı
- Şifre korumalı düzenleme modu ve salt-okunur ziyaretçi görünümü

## Nasıl çalışır?

1. WhatsApp hesabı QR kod ile bağlanır.
2. Bir YouTube kanalı, WhatsApp grubu ve bir veya daha fazla kontrol aralığı seçilir.
3. Her aralık için 15 saniye veya 1 dakika kontrol sıklığı belirlenir; çakışmada hızlı olan sıklık tek kontrol olarak uygulanır.
4. Son beş dakikada yayımlanmış, daha önce işlenmemiş bir video bulunduğunda seçilen gruba anket veya mesaj gönderilir. Daha eski sonuçlar iptal kaydı olarak tutulur.

Teslimat `at-most-once` çalışır: WhatsApp hazır değilse olay gönderilmeden bekletilir. Baileys gönderimi başladıktan sonra hata alınırsa sonuç belirsiz kabul edilir ve çift mesaj riskini önlemek için otomatik gönderim tekrarı yapılmaz; olay `failed` durumunda inceleme için saklanır.

## Gereksinimler

- Node.js 20 veya üzeri
- MongoDB veritabanı
- YouTube Data API v3 anahtarı
- QR kod okutabileceğiniz bir WhatsApp hesabı

## Kurulum

Projeyi indirin ve bağımlılıkları yükleyin:

```bash
git clone https://github.com/AliKacarr/youtube-whatsapp-poll-bot.git
cd youtube-whatsapp-poll-bot
npm install
```

`.env.example` dosyasını `.env` olarak kopyalayın:

```powershell
Copy-Item .env.example .env
```

Linux veya macOS için:

```bash
cp .env.example .env
```

Gerekli değerleri doldurun:

```env
NODE_ENV=development
PORT=3000

MONGO_URI=mongodb+srv://kullanici:parola@cluster.example.mongodb.net
DB_NAME=youtube_whatsapp_bot
CONFIG_KEY=benzersiz_bot_anahtari

YOUTUBE_API_KEY=your_youtube_api_key_here
YOUTUBE_DAILY_QUOTA_LIMIT=1000

PING_URL=
```

Uygulamayı başlatın:

```bash
npm start
```

Ardından `http://localhost:3000` adresini açın.

## Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|:---:|---|
| `MONGO_URI` | Evet | MongoDB bağlantı adresi |
| `DB_NAME` | Evet | Kullanılacak veritabanı adı |
| `CONFIG_KEY` | Evet | Bu bot kurulumunu veritabanındaki diğer kurulumlardan ayıran anahtar |
| `YOUTUBE_API_KEY` | Evet | YouTube Data API v3 anahtarı |
| `YOUTUBE_DAILY_QUOTA_LIMIT` | Hayır | Panelde gösterilecek tahmini günlük sınır; varsayılan `1000` |
| `PORT` | Hayır | HTTP portu; varsayılan `3000` |
| `NODE_ENV` | Hayır | Üretimde `production` kullanılabilir |
| `PING_URL` | Hayır | İki dakikada bir çağrılacak sağlık kontrolü adresi |
| `AUTH_COLLECTION` | Hayır | Eski Baileys oturum koleksiyonundan geçiş için kaynak koleksiyon |

`CONFIG_KEY` en fazla 64 karakter olabilir ve yalnızca harf, rakam, tire veya alt çizgi içerebilir. `.env` dosyasını Git'e eklemeyin.

## İlk yönetici girişi

Site varsayılan olarak görüntüleme modunda açılır. İlk kurulumda:

1. **Düzenleme moduna geç** düğmesine basın.
2. `.env` dosyasındaki `CONFIG_KEY` değerini girin.
3. En az 6 karakterli bir yönetici şifresi oluşturun.

Şifre MongoDB'de düz metin olarak saklanmaz. Yönetici oturumu cihazda 30 gün geçerlidir. **Görüntüleme moduna geç** oturumu korur; **Çıkış** düğmesi oturumu tamamen kapatır.

## YouTube API kullanımı

Bot, her etkin kanal için çalışma aralıklarında seçilen sıklıkta `playlistItems.list` isteği yapar. Kontroller 15 saniyelik sabit zaman slotlarına bağlıdır; yavaş bir yanıt sonraki slotu engellemez. Aynı videoyu gören örtüşen istekler MongoDB benzersiz indeksiyle tek olaya dönüştürülür ve yalnızca bu olay teslimat worker'ı tarafından atomik olarak sahiplenilir. Çakışan zaman aralıklarında 15 saniyelik sıklık önceliklidir. Panel, seçilen zaman aralıklarına göre günlük tahmini kullanımı hesaplar.

Örnek: `08:00–20:00` aralığı 1 dakikalık sıklıkla günlük 721 istektir. `14:59–15:02` aralığı 15 saniyelik, `15:02–15:15` aralığı 1 dakikalık seçildiğinde çakışma tekilleştirilir ve toplam 26 istek oluşur. Gösterilen sınır bilgilendirme amaçlıdır; aşılması ayarların kaydedilmesini engellemez.

## Komutlar

```bash
npm start       # Uygulamayı başlatır
npm run dev     # Dosya değişikliklerini izleyerek başlatır
npm test        # Testleri çalıştırır
```

## Sorun giderme

- **QR kod görünmüyor:** Düzenleme moduna geçtiğinizden ve MongoDB bağlantısının hazır olduğundan emin olun.
- **Gruplar yüklenmiyor:** WhatsApp bağlantısını ve hesabın gruplara üye olduğunu kontrol edin.
- **Kanal bulunamıyor:** YouTube Data API v3 hizmetini ve `YOUTUBE_API_KEY` değerini doğrulayın.
- **Video gönderilmiyor:** Kanalın etkinliğini, kontrol aralığını, WhatsApp bağlantısını ve son video olaylarını kontrol edin.

Bu sürüm temiz kurulum için hazırlanmıştır. Önceki tek-kanal veri modelinden otomatik ve eksiksiz geçiş garanti edilmez.

## Güvenlik

- MongoDB ve YouTube API bilgilerini yalnızca ortam değişkenlerinde saklayın.
- MongoDB kullanıcısına yalnızca gerekli veritabanı izinlerini verin.
- YouTube API anahtarını yalnızca YouTube Data API v3 ile sınırlandırın.
- WhatsApp oturum koleksiyonları hassas veri içerdiği için veritabanını herkese açmayın.

## Geliştirici

**Ali Kaçar**

[![Instagram](https://img.shields.io/badge/Instagram-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/alikacar23/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/alikacar23/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/AliKacarr)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@alikacardev)

[alikacardev@gmail.com](mailto:alikacardev@gmail.com)

---

## Lisans

Bu proje [Apache License 2.0](LICENSE.txt) ile lisanslanmıştır.
