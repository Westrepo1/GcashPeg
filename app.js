const express = require('express');
const mongoose = require('mongoose');
const fileUpload = require('express-fileupload');
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const session = require('express-session');
const flash = require('connect-flash');
const cors = require('cors');
const path = require('path');
// const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('./server/Models/User');
const SendMoney = require('./server/Models/sendMoney');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 6500;

// Zoho ZeptoMail REST API configuration.
// Email delivery is handled by a bounded in-process background queue so OTP,
// registration, account and transaction workflows never wait for Zoho.
const ZOHO_DEFAULT_ENDPOINT = 'https://cpaas.zoho.com/v1.1/email';
const EMAIL_MAX_CONCURRENT = 3;
const EMAIL_MAX_ATTEMPTS = 3;
const EMAIL_RETRY_BASE_MS = 1500;
const emailQueue = [];
let activeEmailWorkers = 0;

function cleanEmailConfig(value) {
  return String(value == null ? '' : value).trim().replace(/^([\"'])(.*)\1$/, '$2').trim();
}

function getZohoConfig() {
  return {
    apiKey: cleanEmailConfig(process.env.ZOHO_CPAAS_API_KEY),
    fromEmail: cleanEmailConfig(process.env.ZOHO_FROM_EMAIL || process.env.FROM_EMAIL || 'support@gcash.com'),
    fromName: cleanEmailConfig(process.env.ZOHO_FROM_NAME || process.env.FROM_NAME || 'GCash'),
    endpoint: cleanEmailConfig(process.env.ZOHO_EMAIL_API_URL || ZOHO_DEFAULT_ENDPOINT),
  };
}

function isValidEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)) return false;
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(value);
}

function maskEmailAddress(value) {
  const parts = String(value || '').split('@');
  if (parts.length !== 2) return '[invalid email]';
  return `${parts[0].slice(0, 2)}***@${parts[1]}`;
}

function getZohoAuthorization(apiKey) {
  const key = cleanEmailConfig(apiKey);
  if (!key) return null;
  return /^Zoho-enczapikey\s+/i.test(key) ? key : `Zoho-enczapikey ${key}`;
}

function logZohoConfiguration() {
  const config = getZohoConfig();
  const rawKey = process.env.ZOHO_CPAAS_API_KEY;
  console.info('[Zoho Debug] Email configuration:', {
    endpoint: config.endpoint,
    endpointUsesHttps: config.endpoint.startsWith('https://'),
    apiKeyPresent: Boolean(config.apiKey),
    apiKeyLength: config.apiKey.length,
    apiKeyHasOuterWhitespace: typeof rawKey === 'string' && rawKey !== rawKey.trim(),
    apiKeyContainsAuthorizationPrefix: /^Zoho-enczapikey\s+/i.test(config.apiKey),
    sender: maskEmailAddress(config.fromEmail),
    senderSyntaxValid: isValidEmailAddress(config.fromEmail),
    senderNamePresent: Boolean(config.fromName),
  });
  if (!config.apiKey) console.error('[Zoho Diagnosis] ZOHO_CPAAS_API_KEY is missing. Email will not be delivered.');
  if (config.apiKey && config.apiKey.length < 20) console.warn('[Zoho Diagnosis] API key looks unusually short. Confirm the complete Agent Send Mail Token was configured. The key is not displayed.');
  if (!isValidEmailAddress(config.fromEmail)) console.error('[Zoho Diagnosis] Sender email syntax is invalid. Check ZOHO_FROM_EMAIL/FROM_EMAIL.');
  if (!config.endpoint.startsWith('https://')) console.error('[Zoho Diagnosis] Zoho endpoint must use HTTPS.');
}

