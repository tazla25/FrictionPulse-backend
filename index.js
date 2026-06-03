const express = require('express');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');
const winston = require('winston');

// ─────────────────────────────────────────────────────────────────────────
// 1. STARTUP CONFIGURATION & ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RESEND_API_KEY',
  'WEBHOOK_SECRET',
  'SENDER_EMAIL'
];

REQUIRED_ENV.forEach((envName) => {
  if (!process.env[envName]) {
    console.error(`[FATAL ERROR] Missing required environment variable: ${envName}`);
    process.exit(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. STRUCTURED LOGGING INITIALIZATION (Winston)
// ─────────────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json() // Production structured JSON output
  ),
  defaultMeta: { service: 'frictionpulse-backend' },
  transports: [
    new winston.transports.Console()
  ]
});

// ─────────────────────────────────────────────────────────────────────────
// 3. SENTRY ERROR TRACKING INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2, // Track 20% of HTTP transactions for APM
  });
  logger.info('Sentry SDK successfully initialized');
} else {
  logger.warn('Sentry DSN not provided; error tracking is disabled');
}

const app = express();

// Sentry request handler must be the first middleware
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// Supabase administrative client using service key
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─────────────────────────────────────────────────────────────────────────
// 4. REPLAY PROTECTION (InMemory Capped Cache)
// ─────────────────────────────────────────────────────────────────────────
const processedEventIds = new Set();
const MAX_CACHE_SIZE = 10000;
const CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
  processedEventIds.clear();
  logger.info('Cleared processed webhook event cache');
}, CACHE_CLEANUP_INTERVAL);

