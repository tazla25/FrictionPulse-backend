# FrictionPulse Backend & Edge Function Input Validation Audit Report

This document outlines the findings of a comprehensive backend and Edge Function validation audit. The focus is on ensuring all public inputs (email, phone, URLs, lead data, feedback payloads, objection content, webhook payloads) are correctly validated and sanitized on the server side.

## 1. High Severity: `escapeHtml` Array Bypass Vulnerability

**Location:** `index.js` -> `escapeHtml(str)`

**Description:**
The backend defines a custom HTML escaping utility to sanitize user-provided values (e.g., `email`, `phone`, `objection_id`, `page_url`, `domain`) before embedding them in outgoing email templates. The function includes the following logic:

```javascript
function escapeHtml(str) {
  if (!str) return '';
  if (typeof str !== 'string') return String(str);
  return str.replace(/[&<>"']/g, (m) => { ... });
}
```

The `if (typeof str !== 'string') return String(str);` check is flawed. If an attacker passes an array (e.g., via a JSON payload: `"email": ["<script>alert(1)</script>"]`), `typeof str` evaluates to `'object'`. The function then immediately returns `String(["<script>alert(1)</script>"])`, which evaluates to `"<script>alert(1)</script>"`, completely bypassing the `.replace()` regex sanitization.

**Impact:**
This allows attackers to inject malicious HTML/JavaScript or perform Email Injection attacks by bypassing the custom sanitization logic.

**Recommendation:**
Cast the input to a string *before* evaluating or returning it, ensuring the `.replace()` function is always called on stringified inputs.

```javascript
function escapeHtml(str) {
  if (!str) return '';
  const stringified = String(str);
  return stringified.replace(/[&<>"']/g, (m) => { ... });
}
```

---

## 2. Medium Severity: Missing Strict Type Checking on API Endpoint Inputs

**Location:** `index.js` -> `/api/create-subscription` and `/api/verify-subscription` POST endpoints

**Description:**
Both backend payment API endpoints perform existence checks for required fields in `req.body` but fail to enforce that these fields are exclusively strings.

For `/api/create-subscription`:
```javascript
const { planId } = req.body;
if (!planId || !['starter', 'growth', 'pro'].includes(planId)) { ... }
```
*(Less severe here due to the strict array inclusion check).*

For `/api/verify-subscription`:
```javascript
const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = req.body;
if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !planId) { ... }
```

**Impact:**
Passing non-string inputs (like objects or arrays) to properties like `razorpay_payment_id` and `razorpay_subscription_id` can cause unintended behavior when these values are later concatenated to generate the expected HMAC signature:
```javascript
const body = razorpay_payment_id + '|' + razorpay_subscription_id;
```
If an attacker passes arrays/objects, this could result in type coercion anomalies (`[object Object]|[object Object]`).

**Recommendation:**
Add explicit `typeof parameter === 'string'` checks for all `req.body` parameters before processing.

---

## 3. Medium Severity: Missing Strict Type Checking on Edge Function Inputs

**Location:** Edge Functions -> `create-subscription/index.ts` and `verify-subscription/index.ts`

**Description:**
Similar to the backend API endpoints, the Edge Functions parse the request JSON body but do not enforce strict string types.

In `verify-subscription/index.ts`:
```typescript
const body = await req.json();
const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = body;

// ...
const generatedSignatureData = `${razorpay_payment_id}|${razorpay_subscription_id}`;
```

**Impact:**
Just like the main backend, relying on implicit template literal stringification of unknown input types (potentially arrays or nested objects) can lead to subtle bugs or signature generation bypasses if an attacker intentionally malforms the JSON body.

**Recommendation:**
Enforce strict validation inside the Edge Functions:
```typescript
if (
  typeof razorpay_payment_id !== 'string' ||
  typeof razorpay_subscription_id !== 'string' ||
  typeof razorpay_signature !== 'string'
) {
  return new Response(JSON.stringify({ error: "Invalid parameter types" }), { status: 400 });
}
```

---

## 4. Low to Medium Severity: Insufficient Data-Level Validation in Supabase

**Location:** Supabase Public Tables (`objections`, `feedback`, `sites`)

**Description:**
A review of the Supabase schema (`public.objections`, `public.feedback`, `public.sites`) shows that while some fields (`email`, `phone`, `page_url`) have rigorous regular expression checks enforced via Check Constraints, other text-heavy fields are only constrained by length.

For example, `public.objections`:
- `label`: `CHECK (length(label) <= 255)`
- `counter_message`: `CHECK (counter_message IS NULL OR length(counter_message) <= 1000)`

`public.feedback`:
- `message`: `CHECK (length(message) <= 2000)`

**Impact:**
Because there are no strict alphanumeric or content-filtering checks at the database layer for these fields, raw HTML tags, script payloads, and malformed characters can be successfully inserted into the database. If any future frontend service or backend worker renders these fields without running them through a proper HTML escaper first, a Stored XSS vulnerability will manifest.

**Recommendation:**
While completely preventing HTML characters in text bodies at the DB level is often overly restrictive for a SaaS application, it is highly recommended to either:
1. Strip HTML tags at the API level *before* inserting into Supabase.
2. Ensure that any microservice, worker, or UI component that queries these tables implements strict DOM sanitization (e.g., using DOMPurify on the frontend).
