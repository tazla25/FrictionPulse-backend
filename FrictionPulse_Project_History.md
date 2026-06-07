# 📊 FrictionPulse Project History & Technical Roadmap

This document provides a comprehensive developmental history, completed improvements, current security and architectural states, and remaining roadmap tasks (including critical launch blockers) for the **FrictionPulse** platform, covering the frontend (widget & dashboard), backend service, and Supabase integration.

---

## 🏗️ 1. Project Overview
**FrictionPulse** is a SaaS platform designed to capture and address customer hesitation on cart and checkout pages. When user hesitation is detected (e.g., cursor moving out of page, inactivity), the injected widget displays reassuring counter-messages answering common customer objections. If the visitor is still unconvinced, the widget captures their lead information (email or phone) or feedback.

The system is composed of:
1. **Frontend Widget (`widget.js`)**: Injected into merchant websites via a script tag. Renders a secure Shadow DOM to prevent style leakage.
2. **Merchant Dashboard (`dashboard.html`)**: A responsive UI where merchants manage sites, objections, view leads, check feedback, and monitor analytics.
3. **Backend Service (`FrictionPulse-backend`)**: A Node.js backend managing webhook alerts, email dispatches, and third-party integrations.
4. **Supabase Database & Edge Functions**: Handled via Supabase RLS and PostgreSQL triggers, with Deno Edge Functions managing Razorpay payment logic.

---

## 📅 2. Development History & Completed Improvements

### Phase 1: Core Observability & Diagnostics (Deployment Readiness)
* **Structured Logging**: Migrated backend print statements to a production-grade **Winston logger** returning structured JSON logs.
* **Error Tracking**: Integrated the **Sentry SDK** on both frontend (`widget.js`) and backend (`index.js`) to capture and report uncaught exceptions.
* **Health Endpoints**: Built a production `/health` endpoint validating database connection, auth admin API responsiveness, and SMTP connection health, alongside a basic `/ping` check.

### Phase 2: Security Lockdown & Multi-Tenant Isolation
* **Row-Level Security (RLS)**: Hardened the database layer by enabling RLS across all tables (`sites`, `objections`, `leads`, `feedback`, `votes`, `widget_views`).
* **Public Write / Merchant Read Access Control**:
  * Revoked direct SELECT/UPDATE permissions from the anonymous (`anon`) role to block table-harvesting attacks.
  * Allowed public widgets (anon) to only perform `INSERT` operations on leads, feedback, votes, and widget views.
  * Restricted SELECT rights for anon to specific non-sensitive columns on `objections` and `widget_views`.
* **Secure Site Key Validation**: Created a `validate_site_key(site_key)` database RPC function configured with `SECURITY DEFINER` and a hardened `search_path`, allowing public widgets to verify site keys without direct access to the `sites` table.
* **Merchant Lookup Fix**: Resolved a critical auth bug in the email alert webhook: mapped incoming `site_key` to the merchant's `user_id` before querying `auth.users` (previously requested user details by `site_key` directly, which failed).
* **Webhook Authorization**: Secured backend endpoints with Bearer Token validation matching a `WEBHOOK_SECRET` environment variable.

### Phase 2.1: Usage Metrics Cache & Concurrency Hardening
* **Real-Time Metrics Cache**: Avoided expensive table scans (`COUNT(*)`) on write paths by implementing a `usage_metrics` cache table tracked by monthly billing cycles.
* **Automatic Increment Triggers**: Added database triggers (`increment_leads_metric`, `increment_feedback_metric`, `increment_views_metric`) that automatically update the cache on new widget entries.
* **Concurrency-Safe Quotas Check**: Implemented `enforce_lead_quota_resilient()` with row-level write locks (`SELECT ... FOR UPDATE`) on the metrics table. If a merchant exceeds their monthly lead quota, the system sets `locked_by_plan = TRUE` instead of raising database errors, preserving data while restricting dashboard display.
* **Concurrent Domain Protection**: Hardened the `check_domain_limit()` trigger with write locking to block race conditions when merchants attempt to bypass domain limitations via concurrent API requests.

