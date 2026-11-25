const nodemailer = require('nodemailer');
const {
  serviceDb, clientIp, rateLimit, normalizeOptionalNim, normalizeEmail, dbFailure, handler, escapeHtml, requireEnv, HttpError
} = require('../lib/server');

let smtpTransporter = null;
function gmailMailer() {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: requireEnv('SMTP_USER'), pass: requireEnv('SMTP_PASS') }
    });
  }
  return smtpTransporter;
}

// Pengirim berbasis HTTPS API. Dipakai untuk pemilihan berskala besar karena
// Gmail SMTP dibatasi sekitar 500 email per hari, sedangkan 1000 pemilih
// membutuhkan lebih dari itu. Pemilihan provider ditentukan EMAIL_PROVIDER.
function httpApiMailer(provider) {
  return {
    async sendMail(message) {
      if (provider === 'brevo') {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': requireEnv('BREVO_API_KEY'),
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify({
            sender: { name: 'Pemilwa KMTEDI 2026', email: requireEnv('MAIL_FROM_ADDRESS') },
            to: (Array.isArray(message.to) ? message.to : [message.to]).map((address) => ({ email: address })),
            subject: message.subject,
            textContent: message.text,
            htmlContent: message.html
          })
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          const err = new Error('Brevo request failed');
          err.code = 'EPROVIDER';
          err.responseCode = res.status;
          err.providerMessage = detail.slice(0, 200);
          throw err;
        }
        return { accepted: message.to };
      }

      if (provider === 'resend') {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${requireEnv('RESEND_API_KEY')}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            from: `Pemilwa KMTEDI 2026 <${requireEnv('MAIL_FROM_ADDRESS')}>`,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html
          })
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          const err = new Error('Resend request failed');
          err.code = 'EPROVIDER';
          err.responseCode = res.status;
          err.providerMessage = detail.slice(0, 200);
          throw err;
        }
        return { accepted: message.to };
      }

      throw new HttpError(503, 'Pengiriman email belum dikonfigurasi dengan benar.');
    }
  };
}

function defaultMailer() {
  const provider = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
  return provider === 'gmail' ? gmailMailer() : httpApiMailer(provider);
}

function createSendOtpHandler(deps = {}) {
  const getDb = deps.getDb || serviceDb;
  const getMailer = deps.getMailer || defaultMailer;
  const getFromAddress = deps.getFromAddress
    || (() => (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase() === 'gmail'
      ? requireEnv('SMTP_USER')
      : requireEnv('MAIL_FROM_ADDRESS'));

  return handler(async (body, req) => {
    const email = normalizeEmail(body.email_prefix);
    const nim = normalizeOptionalNim(body.nim);
    const db = getDb();

    // Banyak mahasiswa bisa berbagi satu IP publik (wifi kampus), jadi batas per IP
    // longgar untuk 300+ pemilih. Batas ketat per email (jeda 60 detik, maks 6/jam)
    // ditegakkan atomik di database.
    await rateLimit(db, 'otp-ip', clientIp(req), 400, 15 * 60);

    const { data, error } = await db.rpc('voter_request_otp', { p_nim: nim, p_email: email });
    if (error) throw dbFailure(error);

    if (!data || data.ok === false) {
      const status = Number(data?.status) || 400;
      const extra = typeof data?.retry_after === 'number' ? { retry_after: data.retry_after } : null;
      throw new HttpError(
        status,
        data?.error || 'Permintaan kode OTP tidak dapat diproses. Silakan coba lagi.',
        extra
      );
    }

    const nimText = data.nim ? `\nNIM: ${data.nim}` : '';
    const nimHtml = data.nim
      ? `<p style="color:#FFF9EF;opacity:.8;font-size:14px;line-height:1.5">NIM: <strong>${escapeHtml(data.nim)}</strong></p>`
      : '';

    try {
      await getMailer().sendMail({
        from: `"Pemilwa KMTEDI 2026" <${getFromAddress()}>`,
        to: data.email,
        subject: 'Kode verifikasi Pemilwa KMTEDI 2026',
        text: `Kode OTP Pemilwa KMTEDI kamu: ${data.otp_code}${nimText}\nBerlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk panitia.`,
        html: `
          <div style="font-family:Arial,sans-serif;background:#250014;color:#FFF9EF;padding:32px 24px;border-radius:8px;max-width:500px;margin:auto">
            <div style="font-size:11px;font-weight:bold;letter-spacing:0.15em;color:#FFB42B;margin-bottom:8px">PEMILWA KMTEDI 2026</div>
            <h2 style="margin:0 0 16px;color:#FFF9EF;font-size:22px;text-transform:uppercase">Kode Verifikasi Hak Suara</h2>
            ${nimHtml}
            <p style="color:#FFF9EF;opacity:.8;font-size:14px;line-height:1.5">Masukkan kode berikut untuk membuka bilik suara:</p>
            <div style="background:#000113;border:2px solid #FFB42B;color:#FFB42B;font-size:36px;font-weight:bold;letter-spacing:0.25em;text-align:center;padding:16px;border-radius:6px;margin:20px 0">${escapeHtml(data.otp_code)}</div>
            <p style="color:#FFF9EF;opacity:.7;font-size:12px;line-height:1.4">Berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk panitia. Abaikan email ini jika kamu tidak memintanya.</p>
            <hr style="border:0;border-top:1px solid rgba(255,249,239,0.15);margin:20px 0">
            <small style="color:#FFF9EF;opacity:.5">Panitia Pemilwa KMTEDI 2026</small>
          </div>
        `
      });
    } catch (mailErr) {
      // Log kode error ringkas saja, jangan pernah mencetak OTP atau kredensial SMTP.
      console.error('Email send failed:', {
        name: mailErr?.name || null,
        message: String(mailErr?.message || '').slice(0, 160),
        code: mailErr?.code || null,
        responseCode: mailErr?.responseCode || null
      });
      throw new HttpError(503, 'Gagal mengirim email kode OTP saat ini. Silakan coba beberapa saat lagi.');
    }

    return {
      email: data.email,
      nim: data.nim,
      cooldown_seconds: data.cooldown_seconds || 60,
      message: `Kode OTP telah dikirim ke ${data.email}.`
    };
  });
}

const sendOtpHandler = createSendOtpHandler();
sendOtpHandler.createHandler = createSendOtpHandler;
module.exports = sendOtpHandler;
