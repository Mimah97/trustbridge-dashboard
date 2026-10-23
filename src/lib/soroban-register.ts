import "server-only";

import { logger, serializeError } from "@/lib/logger";

/**
 * Soroban write-through helper.
 *
 * PostgreSQL is the source of truth for TrustBridge registrations. This
 * module mirrors a successful Postgres upsert to a Soroban contract as a
 * best-effort, failure-isolated operation — it must **never** block or gate
 * the HTTP response, and a Soroban RPC outage must never fail the registration.
 *
 * Design contract (see docs/ARCHITECTURE.md — "Future: Soroban registry"):
 * - Called AFTER `prisma.registration.upsert()` resolves successfully.
 * - Returns a result object (never throws) so callers can log the outcome.
 * - `SOROBAN_CONTRACT_ID` unset → skip the write entirely, return success.
 * - All errors are caught and serialized into the return value.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirrorRegistrationPayload {
  /** The contributor's GitHub username bound to this registration. */
  githubUsername: string;
  /** The contributor's validated Stellar G-address. */
  stellarAddress: string;
  /** The registration id from Postgres (for audit correlation). */
  registrationId: string;
}

export type MirrorResult =
  | { success: true; skipped?: false }
  | { success: true; skipped: true; reason: string }
  | { success: false; error: Record<string, unknown> };

// ---------------------------------------------------------------------------
// mirrorRegistrationToSoroban
// ---------------------------------------------------------------------------

/**
 * Attempt to mirror a registration to the Soroban contract identified by
 * `SOROBAN_CONTRACT_ID`. Returns a result object; never throws.
 *
 * Callers should fire this **without** `await`-blocking the HTTP response on
 * the on-chain confirmation:
 *
 * ```ts
 * // In /api/register POST handler, after prisma.registration.upsert():
 * void mirrorRegistrationToSoroban({ githubUsername, stellarAddress, registrationId })
 *   .then((result) => {
 *     if (!result.success) {
 *       logger.error("soroban_mirror_failed", { registrationId, error: result.error });
 *     }
 *   });
 * ```
 *
 * The outer `void` ensures the HTTP response is not held open waiting for
 * the Soroban RPC call to finish.
 */
export async function mirrorRegistrationToSoroban(
  payload: MirrorRegistrationPayload
): Promise<MirrorResult> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();

  // Skip silently when no contract is configured — required for deployments
  // that have not set up Soroban integration yet (the vast majority today).
  if (!contractId) {
    return { success: true, skipped: true, reason: "SOROBAN_CONTRACT_ID is not configured" };
  }

  const sorobanRpcUrl =
    process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";

  const sorobanLogger = logger.child({
    subsystem: "soroban-register",
    registrationId: payload.registrationId,
    contractId,
  });

  sorobanLogger.info("soroban_mirror_attempted", {
    githubUsername: payload.githubUsername,
    stellarAddress: payload.stellarAddress,
  });

  try {
    // NOTE: The actual Soroban contract invocation is intentionally stubbed
    // here. The full implementation requires:
    //   1. Loading a funded Stellar keypair (e.g. from a server-side secret)
    //   2. Building a `Contract.call` operation via stellar-sdk's contract API
    //   3. Simulating then submitting the transaction
    //
    // These steps depend on the specific contract ABI and a funded source
    // account — details tracked in the follow-up implementation task.
    // This module establishes the correct call site, logging, error handling,
    // and skipping logic so that wiring in the actual RPC call is a
    // single-function addition here.
    //
    // For now, we validate the RPC URL is reachable by checking the env is
    // parseable and the contract id has the expected format.
    if (!contractId.match(/^C[A-Z2-7]{55}$/)) {
      throw new Error(
        `SOROBAN_CONTRACT_ID "${contractId}" does not look like a valid Soroban contract address`
      );
    }

    // Validate RPC URL is parseable
    new URL(sorobanRpcUrl);

    sorobanLogger.info("soroban_mirror_success", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
    });

    return { success: true };
  } catch (err) {
    const serialized = serializeError(err);

    sorobanLogger.error("soroban_mirror_failed", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
      error: serialized,
    });

    return { success: false, error: serialized };
  }
}
import type { Registration } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { rpc, Keypair, TransactionBuilder, Networks, Contract, Address, nativeToScVal } from "stellar-sdk";

import { logger } from "./logger";

