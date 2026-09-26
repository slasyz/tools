import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isSandboxAuthorizationEvent,
  requestSandboxAuthorization,
  type SandboxAuthorizationEvent,
} from "../src/api.ts";

test("observing a request without registering an authorizer keeps it blocked", async () => {
  let observed = false;
  await assert.rejects(
    requestSandboxAuthorization(
      {
        emit(_channel, data) {
          observed = isSandboxAuthorizationEvent(data);
        },
      },
      { source: "test", cwd: process.cwd(), accesses: [] },
    ),
    /pi-sandbox is missing or inactive; operation blocked/,
  );
  assert.equal(observed, true);
});

test("authorization uses an immutable copy without freezing the caller's request", async () => {
  const request = {
    source: "test",
    cwd: process.cwd(),
    accesses: [{ kind: "write" as const, path: "intended.txt" }],
  };
  await requestSandboxAuthorization(
    {
      emit(_channel, data) {
        assert.ok(isSandboxAuthorizationEvent(data));
        assert.equal(Reflect.set(data, "cwd", "/other"), false);
        assert.equal(Reflect.set(data.accesses, "length", 0), false);
        request.accesses[0].path = "changed.txt";
        data.waitUntil(() => {
          assert.deepEqual(data.accesses, [{ kind: "write", path: "intended.txt" }]);
        });
      },
    },
    request,
  );
  assert.equal(request.accesses[0].path, "changed.txt");
});

test("authorizers cannot register after event dispatch ends", async () => {
  let captured: SandboxAuthorizationEvent | undefined;
  await requestSandboxAuthorization(
    {
      emit(_channel, data) {
        assert.ok(isSandboxAuthorizationEvent(data));
        captured = data;
        data.waitUntil(() => {});
      },
    },
    { source: "test", cwd: process.cwd(), accesses: [] },
  );
  assert.ok(captured);
  const event = captured;
  assert.throws(
    () => event.waitUntil(() => {}),
    /Sandbox authorizers must register during event dispatch/,
  );
});

test("the event guard rejects malformed request fields and file accesses", () => {
  const valid = {
    source: "test",
    cwd: process.cwd(),
    accesses: [{ kind: "read", path: "input.txt" }],
    waitUntil() {},
  };
  assert.equal(isSandboxAuthorizationEvent(valid), true);
  for (const invalid of [
    null,
    {},
    { ...valid, source: 1 },
    { ...valid, cwd: null },
    { ...valid, accesses: {} },
    { ...valid, accesses: [null] },
    { ...valid, accesses: [{ kind: "delete", path: "input.txt" }] },
    { ...valid, accesses: [{ kind: "read", path: 1 }] },
    { ...valid, waitUntil: undefined },
  ]) {
    assert.equal(isSandboxAuthorizationEvent(invalid), false);
  }
});
