require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Google Sheets ───────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const FONNTE_TOKEN   = process.env.FONNTE_TOKEN;
const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ============================================================
//  FUNGSI: Parse pesan dengan Google Gemini (GRATIS)
// ============================================================
async function parseTransactionWithAI(message) {
  const today = new Date().toLocaleDateString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const kemarin = yesterday.toLocaleDateString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });

  const prompt = `Hari ini: ${today} | Kemarin: ${kemarin}

Parse pesan transaksi keuangan berikut. Kembalikan HANYA JSON, tanpa markdown, tanpa penjelasan.

Pesan: "${message}"

Format JSON:
{
  "type": "expense" atau "income",
  "amount": angka bulat tanpa titik atau koma (contoh: 20000),
  "description": "deskripsi singkat maksimal 30 karakter",
  "category": pilih dari daftar berikut,
  "date": "DD/MM/YYYY"
}

Kategori yang tersedia:
- "Transportasi" → bensin, tol, parkir, grab, gojek, angkot, bus
- "Makan & Minum" → makan, minum, kopi, snack, warteg, resto
- "Belanja" → groceries, supermarket, indomaret, alfamart
- "Keluarga" → transfer ortu, adik, kakak, keluarga
- "Tagihan" → listrik, air, internet, cicilan, BPJS
- "Pemasukan" → gaji, bonus, terima uang, cashback
- "Lain-lain" → tidak masuk kategori lain

Aturan:
- "hari ini" atau tanpa keterangan waktu → ${today}
- "kemarin" → ${kemarin}
- Pengeluaran → type "expense" | Pemasukan → type "income"`;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
    }
  );

  const raw = response.data.candidates[0].content.parts[0].text
    .trim().replace(/```json|```/g, '').trim();
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
//  FUNGSI: Kirim WhatsApp via Fonnte
// ============================================================
async function sendWhatsApp(target, message) {
  await axios.post('https://api.fonnte.com/send', {
    target, message, countryCode: '62'
  }, { headers: { Authorization: FONNTE_TOKEN } });
}

function formatRupiah(amount) {
  return new Intl.NumberFormat('id-ID').format(Math.abs(amount));
}

// ============================================================
//  WEBHOOK
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { sender, message } = req.body;
    if (!sender || !message) return;
    if (ALLOWED_NUMBER && sender !== ALLOWED_NUMBER) return;

    const msg = message.trim();

    if (msg.toLowerCase() === 'saldo') {
      const balance = await getCurrentBalance();
      await sendWhatsApp(sender,
        `💰 *Saldo Kamu Saat Ini*\n━━━━━━━━━━━━━━\nRp ${formatRupiah(balance)}`
      );
      return;
    }

    if (msg.toLowerCase().startsWith('saldo awal')) {
      const amount = parseFloat(msg.replace(/[^0-9]/g, ''));
      if (!isNaN(amount) && amount > 0) {
        await updateBalance(amount);
        await sendWhatsApp(sender,
          `✅ *Saldo Awal Diset*\n━━━━━━━━━━━━━━\nRp ${formatRupiah(amount)}`
        );
      }
      return;
    }

    if (msg.toLowerCase() === 'help' || msg.toLowerCase() === 'bantuan') {
      await sendWhatsApp(sender,
        `🤖 *KeuanganAI - Panduan*\n━━━━━━━━━━━━━━\n` +
        `📝 *Catat Pengeluaran:*\n"makan padang 20000"\n"bensin 50rb"\n"parkir 2000 tadi"\n\n` +
        `💵 *Catat Pemasukan:*\n"dapat bonus 500000"\n"terima gaji 3jt"\n\n` +
        `⚙️ *Perintah:*\n"saldo" → cek saldo\n"saldo awal 5000000" → set saldo`
      );
      return;
    }

    const transaction = await parseTransactionWithAI(msg);
    if (!transaction.amount || transaction.amount <= 0) {
      await sendWhatsApp(sender, `❓ Tidak mengerti pesan. Kirim "bantuan" untuk panduan.`);
      return;
    }

    const currentBalance = await getCurrentBalance();
    const newBalance = transaction.type === 'income'
      ? currentBalance + transaction.amount
      : currentBalance - transaction.amount;

    await appendTransaction(transaction, newBalance);
    await updateBalance(newBalance);

    const isIncome = transaction.type === 'income';
    await sendWhatsApp(sender,
      `${isIncome ? '💵' : '💸'} *${isIncome ? 'Pemasukan' : 'Pengeluaran'} Tercatat!*\n` +
      `━━━━━━━━━━━━━━\n` +
      `📝 ${transaction.description}\n` +
      `🗂  ${transaction.category}\n` +
      `📅 ${transaction.date}\n` +
      `${isIncome ? '+' : '-'} Rp ${formatRupiah(transaction.amount)}\n` +
      `━━━━━━━━━━━━━━\n` +
      `💰 Saldo: Rp ${formatRupiah(newBalance)}`
    );

  } catch (err) {
    console.error('Error:', err.message);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'KeuanganAI aktif ✅', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server jalan di port ${PORT}`));