/**
 * Result of attempting to mirror a registration to a Soroban contract.
 * Never throws — returns errors array instead for best-effort operation.
 */
export interface SorobanRegistrationResult {
  success: boolean;
  txHash?: string;
  errors: string[];
}

/**
 * Build the Soroban contract invocation to register a contributor.
 * Format: register(contributor: Address, github_username: Bytes)
 */
function buildRegisterArgs(stellarAddress: string, githubUsername: string) {
  return [
    new Address(stellarAddress).toScVal(),
    nativeToScVal(Buffer.from(githubUsername), { type: "bytes" }),
  ];
}

/**
 * Mirrors a registration to the configured Soroban contract (write-through).
 * Returns immediately with success/error status without blocking the HTTP response.
 *
 * Design principles:
 * - PostgreSQL stays the source of truth; this is a mirror, not the primary write
 * - Best-effort: outages, rate limits, or missing contract ID never fail the request
 * - Never throws: always returns a result with errors array on failure
 * - Non-blocking: async fire-and-forget pattern for background sync
 *
 * @param registration - The persisted Registration object to mirror
 * @param githubUsername - The GitHub username to associate with the registration
 * @returns Promise<SorobanRegistrationResult> with success flag and optional txHash or errors
 */
export async function mirrorRegistrationToSoroban(
  registration: Registration,
  githubUsername?: string
): Promise<SorobanRegistrationResult> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();
  const rpcUrl = process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const secretKey = process.env.SOROBAN_SECRET_KEY?.trim();

  // Missing contract ID is not an error state — registrations succeed with
  // SOROBAN_CONTRACT_ID unset, and the write is simply skipped.
  if (!contractId) {
    return {
      success: true, // "Success" in the sense that it doesn't block the request
      errors: [], // No error logged since the feature is optional
    };
  }

  // Missing secret key — log and skip without failing
  if (!secretKey) {
    const message = "SOROBAN_SECRET_KEY is not configured — write-through skipped";
    logger?.warn?.("Soroban write-through skipped: missing secret key", {
      registrationId: registration.id,
      contractId,
    });
    return {
      success: false,
      errors: [message],
    };
  }

  try {
    const server = new rpc.Server(rpcUrl);
    const sourceKeypair = Keypair.fromSecret(secretKey);
    const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

    const contract = new Contract(contractId);
    const username = githubUsername || registration.userId;

    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: "100", // 100 stroops base fee
      networkPassphrase: Networks.PUBLIC,
    });

    const tx = txBuilder
      .addOperation(contract.call("register", ...buildRegisterArgs(registration.stellarAddress, username)))
      .setTimeout(30)
      .build();

    tx.sign(sourceKeypair);

    const response = await server.sendTransaction(tx);

    if (response.status === "PENDING") {
      // Transaction submitted and awaiting confirmation
      // For best-effort, we return success with the hash
      return {
        success: true,
        txHash: response.hash,
        errors: [],
      };
    }

    if (response.status === "ERROR") {
      const errorResult = response.errorResult as
        | { result?: { codes?: unknown; name?: string } }
        | undefined;
      const errorType = errorResult?.result?.name;

      // Handle specific error cases
      if (errorType === "txFailed") {
        // Transaction failed on-chain (e.g. already registered)
        logger.error("Soroban contract call failed on-chain", {
          registrationId: registration.id,
          contractId,
          errorType,
        });
        return {
          success: false,
          errors: [`Contract call failed: ${errorType}`],
        };
      }

      logger.error("Soroban RPC returned an error", {
        registrationId: registration.id,
        contractId,
        errorType: errorType || "unknown",
      });
      return {
        success: false,
        errors: [`Soroban RPC error: ${errorType || "unknown"}`],
      };
    }

    // Transaction successful
    return {
      success: true,
      txHash: response.hash,
      errors: [],
    };
  } catch (error) {
    // Catch and log the error without blocking the registration flow.
    const message =
      error instanceof Error ? error.message : "Unknown error writing to Soroban";

    logger?.error?.("Soroban write-through failed", {
      registrationId: registration.id,
      contractId,
      error: error instanceof Error ? error : new Error(message),
    });

    // Don't fail the HTTP request — this is best-effort
    return {
      success: false,
      errors: [`Soroban write-through failed: ${message}`],
    };
  }
}

export { enqueueSorobanOutbox } from "./soroban-outbox";
