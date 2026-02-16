/**
 * Welcome email template
 */
export const welcomeEmailTemplate = ({ dashboardUrl, name }) => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Technov AI</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td align="center" style="padding: 40px 40px 20px 40px;">
                            <div style="font-size: 64px; margin-bottom: 10px;">🎉</div>
                            <h1 style="margin: 0; font-size: 28px; font-weight: bold; color: #1a1a1a;">Welcome to Technov AI!</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 0 40px 40px 40px;">
                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Hi ${name},
                            </p>

                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Welcome aboard! We're thrilled to have you join Technov AI.
                                You're now part of a community creating amazing AI-generated videos.
                            </p>

                            <div style="margin: 30px 0; padding: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px;">
                                <h3 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #ffffff;">
                                    Get Started in 3 Easy Steps
                                </h3>
                                <div style="margin-bottom: 12px;">
                                    <span style="display: inline-block; width: 28px; height: 28px; background-color: rgba(255,255,255,0.2); border-radius: 50%; text-align: center; line-height: 28px; color: #ffffff; font-weight: bold; margin-right: 12px;">1</span>
                                    <span style="font-size: 15px; color: #ffffff;">Create your first project</span>
                                </div>
                                <div style="margin-bottom: 12px;">
                                    <span style="display: inline-block; width: 28px; height: 28px; background-color: rgba(255,255,255,0.2); border-radius: 50%; text-align: center; line-height: 28px; color: #ffffff; font-weight: bold; margin-right: 12px;">2</span>
                                    <span style="font-size: 15px; color: #ffffff;">Describe your video idea</span>
                                </div>
                                <div>
                                    <span style="display: inline-block; width: 28px; height: 28px; background-color: rgba(255,255,255,0.2); border-radius: 50%; text-align: center; line-height: 28px; color: #ffffff; font-weight: bold; margin-right: 12px;">3</span>
                                    <span style="font-size: 15px; color: #ffffff;">Watch AI bring it to life</span>
                                </div>
                            </div>

                            <!-- CTA Button -->
                            <table role="presentation" style="margin: 30px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${dashboardUrl}"
                                           style="display: inline-block; padding: 16px 40px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 6px;">
                                            Go to Dashboard
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <div style="margin: 30px 0; padding: 20px; background-color: #f0f7ff; border-radius: 6px;">
                                <p style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #1a1a1a;">
                                    💡 Pro Tips:
                                </p>
                                <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8; color: #4a4a4a;">
                                    <li>Be specific with your descriptions for better results</li>
                                    <li>Experiment with different styles and durations</li>
                                    <li>Check your credit balance before starting projects</li>
                                    <li>Upgrade your plan for longer videos and more features</li>
                                </ul>
                            </div>

                            <div style="margin: 30px 0; padding: 20px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #856404;">
                                    <strong>Need help?</strong> We're here for you! Check out our documentation or
                                    reach out via the chat widget on our website.
                                </p>
                            </div>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px 40px; background-color: #f9f9f9; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0 0 10px 0; font-size: 14px; color: #6a6a6a; text-align: center;">
                                We can't wait to see what you create!
                            </p>
                            <p style="margin: 0; font-size: 14px; color: #6a6a6a; text-align: center;">
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
