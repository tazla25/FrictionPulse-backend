const express = require('express');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const Sentry = require('@sentry/node');
const winston = require('winston');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────
// 1. STARTUP CONFIGURATION & ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'WEBHOOK_SECRET'
];

REQUIRED_ENV.forEach((envName) => {
  if (!process.env[envName]) {
    console.error(`[FATAL ERROR] Missing required environment variable: ${envName}`);
    process.exit(1);
  }
});

// Razorpay Environment Variables validation with fallback warnings
const RAZORPAY_ENV = [
  { key: 'RAZORPAY_KEY_ID', fallback: 'mock_key_id' },
  { key: 'RAZORPAY_KEY_SECRET', fallback: 'mock_key_secret' },
  { key: 'RAZORPAY_PLAN_STARTER_ID', fallback: 'mock_plan_starter_id' },
  { key: 'RAZORPAY_PLAN_GROWTH_ID', fallback: 'mock_plan_growth_id' },
  { key: 'RAZORPAY_PLAN_PRO_ID', fallback: 'mock_plan_pro_id' },
  { key: 'RAZORPAY_WEBHOOK_SECRET', fallback: 'mock_webhook_secret' }
];

RAZORPAY_ENV.forEach(({ key, fallback }) => {
  if (!process.env[key]) {
    console.warn(`[WARNING] Missing Razorpay environment variable: ${key}. Falling back to mock/warning value.`);
    process.env[key] = fallback;
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

// Enable CORS for frontend requests
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, apikey");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: parseInt(process.env.SMTP_PORT, 10) === 465, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

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
  const stringified = String(str);
  return stringified.replace(/[&<>"']/g, (m) => {
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

    // C. Verify Email service SMTP connectivity
    if (transporter) {
      try {
        await transporter.verify();
        healthInfo.services.email_service = 'configured_active';
      } catch (emailError) {
        logger.warn('SMTP verification failed', { error: emailError.message });
        healthInfo.services.email_service = 'configured_error';
      }
    } else {
      healthInfo.services.email_service = 'not_configured';
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

    // F. Send Dynamic Email Alert (TEMPORARILY DISABLED)
    const ENABLE_EMAIL_NOTIFICATIONS = false;

    if (ENABLE_EMAIL_NOTIFICATIONS && transporter) {
      logger.info('Dispatching email alert via Gmail SMTP', { requestId, recipient: maskEmail(merchantEmail) });
      try {
        await transporter.sendMail({
          from: process.env.SENDER_EMAIL,
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
        logger.info('Email dispatch successful');
      } catch (emailError) {
        logger.error('Nodemailer SMTP returned delivery error', { requestId, error: emailError.message });
        // Email delivery is optional and should not prevent a successful webhook response
      }
    } else {
      logger.info('Email alerts are temporarily disabled or SMTP not configured; skipping email dispatch.', {
        emailNotificationsEnabled: ENABLE_EMAIL_NOTIFICATIONS,
        hasTransporter: !!transporter
      });
    }

    // Structured Business-Event Logging: Log successful saving and dashboard notification creation
    logger.info('Business Event: Dashboard notification created for lead', {
      requestId,
      siteKey,
      leadId: newRecord.id,
      domain: siteData.domain
    });

    return res.status(200).json({ status: 'Success', message: 'Lead saved and dashboard notification created' });
  } catch (error) {
    logger.error('Unhandled webhook exception caught', { requestId, error: error.message, stack: error.stack });
    
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }
    
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 8.5. RAZORPAY WEBHOOK ENDPOINT
// ─────────────────────────────────────────────────────────────────────────
app.post('/webhook/razorpay', async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9).toUpperCase();
  logger.info('Razorpay webhook execution started', { requestId });

  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const isMockSecret = !secret || secret === 'mock_webhook_secret';

    if (!isMockSecret) {
      if (!signature) {
        logger.warn('Unauthorized Razorpay webhook request: missing signature header', { requestId });
        return res.status(400).json({ error: 'Bad Request: Missing signature' });
      }
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody || '')
        .digest('hex');

      if (signature !== expectedSignature) {
        logger.warn('Forbidden Razorpay webhook request: signature mismatch', { requestId });
        return res.status(400).json({ error: 'Bad Request: Invalid webhook signature' });
      }
    } else {
      logger.info('Skipping signature check for mock webhook secret', { requestId });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      logger.warn('Bad request payload: body is empty or not an object', { requestId });
      return res.status(400).json({ error: 'Bad Request: Invalid payload body' });
    }

    const eventType = payload.event;
    const supportedEvents = [
      'subscription.activated',
      'subscription.charged',
      'subscription.cancelled',
      'subscription.pending',
      'subscription.halted'
    ];

    if (!supportedEvents.includes(eventType)) {
      logger.info('Received unsupported Razorpay event type', { requestId, eventType });
      return res.status(200).json({ received: true, ignored: true });
    }

    const notes = payload.payload?.subscription?.entity?.notes || 
                  payload.payload?.payment?.entity?.notes || 
                  {};
    const userId = notes.user_id;

    // Log the event in billing_events table
    const { error: eventLogError } = await supabase
      .from('billing_events')
      .insert({
        user_id: userId || null,
        event_type: eventType,
        processor: 'razorpay',
        payload: payload
      });

    if (eventLogError) {
      logger.error('Failed to log Razorpay webhook event to billing_events', {
        requestId,
        error: eventLogError.message,
        eventType,
        userId
      });
    } else {
      logger.info('Logged Razorpay webhook event to billing_events', {
        requestId,
        eventType,
        userId
      });
    }

    if (!userId) {
      logger.warn('No user_id found in notes. Skipping subscription upsert.', { requestId, eventType });
      return res.status(200).json({ success: true, message: 'Event logged but subscription upsert skipped (no user_id)' });
    }

    const entity = payload.payload?.subscription?.entity || 
                   payload.payload?.payment?.entity || 
                   {};
    const subscriptionId = payload.payload?.subscription?.entity?.id || entity.id || null;

    let status;
    let planTier;
    let currentPeriodEnd;

    if (eventType === 'subscription.activated' || eventType === 'subscription.charged') {
      status = 'active';
      planTier = notes.plan_tier || 'starter';
      if (entity.current_end) {
        currentPeriodEnd = new Date(entity.current_end * 1000).toISOString();
      } else {
        currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      }
    } else if (eventType === 'subscription.cancelled') {
      status = 'canceled';
      planTier = 'free';
    } else if (eventType === 'subscription.pending') {
      status = 'past_due';
      planTier = notes.plan_tier || 'free';
    } else if (eventType === 'subscription.halted') {
      status = 'halted';
      planTier = 'free';
    }

    const upsertData = {
      user_id: userId,
      plan_tier: planTier,
      status: status,
      updated_at: new Date().toISOString()
    };

    if (subscriptionId) {
      upsertData.razorpay_subscription_id = subscriptionId;
    }

    if (currentPeriodEnd) {
      upsertData.current_period_end = currentPeriodEnd;
    }

    logger.info('Upserting billing subscription from webhook', {
      requestId,
      userId,
      subscriptionId,
      planTier,
      status,
      currentPeriodEnd
    });

    const { error: dbError } = await supabase
      .from('billing_subscriptions')
      .upsert(upsertData, { onConflict: 'user_id' });

    if (dbError) {
      logger.error('Failed to upsert billing subscription from webhook', {
        requestId,
        userId,
        error: dbError.message
      });
      throw new Error(`Database upsert failed: ${dbError.message}`);
    }

    logger.info('Billing subscription upserted successfully from webhook', {
      requestId,
      userId
    });

    return res.status(200).json({
      success: true,
      message: 'Subscription updated successfully'
    });

  } catch (error) {
    logger.error('Unhandled Razorpay webhook exception caught', {
      requestId,
      error: error.message,
      stack: error.stack
    });

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }

    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 9. CREATE SUBSCRIPTION ENDPOINT
// ─────────────────────────────────────────────────────────────────────────
app.get(['/api/payments/create-subscription', '/api/create-subscription'], (req, res) => {
  return res.status(405).json({ error: 'Method Not Allowed. Please send a POST request containing your authentication token and planId.' });
});

app.post(['/api/payments/create-subscription', '/api/create-subscription'], async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9).toUpperCase();
  logger.info('Create subscription request started', { requestId });

  let user = null;

  try {
    // A. Bearer Token Authentication
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Unauthorized subscription request: missing or invalid authorization header', { requestId });
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const token = authHeader.split(' ')[1];
    const authResult = await supabase.auth.getUser(token);
    user = authResult.data ? authResult.data.user : null;
    const authError = authResult.error;
    
    if (authError || !user) {
      logger.warn('Unauthorized subscription request: invalid user token', { 
        requestId, 
        error: authError ? authError.message : 'No user found' 
      });
      return res.status(401).json({ error: 'Unauthorized: Invalid authentication token' });
    }

    // B. Payload Validation
    const { planId } = req.body;
    if (typeof planId !== 'string' || !planId || !['starter', 'growth', 'pro'].includes(planId)) {
      logger.warn('Bad subscription request: invalid planId', { requestId, planId });
      return res.status(400).json({ error: 'Bad Request: Invalid or missing planId. Must be "starter", "growth", or "pro".' });
    }

    // C. Mock Mode Check
    const keyId = process.env.RAZORPAY_KEY_ID;
    if (keyId === 'mock_key_id' || (keyId && keyId.startsWith('mock_'))) {
      const randomString = Math.random().toString(36).substring(2, 15);
      const mockResponse = {
        id: `sub_mock_${randomString}`,
        plan_id: planId,
        status: 'created',
        user_id: user.id,
        mock: true
      };
      logger.info('Mock subscription generated', { requestId, planId, userId: user.id });
      return res.status(200).json(mockResponse);
    }

    // D. Real Mode Execution
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });

    let planEnvKey;
    if (planId === 'starter') {
      planEnvKey = 'RAZORPAY_PLAN_STARTER_ID';
    } else if (planId === 'growth') {
      planEnvKey = 'RAZORPAY_PLAN_GROWTH_ID';
    } else if (planId === 'pro') {
      planEnvKey = 'RAZORPAY_PLAN_PRO_ID';
    }

    const razorpayPlanId = process.env[planEnvKey];
    if (!razorpayPlanId) {
      logger.error('Razorpay plan ID environment variable not set', { requestId, planEnvKey });
      return res.status(500).json({ error: `Internal Server Error: Missing configuration for ${planId}` });
    }

    const subscriptionOptions = {
      plan_id: razorpayPlanId,
      total_count: 120, // 10 years (monthly)
      quantity: 1,
      customer_notify: 1,
      notes: {
        user_id: user.id,
        plan_tier: planId
      }
    };

    logger.info('Initiating Razorpay API subscription creation', { 
      requestId, 
      planId, 
      razorpayPlanId 
    });

    const subscription = await razorpay.subscriptions.create(subscriptionOptions);
    
    logger.info('Razorpay subscription created successfully', { 
      requestId, 
      subscriptionId: subscription.id 
    });

    const responsePayload = Object.assign({}, subscription, { razorpay_key_id: keyId });
    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error("[DETAILED EXCEPTION] inside POST /api/create-subscription:");
    console.error("- Request Body:", JSON.stringify(req.body));
    console.error("- planId:", req.body ? req.body.planId : 'undefined');
    console.error("- User ID:", (typeof user !== 'undefined' && user) ? user.id : 'undefined');
    console.error("- Supabase User Object:", (typeof user !== 'undefined' && user) ? JSON.stringify(user) : 'undefined');
    console.error("- Error Message:", error.message);
    console.error("- Error Stack:", error.stack);

    logger.error('Unhandled subscription creation exception caught', { 
      requestId, 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      userId: (typeof user !== 'undefined' && user) ? user.id : null
    });

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }

    return res.status(500).json({ 
      error: 'Internal Server Error', 
      details: { 
        message: error.message, 
        stack: error.stack 
      } 
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 10. VERIFY SUBSCRIPTION ENDPOINT
// ─────────────────────────────────────────────────────────────────────────
app.get(['/api/payments/verify-subscription', '/api/verify-subscription'], (req, res) => {
  return res.status(405).json({ error: 'Method Not Allowed. Please send a POST request containing your authentication token, payment details, and planId.' });
});

app.post(['/api/payments/verify-subscription', '/api/verify-subscription'], async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9).toUpperCase();
  logger.info('Verify subscription request started', { requestId });

  let user = null;
  let dbError = null;

  try {
    // A. Bearer Token Authentication
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Unauthorized verification request: missing or invalid authorization header', { requestId });
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const token = authHeader.split(' ')[1];
    const authResult = await supabase.auth.getUser(token);
    user = authResult.data ? authResult.data.user : null;
    const authError = authResult.error;
    
    if (authError || !user) {
      logger.warn('Unauthorized verification request: invalid user token', { 
        requestId, 
        error: authError ? authError.message : 'No user found' 
      });
      return res.status(401).json({ error: 'Unauthorized: Invalid authentication token' });
    }

    // B. Request Payload Validation
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = req.body;
    if (
      typeof razorpay_payment_id !== 'string' ||
      typeof razorpay_subscription_id !== 'string' ||
      typeof razorpay_signature !== 'string' ||
      typeof planId !== 'string' ||
      !razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !planId
    ) {
      logger.warn('Bad verification request: missing parameters', { 
        requestId, 
        hasPaymentId: !!razorpay_payment_id,
        hasSubId: !!razorpay_subscription_id,
        hasSig: !!razorpay_signature,
        hasPlanId: !!planId 
      });
      return res.status(400).json({ error: 'Bad Request: Missing required parameters' });
    }

    const isMock = razorpay_subscription_id.startsWith('sub_mock_');

    if (!isMock) {
      // C. Real Verification
      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!secret) {
        logger.error('Razorpay key secret not configured for verification', { requestId });
        return res.status(500).json({ error: 'Internal Server Error: Payment verification misconfigured' });
      }
      const body = razorpay_payment_id + '|' + razorpay_subscription_id;
      const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');

      if (razorpay_signature !== expectedSignature) {
        logger.warn('Signature mismatch for verification request', { 
          requestId, 
          subscriptionId: razorpay_subscription_id 
        });
        return res.status(400).json({ error: 'Bad Request: Invalid payment signature' });
      }
    } else {
      logger.info('Skipping signature check for mock subscription', { 
        requestId, 
        subscriptionId: razorpay_subscription_id 
      });
    }

    // D. Database Sync / Upsert
    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    
    logger.info('Upserting billing subscription', { 
      requestId, 
      userId: user.id, 
      subscriptionId: razorpay_subscription_id, 
      planId, 
      currentPeriodEnd 
    });

    const dbUpsertResult = await supabase
      .from('billing_subscriptions')
      .upsert({
        user_id: user.id,
        razorpay_subscription_id: razorpay_subscription_id,
        plan_tier: planId,
        status: 'active',
        current_period_end: currentPeriodEnd,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
    dbError = dbUpsertResult.error;

    if (dbError) {
      logger.error('Failed to upsert billing subscription', { 
        requestId, 
        userId: user.id, 
        error: dbError.message 
      });
      throw new Error(`Database upsert failed: ${dbError.message}`);
    }

    logger.info('Billing subscription upserted successfully', { 
      requestId, 
      userId: user.id 
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Subscription verified and recorded successfully' 
    });

  } catch (error) {
    console.error("[DETAILED EXCEPTION] inside POST /api/verify-subscription:");
    console.error("- Request Body:", JSON.stringify(req.body));
    console.error("- planId:", req.body ? req.body.planId : 'undefined');
    console.error("- User ID:", (typeof user !== 'undefined' && user) ? user.id : 'undefined');
    console.error("- Supabase User Object:", (typeof user !== 'undefined' && user) ? JSON.stringify(user) : 'undefined');
    console.error("- Database Update Result (error parameter):", (typeof dbError !== 'undefined' && dbError) ? JSON.stringify(dbError) : 'N/A');
    console.error("- Error Message:", error.message);
    console.error("- Error Stack:", error.stack);

    logger.error('Unhandled verification exception caught', { 
      requestId, 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      userId: (typeof user !== 'undefined' && user) ? user.id : null
    });

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }

    return res.status(500).json({ 
      error: 'Internal Server Error', 
      details: { 
        message: error.message, 
        stack: error.stack 
      } 
    });
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
app.listen(PORT, async () => {
  logger.info('Production Server started', { port: PORT });
  
  // Verify SMTP Connection at startup (if configured)
  if (transporter) {
    logger.info('Verifying SMTP connection...');
    try {
      await transporter.verify();
      logger.info('SMTP connection successfully verified at startup');
    } catch (error) {
      logger.error('SMTP connection verification failed at startup', { error: error.message, stack: error.stack });
    }
  } else {
    logger.info('SMTP connection verification skipped: no SMTP provider configured');
  }
});