### Phase 2.2: Nodemailer SMTP Email Migration
* **Resend to Gmail SMTP**: Migrated backend notification alerts from Resend to Nodemailer SMTP, supporting standard TLS upgrades on Port `587` (STARTTLS) or direct SSL on Port `465`.
* **Email Feature Toggle**: Introduced `ENABLE_EMAIL_NOTIFICATIONS = false` to allow the platform to run cleanly without sending emails, routing alerts directly to the merchant dashboard notifications log.

### Phase 3: Razorpay Subscriptions & Tiered Access Control
* **Razorpay Integration**: Configured backend endpoints to interface with the Razorpay API:
  * `POST /api/payments/create-subscription`: Generates customer subscriptions.
  * `POST /api/payments/verify-subscription`: Validates signatures.
  * `POST /webhook/razorpay`: Processes real-time updates for `subscription.activated`, `charged`, `cancelled`, `pending`, and `halted`.
* **Mock/Test Mode**: Added an environment check bypassing external gateway calls if `RAZORPAY_KEY_ID` starts with `mock_`, simplifying end-to-end payment simulations.
* **Subscription Tiers Configured**:
  * **Free**: 1 Domain | 50 Leads/month (Default fallback)
  * **Starter ($15/mo)**: 3 Domains | 500 Leads/month
  * **Pro ($99/mo)**: 100 Domains | 10,000 Leads/month
* **Plan-Based Dashboard Customization Locks**:
  * Locked widget styling options (color pickers, custom Google Fonts) for Free/Starter plans.
  * Disabled webhook dashboard integrations for non-Pro tiers.
  * Added warning banners advising upgrades to unlock restricted settings.
* **Resource Usage Indicators**: Rendered animated progress bars in the dashboard's Billing tab displaying active usage metrics relative to subscription limits.

### Phase 4: Critical Vulnerability Remediation & Security Hardening
* **Stored XSS Vulnerabilities**:
  * **Finding**: High-severity Stored XSS existed throughout `dashboard.html` and `widget.js` due to dynamic variables (e.g., `lead.email`, `fb.message`) outputted directly into `.innerHTML` blocks.
  * **Fix**: Implemented a robust `escapeHtml` function and refactored DOM construction to either use `textContent` (in `widget.js`) or explicitly escape all dynamic variables rendered inside HTML templates.
* **Client-Side Billing Bypass**:
  * **Finding**: The upgrade flow in `dashboard.html` (`checkoutSubscription`) contained a `subDetails.mock` block that bypassed Razorpay validation completely, allowing users to unlock premium tiers via client-side manipulation.
  * **Fix**: Removed the mock subscription block entirely and forced the client to execute the real Razorpay integration. `create-subscription` edge function was also patched to remove the `mock: false` response property.
* **Webhook Idempotency**:
  * **Finding**: The `razorpay-webhook` edge function did not track processed events, making it vulnerable to duplicate webhook deliveries which could corrupt subscription states.
  * **Fix**: Created a `processed_webhooks` table. The webhook edge function now extracts `event_id`, verifies against the table, processes the payload, and inserts the `event_id` to prevent duplicate processing.
* **`escapeHtml` Array Bypass (Backend)**:
  * **Finding**: In `index.js` of the backend, the `escapeHtml` utility function did not enforce string types, allowing payload arrays to bypass regex filtering.
  * **Fix**: Modified `escapeHtml` to explicitly cast input payloads to `String(str)` before executing the `.replace()` method.
* **Strict Type Validation on API and Edge Functions**:
  * **Fix**: Enforced `typeof === 'string'` checks on all request body payloads parsed by `index.js` and Edge Functions (`create-subscription/index.ts`, `verify-subscription/index.ts`) to prevent string-concatenation bypasses.
* **Razorpay Subscription Cancellation (Billing Blocker Resolved)**:
  * **Fix**: Implemented the server-side `cancel-subscription` Supabase Edge Function to interface directly with the Razorpay API to cancel active mandates immediately (`cancel_at_cycle_end: 0`). Refactored `dashboard.html`'s downgrade logic to invoke this Edge Function instead of performing a client-side direct database `PATCH`.
