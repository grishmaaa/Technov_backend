/**
 * Email verification template
 */
export const verificationEmailTemplate = ({ verifyUrl, name }) => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td align="center" style="padding: 40px 40px 20px 40px;">
                            <div style="font-size: 48px; margin-bottom: 10px;">🎬</div>
                            <h1 style="margin: 0; font-size: 28px; font-weight: bold; color: #1a1a1a;">Technov AI</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 0 40px 40px 40px;">
                            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">
                                Verify Your Email Address
                            </h2>

                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Hi ${name},
                            </p>

                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Thanks for signing up for Technov AI! We're excited to have you on board.
                                To get started, please verify your email address by clicking the button below.
                            </p>

                            <!-- CTA Button -->
                            <table role="presentation" style="margin: 30px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${verifyUrl}"
                                           style="display: inline-block; padding: 16px 40px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 6px;">
                                            Verify Email Address
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 30px 0 10px 0; font-size: 14px; line-height: 1.6; color: #6a6a6a;">
                                Or copy and paste this link into your browser:
                            </p>
                            <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #0066ff; word-break: break-all;">
                                ${verifyUrl}
                            </p>

                            <p style="margin: 20px 0 0 0; font-size: 14px; line-height: 1.6; color: #6a6a6a;">
                                This verification link will expire in 24 hours.
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px 40px; background-color: #f9f9f9; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0 0 10px 0; font-size: 14px; color: #6a6a6a;">
                                If you didn't create an account with Technov AI, you can safely ignore this email.
                            </p>
                            <p style="margin: 0; font-size: 14px; color: #6a6a6a;">
                                © ${new Date().getFullYear()} Technov AI. All rights reserved.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim();
};
