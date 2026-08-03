#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage, MessageDecoder } from "../src/protocol.mjs";

const managerPath = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(managerPath));
const home = homedir();
const warpRoot = join(home, ".warp", "typescript-language-server");
const target = join(warpRoot, "node_modules", "typescript-language-server", "lib", "cli.mjs");
const tscPath = join(warpRoot, "node_modules", "typescript", "bin", "tsc");
const typescriptPackage = join(warpRoot, "node_modules", "typescript", "package.json");
const stateDir = join(home, ".local", "share", "warp-tsgo-bridge");
const installedBridge = join(stateDir, "bridge.mjs");
const installedProtocol = join(stateDir, "protocol.mjs");
const backup = join(stateDir, "original-cli.mjs");
const commandPath = join(home, ".local", "bin", "warp-tsgo-bridge");
const launchAgent = join(home, "Library", "LaunchAgents", "com.local.warp-tsgo-bridge.plist");
const marker = "WARP_TSGO_BRIDGE_SHIM_V1";
const wrapper = `#!/usr/bin/env node\n// ${marker}\nimport ${JSON.stringify(installedBridge)};\n`;
const quiet = process.argv.includes("--quiet");

function log(message) {
  if (!quiet) console.log(message);
}

async function isPatched() {
  try {
    return (await readFile(target, "utf8")).includes(marker);
  } catch {
    return false;
  }
}

async function typescriptVersion() {
  const descriptor = JSON.parse(await readFile(typescriptPackage, "utf8"));
  return descriptor.version;
}

async function writeAtomic(path, contents, mode = 0o644) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

async function installCommand() {
  await mkdir(dirname(commandPath), { recursive: true });
  await rm(commandPath, { force: true });
  await symlink(managerPath, commandPath);
}

async function installLaunchAgent() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.warp-tsgo-bridge</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${commandPath}</string>
    <string>repair</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>WatchPaths</key><array><string>${target}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>${stateDir}/launch-agent.log</string>
  <key>StandardErrorPath</key><string>${stateDir}/launch-agent-error.log</string>
</dict></plist>
`;
  await writeAtomic(launchAgent, plist);
  const domain = `gui/${process.getuid()}`;
  await run("/bin/launchctl", ["bootout", domain, launchAgent], { allowFailure: true });
  await run("/bin/launchctl", ["bootstrap", domain, launchAgent]);
}

async function patch() {
  if (!existsSync(target)) throw new Error(`Warp LSP entry point not found: ${target}`);
  if (!existsSync(tscPath)) throw new Error(`TypeScript 7 executable not found: ${tscPath}`);

  const version = await typescriptVersion();
  if (!version.startsWith("7.")) {
    throw new Error(`Expected Warp's TypeScript 7 package, found ${version}.`);
  }

  await mkdir(stateDir, { recursive: true });
  await copyFile(join(projectRoot, "src", "bridge.mjs"), installedBridge);
  await copyFile(join(projectRoot, "src", "protocol.mjs"), installedProtocol);

  if (!(await isPatched())) {
    await copyFile(target, backup);
    await writeAtomic(target, wrapper, 0o755);
  }
  log(`Warp TypeScript entry point now uses native TypeScript ${version}.`);
}

async function install() {
  await installCommand();
  await patch();
  await installLaunchAgent();
  log(`Installed ${commandPath}`);
  log(`Automatic repair enabled through ${launchAgent}`);
}

async function repair() {
  await installCommand();
  await patch();
}

async function uninstall() {
  const domain = `gui/${process.getuid()}`;
  await run("/bin/launchctl", ["bootout", domain, launchAgent], { allowFailure: true });
  await rm(launchAgent, { force: true });

  if (await isPatched()) {
    if (!existsSync(backup)) throw new Error(`Cannot restore Warp: backup missing at ${backup}`);
    await copyFile(backup, target);
  }
  await rm(commandPath, { force: true });
  log("Restored Warp's original TypeScript language-server entry point.");
}

async function status() {
  let version = "unavailable";
  try { version = await typescriptVersion(); } catch {}
  console.log(`Bridge: ${await isPatched() ? "installed" : "not installed"}`);
  console.log(`Warp TypeScript: ${version}`);
  console.log(`Native executable: ${existsSync(tscPath) ? tscPath : "missing"}`);
  console.log(`Backup: ${existsSync(backup) ? backup : "missing"}`);
  console.log(`LaunchAgent: ${existsSync(launchAgent) ? "installed" : "not installed"}`);
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: options.capture ? ["pipe", "pipe", "pipe"] : "ignore",
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout?.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr?.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr, child });
      else reject(new Error(`${program} exited with ${code}: ${stderr.toString("utf8")}`));
    });
  });
}

async function testBridge() {
  const child = spawn(process.execPath, [installedBridge], {
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new MessageDecoder();
  let stderr = "";
  const rootUri = new URL(`file://${projectRoot}`).href;
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: "webflow" }],
      initializationOptions: {},
    },
  };

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for TypeScript 7 LSP.")), 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.id !== 1) continue;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(`Bridge exited with ${code}: ${stderr}`));
    });
    child.stdin.write(encodeMessage(initialize));
  });

  child.kill("SIGTERM");
  const info = result.serverInfo;
  if (info?.name !== "typescript-go" || !info.version?.startsWith("7.")) {
    throw new Error(`Unexpected language server: ${JSON.stringify(info)}`);
  }
  console.log(`PASS: ${info.name} ${info.version} initialized through the bridge.`);
}

const command = process.argv[2] ?? "status";
try {
  if (command === "install") await install();
  else if (command === "repair") await repair();
  else if (command === "uninstall") await uninstall();
  else if (command === "status") await status();
  else if (command === "test") await testBridge();
  else {
    console.log("Usage: warp-tsgo-bridge <install|status|repair|test|uninstall>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`warp-tsgo-bridge: ${error.message}`);
  process.exitCode = 1;
}
