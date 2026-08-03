import test from "node:test";
import assert from "node:assert/strict";
import { addWorkspaceRoot, encodeMessage, MessageDecoder } from "../src/protocol.mjs";

test("adds rootUri from the first workspace folder", () => {
  const input = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      workspaceFolders: [{ uri: "file:///tmp/project", name: "project" }],
    },
  };

  const result = addWorkspaceRoot(input);
  assert.equal(result.changed, true);
  assert.equal(result.workspaceUri, "file:///tmp/project");
  assert.equal(result.message.params.rootUri, "file:///tmp/project");
  assert.equal(input.params.rootUri, undefined);
});

test("preserves an existing rootUri", () => {
  const input = {
    method: "initialize",
    params: {
      rootUri: "file:///tmp/root",
      workspaceFolders: [{ uri: "file:///tmp/other" }],
    },
  };
  const result = addWorkspaceRoot(input);
  assert.equal(result.changed, false);
  assert.equal(result.message, input);
  assert.equal(result.workspaceUri, "file:///tmp/root");
});

test("decodes fragmented and adjacent LSP frames", () => {
  const first = encodeMessage({ id: 1, method: "initialize" });
  const second = encodeMessage({ method: "initialized" });
  const combined = Buffer.concat([first, second]);
  const decoder = new MessageDecoder();

  assert.deepEqual(decoder.push(combined.subarray(0, 12)), []);
  assert.deepEqual(decoder.push(combined.subarray(12)), [
    { id: 1, method: "initialize" },
    { method: "initialized" },
  ]);
});
