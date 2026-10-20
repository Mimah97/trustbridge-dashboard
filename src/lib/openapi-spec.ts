import "server-only";

/**
 * OpenAPI 3.0.0 schema object
 */
export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: {
      name: string;
      url: string;
    };
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

/**
 * Generates the OpenAPI 3.0.0 specification for TrustBridge Dashboard
 */
export function generateOpenAPISpec(
  apiUrl: string = "http://localhost:3000"
): OpenAPISpec {
  return {
    openapi: "3.0.0",
    info: {
      title: "TrustBridge Dashboard API",
      version: "1.0.0",
      description:
        "API for managing Stellar address registrations and payout readiness validation",
      contact: {
        name: "TrustBridge",
        url: "https://github.com/Stellar-TrustBridge/trustbridge-dashboard",
      },
    },
    servers: [
      {
        url: apiUrl,
        description: "TrustBridge Dashboard API",
      },
    ],
    paths: {
      "/api/register": {
        get: {
          operationId: "getRegistration",
          summary: "Get contributor registration",
          tags: ["Registration"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Registration found",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Registration",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated",
            },
            "404": {
              description: "Registration not found",
            },
          },
        },
        post: {
          operationId: "updateRegistration",
          summary: "Create or update contributor registration",
          tags: ["Registration"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RegistrationInput",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Registration updated",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Registration",
                  },
                },
              },
            },
            "400": {
              description: "Invalid request",
            },
            "401": {
              description: "Not authenticated",
            },
          },
        },
      },
      "/api/check": {
        post: {
          operationId: "checkAddress",
          summary: "Validate Stellar address via Horizon",
          tags: ["Validation"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CheckRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Address check result",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CheckResult",
                  },
                },
              },
            },
            "400": {
              description: "Invalid address",
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/contributors": {
        get: {
          operationId: "listContributors",
          summary: "List all contributors with readiness status",
          tags: ["Contributors"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description: "Pagination cursor (base64-encoded ID)",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              description: "Number of results per page",
            },
          ],
          responses: {
            "200": {
              description: "List of contributors",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ContributorList",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated or not a maintainer",
            },
          },
        },
        post: {
          operationId: "recheckAllContributors",
          summary: "Batch re-check all contributors via Horizon",
          tags: ["Contributors"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Batch re-check initiated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      checked: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated or not a maintainer",
            },
          },
        },
      },
      "/api/stats": {
        get: {
          operationId: "getStats",
          summary: "Get aggregate readiness statistics",
          tags: ["Stats"],
          responses: {
            "200": {
              description: "Dashboard statistics",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/DashboardStats",
                  },
                },
              },
            },
          },
        },
      },
      "/api/actions/lookup": {
        get: {
          operationId: "lookupAction",
          summary: "Public action lookup for a Stellar address",
          tags: ["Actions"],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "asset_code",
              in: "query",
              schema: { type: "string", default: "USDC" },
              description: "Asset code for trustline check",
            },
            {
              name: "asset_issuer",
              in: "query",
              schema: { type: "string" },
              description: "Asset issuer public key",
            },
          ],
          responses: {
            "200": {
              description: "Action lookup result with next-action hint",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ActionLookupResult",
                  },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/badge": {
        get: {
          operationId: "getBadge",
          summary: "Get readiness badge for a Stellar address",
          tags: ["Badge"],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "format",
              in: "query",
              schema: {
                type: "string",
                enum: ["json", "svg"],
                default: "json",
              },
              description: "Response format for the badge",
            },
          ],
          responses: {
            "200": {
              description: "Badge payload (JSON) or rendered SVG badge",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Badge",
                  },
                },
                "image/svg+xml": {
                  schema: { type: "string" },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "404": {
              description: "No badge available for address",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/address-history": {
        get: {
          operationId: "getAddressHistory",
          summary: "Get readiness history for a Stellar address",
          tags: ["Address History"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description: "Pagination cursor (base64-encoded ID)",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              description: "Number of history entries per page",
            },
          ],
          responses: {
            "200": {
              description: "Address history entries",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/AddressHistoryList",
                  },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated",
            },
          },
        },
      },
      "/api/webhooks/trustbridge-action": {
        post: {
          operationId: "trustbridgeActionWebhook",
          summary: "Receive trustbridge-action validation webhook",
          tags: ["Webhooks"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookPayload",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Webhook accepted",
            },
            "400": {
              description: "Invalid webhook payload",
            },
            "401": {
              description: "Invalid webhook signature",
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
        Badge: {
          type: "object",
          required: ["address", "status"],
          properties: {
            address: { type: "string" },
            status: {
              type: "string",
              enum: ["ready", "pending", "blocked", "unknown"],
            },
            label: { type: "string" },
            message: { type: "string" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AddressHistoryEntry: {
          type: "object",
          required: ["id", "address", "status", "createdAt"],
          properties: {
            id: { type: "string" },
            address: { type: "string" },
            status: {
              type: "string",
              enum: ["ready", "pending", "blocked", "unknown"],
            },
            reason: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        AddressHistoryList: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              items: { $ref: "#/components/schemas/AddressHistoryEntry" },
            },
            nextCursor: { type: "string", nullable: true },
          },
        },
      },
    },
  };
}