* **Final Security Hardening Merged**:
  * **Fix**: Enforced a strict Content Security Policy (CSP) header across `dashboard.html`, `demo.html`, `index.html`, and `pricing.html` (restricting resources to self, Vercel, Supabase, Google Fonts, and Razorpay). Secured dynamic objection rendering in `dashboard.html` by shifting from `.innerHTML` to safe DOM nodes (`createElement`, `textContent`). Added regex-based email input validation to `widget.js` before submitting captured lead/feedback events.

---

## 🔒 3. Supabase Schema Structure & RLS Status

The database project `amtalgsyuedgayxkxijw` includes the following tables:

| Table Name | Row Count | RLS Enabled | Description |
| :--- | :---: | :---: | :--- |
| `public.sites` | 118 | **Yes** | Stores merchant sites, domains, and private `site_key` credentials. Protected by policy: `auth.uid() = user_id`. |
| `public.objections` | 65 | **Yes** | Objection cards and reassurance messages. Public anon users have read-only access. |
| `public.votes` | 21 | **Yes** | Widget upvotes/downvotes. Public anon users can `INSERT`. |
| `public.feedback` | 6 | **Yes** | Customer feedback submissions. Public anon users can `INSERT`. |
| `public.leads` | 10,557 | **Yes** | Captured lead details (email/phone). Public anon users can `INSERT`. |
| `public.widget_views` | 173 | **Yes** | Analytics tracking widget impressions. Public anon users can `INSERT`. |
| `public.billing_subscriptions` | 5 | **Yes** | Stores payment details and plan tiers. Managed by service role; read-only for merchants. |
| `public.processed_webhooks` | 0 | **Yes** | Keeps track of processed Razorpay webhooks to enforce idempotency. |
| `public.usage_metrics` | - | **Yes** | Real-time cache of lead/feedback usage per user account. Read-only for merchants. |
| `public.email_alerts` | 2 | **Yes** | Logs of sent backend notifications. |

---

## 🎯 4. Features & Improvements Remaining (Roadmap)

### 🚨 Critical Launch Blockers (Resolved ✅)
- [x] **1. Create a `cancel-subscription` Supabase Edge Function**:
  * **Status**: Resolved. The edge function is fully implemented and securely handles server-side Razorpay cancellations via basic authentication.
- [x] **2. Update dashboard.html Downgrade Logic**:
  * **Status**: Resolved. Refactored `checkoutSubscription` to call the `/cancel-subscription` Edge Function using the user's active session token, avoiding direct database modifications and RLS errors.

### UI & UX Enhancements
- [x] **3. Conversion Funnel (Overview Tab)**:
  * **Status**: Completed. Added a beautiful vertical funnel visualization (`Visitors ➔ Objection Clicks ➔ Captured Leads ➔ Converted Leads`) rendering real-time performance bars, percentage conversion calculations, and drop-off metrics dynamically.
- [x] **4. Lead/Feedback Detail Page & Activity Timeline**:
  * **Status**: Completed. Replaced the third-party modal with a dedicated details view (`tab-details`) inside the dashboard, featuring a chronological activity timeline displaying widget load, objection trigger, submission, and status changes.
- [x] **5. Inline Editing for Objections**:
  * **Status**: Completed. Enabled inline text updates for objection labels and reassurance messages directly inside the settings tables.

### Integrations & Customizations
- [x] **6. Webhook Destinations Interface (Pro Tier)**:
  * **Status**: Completed. Added an interface allowing Pro merchants to input third-party webhook destination URLs and check triggering checkboxes, stored securely in localStorage per site.
- [x] **7. A/B Testing**:
  * **Status**: Completed. Added full support for setting up multiple reassurance messages per objection (Version A/Version B) to evaluate conversion efficiencies.
- [ ] **8. Export Expansion**:
  * **Status**: Partially Completed. CSV and JSON format downloads are fully supported for leads and feedback. Direct Google Sheets pushes remain as a future roadmap item.
- [x] **9. Global Search & Tagging**:
  * **Status**: Completed. Added global search input filtering leads/feedback/objections, and enabled custom tags (e.g., `"VIP"`, `"Needs Followup"`) on leads and feedback records.

### Backend & Database Enhancements
- [x] **10. Database-Level Check Constraints**:
  * **Status**: Completed. Added strict PostgreSQL CHECK constraints to validate emails, URLs, phone numbers, and string lengths directly on the Supabase database.
