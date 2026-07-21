#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

const DEFAULT_PROJECT_REF = "zcsxwjcshobjuwigmcnz";
const DEFAULT_SUPABASE_URL = `https://${DEFAULT_PROJECT_REF}.supabase.co`;

function usage() {
  console.log(`Usage:
  npm run auth:create-user -- --email user@example.com
  printf '%s\\n' 'password' | npm run auth:create-user -- --email user@example.com --password-stdin

Creates a confirmed production Supabase Auth user. If the email already exists,
the command updates that user's password and confirms the email.

The command obtains the production service-role key through the authenticated
Supabase CLI. It never prints the key or the password.`);
}

function parseArgs(argv) {
  const args = { email: "", password: "", passwordStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--email") {
      args.email = argv[++index] ?? "";
      continue;
    }
    if (arg === "--password") {
      args.password = argv[++index] ?? "";
      continue;
    }
    if (arg === "--password-stdin") {
      args.passwordStdin = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return chunks.join("").trimEnd();
}

async function readPasswordInteractively() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Use --password-stdin when the command is not running in a terminal.");
  }

  output.write("Password: ");
  execFileSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    return await new Promise((resolve) => {
      input.once("data", (chunk) => resolve(String(chunk).trimEnd()));
    });
  } finally {
    execFileSync("stty", ["echo"], { stdio: "inherit" });
    output.write("\n");
  }
}

function getProductionServiceRoleKey() {
  let outputText;
  try {
    outputText = execFileSync(
      "supabase",
      ["projects", "api-keys", "--project-ref", DEFAULT_PROJECT_REF],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(
      "Could not read the production Supabase key. Run `supabase login` first.",
    );
  }

  const line = outputText
    .split("\n")
    .find((candidate) => /^\s*service_role\s*\|/.test(candidate));
  const serviceRoleKey = line?.split("|")[1]?.trim();
  if (!serviceRoleKey) {
    throw new Error("The Supabase CLI did not return a production service-role key.");
  }
  return serviceRoleKey;
}

async function supabaseRequest(path, serviceRoleKey, options = {}) {
  const response = await fetch(`${DEFAULT_SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }

  if (!response.ok) {
    const message = body?.msg ?? body?.message ?? body?.error_description ?? "Supabase request failed.";
    throw new Error(`${response.status}: ${message}`);
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Provide a valid --email.");

  let password = args.password;
  if (args.passwordStdin) password = await readPasswordFromStdin();
  if (!password) password = await readPasswordInteractively();
  if (password.length < 8) throw new Error("Password must contain at least 8 characters.");

  const serviceRoleKey = getProductionServiceRoleKey();
  const users = await supabaseRequest(
    "/auth/v1/admin/users?per_page=100&page=1",
    serviceRoleKey,
  );
  const existing = users?.users?.find(
    (user) => user.email?.toLowerCase() === email,
  );

  if (existing) {
    await supabaseRequest(`/auth/v1/admin/users/${existing.id}`, serviceRoleKey, {
      method: "PUT",
      body: JSON.stringify({ password, email_confirm: true }),
    });
    console.log(`Updated the production password for ${email}.`);
    return;
  }

  await supabaseRequest("/auth/v1/admin/users", serviceRoleKey, {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  console.log(`Created the confirmed production user ${email}.`);
}

main().catch((error) => {
  console.error(`Auth user command failed: ${error.message}`);
  process.exitCode = 1;
});