function diagnoseZohoResponse(status, data) {
  const safeResponse = data && typeof data === 'object' ? JSON.stringify(data).slice(0, 1200) : String(data || '').slice(0, 1200);
  console.error('[Zoho Debug] REST API rejected email:', { httpStatus: status, response: safeResponse });
  if (status === 401) {
    console.error('[Zoho Diagnosis] HTTP 401 AUTHENTICATION FAILED. Verify the Agent Send Mail Token, that it belongs to this agent/data center, and that Authorization is exactly "Zoho-enczapikey <token>". The token is never logged.');
  } else if (status === 403) {
    console.error('[Zoho Diagnosis] HTTP 403 FORBIDDEN. Check agent/account permissions and the endpoint supported by this Zoho account.');
  } else if (status === 400 || status === 422) {
    console.error('[Zoho Diagnosis] INVALID EMAIL REQUEST. Check sender verification, recipient addresses, and the ZeptoMail payload.');
  } else if (status === 404) {
    console.error('[Zoho Diagnosis] ENDPOINT NOT FOUND. Check ZOHO_EMAIL_API_URL and the account data center.');
  } else if (status === 429) {
    console.error('[Zoho Diagnosis] RATE LIMIT. Zoho will be retried with a delay.');
  } else if (status >= 500) {
    console.error('[Zoho Diagnosis] ZOHO SERVER ERROR. The request will be retried.');
  }
}

async function deliverZohoEmail(job) {
  const config = getZohoConfig();
  const authorization = getZohoAuthorization(config.apiKey);
  if (!authorization) throw Object.assign(new Error('ZOHO_CPAAS_API_KEY is missing.'), { permanent: true });
  if (typeof fetch !== 'function') throw Object.assign(new Error('Zoho REST email requires Node.js 18 or newer.'), { permanent: true });
  if (!config.endpoint.startsWith('https://')) throw Object.assign(new Error('Zoho REST endpoint must use HTTPS.'), { permanent: true });
  if (!isValidEmailAddress(config.fromEmail)) throw Object.assign(new Error(`Invalid Zoho sender email: ${maskEmailAddress(config.fromEmail)}`), { permanent: true });
  if (!isValidEmailAddress(job.to)) throw Object.assign(new Error(`Invalid recipient email: ${maskEmailAddress(job.to)}`), { permanent: true });

  const payload = {
    from: { address: config.fromEmail, name: config.fromName },
    to: [{ email_address: { address: job.to, name: '' } }],
    subject: job.subject,
    htmlbody: job.html || `<p>${job.subject}</p>`,
  };
  if (job.text) payload.textbody = job.text;

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    throw new Error(`Could not connect to Zoho REST API: ${networkError.message}`);
  }

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch (_) { data = { responseText: raw.slice(0, 1200) }; }

  if (!response.ok) {
    diagnoseZohoResponse(response.status, data);
    const providerMessage = data?.message || data?.error?.message || data?.error || `Zoho REST request failed (HTTP ${response.status})`;
    const error = new Error(typeof providerMessage === 'string' ? providerMessage : JSON.stringify(providerMessage));
    error.status = response.status;
    error.permanent = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422;
    throw error;
  }

  console.info('[Zoho] Email accepted by REST API:', {
    jobId: job.id,
    messageId: data?.data?.[0]?.message_id || data?.message_id || data?.request_id || null,
    recipient: maskEmailAddress(job.to),
  });
  return data;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processEmailQueue() {
  while (activeEmailWorkers < EMAIL_MAX_CONCURRENT && emailQueue.length > 0) {
    const job = emailQueue.shift();
    activeEmailWorkers += 1;
    (async () => {
      for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt += 1) {
        try {
          await deliverZohoEmail(job);
          return;
        } catch (error) {
          console.error(`[Zoho] Email attempt ${attempt}/${EMAIL_MAX_ATTEMPTS} failed:`, {
            jobId: job.id,
            recipient: maskEmailAddress(job.to),
            message: error.message,
            status: error.status || null,
          });
          if (error.permanent || attempt === EMAIL_MAX_ATTEMPTS) {
            console.error('[Zoho] Email delivery permanently failed:', {
              jobId: job.id,
              recipient: maskEmailAddress(job.to),
              subject: job.subject,
              reason: error.message,
            });
            return;
          }
          await delay(EMAIL_RETRY_BASE_MS * attempt);
        }
      }
    })().catch((error) => {
      console.error('[Zoho] Unexpected background email worker error:', error.message);
    }).finally(() => {
      activeEmailWorkers -= 1;
      processEmailQueue();
    });
  }
}

/**
 * Nonblocking email interface used by existing routes.
 * Returns as soon as the email has been accepted into the in-process queue.
 * Delivery failures are logged and never interrupt the business workflow.
 */
