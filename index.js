const express = require('express');
const { Resend } = require('resend');

const app = express();
app.use(express.json()); 

const resend = new Resend(process.env.RESEND_API_KEY);

// ১. UptimeRobot-এর জন্য Ping Route (সার্ভার জাগিয়ে রাখার জন্য)
app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake! 🚀');
});

// ২. Supabase থেকে আসা ডেটা রিসিভ করার Webhook
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const newRecord = payload.record;

    // Resend দিয়ে ইমেইল পাঠানো
    await resend.emails.send({
      from: 'onboarding@resend.dev', 
      to: process.env.MY_EMAIL, 
      subject: '🎉 New Activity on FrictionPulse!',
      html: `<h3>New Update in Database:</h3><pre>${JSON.stringify(newRecord, null, 2)}</pre>`
    });

    res.status(200).send('Email sent successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error sending email');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Render backend is running on port ${PORT}`);
});