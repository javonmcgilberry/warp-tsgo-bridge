import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeMessage, MessageDecoder } from "../src/protocol.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgePath = join(projectRoot, "src", "bridge.mjs");

class LspClient {
  #child;
  #decoder = new MessageDecoder();
  #nextId = 1;
  #pending = new Map();
  #stderr = "";

  constructor() {
    this.#child = spawn(process.execPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.on("data", (chunk) => { this.#stderr += chunk.toString("utf8"); });
    this.#child.stdout.on("data", (chunk) => {
      for (const message of this.#decoder.push(chunk)) this.#receive(message);
    });
  }

  #receive(message) {
    if (message.method && message.id != null) {
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  request(method, params) {
    const id = this.#nextId++;
    this.#child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out. ${this.#stderr}`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  notify(method, params) {
    this.#child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  close() {
    this.#child.kill("SIGTERM");
  }
}

test("native server provides hover and go-to-definition through the bridge", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "warp-tsgo-bridge-"));
  const definitionPath = join(workspace, "definition.ts");
  const usagePath = join(workspace, "usage.ts");
  const definitionText = "export function greet(name: string) { return `Hello ${name}`; }\n";
  const usageText = 'import { greet } from "./definition";\nconst message = greet("Warp");\n';
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  await writeFile(definitionPath, definitionText);
  await writeFile(usagePath, usageText);

  const client = new LspClient();
  try {
    const rootUri = pathToFileURL(workspace).href;
    await client.request("initialize", {
      processId: process.pid,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: "fixture" }],
      initializationOptions: {},
    });
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(definitionPath).href,
        languageId: "typescript",
        version: 1,
        text: definitionText,
      },
    });
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(usagePath).href,
        languageId: "typescript",
        version: 1,
        text: usageText,
      },
    });

    const position = { line: 1, character: 17 };
    const textDocument = { uri: pathToFileURL(usagePath).href };
    const hover = await client.request("textDocument/hover", { textDocument, position });
    assert.ok(hover?.contents, "expected hover content for greet");

    const definition = await client.request("textDocument/definition", { textDocument, position });
    const locations = Array.isArray(definition) ? definition : [definition];
    assert.ok(
      locations.some((location) => (location?.uri ?? location?.targetUri) === pathToFileURL(definitionPath).href),
      "expected greet to resolve to definition.ts",
    );
  } finally {
    client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