async function sendMail(to, subject, html, text) {
  const config = getZohoConfig();
  const recipient = String(to || '').trim();
  const mailSubject = String(subject || '').trim();
  const jobId = `zoho-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!config.apiKey) {
    logZohoConfiguration();
    console.error('[Zoho] Email not queued: API key is missing.', { jobId, recipient: maskEmailAddress(recipient) });
    return { id: jobId, provider: 'zoho_rest_skipped', queued: false };
  }
  if (!isValidEmailAddress(recipient)) {
    console.error('[Zoho] Email not queued: invalid recipient address.', { jobId, recipient: maskEmailAddress(recipient) });
    return { id: jobId, provider: 'zoho_rest_skipped', queued: false };
  }
  if (!mailSubject) {
    console.error('[Zoho] Email not queued: subject is missing.', { jobId });
    return { id: jobId, provider: 'zoho_rest_skipped', queued: false };
  }

  emailQueue.push({ id: jobId, to: recipient, subject: mailSubject, html: String(html || ''), text: text == null ? '' : String(text) });
  console.info('[Zoho] Email queued for background delivery:', {
    jobId,
    recipient: maskEmailAddress(recipient),
    queueLength: emailQueue.length,
  });
  setImmediate(processEmailQueue);
  return { id: jobId, provider: 'zoho_rest_queued', queued: true };
}

// Beautiful email templates (GCash branded).
function baseEmailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#e8f4fd;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8f4fd;padding:24px 12px">
<tr><td align="center">
<table width="590" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08)">
<tr><td style="padding:28px 24px;text-align:center;background:#007dff">
<div style="width:60px;height:60px;background:#fff;border-radius:50%;margin:0 auto 12px;line-height:60px;font-size:28px;font-weight:bold;color:#007dff">G</div>
<span style="color:#fff;font-size:22px;font-weight:bold;letter-spacing:1px">GCASH</span>
</td></tr>
<tr><td style="padding:28px 30px">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 30px;border-top:1px solid #e3e3e3;color:#979797;font-size:12px;text-align:center">
<p style="margin:0 0 6px">© ${new Date().getFullYear()} GCash. All rights reserved.</p>
<p style="margin:0">This is an automated message. Please do not reply directly to this email.</p>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

function welcomeEmailHtml(fullname) {
  const name = fullname || 'there';
  return baseEmailShell('Welcome', `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">Welcome to <strong>GCash</strong>! We're thrilled to have you as a new member of our community.</p>
<p style="font-size:16px;line-height:1.6;color:#333">Your account is ready. You can now send money, check balances, and manage your finances instantly.</p>
<p style="font-size:16px;line-height:1.6;color:#333">Log in anytime to explore all the features waiting for you.</p>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}


