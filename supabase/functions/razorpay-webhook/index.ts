import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyWebhookSignature(bodyText: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = new Uint8Array(
    signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );

  return await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(bodyText)
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const signature = req.headers.get("x-razorpay-signature");
    if (!signature) {
      return new Response("No signature found", { status: 400 });
    }

    const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error("RAZORPAY_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const bodyText = await req.text();
    const isValid = await verifyWebhookSignature(bodyText, signature, webhookSecret);

    if (!isValid) {
      return new Response("Invalid signature", { status: 400 });
    }

    const event = JSON.parse(bodyText);
    const eventId = event.event_id || req.headers.get("x-razorpay-event-id"); // fallback
    console.log("Received Razorpay event:", event.event, "ID:", eventId);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    if (eventId) {
      // Check idempotency
      const { data: existingWebhook, error: checkError } = await supabaseAdmin
        .from('processed_webhooks')
        .select('id')
        .eq('id', eventId)
        .single();

      if (existingWebhook) {
        console.log(`Webhook event ${eventId} already processed. Skipping.`);
        return new Response("Ok", { status: 200 });
      }
    }

    if (event.event === "subscription.charged" || event.event === "subscription.activated") {
       const sub = event.payload.subscription.entity;
       const razorpay_subscription_id = sub.id;
       const razorpay_customer_id = sub.customer_id;

       let current_period_end = null;
       if (sub.current_end) {
          current_period_end = new Date(sub.current_end * 1000).toISOString();
       }

       // Find the user by razorpay_subscription_id
       const { data: existingSub, error: findError } = await supabaseAdmin
        .from('billing_subscriptions')
        .select('user_id, updated_at')
        .eq('razorpay_subscription_id', razorpay_subscription_id)
        .single();

       if (findError) {
         console.error("Could not find subscription to update", findError);
       } else if (existingSub) {
         await supabaseAdmin
           .from('billing_subscriptions')
           .update({
             status: sub.status === 'active' ? 'active' : 'inactive',
             current_period_end: current_period_end,
             razorpay_customer_id: razorpay_customer_id,
             updated_at: new Date().toISOString()
           })
           .eq('user_id', existingSub.user_id);
       }
    }

    if (event.event === "subscription.cancelled" || event.event === "subscription.halted") {
       const sub = event.payload.subscription.entity;
       const razorpay_subscription_id = sub.id;

       await supabaseAdmin
           .from('billing_subscriptions')
           .update({
             status: 'cancelled',
             updated_at: new Date().toISOString()
           })
           .eq('razorpay_subscription_id', razorpay_subscription_id);
    }

    if (eventId) {
      await supabaseAdmin
        .from('processed_webhooks')
        .insert({ id: eventId });
    }

    return new Response("Ok", { status: 200 });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});
