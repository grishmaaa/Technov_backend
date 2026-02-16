/**
 * Video ready notification email template
 */
export const videoReadyEmailTemplate = ({ viewUrl, projectTitle, name }) => {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Video is Ready!</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td align="center" style="padding: 40px 40px 20px 40px;">
                            <div style="font-size: 64px; margin-bottom: 10px;">🎬</div>
                            <h1 style="margin: 0; font-size: 28px; font-weight: bold; color: #1a1a1a;">Your Video is Ready!</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 0 40px 40px 40px;">
                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Hi ${name},
                            </p>

                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                                Great news! Your AI-generated video <strong>"${projectTitle}"</strong> has finished processing
                                and is ready to watch.
                            </p>

                            <div style="margin: 30px 0; padding: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; text-align: center;">
                                <p style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #ffffff;">
                                    "${projectTitle}"
                                </p>
                                <p style="margin: 0; font-size: 14px; color: #ffffff; opacity: 0.9;">
                                    Click below to view, download, or share your creation
                                </p>
                            </div>

                            <!-- CTA Button -->
                            <table role="presentation" style="margin: 30px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${viewUrl}"
                                           style="display: inline-block; padding: 16px 40px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 6px;">
                                            Watch Your Video
                                        </a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 30px 0 10px 0; font-size: 14px; line-height: 1.6; color: #6a6a6a;">
                                Or copy and paste this link into your browser:
                            </p>
                            <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #0066ff; word-break: break-all;">
                                ${viewUrl}
                            </p>

                            <div style="margin: 30px 0 0 0; padding: 20px; background-color: #f0f7ff; border-radius: 6px;">
                                <p style="margin: 0 0 10px 0; font-size: 14px; font-weight: 600; color: #1a1a1a;">
                                    What's next?
                                </p>
                                <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8; color: #4a4a4a;">
                                    <li>Download your video in HD quality</li>
                                    <li>Share it on social media</li>
                                    <li>Create more videos with different styles</li>
                                </ul>
                            </div>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px 40px; background-color: #f9f9f9; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0 0 10px 0; font-size: 14px; color: #6a6a6a; text-align: center;">
                                Thanks for using Technov AI! We can't wait to see what you create next.
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