function otpEmailHtml(fullname, code) {
  const name = fullname || 'there';
  return baseEmailShell('Email Verification', `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">Thank you for registering with <strong>GCash</strong>. Please use the one-time verification code below to activate your account.</p>
<p style="font-size:28px;font-weight:700;text-align:center;letter-spacing:6px;margin:28px 0;color:#007dff">${code}</p>
<p style="font-size:16px;line-height:1.6;color:#333">This code is valid for <strong>30 minutes</strong>. Do not share it with anyone.</p>
<p style="font-size:16px;line-height:1.6;color:#333">If you did not create a GCash account, you can safely ignore this email.</p>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}

function suspensionEmailHtml(fullname, isSuspended) {
  const name = fullname || 'there';
  const status = isSuspended ? 'suspended' : 'reactivated';
  const statusColor = isSuspended ? '#dc3545' : '#28a745';
  const extra = isSuspended
    ? 'If you believe this is a mistake, please contact our support team immediately.'
    : 'You can now log in and access all features again.';
  return baseEmailShell(`Account ${status}`, `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">Your GCash account has been <strong style="color:${statusColor}">${status}</strong>.</p>
<p style="font-size:16px;line-height:1.6;color:#333">${extra}</p>
<p style="text-align:center;margin:28px 0">
<a href="https://gcash-pep.onrender.com/login" style="display:inline-block;background:#007dff;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700">Go to Login</a>
</p>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}

function announcementEmailHtml(fullname, message) {
  const name = fullname || 'there';
  return baseEmailShell('Announcement', `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">We have an important announcement for you:</p>
<div style="background:#f0f7ff;border-left:4px solid #007dff;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0">
<p style="font-size:16px;line-height:1.6;color:#333;margin:0">${message || ''}</p>
</div>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}

function accountNoticeEmailHtml(fullname, message) {
  const name = fullname || 'there';
  return baseEmailShell('Account Notice', `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">This is a notice regarding your GCash account:</p>
<div style="background:#fff8e6;border-left:4px solid #ffc107;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0">
<p style="font-size:16px;line-height:1.6;color:#333;margin:0">${message || ''}</p>
</div>
<p style="font-size:16px;line-height:1.6;color:#333">If you have any questions, please contact support.</p>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}

function promotionalEmailHtml(fullname, message) {
  const name = fullname || 'there';
  return baseEmailShell('Special Offer', `
<p style="font-size:18px;margin:0 0 12px;color:#222">Hi ${name},</p>
<p style="font-size:16px;line-height:1.6;color:#333">We have something special for you!</p>
<div style="background:#e8faf0;border-left:4px solid #28a745;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0">
<p style="font-size:16px;line-height:1.6;color:#333;margin:0">${message || ''}</p>
</div>
<p style="text-align:center;margin:28px 0">
<a href="https://gcash-pep.onrender.com/" style="display:inline-block;background:#28a745;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700">Learn More</a>
</p>
<p style="font-size:16px;margin:24px 0 0;color:#222">Best regards,<br><br><strong>The GCash Team</strong></p>`);
}

// Middlewares
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use(cors());
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  useTempFiles: true,
  tempFileDir: 'public/uploads',
}));
app.use(methodOverride('_method'));
app.use(session({
  secret: 'piuscandothis',
  resave: false,
  saveUninitialized: false,
}));
app.use(flash());

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// DB config
const db = 'mongodb+srv://marcelpolocha1:081358pius@cluster0.f9a85hv.mongodb.net/gcashProps';
mongoose.connect(db)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

