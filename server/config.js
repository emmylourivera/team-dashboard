// All settings come from environment variables. See .env.example.

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/team_dashboard",
  production: process.env.NODE_ENV === "production",

  // "header": trust the signed-in user's email from a header set by the
  //           company's single sign-on proxy (oauth2-proxy, Google IAP,
  //           Cloudflare Access, Azure App Proxy...). This is the production mode.
  // "dev":    everyone is DEV_USER_EMAIL. Local testing only; refused when
  //           NODE_ENV=production.
  authMode: process.env.AUTH_MODE || "header",
  emailHeader: (process.env.AUTH_EMAIL_HEADER || "x-forwarded-email").toLowerCase(),
  nameHeader: (process.env.AUTH_NAME_HEADER || "x-forwarded-preferred-username").toLowerCase(),
  // Optional shared secret the proxy adds to every request, so requests that
  // bypass the proxy are rejected even if someone sets the email header.
  proxySecretHeader: (process.env.AUTH_PROXY_SECRET_HEADER || "x-proxy-secret").toLowerCase(),
  proxySecret: process.env.AUTH_PROXY_SECRET || "",
  allowedDomains: list(process.env.ALLOWED_EMAIL_DOMAINS),
  devUserEmail: process.env.DEV_USER_EMAIL || "dev@example.com",
  devUserName: process.env.DEV_USER_NAME || "Dev User",

  // Workspace owners manage members and access requests (the old artifact owner).
  ownerEmails: list(process.env.OWNER_EMAILS),
  // Editors can change workspace settings that only page editors could change before.
  editorEmails: list(process.env.EDITOR_EMAILS),
  // Signed-in people on this list can look but not change anything.
  readOnlyEmails: list(process.env.READ_ONLY_EMAILS),

  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,

  // AI features (panel detection, print proof check). Off when no key is set.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  aiModel: process.env.AI_MODEL || "claude-opus-5-5",
};

if (config.authMode === "dev" && config.production) {
  throw new Error("AUTH_MODE=dev is not allowed when NODE_ENV=production.");
}
if (!["dev", "header"].includes(config.authMode)) {
  throw new Error(`Unknown AUTH_MODE "${config.authMode}". Use "header" or "dev".`);
}
