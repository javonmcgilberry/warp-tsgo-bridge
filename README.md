# Warp tsgo bridge

Warp's code editor currently starts `typescript-language-server`, which expects
the old Node-based `tsserver.js`. TypeScript 7 replaced that server with a native
Go implementation. Warp installed TypeScript 7 as its fallback, but its existing
adapter couldn't use it.

I hit this in the Webflow repository. Warp said it couldn't find a valid
TypeScript installation even though the project already had one. I wanted to use
the new TypeScript 7 server instead of downgrading the project or waiting for
Warp to support custom language servers.

The bridge fixes the initialization request Warp sends and starts the native
server with:

```sh
tsc --lsp --stdio
```

It doesn't change project dependencies. It backs up Warp's original entry point
and installs a macOS LaunchAgent that reapplies the patch if a Warp update
overwrites it.

## Usage

```sh
node bin/warp-tsgo-bridge.mjs install

warp-tsgo-bridge status
warp-tsgo-bridge test
warp-tsgo-bridge repair
warp-tsgo-bridge uninstall
```

This patch depends on Warp's current internal file layout. `uninstall` restores
the original language-server entry point.
