#!/usr/bin/env node

import net from "node:net";

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) failPermanent(`missing argument: ${name}`);
  try { return JSON.parse(raw); }
  catch (e) { failPermanent(`invalid JSON argument for ${name}: ${e.message}`); }
}

function writeOk(value) { process.stdout.write(JSON.stringify(value)); }

function fail(message) {
  console.error(message);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

function failPermanent(message) {
  console.error(`permanent: ${message}`);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });
    let buf = "";
    socket.on("data", (chunk) => { buf += chunk; });
    socket.on("close", () => {
      try { resolve(JSON.parse(buf.trim())); }
      catch (e) { reject(new Error(`bad socket response: ${buf}`)); }
    });
    socket.on("error", reject);
  });
}

async function main() {
  const socketPath = parseJsonArg(2, "socket");
  const message = parseJsonArg(3, "message");
  if (typeof message !== "string") failPermanent("message must be a string");

  const response = await request(socketPath, { op: "send", message });
  if (!response.ok) fail(response.error || "send failed");
  writeOk(null);
}

main().catch((error) => fail(error.message));
