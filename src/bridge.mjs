#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addWorkspaceRoot, encodeMessage, MessageDecoder } from "./protocol.mjs";

const typescriptRoot = join(
  homedir(),
  ".warp",
  "typescript-language-server",
  "node_modules",
  "typescript",
);
const tscPath = join(typescriptRoot, "bin", "tsc");
const decoder = new MessageDecoder();
const serverDecoder = new MessageDecoder();
let server;

const handledClientRequests = new Set([
  "client/registerCapability",
  "client/unregisterCapability",
  "window/workDoneProgress/create",
]);

function workspaceDirectory(workspaceUri) {
  if (!workspaceUri?.startsWith("file:")) return process.cwd();
  try {
    return dirname(fileURLToPath(new URL(`${workspaceUri.replace(/\/$/, "")}/placeholder`)));
  } catch {
    return process.cwd();
  }
}

function startServer(workspaceUri) {
  if (server) return server;
  if (!existsSync(tscPath)) {
    throw new Error(`TypeScript 7 executable not found at ${tscPath}`);
  }

  server = spawn(tscPath, ["--lsp", "--stdio"], {
    cwd: workspaceDirectory(workspaceUri),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    try {
      for (const message of serverDecoder.push(chunk)) {
        if (handledClientRequests.has(message.method) && message.id != null) {
          server.stdin.write(encodeMessage({ jsonrpc: "2.0", id: message.id, result: null }));
        } else {
          process.stdout.write(encodeMessage(message));
        }
      }
    } catch (error) {
      process.stderr.write(`[warp-tsgo-bridge] ${error.stack ?? error.message}\n`);
      process.exit(1);
    }
  });
  server.stderr.pipe(process.stderr);
  server.on("error", (error) => {
    process.stderr.write(`[warp-tsgo-bridge] ${error.message}\n`);
    process.exitCode = 1;
  });
  server.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
  return server;
}

process.stdin.on("data", (chunk) => {
  try {
    for (const incoming of decoder.push(chunk)) {
      const { message, workspaceUri } = addWorkspaceRoot(incoming);
      const child = startServer(workspaceUri);
      child.stdin.write(encodeMessage(message));
    }
  } catch (error) {
    process.stderr.write(`[warp-tsgo-bridge] ${error.stack ?? error.message}\n`);
    process.exit(1);
  }
});

process.stdin.on("end", () => server?.stdin.end());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server?.kill(signal));
}