// Middleware to pass flash messages to views
app.use((req, res, next) => {
  res.locals.messages = req.flash();
  next();
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.jwt;
  if (token) {
    jwt.verify(token, 'piuscandothis', (err, decodedToken) => {
      if (err) {
        console.log(err.message);
        res.redirect('/login');
      } else {
        req.userId = decodedToken.id;
        next();
      }
    });
  } else {
    res.redirect('/login');
  }
};

// Unified handleErrors function
const handleErrors = (err) => {
  let errors = {
    first_name: '',
    last_name: '',
    email: '',
    password: '',
    accNo: '',
  };

  if (err.code === 11000) {
    if (err.keyPattern && err.keyPattern.email) {
      errors.email = 'That email is already registered';
    } else if (err.keyPattern && err.keyPattern.accNo) {
      errors.accNo = 'Account number already exists';
    } else {
      errors.email = 'Duplicate value – that email or account may already exist';
    }
    return errors;
  }

  if (err.message && err.message.includes('user validation failed')) {
    Object.values(err.errors || {}).forEach(({ properties }) => {
      if (properties && properties.path) {
        errors[properties.path] = properties.message;
      }
    });
    return errors;
  }

  if (err.message === 'Incorrect email') {
    errors.email = 'Incorrect email';
  } else if (err.message === 'Incorrect password') {
    errors.password = 'Incorrect password';
  } else if (err.message === 'Your account is suspended. If you believe this is a mistake, please contact support') {
    errors.email = err.message;
  } else if (err.message === 'All fields are required') {
    errors.first_name = 'All fields are required';
  } else if (err.message === 'Passwords do not match') {
    errors.password = 'Passwords do not match';
  } else if (err.message === 'Password must be at least 6 characters') {
    errors.password = 'Password must be at least 6 characters';
  } else if (err.message) {
    errors.email = err.message;
  }

  return errors;
};

// JWT token creation
const maxAge = 3 * 24 * 60 * 60;
const createToken = (id) => {
  return jwt.sign({ id }, 'piuscandothis', { expiresIn: maxAge });
};

// Generate account number
const generateAccountNumber = () => {
  const prefix = '557335';
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}${randomDigits}`;
};

// Routes
app.get('/', (req, res) => {
  res.render('login');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      throw Error('All fields are required');
    }

    const user = await User.login(email, password);
    const token = createToken(user._id);
    res.cookie('jwt', token, { httpOnly: true, maxAge: maxAge * 1000 });

    res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        accNo: user.accNo,
        balance: user.balance,
      },
    });
  } catch (err) {
    const errors = handleErrors(err);
    console.error('Login error:', { message: err.message, errors });
    res.status(400).json({ success: false, errors });
  }
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { first_name, last_name, email, password1, password2 } = req.body;

  try {
    if (!first_name || !last_name || !email || !password1 || !password2) {
      throw Error('All fields are required');
    }

    if (password1 !== password2) {
      throw Error('Passwords do not match');
    }

    if (String(password1).length < 6) {
      throw Error('Password must be at least 6 characters');
    }

    // Check if email already exists before creating
    const existing = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (existing) {
      return res.status(400).json({
        success: false,
        errors: { email: 'That email is already registered', first_name: '', last_name: '', password: '', accNo: '' },
        message: 'That email is already registered',
      });
    }

    let accNo;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 20) {
      accNo = generateAccountNumber();
      const existingUser = await User.findOne({ accNo });
      if (!existingUser) {
        isUnique = true;
      }
      attempts += 1;
    }

    if (!isUnique) {
      throw Error('Could not generate a unique account number. Please try again.');
    }

    // Generate email verification OTP (valid 30 minutes)
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = new Date(Date.now() + 30 * 60 * 1000);

    // Account stays suspended until email is verified
    const user = new User({
      first_name: String(first_name).trim(),
      last_name: String(last_name).trim(),
      email: String(email).trim().toLowerCase(),
      password: password1,
      accNo,
      isSuspended: true,
      otp,
      otpExpires,
    });

    const savedUser = await user.save();

    // Queue verification email through Zoho REST API (nonblocking).
    const fullname = `${savedUser.first_name} ${savedUser.last_name}`;
    try {
      await sendMail(
        savedUser.email,
        'Verify Your Email – GCash',
        otpEmailHtml(fullname, String(otp))
      );
      console.log('Verification email queued for', maskEmailAddress(savedUser.email));
    } catch (mailErr) {
      console.error('Verification email error:', mailErr.message);
      // Account still created; user can request resend if needed
    }

    // Do NOT set JWT cookie — user must verify email first, then log in
    res.status(201).json({
      success: true,
      redirect: `/verify-email?email=${encodeURIComponent(savedUser.email)}`,
      message: 'Account created. Please check your email for the verification code.',
      user: {
        _id: savedUser._id,
        email: savedUser.email,
      },
    });
  } catch (err) {
    const errors = handleErrors(err);
    console.error('Registration error:', { message: err.message, stack: err.stack, errors });
    res.status(400).json({ success: false, errors, message: err.message || 'Registration failed' });
  }
});


// ========== EMAIL VERIFICATION ==========
app.get('/verify-email', (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  res.render('verify-email', { email });
});

app.post('/verify-email', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && (req.body.code || req.body.otp)) || '').trim();

    if (!email) {
      return res.status(400).json({
        success: false,
        errors: { code: 'Email is required. Please start from the registration page.' },
        message: 'Email is required',
      });
    }
    if (!code) {
      return res.status(400).json({
        success: false,
        errors: { code: 'Verification code is required' },
        message: 'Verification code is required',
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        errors: { code: 'No account found with this email' },
        message: 'No account found with this email',
      });
    }

    const inputOtp = Number(code);
    if (
      !user.otp ||
      user.otp === 0 ||
      user.otp !== inputOtp ||
      !user.otpExpires ||
      new Date() > new Date(user.otpExpires)
    ) {
      return res.status(400).json({
        success: false,
        errors: { code: 'Invalid or expired verification code' },
        message: 'Invalid or expired verification code',
      });
    }

    // Activate account
    user.isSuspended = false;
    user.otp = 0;
    user.otpExpires = null;
    await user.save();

    // Redirect to login — user signs in after verification
    return res.status(200).json({
      success: true,
      message: 'Email verified successfully. You can now log in.',
      redirect: '/login',
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
      },
    });
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).json({
      success: false,
      errors: { code: 'Server error. Please try again.' },
      message: err.message || 'Verification failed',
    });
  }
});

app.post('/resend-verification', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this email' });
    }
    if (!user.isSuspended) {
      return res.status(400).json({ success: false, message: 'This account is already verified. Please log in.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    user.otp = otp;
    user.otpExpires = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const fullname = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    await sendMail(user.email, 'Verify Your Email – GCash', otpEmailHtml(fullname, String(otp)));

    return res.status(200).json({ success: true, message: 'Your new verification code has been queued for email delivery.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to resend code' });
  }
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -otp -otpExpires');
    if (!user) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
    res.render('dashboard', { user });
  } catch (err) {
    console.error(err);
    res.clearCookie('jwt');
    res.redirect('/login');
  }
});

app.get('/api/user', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -otp -otpExpires');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        accNo: user.accNo,
        balance: user.balance,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.userId)) {
      console.error('Invalid userId:', req.userId);
      return res.status(400).json({ success: false, message: 'Invalid user ID' });
    }

    const sender = await User.findById(req.userId).lean();
    if (!sender) {
      console.error('User not found for userId:', req.userId);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const transactions = await SendMoney.find({
      $or: [
        { owner: req.userId },
        { recipient_account: sender.accNo || '' },
      ],
    }).sort({ createdAt: -1 }).lean();

    const transactionDetails = await Promise.all(
      transactions.map(async (transaction) => {
        let senderName = sender.first_name && sender.last_name
          ? `${sender.first_name} ${sender.last_name}`
          : 'Unknown Sender';
        let recipientName;

        if (transaction.owner && transaction.owner.toString() === req.userId.toString()) {
          if (transaction.recipient_name) {
            recipientName = transaction.recipient_name;
          } else {
            const recipient = await User.findOne({ accNo: transaction.recipient_account }).lean();
            recipientName = recipient && recipient.first_name && recipient.last_name
              ? `${recipient.first_name} ${recipient.last_name}`
              : 'Unknown Recipient';
          }
        } else {
          const owner = transaction.owner && mongoose.Types.ObjectId.isValid(transaction.owner)
            ? await User.findById(transaction.owner).lean()
            : null;
          senderName = owner && owner.first_name && owner.last_name
            ? `${owner.first_name} ${owner.last_name}`
            : 'Unknown Sender';
          recipientName = sender.first_name && sender.last_name
            ? `${sender.first_name} ${sender.last_name}`
            : 'You';
        }

        return {
          id: transaction._id,
          senderAccountNumber: transaction.from || '',
          recipientAccountNumber: transaction.recipient_account || '',
          senderName,
          recipientName,
          amount: transaction.amount,
          date: transaction.createdAt,
          note: transaction.note || '',
        };
      })
    );

    res.status(200).json({ success: true, transactions: transactionDetails });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/send-money', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    user.otp = otp;
    user.otpExpires = otpExpires;
    await user.save();
    res.render('send-money');
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

app.post('/send-money', requireAuth, async (req, res) => {
  try {
    const { recipient_account, amount, note, recipient_name } = req.body;
    const parsedAmount = Number(amount);

    if (!recipient_account || !parsedAmount || parsedAmount <= 0) {
      throw Error('Valid recipient account and amount are required');
    }

    const sender = await User.findById(req.userId);
    if (!sender) {
      throw Error('Sender not found');
    }

    if (sender.balance < parsedAmount) {
      throw Error('Insufficient balance');
    }

    let recipient = await User.findOne({ accNo: recipient_account });
    let isRecipientNotFound = false;

    if (!recipient) {
      if (!recipient_name || typeof recipient_name !== 'string' || recipient_name.trim() === '') {
        throw Error('Recipient name is required for non-registered accounts');
      }
      isRecipientNotFound = true;
    }

    sender.balance -= parsedAmount;
    await sender.save();

    if (!isRecipientNotFound) {
      recipient.balance += parsedAmount;
      await recipient.save();
    }

    const transaction = new SendMoney({
      from: sender.accNo,
      recipient_account,
      amount: parsedAmount,
      note,
      owner: sender._id,
      recipient_name: isRecipientNotFound ? recipient_name.trim() : null,
    });
    await transaction.save();

    const transactionDetails = {
      id: transaction._id,
      senderAccountNumber: sender.accNo,
      recipientAccountNumber: recipient_account,
      senderName: `${sender.first_name} ${sender.last_name}`,
      recipientName: isRecipientNotFound
        ? recipient_name.trim()
        : `${recipient.first_name} ${recipient.last_name}`,
      amount: parsedAmount,
      date: transaction.createdAt,
      note: note,
    };

    res.status(200).json({
      success: true,
      redirect: '/confirmation',
      transaction: transactionDetails,
    });
  } catch (err) {
    const errors = handleErrors(err);
    res.status(400).json({ success: false, errors, message: err.message });
  }
});

app.get('/api/user/:accNo', requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ accNo: req.params.accNo }).select('first_name last_name accNo');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({
      success: true,
      user: {
        accountNumber: user.accNo,
        name: `${user.first_name} ${user.last_name}`,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/validate-otp', requireAuth, async (req, res) => {
  const { otp } = req.body;

  try {
    if (!otp) {
      throw Error('OTP is required');
    }

    const user = await User.findById(req.userId);
    if (!user) {
      throw Error('User not found');
    }

    const inputOtp = Number(otp);

    if (
      user.otp === null ||
      user.otpExpires === null ||
      user.otp !== inputOtp ||
      new Date() > new Date(user.otpExpires)
    ) {
      throw Error('Invalid or expired OTP');
    }

    user.otp = null;
    user.otpExpires = null;
    await user.save();

    res.status(200).json({ success: true, message: 'OTP validated successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/confirmation', (req, res) => {
  res.render('confirmation');
});

app.get('/transactions/:userId', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password -otp -otpExpires').lean();
    if (!user) {
      return res.status(404).render('error', { message: 'User not found' });
    }
    res.render('transactions', { user });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'An error occurred while fetching user details' });
  }
});

app.get('/siteAdminPages', async (req, res) => {
  let perPage = 100;
  let page = parseInt(req.query.page) || 1;
  let sort = req.query.sort || 'createdAt';
  let order = req.query.order || 'desc';
  let status = req.query.status || 'all';

  try {
    let query = {};
    if (status === 'active') {
      query.isSuspended = false;
    } else if (status === 'suspended') {
      query.isSuspended = true;
    }

    let sortField = sort;
    if (sort === 'fullname') {
      sortField = 'first_name';
    } else if (sort === 'tel') {
      sortField = 'phone';
    } else if (sort === 'index') {
      sortField = 'createdAt';
    }

    const user = await User.aggregate([
      {
        $addFields: {
          fullname: { $concat: ['$first_name', ' ', '$last_name'] },
          tel: '$phone',
        },
      },
      { $match: query },
      { $sort: { [sortField]: order === 'asc' ? 1 : -1 } },
    ])
      .skip(perPage * (page - 1))
      .limit(perPage)
      .exec();

    const count = await User.countDocuments(query);

    res.render('adminDashboard', {
      user,
      page,
      totalPages: Math.ceil(count / perPage),
      sort,
      order,
      status,
    });
  } catch (error) {
    console.log(error);
    res.render('adminDashboard', {
      user: [],
      page: 1,
      totalPages: 1,
      sort: 'createdAt',
      order: 'desc',
      status: 'all',
    });
  }
});

app.get('/viewUser/:id', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id })
      .populate('sendMoneys')
      .lean();

    if (!user) {
      return res.status(404).render('error', { message: 'User not found' });
    }

    user.fullname = `${user.first_name} ${user.last_name}`;

    res.render('viewUser', {
      user,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'An error occurred while fetching user details' });
  }
});

app.get('/editUser/:id', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id }).lean();
    if (!user) {
      return res.status(404).render('error', { message: 'User not found' });
    }

    user.fullname = `${user.first_name} ${user.last_name}`;

    res.render('editUser', {
      user,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('error', { message: 'An error occurred while fetching user details' });
  }
});

app.put('/editUser/:id', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, balance, isSuspended } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).render('editUser', {
        user: {},
        error: 'User not found',
      });
    }

    if (first_name !== undefined) user.first_name = first_name;
    if (last_name !== undefined) user.last_name = last_name;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (balance !== undefined) user.balance = Number(balance);
    if (isSuspended !== undefined) user.isSuspended = isSuspended === 'true' || isSuspended === true;

    await user.save();

    user.fullname = `${user.first_name} ${user.last_name}`;

    res.redirect(`/viewUser/${req.params.id}`);
  } catch (error) {
    console.error(error);
    res.status(500).render('editUser', {
      user: await User.findOne({ _id: req.params.id }).lean(),
      error: 'An error occurred while updating the user',
    });
  }
});

// Email function for suspension notification – queued through Zoho REST API.
const sendSuspensionEmail = async (fullname, email, isSuspended) => {
  try {
    const status = isSuspended ? 'suspended' : 'reactivated';
    const subject = `Account ${status.charAt(0).toUpperCase() + status.slice(1)} – GCash`;
    const html = suspensionEmailHtml(fullname, isSuspended);
    await sendMail(email, subject, html);
    console.log('Suspension notification queued for', maskEmailAddress(email));
  } catch (error) {
    console.error('Error sending suspension email:', error.message);
  }
};

app.post('/suspendUser/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/siteAdminPages');
    }

    user.isSuspended = !user.isSuspended;
    await user.save();

    const fullname = user.fullname || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User';
    await sendSuspensionEmail(fullname, user.email, user.isSuspended);

    req.flash('success', `User ${user.isSuspended ? 'suspended' : 'reactivated'} successfully`);
    res.redirect('/siteAdminPages');
  } catch (error) {
    console.error('Error in suspendUser:', error);
    req.flash('error', 'Error updating user suspension status');
    res.redirect('/siteAdminPages');
  }
});

app.delete('/deleteUser/:id', async (req, res) => {
  try {
    await User.deleteOne({ _id: req.params.id });
    res.redirect('/siteAdminPages');
  } catch (error) {
    console.log(error);
  }
});

// ========== ADMIN EMAIL PAGE ==========
app.get('/admin/email', async (req, res) => {
  try {
    const users = await User.find({})
      .select('first_name last_name email')
      .sort({ first_name: 1 })
      .lean();

    const usersWithName = users.map((u) => ({
      _id: u._id,
      email: u.email,
      fullname: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
    }));

    res.render('adminEmail', {
      users: usersWithName,
      messages: req.flash(),
    });
  } catch (error) {
    console.error('Error loading admin email page:', error);
    res.render('adminEmail', {
      users: [],
      messages: { error: ['Failed to load users'] },
    });
  }
});

app.post('/admin/email', async (req, res) => {
  try {
    const { userIds, allUsers, subject, message, template } = req.body;

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ success: false, message: 'Subject is required' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    let recipients = [];

    if (allUsers === true || allUsers === 'true' || allUsers === 'on') {
      const all = await User.find({}).select('first_name last_name email').lean();
      recipients = all.filter((u) => u.email);
    } else {
      let ids = userIds;
      if (typeof ids === 'string') {
        try { ids = JSON.parse(ids); } catch (_) { ids = [ids]; }
      }
      if (!Array.isArray(ids)) ids = ids ? [ids] : [];
      if (ids.length === 0) {
        return res.status(400).json({ success: false, message: 'Please select at least one user or check All Users' });
      }
      const selected = await User.find({ _id: { $in: ids } }).select('first_name last_name email').lean();
      recipients = selected.filter((u) => u.email);
    }

    if (recipients.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid recipients found' });
    }

    const chosenTemplate = String(template || 'announcement').toLowerCase();
    let sent = 0;
    const failedEmails = [];

    for (const user of recipients) {
      const fullname = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'there';
      let html;
      if (chosenTemplate === 'account') {
        html = accountNoticeEmailHtml(fullname, message);
      } else if (chosenTemplate === 'promotional') {
        html = promotionalEmailHtml(fullname, message);
      } else {
        html = announcementEmailHtml(fullname, message);
      }

      try {
        await sendMail(user.email, subject, html);
        sent += 1;
      } catch (mailErr) {
        console.error('Failed to queue email to', maskEmailAddress(user.email), mailErr.message);
        failedEmails.push(user.email);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Email sent successfully to ${sent} user(s)${failedEmails.length ? `. Failed: ${failedEmails.length}` : ''}.`,
      sent,
      failed: failedEmails.length,
    });
  } catch (error) {
    console.error('Admin email send error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send emails' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('jwt');
  res.redirect('/login');
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
