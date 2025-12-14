// server/utils/sendVerificationEmail.js   ← keep the same path

// CORRECT WAY for resend ^6.6.0 in CommonJS (require)
const { Resend } = require('resend');

// Use env var on Render, fallback only for local testing (remove later for security)
const resend = new Resend('re_gDrH56KC_35b1sqbv63dtC9Q6tGv15QbM');

const sendVerificationEmail = async (email, name, token) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Gcash <gcash@app-pay-swift.com>',   // Make sure this is verified in Resend dashboard
      to: [email],
      subject: 'Verify your email address with Gcash',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; background: #f4f4f4;">
          <h2 style="color: #d32f2f; text-align: center;">Verify Your Email Address</h2>
          
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center;">
            <h3>Hey ${name},</h3>
            <p>Welcome to <strong>Gcash</strong>. Please verify your email address to complete your registration.</p>
            
            <div style="margin: 30px 0; padding: 25px; background: whitesmoke; border-radius: 10px;">
              <h4 style="font-size: 32px; letter-spacing: 8px; color: #d32f2f;">${token}</h4>
              <p>Your verification code</p>
            </div>

            <p style="color: #666; font-size: 14px;">
              This code will expire in <strong>15 minutes</strong>, so be sure to use it soon.
            </p>

            <p>See you there!<br><strong>The Gcash Team</strong></p>
          </div>

          <p style="text-align: center; color: #999; font-size: 12px; margin-top: 30px;">
            © 2025 Gcash. All rights reserved.
          </p>
        </div>
      `
    });

    if (error) {
      console.error('Resend error:', error);
      throw new Error(error.message || 'Failed to send email');
    }

    console.log('Verification email sent successfully:', data.id);
    return data;
  } catch (error) {
    console.error('Failed to send verification email:', error.message || error);
    throw error;
  }
};

module.exports = { sendVerificationEmail };