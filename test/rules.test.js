import { test } from "node:test";
import assert from "node:assert/strict";
import { canRead, canWrite } from "../server/rules.js";

const owner = { id: "owner@co.com", isOwner: true, canWrite: true };
const person = { id: "pat@co.com", isOwner: false, canWrite: true };
const readOnly = { id: "vendor@v.com", isOwner: false, canWrite: false };

test("members: everyone reads, only owners write", () => {
  assert.equal(canRead(person, ["members"]), true);
  assert.equal(canWrite(person, ["members", "pat@co.com"]), false);
  assert.equal(canWrite(owner, ["members", "pat@co.com"]), true);
});

test("access requests and visits: owners see all, people see their own", () => {
  for (const col of ["accessRequests", "visits"]) {
    assert.equal(canRead(person, [col]), false);
    assert.equal(canRead(owner, [col]), true);
    assert.equal(canRead(person, [col, "pat@co.com"]), true);
    assert.equal(canWrite(person, [col, "pat@co.com"]), true);
    assert.equal(canRead(person, [col, "someone@co.com"]), false);
    assert.equal(canWrite(person, [col, "someone@co.com"]), false);
  }
});

test("everything else: all signed-in people read, read-only people can't write", () => {
  assert.equal(canRead(readOnly, ["requests", "r1"]), true);
  assert.equal(canWrite(readOnly, ["requests", "r1"]), false);
  assert.equal(canWrite(person, ["requests", "r1", "chat", "m1"]), true);
});
