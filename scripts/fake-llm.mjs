#!/usr/bin/env node
// Serves Vireo's scripted model as a standalone OpenAI-compatible endpoint,
// e.g. to test Vireo behind LiteLLM without real provider keys.
// Usage: npm run build && node scripts/fake-llm.mjs [port]
import { startFakeLlmServer } from "../apps/node/dist/fake-llm-server.js";

const { url, server } = await startFakeLlmServer(Number(process.argv[2] ?? 0));
server.ref();
console.log(`Scripted model on ${url}`);
