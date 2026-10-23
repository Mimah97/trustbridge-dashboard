import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Records an initial address registration for a user.
 * Called when a user first registers a Stellar address.
 */
export async function recordInitialAddress(
  userId: string,
  stellarAddress: string
): Promise<void> {
  const registration = await prisma.registration.findUnique({
    where: { userId },
  });

  if (!registration || registration.deletedAt) return;

  await prisma.addressHistoryRecord.create({
    data: {
      userId,
      previousAddress: null,
      newAddress: stellarAddress,
      changeType: "initial",
    },
  });
}

/**
 * Records an address change for a user.
 * Called when a user updates their registered Stellar address.
 */
export async function recordAddressChange(
  userId: string,
  previousAddress: string | null,
  newAddress: string
): Promise<void> {
  await prisma.addressHistoryRecord.create({
    data: {
      userId,
      previousAddress,
      newAddress,
      changeType: "updated",
    },
  });
}

/**
 * Retrieves the complete address history for a user.
 */
export async function getAddressHistory(
  userId: string
): Promise<
  {
    stellarAddress: string;
    changeType: string;
    recordedAt: Date;
  }[]
> {
  const history = await prisma.addressHistoryRecord.findMany({
    where: { userId },
    select: {
      newAddress: true,
      changeType: true,
      recordedAt: true,
    },
    orderBy: { recordedAt: "desc" },
  });

  return history.map((record) => ({
    stellarAddress: record.newAddress,
    changeType: record.changeType,
    recordedAt: record.recordedAt,
  }));
}

/**
 * Gets the most recent address registration for a user.
 */
export async function getLatestAddress(userId: string): Promise<string | null> {
  const latest = await prisma.addressHistoryRecord.findFirst({
    where: { userId },
    select: { newAddress: true },
    orderBy: { recordedAt: "desc" },
  });

  return latest?.newAddress ?? null;
}

/**
 * Supported export serialization formats for address history.
 */
export type AddressHistoryExportFormat = "json" | "csv";

/**
 * Stable error codes surfaced by the address-history export flow.
 */
export type AddressHistoryExportErrorCode =
  | "invalid_format"
  | "empty_history";

/**
 * Raised when an export request cannot be fulfilled. Carries a stable code
 * so API routes can map it to a deterministic HTTP response.
 */
export class AddressHistoryExportError extends Error {
  readonly code: AddressHistoryExportErrorCode;

  constructor(code: AddressHistoryExportErrorCode, message: string) {
    super(message);
    this.name = "AddressHistoryExportError";
    this.code = code;
  }
}

const EXPORT_FORMATS: readonly AddressHistoryExportFormat[] = ["json", "csv"];

/**
 * Normalizes and validates a requested export format. Defaults to JSON when
 * unspecified; rejects unknown formats with a stable error.
 */
export function parseExportFormat(
  raw: unknown
): AddressHistoryExportFormat {
  if (raw === undefined || raw === null || raw === "") return "json";
  if (typeof raw !== "string" || !EXPORT_FORMATS.includes(raw as AddressHistoryExportFormat)) {
    throw new AddressHistoryExportError(
      "invalid_format",
      `Unsupported export format. Expected one of: ${EXPORT_FORMATS.join(", ")}.`
    );
  }
  return raw as AddressHistoryExportFormat;
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serializes address history records into the requested export format.
 * Reuses the same record shape returned by `getAddressHistory`.
 */
export function serializeAddressHistory(
  records: Awaited<ReturnType<typeof getAddressHistory>>,
  format: AddressHistoryExportFormat
): { contentType: string; body: string } {
  if (format === "csv") {
    const header = "stellarAddress,changeType,recordedAt";
    const rows = records.map((record) =>
      [
        escapeCsvField(record.stellarAddress),
        escapeCsvField(record.changeType),
        escapeCsvField(record.recordedAt.toISOString()),
      ].join(",")
    );
    return {
      contentType: "text/csv; charset=utf-8",
      body: [header, ...rows].join("\n"),
    };
  }

  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      records: records.map((record) => ({
        stellarAddress: record.stellarAddress,
        changeType: record.changeType,
        recordedAt: record.recordedAt.toISOString(),
      })),
    }),
  };
}

/**
 * Builds a scoped export payload for a single user's address history.
 * Enforces that the caller only exports their own history and fails with a
 * stable error when there is nothing to export.
 */
export async function buildAddressHistoryExport(
  userId: string,
  requestedUserId: string | null | undefined,
  rawFormat: unknown
): Promise<{
  format: AddressHistoryExportFormat;
  contentType: string;
  body: string;
  filename: string;
}> {
  if (!userId) {
    throw new AddressHistoryExportError(
      "empty_history",
      "Authenticated user is required to export address history."
    );
  }

  if (requestedUserId && requestedUserId !== userId) {
    throw new AddressHistoryExportError(
      "empty_history",
      "Address history export is scoped to the authenticated user."
    );
  }

  const format = parseExportFormat(rawFormat);
  const records = await getAddressHistory(userId);

  if (records.length === 0) {
    throw new AddressHistoryExportError(
      "empty_history",
      "No address history available to export."
    );
  }

  const { contentType, body } = serializeAddressHistory(records, format);

  return {
    format,
    contentType,
    body,
    filename: `address-history.${format}`,
  };
}