// ─────────────────────────────────────────────────────────────────────────
// 5. SECURITY UTILITIES: HTML ESCAPING
// ─────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  if (typeof str !== 'string') return String(str);
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#039;';
      default: return m;
    }
  });
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'anonymous';
  const parts = email.split('@');
  if (parts.length !== 2) return 'invalid-email';
  const name = parts[0];
  const domain = parts[1];
  const maskedName = name.length > 2 ? `${name.substring(0, 2)}***` : '***';
  return `${maskedName}@${domain}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. ROUTE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => {
  logger.info('Ping endpoint checked');
  return res.status(200).send('Server is awake! 🚀');
});

// ─────────────────────────────────────────────────────────────────────────
// 7. PRODUCTION-GRADE HEALTH CHECK ENDPOINT
// ─────────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const healthInfo = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'production',
    services: {
      server: 'up',
      database: 'down',
      auth: 'down',
      email_service: 'down'
    }
  };

  try {
    // A. Verify Database Connectivity (Select 1 row from sites)
    const { data: dbData, error: dbError } = await supabase
      .from('sites')
      .select('id')
      .limit(1);

    if (dbError) throw new Error(`Database connection failed: ${dbError.message}`);
    healthInfo.services.database = 'up';

    // B. Verify Auth connectivity (Run a quick empty metadata check on auth admin)
    const { error: authError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (authError) throw new Error(`Auth service connection failed: ${authError.message}`);
    healthInfo.services.auth = 'up';

    // C. Verify Email service config availability
    if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.startsWith('re_')) {
      healthInfo.services.email_service = 'configured_active';
    } else {
      throw new Error('Resend API key missing or misconfigured');
    }

    logger.info('Health status check passed', { services: healthInfo.services });
    return res.status(200).json(healthInfo);
  } catch (error) {
    healthInfo.status = 'unhealthy';
    logger.error('Health status check failed', { 
      error: error.message, 
      services: healthInfo.services 
    });
    
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }
    
    return res.status(500).json(healthInfo);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8. SECURE WEBHOOK & EMAIL ALERT DISPATCH ROUTE
// ─────────────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9).toUpperCase();
  logger.info('Webhook execution started', { requestId });

  try {
    // A. Bearer Token Authentication
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Unauthorized webhook request: invalid authorization header', { requestId });
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const token = authHeader.split(' ')[1];
    if (token !== process.env.WEBHOOK_SECRET) {
      logger.warn('Forbidden webhook request: secret token mismatch', { requestId });
      return res.status(403).json({ error: 'Forbidden: Invalid webhook signature' });
    }

    // B. Schema & Payload Validation
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      logger.warn('Bad request payload: body is empty or not an object', { requestId });
      return res.status(400).json({ error: 'Bad Request: Invalid payload body' });
    }

    if (payload.table !== 'leads') {
      logger.warn('Bad request: unsupported table event triggered', { requestId, table: payload.table });
      return res.status(400).json({ error: 'Bad Request: Unsupported database table event' });
    }

    if (payload.type !== 'INSERT') {
      logger.warn('Bad request: unsupported payload event type', { requestId, type: payload.type });
      return res.status(400).json({ error: 'Bad Request: Unsupported database trigger type' });
    }

    // Replay Protection
    if (payload.id) {
      if (processedEventIds.has(payload.id)) {
        logger.info('Replay trigger skipped', { requestId, eventId: payload.id });
        return res.status(200).json({ status: 'Ignored', message: 'Replay trigger detected and skipped' });
      }
      
      if (processedEventIds.size >= MAX_CACHE_SIZE) {
        const firstElement = processedEventIds.values().next().value;
        processedEventIds.delete(firstElement);
      }
      processedEventIds.add(payload.id);
    }

    const newRecord = payload.record;
    if (!newRecord || typeof newRecord !== 'object' || !newRecord.id) {
      logger.warn('Bad request: invalid record object or missing ID', { requestId });
      return res.status(400).json({ error: 'Bad Request: Missing database record in payload' });
    }

    const siteKey = newRecord.site_key;
    if (!siteKey || typeof siteKey !== 'string') {
      logger.warn('Bad request: invalid or missing site_key in payload record', { requestId });
      return res.status(400).json({ error: 'Bad Request: Invalid site_key' });
    }

    // C. Step 1: Query sites table to find user_id (merchant UUID)
    logger.info('Searching database for owner of site_key', { requestId });
    const { data: siteData, error: siteError } = await supabase
      .from('sites')
      .select('user_id, domain')
      .eq('site_key', siteKey)
      .maybeSingle();

    if (siteError) {
      logger.error('Database query failed during site_key search', { requestId, error: siteError.message });
      throw new Error(`Database query failed: ${siteError.message}`);
    }

    if (!siteData) {
      logger.warn('No registered site found for key', { requestId });
      return res.status(404).json({ error: 'Site not registered under any merchant profile' });
    }

    const merchantId = siteData.user_id;

    // D. Step 2: Query auth.users to retrieve merchant email
    logger.info('Fetching merchant email from auth.users', { requestId, merchantId });
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(merchantId);

    if (userError || !userData || !userData.user) {
      logger.error('Merchant authentication lookup failed for UUID', { requestId, merchantId, error: userError ? userError.message : 'No user found' });
      return res.status(404).json({ error: 'Merchant authentication user profile not found' });
    }

    const merchantEmail = userData.user.email;
    logger.info('Merchant email lookup completed', { 
      requestId, 
      domain: siteData.domain, 
      merchantEmail: maskEmail(merchantEmail) 
    });

    // E. HTML Escaping for User-Controlled Fields
    const safeEmail = escapeHtml(newRecord.email);
    const safePhone = escapeHtml(newRecord.phone);
    const safeObjection = escapeHtml(newRecord.objection_id);
    const safePageUrl = escapeHtml(newRecord.page_url);
    const safeDomain = escapeHtml(siteData.domain);

    // F. Send Dynamic Email Alert via Resend
    logger.info('Dispatching email alert via Resend', { requestId, recipient: maskEmail(merchantEmail) });
    const emailResult = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: merchantEmail,
      subject: `🎉 New Lead Captured on ${safeDomain}!`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e1e8ed; border-radius: 16px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="background-color: #FFF5F2; display: inline-block; padding: 12px; border-radius: 50%; margin-bottom: 12px;">
              <span style="font-size: 32px;">🎉</span>
            </div>
            <h2 style="color: #FF4E11; font-size: 24px; margin: 0; font-weight: 700;">New Lead Captured!</h2>
            <p style="color: #5f6368; font-size: 14px; margin: 6px 0 0 0;">FrictionPulse Widget Alert</p>
          </div>
          
          <p style="font-size: 16px; line-height: 1.6; color: #202124; margin-bottom: 24px;">
            A customer visited <strong>${safeDomain}</strong>, encountered a hesitation, and requested to be contacted:
          </p>
          
          <div style="background-color: #f8f9fa; padding: 24px; border-radius: 12px; margin-bottom: 24px; border: 1px solid #f1f3f4;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr style="border-bottom: 1px solid #f1f3f4;">
                <td style="padding: 10px 0; font-weight: 600; color: #5f6368; width: 120px; font-size: 14px;">Email:</td>
                <td style="padding: 10px 0; color: #202124; font-size: 14px; word-break: break-all;"><strong>${safeEmail || 'Not provided'}</strong></td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f3f4;">
                <td style="padding: 10px 0; font-weight: 600; color: #5f6368; font-size: 14px;">Phone:</td>
                <td style="padding: 10px 0; color: #202124; font-size: 14px;"><strong>${safePhone || 'Not provided'}</strong></td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f3f4;">
                <td style="padding: 10px 0; font-weight: 600; color: #5f6368; font-size: 14px;">Objection:</td>
                <td style="padding: 10px 0; color: #202124; font-size: 14px;">${safeObjection || 'General hesitation'}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-weight: 600; color: #5f6368; font-size: 14px;">Page URL:</td>
                <td style="padding: 10px 0; color: #0056b3; font-size: 13px; word-break: break-all;">${safePageUrl || 'Unknown'}</td>
              </tr>
            </table>
          </div>
          
          <p style="font-size: 12px; color: #70757a; margin-top: 32px; border-top: 1px solid #e1e8ed; padding-top: 16px; text-align: center;">
            This email was sent dynamically to you by FrictionPulse because a visitor triggered a widget event.
          </p>
        </div>
      `
    });

    if (emailResult.error) {
      logger.error('Resend API returned delivery error', { requestId, error: emailResult.error });
      return res.status(502).json({ error: 'Failed to deliver merchant notification email' });
    }

    // Structured Business-Event Logging: Log successful delivery
    logger.info('Business Event: Lead alert email delivered', {
      requestId,
      siteKey,
      leadId: newRecord.id,
      domain: siteData.domain
    });

    return res.status(200).json({ status: 'Success', message: 'Notification email successfully dispatched' });
  } catch (error) {
    logger.error('Unhandled webhook exception caught', { requestId, error: error.message, stack: error.stack });
    
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }
    
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Sentry error handler middleware must be before any other error middleware
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Fallback unhandled error middleware
app.use((err, req, res, next) => {
  logger.error('Express middleware unhandled error', { error: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info('Production Server started', { port: PORT }));
