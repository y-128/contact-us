import PostalMime from 'postal-mime';

// Define the environment variables
interface Env {
  // Discord Bot Token for API authentication
  DISCORD_BOT_TOKEN: string;
  // The specific Discord server (guild) ID where tickets will be managed
  DISCORD_GUILD_ID: string;
  // The category within the Discord server where new ticket channels will be created
  DISCORD_CATEGORY_ID: string; 
  // Public key for verifying Discord's incoming interaction webhooks
  DISCORD_PUBLIC_KEY: string;
  // API key for Resend (email sending service)
  RESEND_API_KEY: string;
  // The "from" email address used by Resend for outgoing emails
  RESEND_FROM_EMAIL: string;
  // Optional domain used to build reply+{channelId}@<domain> addresses
  REPLY_TO_DOMAIN?: string;
  // Cloudflare KV Namespace for storing ticket data (e.g., channel ID to user email mapping)
  TICKET_KV: KVNamespace;
  // Comma-separated list of allowed origins for CORS
  ALLOWED_ORIGIN: string;
  // Secret key for validating Cloudflare Turnstile (CAPTCHA) responses
  TURNSTILE_SECRET_KEY: string;
}

function extractDomainFromAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Supports either "user@example.com" or "Name <user@example.com>" formats.
  const angleMatch = trimmed.match(/<([^>]+)>/);
  const emailPart = angleMatch?.[1] ?? trimmed;
  const at = emailPart.lastIndexOf("@");
  if (at < 1 || at === emailPart.length - 1) {
    return null;
  }
  return emailPart.slice(at + 1).trim().toLowerCase();
}

function buildReplyToAddress(channelId: string, env: Env): string | undefined {
  const configuredDomain = env.REPLY_TO_DOMAIN?.trim().toLowerCase();
  const domain = configuredDomain || extractDomainFromAddress(env.RESEND_FROM_EMAIL);
  if (!domain) {
    return undefined;
  }
  return `reply+${channelId}@${domain}`;
}

function buildThreadEmailSubject(channelId: string): string {
  return `お問い合わせ(#${channelId})`;
}

// Helper function to generate CORS headers based on request origin
function getCorsHeaders(request: Request, env: Env): { [key: string]: string } {
  const origin = request.headers.get("Origin");
  // ALLOWED_ORIGIN can be a comma-separated list of domains
  const allowedOrigins = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.split(',').map(o => o.trim()) : [];

  const headers: { [key: string]: string } = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // If the request's origin is in our list of allowed origins, reflect it
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

// A more robust HTML sanitizer to prevent XSS. It whitelists basic tags.
function sanitizeHTML(str: string): string {
    if (!str) return "";
    // Basic sanitizer: remove all tags except a few safe ones like <p>, <br>
    // For a production app, a more robust library would be better if available in CF Workers.
    const tagsToKeep = /<\/?(p|br)\s*\/?>/gi;
    let sanitized = str.replace(/<[^>]*>/g, (tag) => {
        return tag.match(tagsToKeep) ? tag : "";
    });

    // Escape remaining special characters
    const replacements: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return sanitized.replace(/[&<>"']/g, (match) => replacements[match]);
}


// Helper function to verify the Turnstile token
async function verifyTurnstile(token: string, secretKey: string, remoteIp: string | null): Promise<boolean> {
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      secret: secretKey,
      response: token,
      remoteip: remoteIp || undefined,
    }),
  });

  const data: { success: boolean; "error-codes"?: string[] } = await response.json();
  if (!data.success) {
    console.error(`Turnstile verification failed with error codes: ${data["error-codes"]?.join(', ')}`);
  }
  return data.success;
}

// Helper function to interact with Discord API
async function discordApi(path: string, method: string, token: string, body?: object) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method: method,
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ContactFormWorker/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Discord API Error on ${method} ${path}: ${response.status} ${response.statusText} - ${errorText}`);
    // Re-throw a more informative error
    throw new Error(`Discord API Error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Helper function to send email via Resend
