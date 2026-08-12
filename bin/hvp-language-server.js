#!/usr/bin/env node
// Thin launcher so `npx hvp-language-server` / a client's configured server
// command resolves to a real executable. Argument parsing (--stdio, --node-ipc,
// --socket=<port>) is handled by vscode-languageserver's createConnection()
// inside server.js itself — nothing to do here but load the compiled server.
require('../out/src/server.js');
