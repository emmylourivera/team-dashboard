// Who may read and write what. These mirror the rules the dashboard had on
// claude.ai:
//   members                      everyone reads, only owners write
//   accessRequests, visits       only owners read or write the whole list;
//                                each person reads and writes their own document
//   everything else              every signed-in person reads; everyone who
//                                isn't read-only writes
import { httpError } from "./db.js";

const PRIVATE_PER_PERSON = new Set(["accessRequests", "visits"]);

// parts: path segments, e.g. ["members"] or ["accessRequests", "<user id>"]
export function canRead(user, parts) {
  const top = parts[0];
  if (PRIVATE_PER_PERSON.has(top)) {
    if (user.isOwner) return true;
    return parts.length >= 2 && parts[1] === user.id;
  }
  return true;
}

export function canWrite(user, parts) {
  if (!user.canWrite) return false;
  const top = parts[0];
  if (top === "members") return user.isOwner;
  if (PRIVATE_PER_PERSON.has(top)) {
    if (user.isOwner) return true;
    return parts.length >= 2 && parts[1] === user.id;
  }
  return true;
}

export function assertRead(user, parts) {
  if (!canRead(user, parts)) throw httpError(403, "permission_denied");
}
export function assertWrite(user, parts) {
  if (!canWrite(user, parts)) throw httpError(403, "permission_denied");
}