async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
  replyTo?: string
) {
  const emailBody: Record<string, unknown> = { from, to, subject, html };
  if (replyTo) {
    emailBody.reply_to = replyTo;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(emailBody),
  });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`Resend API Error: ${response.status} ${response.statusText} - ${errorText}`);
        throw new Error(`Resend API Error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

// Helper function to convert hex string to Uint8Array safely
function hexToUint8Array(hex: string): Uint8Array | null {
  const matches = hex.match(/.{1,2}/g);
  if (!matches) {
    return null;
  }
  try {
    return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
  } catch (e) {
    console.error("Failed to parse hex string:", e);
    return null;
  }
}

// Helper function to verify the signature from Discord using Web Crypto API
async function verifySignature(requestHeaders: Headers, body: string, publicKey: string): Promise<boolean> {
  const signatureHex = requestHeaders.get("x-signature-ed25519");
  const timestamp = requestHeaders.get("x-signature-timestamp");

  if (!signatureHex || !timestamp) {
    return false;
  }

  const encoder = new TextEncoder();
  const keyData = hexToUint8Array(publicKey);
  if (!keyData) {
      return false;
  }
  const keyDataForImport = Uint8Array.from(keyData);
  const key = await crypto.subtle.importKey("raw", keyDataForImport, { name: "Ed25519" }, false, ["verify"]);

  const signature = hexToUint8Array(signatureHex);
  if (!signature) {
      return false;
  }
  const signatureForVerify = Uint8Array.from(signature);
  const dataToVerify = Uint8Array.from(encoder.encode(timestamp + body));

  return await crypto.subtle.verify("Ed25519", key, signatureForVerify, dataToVerify);
}


export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const corsHeaders = getCorsHeaders(request, env);
    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Endpoint for website form submissions
      if (url.pathname === "/" && request.method === "POST") {
        const body: { "cf-turnstile-response": string; email: string; message: string; sender: string; subject?: string } = await request.json();

        // 1. Verify the Turnstile token
        const turnstileToken = body["cf-turnstile-response"];
        const clientIp = request.headers.get("CF-Connecting-IP");
        const isTurnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIp);

        if (!isTurnstileValid) {
          return new Response("Invalid CAPTCHA response.", { status: 403, headers: corsHeaders });
        }
        
        // 2. Sanitize all user inputs
        const email = sanitizeHTML(body.email);
        const message = sanitizeHTML(body.message);
        const subject = body.subject ? sanitizeHTML(body.subject) : undefined;
        const sender = body.sender; // Not HTML, so no need to sanitize

        if (!email || !message) {
          return new Response("Missing email or message", { status: 400, headers: corsHeaders });
        }

        // 3. Create a user-friendly and safe channel name
        const sanitizedEmail = email.replace(/[^a-zA-Z0-9.-]/g, "").substring(0, 50);
        const channelName = `ticket-${sanitizedEmail}-${Math.random().toString(36).substring(2, 6)}`;


        // 4. Create a new channel in Discord
        const newChannel = (await discordApi(
          `/guilds/${env.DISCORD_GUILD_ID}/channels`,
          "POST",
          env.DISCORD_BOT_TOKEN,
          {
            name: channelName,
            type: 0, // 0 = Text Channel
            parent_id: env.DISCORD_CATEGORY_ID,
            topic: `Ticket for: ${email}`, // Add email to channel topic for clarity
          }
        )) as { id: string };

        // 5. Store the mapping from channel ID to user email in KV
        await env.TICKET_KV.put(newChannel.id, email);

        // 6. Post the initial message to the new channel
        const origin = request.headers.get("Origin");
        const fields = [
          { name: "User Email", value: email, inline: true },
        ];

        if (origin) {
          fields.push({ name: "Site", value: origin, inline: true });
        }

        if (subject) {
          fields.push({ name: "Subject", value: subject, inline: true });
        } else {
          fields.push({ name: "User ID", value: `\`${sender}\``, inline: true });
        }
        fields.push({ name: "Message", value: message.substring(0, 1024), inline: false }); // Limit message length

        await discordApi(`/channels/${newChannel.id}/messages`, "POST", env.DISCORD_BOT_TOKEN, {
          embeds: [{
            title: "New Inquiry Received",
            color: 0x5865F2, // Discord Blurple
            fields,
            footer: {
              text: "Reply to this user by using the /reply command.",
            },
            timestamp: new Date().toISOString(),
          }],
        });

        // 7. Send confirmation email to the user
        const confirmationHtml = `<p>この度はお問い合わせいただき、誠にありがとうございます。</p>
<p>以下の内容でお問い合わせを受け付けました。</p>
<hr>
<p><strong>メールアドレス:</strong> ${email}</p>
${subject ? `<p><strong>件名:</strong> ${subject}</p>` : ''}
<p><strong>お問い合わせ内容:</strong></p>
<p>${message.replace(/\n/g, "<br>")}</p>
<hr>
<p>内容を確認の上、必要に応じて改めてご連絡いたしますので、今しばらくお待ちくださいませ。</p>`;

        // Reply-To address encodes the channel ID so inbound replies route back here
        const replyToEmail = buildReplyToAddress(newChannel.id, env);
        if (!replyToEmail) {
          console.error("Reply-To address could not be generated. Check REPLY_TO_DOMAIN or RESEND_FROM_EMAIL.");
        }

        ctx.waitUntil(sendEmail(
          env.RESEND_API_KEY,
          env.RESEND_FROM_EMAIL,
          email,
          buildThreadEmailSubject(newChannel.id),
          confirmationHtml,
          replyToEmail
        ).catch(e => console.error(`Failed to send confirmation email: ${e}`)));

        return new Response("Ticket created successfully", { status: 201, headers: corsHeaders });
      }

      // Health-check endpoint for probes hitting the Worker root URL
      if (url.pathname === "/" && request.method === "GET") {
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      // Endpoint for Discord Interaction Webhooks (for slash commands)
      if (url.pathname === "/discord-interactions" && request.method === "POST") {
        const rawBody = await request.text();
        const isValid = await verifySignature(request.headers, rawBody, env.DISCORD_PUBLIC_KEY);

        if (!isValid) {
          return new Response("Invalid signature", { status: 401 });
        }
        
        const interaction = JSON.parse(rawBody);

        // Handle PING from Discord
        if (interaction.type === 1) { // PING
          return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } });
        }
        
        // Handle Slash Command
        if (interaction.type === 2 && interaction.data.name === "reply") { // APPLICATION_COMMAND
          const channelId = interaction.channel.id;
          const rawReplyContent = interaction.data.options.find((opt: any) => opt.name === "message").value;
          const replyContent = sanitizeHTML(rawReplyContent);
          const discordUser = interaction.member.user;

          // Acknowledge the interaction immediately
          ctx.waitUntil((async () => {
            const userEmail = await env.TICKET_KV.get(channelId);
            if (!userEmail) {
              console.error(`No email found for channel ID: ${channelId}`);
               await discordApi(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, "PATCH", env.DISCORD_BOT_TOKEN, {
                  content: `❌ Could not find the user's email for this ticket.`,
                });
              return;
            }

            // Reply-To keeps the conversation thread linked to this channel
            const replyToEmail = buildReplyToAddress(channelId, env);
            if (!replyToEmail) {
              console.error("Reply-To address could not be generated. Check REPLY_TO_DOMAIN or RESEND_FROM_EMAIL.");
            }

            try {
              await sendEmail(
                env.RESEND_API_KEY,
                env.RESEND_FROM_EMAIL,
                userEmail,
                buildThreadEmailSubject(channelId),
                `<p>お問い合わせありがとうございます。</p><br><p>${replyContent.replace(/\n/g, "<br>")}</p>`,
                replyToEmail
              );

              // Follow-up message in Discord to confirm email was sent
              await discordApi(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, "PATCH", env.DISCORD_BOT_TOKEN, {
                content: `✅ Email sent successfully to \`${userEmail}\`!`,
              });
            } catch (e) {
                console.error("Failed to send email or follow-up message:", e);
                await discordApi(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, "PATCH", env.DISCORD_BOT_TOKEN, {
                  content: `❌ Failed to send email. Please check the logs. Error: ${e instanceof Error ? e.message : 'Unknown error'}`,
                });
            }
          })());

          // Respond immediately to Discord to avoid timeout
          return new Response(JSON.stringify({ type: 5 }), { headers: { "Content-Type": "application/json" } }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
        }

        return new Response("Unsupported interaction type", { status: 400 });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (error: unknown) {
      console.error("Unhandled error in fetch handler:", error);
      const msg = error instanceof Error ? error.message : 'Internal Server Error';
      return new Response(msg, { status: 500, headers: corsHeaders });
    }
  },

  // Receives emails sent to reply+{channelId}@<domain> and posts them to the Discord ticket channel
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const toAddress = message.to;

    // Extract channelId from address format: reply+{channelId}@domain
    const match = toAddress.match(/^reply\+([^@]+)@/);
    if (!match) {
      console.error(`Could not parse channelId from email address: ${toAddress}`);
      message.setReject("Unknown address format.");
      return;
    }
    const channelId = match[1];

    try {
      // Parse the raw MIME email to extract the text body
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const parsedEmail = await new PostalMime().parse(rawEmail);

      const textBody = parsedEmail.text ||
        (parsedEmail.html ? parsedEmail.html.replace(/<[^>]*>/g, '').trim() : '') ||
        "（内容なし）";

      if (textBody.trim() === '（内容なし）') {
        console.warn(`Email from ${message.from} to ${toAddress} had no parsable content.`);
        // Optionally, notify Discord that an empty email was received.
      }

      // Post the user's reply to the corresponding Discord ticket channel
      await discordApi(`/channels/${channelId}/messages`, "POST", env.DISCORD_BOT_TOKEN, {
        embeds: [{
          title: "📧 User Reply Received",
          description: textBody.substring(0, 4096), // Embed description limit
          color: 0x57F287, // Green
          fields: [
            { name: "From", value: message.from, inline: true },
          ],
          footer: { text: "Use the /reply command to respond." },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch(e) {
        console.error(`Failed to process inbound email for channel ${channelId}:`, e);
        // We cannot easily reject here as the message is already being processed.
        // The best we can do is log the error.
    }
  },
};
