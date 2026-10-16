/**
 * Shared test helpers. Everything here is FABRICATED — no live service, no real credentials.
 *
 * `fetch` is injected into the client and the CLI, so the whole deterministic suite runs
 * offline. The only live test in this repository is `scripts/live-smoke.mjs`, which is not
 * part of `npm test`.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, "..", "fixtures");

/** @param {string} name */
export function fixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/** @param {string} name */
export function fixtureJson(name) {
  return JSON.parse(fixture(name));
}

/** A fake bearer token that looks real enough to prove redaction works. */
export const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.fake-payload.sig-nature";
export const FAKE_SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/**
 * @param {unknown} body
 * @param {number} [status]
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * SSE response that enqueues every frame immediately and then closes.
 * @param {string[]} frames
 * @param {{ close?: boolean }} [options]
 */
export function sseResponse(frames, options = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (options.close !== false) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * SSE response that emits a prefix and then stalls forever (no close, no more frames).
 * Exercises the client-side deadline without hanging the test.
 * @param {string[]} prefixFrames
 */
export function stalledSseResponse(prefixFrames = []) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of prefixFrames) controller.enqueue(encoder.encode(frame));
        // intentionally never closed
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * Route-based fake fetch. Records every call for assertions.
 * @param {Array<[string, (url: string, init: any) => Response | Promise<Response>]>} routes
 */
export function fakeFetch(routes) {
  /** @type {{ url: string, init: any, body: any, headers: Record<string,string> }[]} */
  const calls = [];
  const impl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    for (const [match, responder] of routes) {
      if (url.includes(match)) return responder(url, init);
    }
    throw new Error(`unexpected request in test: ${url}`);
  };
  impl.calls = calls;
  /** @param {string} part */
  impl.call = (part) => calls.find((c) => c.url.includes(part));
  return impl;
}

/** Split an `.sse` fixture file into whole `data:` frames (each ending in a newline). */
export function framesFrom(name) {
  return fixture(name)
    .split(/\n(?=data:)/)
    .filter((f) => f.trim())
    .map((f) => `${f.trim()}\n`);
}

/** Fixture frames for the standard "answer with source links" reply. */
export function answerFrames() {
  return framesFrom("chat-answer.sse");
}

/** Fixture frames for the "cannot answer" reply. */
export function vagueFrames() {
  return framesFrom("chat-vague.sse");
}

/** Fixture frames for a service-side stream error. */
export function errorFrames() {
  return framesFrom("chat-error.sse");
}

/** Fixture frames for a stream that is cut off before `data: [DONE]`. */
export function interruptedFrames() {
  return framesFrom("chat-interrupted.sse");
}

/**
 * The four routes a successful `ask()` needs, all mocked.
 * @param {{
 *   frames?: string[],
 *   bootstrap?: unknown,
 *   conversations?: unknown,
 *   agents?: unknown,
 *   chatStatus?: number,
 *   chatBody?: unknown,
 *   chatResponder?: () => Response | Promise<Response>,
 * }} [options]
 */
export function docsRoutes(options = {}) {
  return /** @type {any} */ ([
    ["/api/v1/widget/bootstrap", () => jsonResponse(options.bootstrap ?? fixtureJson("bootstrap.json"))],
    ["/api/v1/pharos/conversations/session/", () => jsonResponse(options.agents ?? fixtureJson("agents.json"))],
    ["/api/v1/pharos/conversations/session", () => jsonResponse(options.conversations ?? fixtureJson("conversations.json"))],
    [
      "/api/v1/pharos/chat/completions",
      () => {
        if (options.chatResponder) return options.chatResponder();
        if (options.chatStatus && options.chatStatus !== 200) {
          return jsonResponse(options.chatBody ?? { code: "401", message: "must not be used" }, options.chatStatus);
        }
        return sseResponse(options.frames ?? answerFrames());
      },
    ],
  ]);
}

/** Create a unique temp directory (inside the shared temp area when it exists). */
export async function tempDir() {
  const root = path.join(os.tmpdir(), "opencode");
  try {
    await mkdir(root, { recursive: true });
    return await mkdtemp(path.join(root, "pharos-docs-"));
  } catch {
    return mkdtemp(path.join(os.tmpdir(), "pharos-docs-"));
  }
}

/** Write a fabricated cached session and return its path plus the temp directory. */
export async function tempSessionFile(session = {}) {
  const dir = await tempDir();
  const file = path.join(dir, "session.json");
  await writeFile(
    file,
    `${JSON.stringify({ accessToken: FAKE_JWT, tokenType: "AUTHENTICATED", sessionId: FAKE_SESSION_ID, ...session }, null, 2)}\n`,
    "utf8",
  );
  return { file, dir };
}

/** A temp session path that deliberately does not exist. */
export async function missingSessionFile() {
  const dir = await tempDir();
  return { file: path.join(dir, "does-not-exist.json"), dir };
}

/** Capture CLI output into strings. */
export function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: { out: (t) => stdout.push(t), err: (t) => stderr.push(t) },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}
