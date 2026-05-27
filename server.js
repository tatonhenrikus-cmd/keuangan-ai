// ============================================================
//  KeuanganAI - WhatsApp to Google Sheets
//  Dibuat untuk pencatatan keuangan otomatis via WhatsApp
// ============================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Inisialisasi Anthropic ──────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Inisialisasi Google Sheets ──────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const FONNTE_TOKEN    = process.env.FONNTE_TOKEN;
const ALLOWED_NUMBER  = process.env.ALLOWED_NUMBER; // nomor HP kamu (format: 628xxxxxxxxxx)

// ============================================================
//  FUNGSI: Parse pesan dengan Claude AI
// ============================================================
async function parseTransactionWithAI(message) {
  // Tanggal hari ini dalam format Indonesia
  const today = new Date().toLocaleDateString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });

  // Hitung kemarin
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const kemarin = yesterday.toLocaleDateString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });

  const prompt = `Hari ini: ${today} | Kemarin: ${kemarin}

Parse pesan transaksi keuangan berikut. Kembalikan HANYA JSON, tanpa markdown, tanpa penjelasan.

Pesan: "${message}"

Format JSON yang harus dikembalikan:
{
  "type": "expense" atau "income",
  "amount": angka bulat tanpa titik atau koma (contoh: 20000),
  "description": "deskripsi singkat maksimal 30 karakter",
  "category": pilih salah satu dari daftar di bawah,
  "date": "DD/MM/YYYY"
}

Daftar kategori yang tersedia:
- "Transportasi"    → bensin, tol, parkir, grab, gojek, angkot, bus
- "Makan & Minum"   → makan, minum, kopi, snack, warteg, resto, kantin
- "Belanja"         → groceries, supermarket, indomaret, alfamart, kebutuhan rumah
- "Keluarga"        → transfer ortu, adik, kakak, kiriman keluarga
- "Tagihan"         → listrik, air, internet, cicilan, BPJS
- "Pemasukan"       → gaji, bonus, terima uang, cashback, transfer masuk
- "Lain-lain"       → apapun yang tidak masuk kategori di atas

Aturan tanggal:
- "hari ini" atau tidak ada keterangan waktu → ${today}
- "kemarin" → ${kemarin}
- "tadi pagi / siang / malam" → ${today}
- Jika ada tanggal eksplisit seperti "tanggal 5" → gunakan tanggal tersebut bulan ini

Aturan type:
- Pengeluaran (beli, bayar, makan, bensin, dll) → "expense"
- Pemasukan (terima, dapat, bonus, gaji, masuk) → "income"`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ============================================================
//  FUNGSI: Google Sheets helpers
// ============================================================
async function getSheets() {
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function getCurrentBalance() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Saldo!B1',
  });
  const val = res.data.values?.[0]?.[0];
  return val ? parseFloat(val.toString().replace(/[^0-9.-]/g, '')) : 0;
}

async function updateBalance(newBalance) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Saldo!B1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newBalance]] }
  });
}

