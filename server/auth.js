import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { touchUser } from "./db.js";

const seen = new Map(); // id -> last time we wrote to the users table

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Works out who is making the request from its headers.
// Returns { id, email, name, isOwner, isEditor, canWrite } or null.
export function identify(headers) {
  let email, name;
  if (config.authMode === "dev") {
    email = config.devUserEmail;
    name = config.devUserName;
  } else {
    if (config.proxySecret && !safeEqual(headers[config.proxySecretHeader] || "", config.proxySecret)) return null;
    email = headers[config.emailHeader];
    name = headers[config.nameHeader];
    // Google IAP prefixes the value: "accounts.google.com:person@company.com"
    if (email && email.includes(":")) email = email.split(":").pop();
  }
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s/]+@[^@\s/]+$/.test(email)) return null;
  const domain = email.split("@")[1];
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) return null;

  const id = email;
  const isOwner = config.ownerEmails.includes(email);
  return {
    id,
    email,
    name: String(name || "").trim() || email.split("@")[0],
    isOwner,
    isEditor: isOwner || config.editorEmails.includes(email),
    canWrite: !config.readOnlyEmails.includes(email),
  };
}

export function requireUser(req, res, next) {
  const user = identify(req.headers);
  if (!user) return res.status(401).json({ code: "not_signed_in" });
  req.user = user;
  const last = seen.get(user.id) || 0;
  if (Date.now() - last > 5 * 60 * 1000) {
    seen.set(user.id, Date.now());
    touchUser(user).catch(() => {});
  }
  next();
}
