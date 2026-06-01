const express = require('express');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// সুপাবেসের সাথে কানেকশন (Service Role Key লাগবে auth.users দেখার জন্য)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/ping', (req, res) => res.status(200).send('Server is awake! 🚀'));

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const newRecord = payload.record; 
    
    // ফ্রন্টএন্ড থেকে আসা site_key
    const siteKey = newRecord.site_key;

    if (!siteKey) {
      return res.status(400).send('Site Key is missing from the record');
    }

    // ১. Supabase Auth থেকে মার্চেন্টের ইমেইল খুঁজে বের করা
    const { data: userData, error } = await supabase.auth.admin.getUserById(siteKey);

    if (error || !userData || !userData.user) {
      console.error("Merchant not found in auth.users:", error);
      return res.status(404).send('Merchant not found');
    }

    const merchantEmail = userData.user.email;

    // ২. সরাসরি সেই নির্দিষ্ট মার্চেন্টের ইমেইলে নোটিফিকেশন পাঠানো
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
