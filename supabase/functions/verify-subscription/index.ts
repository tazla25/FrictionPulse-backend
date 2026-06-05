import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyHmacSha256(data: string, signature: string, secret: string) {
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
    new TextEncoder().encode(data)
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const token = authHeader.replace('Bearer ', '');

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseUserClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseUserClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planId } = body;

    if (
      typeof razorpay_payment_id !== 'string' ||
      typeof razorpay_subscription_id !== 'string' ||
      typeof razorpay_signature !== 'string' ||
      typeof planId !== 'string'
    ) {
      return new Response(JSON.stringify({ error: "Invalid parameter types" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");

    if (!keySecret) {
      return new Response(JSON.stringify({ error: "Razorpay credentials not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify signature
    const generatedSignatureData = `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const isValid = await verifyHmacSha256(generatedSignatureData, razorpay_signature, keySecret);

    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid payment signature" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Update or Insert Billing Subscription
    const { error: upsertError } = await supabaseAdmin
      .from('billing_subscriptions')
      .upsert({
        user_id: user.id,
        plan_tier: planId,
        status: 'active',
        razorpay_subscription_id: razorpay_subscription_id,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (upsertError) {
       console.error("Supabase upsert error:", upsertError);
       return new Response(JSON.stringify({ error: "Failed to update subscription status" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({ error: "An unexpected error occurred during payment verification." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
