/**
 * Wallet sign-in for the Pharos Agent Center — required before the Docs MCP will answer.
 *
 * Verified behaviour (2026-10-16, reproduced from the Task 3 reference project): an anonymous
 * GUEST token from `POST /api/v1/widget/bootstrap` is rejected by the chat endpoint with
 * HTTP 401 `{"code":"401","message":"Unauthorized, please login first"}`. The same two-step
 * handshake the web UI performs upgrades the session:
 *
 *   1. POST /api/v1/widget/wallet/challenge              { address, chainId, appKey }
 *   2. POST /api/v1/widget/agentcenter/wallet/verify     { challengeId, address, signature, ... }
 *      -> tokenType ONBOARDING
 *   3. poll GET /api/v1/widget/onboarding/status, sign the guardian EIP-712 claim if asked
 *   4. POST /api/v1/widget/agentcenter/onboarding/complete -> tokenType AUTHENTICATED
 *
 * The signing identity is a throwaway EOA created under `.local/` (git-ignored). It never
 * needs funds: only `personal_sign` and `signTypedData` are used, never a transaction.
 *
 * viem is imported lazily so that read-only users who only consume a cached token or
 * PHAROS_ACCESS_TOKEN never need the dependency resolved at runtime.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PharosError } from "./errors.mjs";

export const DEFAULT_WALLET_FILE = ".local/wallet.json";

/**
 * Convert the API's EIP-712 payload into the shape signing libraries expect
 * (`uint*` values arrive as decimal strings; `chainId` may arrive as a string).
 * @param {any} typedData
 */
export function normalizeTypedData(typedData) {
  const clone = JSON.parse(JSON.stringify(typedData));
  const uintFields = new Set();
  for (const fields of Object.values(clone.types ?? {})) {
    for (const f of fields) if (/^uint\d*$/.test(f.type)) uintFields.add(f.name);
  }
  for (const [k, v] of Object.entries(clone.message ?? {})) {
    if (uintFields.has(k) && typeof v === "string" && /^\d+$/.test(v)) clone.message[k] = BigInt(v);
  }
  if (typeof clone.domain?.chainId === "string" && /^\d+$/.test(clone.domain.chainId)) {
    clone.domain.chainId = Number(clone.domain.chainId);
  }
  return clone;
}

/**
 * Load the local throwaway EOA, creating it on first run. The private key is written only to
 * the git-ignored `.local/` directory and is never printed.
 * @param {string} file
 * @returns {Promise<{ address: string, privateKey: string, createdAt?: string }>}
 */
export async function loadOrCreateWallet(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.privateKey && parsed?.address) return parsed;
  } catch {
    /* first run */
  }
  const { generatePrivateKey, privateKeyToAccount } = await loadViem();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ address: account.address, privateKey, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return { address: account.address, privateKey };
}

async function loadViem() {
  try {
    return await import("viem/accounts");
  } catch (err) {
    throw new PharosError("wallet sign-in needs the `viem` dependency, which is not installed", {
      kind: "usage",
      hint: "Run `npm install` in the project directory, then retry `pharos-docs --login`.",
      cause: err,
    });
  }
}

/**
 * Perform the full sign-in + onboarding handshake and return a redacted summary.
 *
 * @param {{
 *   client: import("./mcp.mjs").PharosDocsClient,
 *   walletFile?: string,
 *   chainId?: number | null,
 *   maxPolls?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onStep?: (step: { step: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export async function runLogin(options) {
  const { client } = options;
  const walletFile = options.walletFile ?? DEFAULT_WALLET_FILE;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onStep = options.onStep ?? (() => {});
  const maxPolls = options.maxPolls ?? 20;

  const { privateKeyToAccount } = await loadViem();
  const wallet = await loadOrCreateWallet(walletFile);
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (wallet.privateKey));
  const steps = [];

  const guest = await client.bootstrap();
  onStep({ step: "bootstrap", detail: { tokenType: guest.tokenType, remainingQuota: guest.remainingQuota } });
  steps.push({ step: "bootstrap", tokenType: guest.tokenType });

  const chainId = options.chainId ?? (Number(guest.supportedChains?.[0]) || 5734951);
  const challenge = await client.requestWalletChallenge({ address: account.address, chainId });
  const signature = await account.signMessage({ message: challenge.message });
  const verified = await client.verifyWallet({ challengeId: challenge.challengeId, address: account.address, signature });
  steps.push({ step: "wallet-verify", tokenType: verified.tokenType, expiresAt: verified.expiresAt });
  onStep({ step: "wallet-verify", detail: { tokenType: verified.tokenType, expiresAt: verified.expiresAt } });

  let status = await client.waitForOnboarding({ maxPolls, sleep });
  steps.push({ step: "onboarding-status", state: status.state, nextAction: status.nextAction });
  onStep({ step: "onboarding-status", detail: { state: status.state, nextAction: status.nextAction } });

  if (status.nextAction === "PREPARE_OR_SIGN_GUARDIAN") {
    const prep = await client.prepareGuardianClaim();
    const typed = normalizeTypedData(prep.typedData);
    const claimSignature = await account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    const submitted = await client.submitGuardianClaim({ operationId: prep.operationId, signature: claimSignature });
    steps.push({ step: "guardian-claim", ok: submitted.ok, code: submitted.code });
    onStep({ step: "guardian-claim", detail: { ok: submitted.ok, code: submitted.code } });

    for (let i = 0; i < 10; i += 1) {
      const claim = await client.guardianClaimStatus({ operationId: prep.operationId });
      steps.push({ step: "guardian-claim-status", status: claim.data?.status ?? null });
      if (claim.data?.status && claim.data.status !== "PENDING" && claim.data.status !== "PROCESSING") break;
      await sleep(3000);
    }
    status = await client.waitForOnboarding({ maxPolls, sleep });
    steps.push({ step: "onboarding-status-after-guardian", state: status.state, nextAction: status.nextAction });
    onStep({ step: "onboarding-status", detail: { state: status.state, nextAction: status.nextAction } });
  }

  const completed = await client.completeOnboarding();
  steps.push({ step: "onboarding-complete", ok: completed.ok, code: completed.code, tokenType: completed.tokenType, state: completed.state });
  onStep({ step: "onboarding-complete", detail: { ok: completed.ok, code: completed.code, tokenType: completed.tokenType } });

  return {
    address: account.address,
    chainId,
    tokenType: client.auth?.tokenType ?? null,
    expiresAt: client.auth?.expiresAt ?? null,
    sessionId: client.auth?.sessionId ?? "",
    steps,
  };
}
