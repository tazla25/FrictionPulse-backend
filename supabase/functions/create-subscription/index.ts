import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const planIdKey = body.planId;

    if (typeof planIdKey !== "string") {
      return new Response(JSON.stringify({ error: "Invalid parameter types" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let razorpayPlanId = "";
    if (planIdKey === "starter") {
      razorpayPlanId = Deno.env.get("RAZORPAY_PLAN_ID_STARTER") || "";
    } else if (planIdKey === "pro") {
      razorpayPlanId = Deno.env.get("RAZORPAY_PLAN_ID_PRO") || "";
    }

    const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "";
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";

    if (!razorpayPlanId) {
      console.error("Invalid plan ID lookup for:", planIdKey, "=>", razorpayPlanId);
      return new Response(JSON.stringify({ error: "Invalid plan ID" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!keyId || !keySecret) {
      return new Response(JSON.stringify({ error: "Razorpay credentials not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const authString = btoa(`${keyId}:${keySecret}`);

    // Create Subscription
    const rzpRes = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${authString}`
      },
      body: JSON.stringify({
        plan_id: razorpayPlanId,
        total_count: 120, // 10 years
        customer_notify: 1
      })
    });

    const rzpData = await rzpRes.json();

    if (!rzpRes.ok) {
      console.error("Razorpay Error:", rzpData);
      return new Response(JSON.stringify({ error: "Failed to create subscription with Razorpay" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(
      JSON.stringify({
        id: rzpData.id,
        razorpay_key_id: keyId
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({ error: "An unexpected error occurred during subscription creation." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