async function appendTransaction(transaction, newBalance) {
  const sheets = await getSheets();
  const row = [
    transaction.date,
    transaction.description,
    transaction.category,
    transaction.type === 'expense' ? transaction.amount : '',
    transaction.type === 'income'  ? transaction.amount : '',
    newBalance
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Transaksi!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

// ============================================================
//  FUNGSI: Kirim balik via WhatsApp (Fonnte)
// ============================================================
async function sendWhatsApp(target, message) {
  await axios.post('https://api.fonnte.com/send', {
    target,
    message,
    countryCode: '62'
  }, {
    headers: { Authorization: FONNTE_TOKEN }
  });
}

// ============================================================
//  FUNGSI: Format Rupiah
// ============================================================
function formatRupiah(amount) {
  return new Intl.NumberFormat('id-ID').format(Math.abs(amount));
}

// ============================================================
//  WEBHOOK ENDPOINT - menerima pesan dari Fonnte
// ============================================================
app.post('/webhook', async (req, res) => {
  // Balas Fonnte dulu agar tidak timeout
  res.sendStatus(200);

  try {
    const { sender, message } = req.body;
    if (!sender || !message) return;

    // Keamanan: hanya proses dari nomor kamu sendiri
    if (ALLOWED_NUMBER && sender !== ALLOWED_NUMBER) {
      console.log(`Ditolak dari nomor: ${sender}`);
      return;
    }

    const msg = message.trim();

    // ── Perintah Khusus ─────────────────────────────────────

    // Cek saldo
    if (msg.toLowerCase() === 'saldo') {
      const balance = await getCurrentBalance();
      await sendWhatsApp(sender,
        `💰 *Saldo Kamu Saat Ini*\n` +
        `━━━━━━━━━━━━━━\n` +
        `Rp ${formatRupiah(balance)}`
      );
      return;
    }

    // Set saldo awal (contoh: "saldo awal 5000000")
    if (msg.toLowerCase().startsWith('saldo awal')) {
      const raw = msg.replace(/[^0-9]/g, '');
      const amount = parseFloat(raw);
      if (!isNaN(amount) && amount > 0) {
        await updateBalance(amount);
        await sendWhatsApp(sender,
          `✅ *Saldo Awal Berhasil Diset*\n` +
          `━━━━━━━━━━━━━━\n` +
          `Rp ${formatRupiah(amount)}`
        );
      } else {
        await sendWhatsApp(sender, '❌ Format salah. Contoh: saldo awal 5000000');
      }
      return;
    }

    // Bantuan
    if (msg.toLowerCase() === 'help' || msg.toLowerCase() === 'bantuan') {
      await sendWhatsApp(sender,
        `🤖 *KeuanganAI - Panduan*\n` +
        `━━━━━━━━━━━━━━\n` +
        `📝 *Catat Pengeluaran:*\n` +
        `"makan padang 20000 hari ini"\n` +
        `"bensin 50rb"\n` +
        `"parkir 2000 tadi"\n` +
        `"bayar tol 15000 kemarin"\n\n` +
        `💵 *Catat Pemasukan:*\n` +
        `"dapat bonus 500000"\n` +
        `"terima gaji 3000000"\n\n` +
        `⚙️ *Perintah Lain:*\n` +
        `"saldo" → lihat saldo\n` +
        `"saldo awal 5000000" → set saldo awal\n` +
        `"bantuan" → panduan ini`
      );
      return;
    }

    // ── Parse Transaksi dengan AI ────────────────────────────
    console.log(`Pesan masuk dari ${sender}: ${msg}`);

    const transaction = await parseTransactionWithAI(msg);
    console.log('Hasil parse:', transaction);

    // Validasi hasil parse
    if (!transaction.amount || transaction.amount <= 0) {
      await sendWhatsApp(sender,
        `❓ Tidak mengerti pesan tersebut.\n` +
        `Kirim "bantuan" untuk panduan format.`
      );
      return;
    }

    // Hitung saldo baru
    const currentBalance = await getCurrentBalance();
    const newBalance = transaction.type === 'income'
      ? currentBalance + transaction.amount
      : currentBalance - transaction.amount;

    // Simpan ke Google Sheets
    await appendTransaction(transaction, newBalance);
    await updateBalance(newBalance);

    // Kirim konfirmasi
    const isIncome  = transaction.type === 'income';
    const emoji     = isIncome ? '💵' : '💸';
    const sign      = isIncome ? '+' : '-';
    const label     = isIncome ? 'Pemasukan' : 'Pengeluaran';

    await sendWhatsApp(sender,
      `${emoji} *${label} Tercatat!*\n` +
      `━━━━━━━━━━━━━━\n` +
      `📝 ${transaction.description}\n` +
      `🗂  ${transaction.category}\n` +
      `📅 ${transaction.date}\n` +
      `${sign} Rp ${formatRupiah(transaction.amount)}\n` +
      `━━━━━━━━━━━━━━\n` +
      `💰 Saldo: Rp ${formatRupiah(newBalance)}`
    );

  } catch (err) {
    console.error('Error webhook:', err.message);
    // Jangan kirim error detail ke user
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'KeuanganAI aktif ✅', time: new Date().toISOString() });
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ KeuanganAI berjalan di port ${PORT}`);
  console.log(`   Nomor diizinkan: ${ALLOWED_NUMBER || 'SEMUA (bahaya!)'}`);
});
