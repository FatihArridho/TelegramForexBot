<div align="center">

# ⚡ Telegram Forex Signal Bot  
Bot trading berbasis Node.js + Telegraf, dibuat untuk mengelola sinyal **XAUUSD** dan pair lainnya.  
Mendukung **foto, caption, auto-pin, multi-owner, jurnal harian, dan reply status (hit/sl/tp)**.

---

### 👤 Author  
**Created by [Fatih Arridho](https://github.com/FatihArridho)**  
<img src="https://github.com/FatihArridho.png" width="120" style="border-radius:50%;" />

---

### ⭐ Repo Stats  
[![Stars](https://img.shields.io/github/stars/FatihArridho/TelegramForexBot?style=for-the-badge)]()  
[![Forks](https://img.shields.io/github/forks/FatihArridho/TelegramForexBot?style=for-the-badge)]()  
[![Issues](https://img.shields.io/github/issues/FatihArridho/TelegramForexBot?style=for-the-badge)]()  
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)]()

</div>

---

# 🎯 Fitur Utama

- `/buy` dan `/sell` dengan format:  
  ```
  /buy XAUUSD,4118,4115,4120,4122,4124,4126,4128
  ```
- Bisa mengirim **foto + caption** atau hanya teks.
- Pesan sinyal otomatis:
  ✔ dikirim ke channel  
  ✔ dipin  
  ✔ dikirim ke semua owner lewat DM  
- **Multi-owner system** (`/addowner`, `/removeowner`, `/owners`)
- Owner dapat reply DM:
  - `hit`
  - `sl`
  - `tp1` sampai `tp5`
  - `cancel`
- Bot akan **reply ke pesan sinyal asli di channel**, bukan kirim pesan baru.
- Mencegah:
  ✔ TP dobel  
  ✔ Hit dobel  
  ✔ SL dobel  
- **Jurnal harian otomatis** jam **23:11** (ke channel + owner DM)
- Penyimpanan `data.json`:
  - sinyal aktif
  - jurnal profit/loss (dalam R)
  - daftar owner
