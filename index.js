const express = require('express');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// Supabase-এর সাথে কানেকশন তৈরি
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// UptimeRobot-এর জন্য
app.get('/ping', (req, res) => res.status(200).send('Server is awake! 🚀'));

// Supabase থেকে ডেটা রিসিভ করা
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const newRecord = payload.record; 
    
    // ধরে নিচ্ছি উইজেটের ডেটাতে merchant_id আছে
    const merchantId = newRecord.merchant_id;

    if (!merchantId) {
      return res.status(400).send('Merchant ID is missing from the record');
    }

    // ১. ডাটাবেস থেকে নির্দিষ্ট মার্চেন্টের ইমেইল খুঁজে বের করা
    const { data: merchant, error } = await supabase
      .from('merchants') // তোমার মার্চেন্টদের টেবিলের নাম
      .select('email')
      .eq('id', merchantId)
      .single();

    if (error || !merchant) {
      console.error("Merchant not found in database:", error);
      return res.status(404).send('Merchant not found');
    }

    const merchantEmail = merchant.email;

    // ২. সরাসরি সেই মার্চেন্টের ইমেইলে নোটিফিকেশন পাঠানো
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: merchantEmail,
      subject: '🎉 New Lead on Your Website!',
      html: `<h3>Great news! A customer interacted with your widget:</h3><pre>${JSON.stringify(newRecord, null, 2)}</pre>`
    });

    res.status(200).send('Dynamic Email sent to the merchant successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing webhook');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render backend running on port ${PORT}`));
