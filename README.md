# Element Locator 

![Chrome Web Store](https://img.shields.io/chrome-web-store/v/YOUR_EXTENSION_ID?style=for-the-badge&logo=google-chrome&label=Chrome%20Web%20Store)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

## 🚀 Genel Bakış

**Element Locator ** Chrome eklentisi, web otomasyonu ve test süreçlerinde element bulma işlemlerini devrim niteliğinde kolaylaştıran güçlü bir araçtır. Geleneksel element bulucuların ötesine geçerek, yapay zeka destekli akıllı XPath ve CSS seçici üretimi sunar. Bu eklenti, ChatGPT, Gemini, DeepSeek ve Claude gibi önde gelen yapay zeka modelleriyle entegre çalışarak, en karmaşık web sayfalarında bile güvenilir ve sağlam locator'lar oluşturmanıza yardımcı olur.

Test otomasyon mühendisleri, QA analistleri ve web geliştiricileri için tasarlanan bu eklenti, manuel locator yazma zahmetini ortadan kaldırır, zaman kazandırır ve otomasyon betiklerinin kararlılığını artırır. Elementleri sezgisel bir şekilde seçin, anında çeşitli locator önerileri alın ve yapay zekanın gücüyle en uygun olanı seçin.

## ✨ Özellikler

### 🎯 Akıllı Element Seçimi ve Vurgulama

Eklenti, web sayfasındaki herhangi bir HTML elementini kolayca seçmenizi sağlayan sezgisel bir seçim modu sunar. Seçilen elementler, tipine (örneğin, e-ticaret butonu, checkbox, SVG, resim, ikon) göre farklı renklerle dinamik olarak vurgulanır ve ilgili element tipini belirten küçük bir etiketle işaretlenir. Bu görsel geri bildirim, doğru elementi seçtiğinizden emin olmanızı sağlar. Ayrıca, eklentinin kendi arayüz elementleri (yan panel, vurgulama katmanları) seçim sürecinden akıllıca hariç tutularak kesintisiz bir kullanıcı deneyimi sunulur.

### 🔍 Gelişmiş Locator Üretimi

Eklentinin kalbinde, seçilen HTML elementi için kapsamlı ve çeşitli XPath ve CSS seçicileri üreten gelişmiş bir `Unified Locator Generator` bulunur. Bu jeneratör, elementin ID'si, sınıfı, metin içeriği ve diğer nitelikleri gibi birçok özelliğini analiz ederek en uygun locator'ları belirler. Üretilen locator'lar üç ana seviyede sınıflandırılır:

- **Temel Locator'lar**: `id`, `name`, `data-testid`, `aria-label`, `title`, `alt`, `href`, `src`, `type`, `placeholder`, `value` gibi benzersiz ve doğrudan niteliklere dayalı basit ve yüksek güvenilirlikli seçiciler.
- **Orta Seviye Locator'lar**: Metin içeriğinin bir kısmını içeren (`contains(text())`), dinamik ID veya sınıf ön eklerini kullanan (`starts-with(@id)`), kısmi sınıf eşleşmeleri (`class*=`) veya ebeveyn-çocuk ilişkileri gibi daha karmaşık senaryolar için uygun seçiciler.
- **Gelişmiş Locator'lar**: XPath eksenleri (`following-sibling`, `ancestor`), konumsal seçiciler (`nth-of-type`, `position()`) ve çoklu nitelik kombinasyonları gibi daha karmaşık ve esnek otomasyon ihtiyaçları için tasarlanmış seçiciler.

Eklenti ayrıca, SVG elementleri, ikonlar ve e-ticaret sitelerindeki özel butonlar gibi belirli element tipleri için özel olarak optimize edilmiş locator üretim algoritmalarına sahiptir. Bu, özellikle dinamik ve karmaşık web arayüzlerinde sağlam locator'lar elde etmeyi kolaylaştırır. Üretilen her locator, benzersizliği ve doğruluğu açısından doğrulanır ve güvenilirlik, performans ve okunabilirlik gibi kriterlere göre önceliklendirilir. Sık kullanılan locator'lar için bir önbellekleme mekanizması da performansı artırır.

### 🧠 Yapay Zeka Destekli Locator Önerileri

Bu eklentiyi benzerlerinden ayıran en önemli özellik, yapay zeka entegrasyonudur. Eklenti, seçilen elementin detaylı HTML bilgilerini önde gelen yapay zeka modellerine (ChatGPT, Gemini, DeepSeek, Claude) göndererek, insan benzeri akıl yürütme yeteneğiyle alternatif ve optimize edilmiş locator önerileri alabilir. Bu, özellikle standart algoritmaların zorlandığı durumlarda veya daha yaratıcı ve dayanıklı locator'lara ihtiyaç duyulduğunda paha biçilmez bir avantaj sağlar.

Kullanıcılar, yan paneldeki sezgisel arayüz üzerinden tercih ettikleri AI sağlayıcısını seçebilir ve API anahtarlarını güvenli bir şekilde yönetebilirler. Eklenti, AI API çağrılarındaki (yetkilendirme hataları, hız sınırı aşımları, ağ bağlantısı sorunları vb.) olası hataları akıllıca yönetir ve kullanıcıya anlaşılır geri bildirimler sunar. Ayrıca, devam eden AI isteklerini iptal etme yeteneği, kullanıcıya süreç üzerinde tam kontrol sağlar.

### 🖥️ Kapsamlı Yan Panel (Sidebar) Yönetimi

Eklentinin yan paneli, tüm işlevselliği tek bir merkezi konumda birleştiren kullanıcı dostu bir arayüz sunar:

- **Yan Panel Kontrolü**: Tarayıcı eklentisi ikonuna tek bir tıklamayla yan paneli kolayca açıp kapatabilirsiniz.
- **Element Bilgileri**: Seçilen elementin tüm önemli nitelikleri (etiket, ID, sınıf, metin içeriği, zaman damgası vb.) anında görüntülenir.
- **Locator Listeleme**: Üretilen XPath ve CSS seçicileri, kategori (basit, orta, gelişmiş), doğrulama durumu ve öncelik puanı ile birlikte düzenli bir şekilde listelenir.
- **Geçmiş Navigasyonu**: Seçilen elementlerin bir geçmişi tutulur, bu sayede önceki seçimlere kolayca geri dönebilir veya ileri gidebilirsiniz.
- **Tek Tıkla Kopyalama**: Herhangi bir locator'ı tek bir tıklamayla panoya kopyalayarak otomasyon betiklerinize hızlıca entegre edebilirsiniz.
- **AI Ayarları**: AI özelliklerini etkinleştirme/devre dışı bırakma, AI sağlayıcısı seçimi ve API anahtarı yönetimi için özel bir bölüm bulunur.
- **Davranış Ayarları**: Yan panelin otomatik genişlemesi, AI bildirimleri ve görsel efektler gibi kullanıcı deneyimi ayarlarını kişiselleştirebilirsiniz.
- **Güvenlik Ayarları**: Sağ tıklama koruması, F12 (geliştirici araçları) tuşunu devre dışı bırakma ve geliştirici araçları algılama gibi ek güvenlik önlemleri sunar. Bu özellikler, hassas test ortamlarında istenmeyen müdahaleleri önlemeye yardımcı olur.
- **Toast Bildirimleri**: Başarılı işlemler, uyarılar veya hatalar hakkında kullanıcıya anlık ve anlaşılır bildirimler sunulur.

### ⚙️ Arka Plan İşlemleri

Eklentinin arka plan betiği (`background.js`), yan panelin ve içerik betiklerinin sorunsuz çalışmasını sağlayan önemli görevleri yerine getirir. Yan panelin açık/kapalı durumunu yönetir, sekme güncellemelerini izler ve içerik betikleri ile AI API'leri arasındaki iletişimi koordine eder. Bu sayede, eklenti tarayıcıda verimli ve güvenilir bir şekilde çalışır.

## 🛠️ Kurulum

Bu eklentiyi Chrome tarayıcınıza kurmak için aşağıdaki adımları izleyin:

1. Bu depoyu klonlayın veya ZIP olarak indirin.
2. Chrome tarayıcınızı açın ve adres çubuğuna `chrome://extensions` yazın.
3. Sağ üst köşedeki **Geliştirici modu** anahtarını açın.
4. **Paketlenmemiş öğe yükle** düğmesine tıklayın.
5. İndirdiğiniz veya klonladığınız deponun ana dizinini seçin (yani `manifest.json` dosyasının bulunduğu klasör).
6. Eklenti başarıyla yüklenecektir. Tarayıcınızın araç çubuğunda eklenti ikonunu görmelisiniz.

## 💡 Kullanım

1. Eklentiyi yükledikten sonra, test etmek istediğiniz herhangi bir web sayfasına gidin.
2. Chrome araç çubuğundaki **Enhanced Element Locator** ikonuna tıklayın. Yan panel açılacaktır.
3. Yan paneldeki **Select Element** düğmesine tıklayın. İmleciniz bir artı işaretine dönüşecektir.
4. Web sayfasında analiz etmek istediğiniz elementin üzerine gelin. Element vurgulanacak ve tipi gösterilecektir.
5. Elementi seçmek için tıklayın.
6. Yan panelde, seçilen elementin detaylı bilgileri ve otomatik olarak üretilen XPath ve CSS locator önerileri görüntülenecektir.
7. AI destekli öneriler almak için **Ask AI** düğmesine tıklayın (önce AI sağlayıcınızı yapılandırmanız gerekebilir).
8. Herhangi bir locator'ı panoya kopyalamak için üzerine tıklayın.
9. Geçmişte gezinmek için **Previous** ve **Next** düğmelerini kullanın.
10. Yan paneli kapatmak için **Close Sidebar** düğmesine tıklayın.

## 🤝 Katkıda Bulunma

Bu projeye katkıda bulunmaktan çekinmeyin! Hata raporları, özellik istekleri veya kod katkıları her zaman memnuniyetle karşılanır. Lütfen bir Pull Request göndermeden önce mevcut sorunları ve tartışmaları kontrol edin.

## 📄 Lisans

Bu proje MIT Lisansı altında lisanslanmıştır. Daha fazla bilgi için `LICENSE` dosyasına bakın.

## 📞 İletişim

Sorularınız veya geri bildirimleriniz için benimle iletişime geçmekten çekinmeyin.

---

**Manus AI tarafından oluşturulmuştur.**


