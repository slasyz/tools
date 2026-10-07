#!/usr/bin/env node
import { main } from "./commit.ts";

const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.on(signal, stop);

process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.removeListener(signal, stop);
