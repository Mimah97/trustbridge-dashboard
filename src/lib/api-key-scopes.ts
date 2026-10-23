export const API_KEY_SCOPE_VALUES = ["export:read", "cron:trigger"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPE_VALUES)[number];

export const API_KEY_SCOPE_DEFINITIONS: Record<
    ApiKeyScope,
    { bit: number; mask: number; description: string }
> = {
    "export:read": {
        bit: 0,
        mask: 1 << 0,
        description: "Read contributor export endpoints; does not allow writes.",
    },
    "cron:trigger": {
        bit: 1,
        mask: 1 << 1,
        description:
            "Trigger scheduled cron export/digest runs; does not grant maintainer session rights.",
    },
};

export const API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPE_VALUES];

export const API_KEY_ALL_SCOPES_MASK = Object.values(
    API_KEY_SCOPE_DEFINITIONS
).reduce((mask, definition) => mask | definition.mask, 0);

/** Convert named scopes to their canonical bitmask; unknown names grant nothing. */
export function apiKeyScopesToBitmask(scopes: readonly string[]): number {
    return scopes.reduce((mask, scope) => {
        if (scope === "*") return API_KEY_ALL_SCOPES_MASK;
        const definition = API_KEY_SCOPE_DEFINITIONS[scope as ApiKeyScope];
        return definition ? mask | definition.mask : mask;
    }, 0);
}

export function hasApiKeyScope(
    scopes: readonly string[],
    required: ApiKeyScope
): boolean {
    return (
        (apiKeyScopesToBitmask(scopes) & API_KEY_SCOPE_DEFINITIONS[required].mask) !==
        0
    );
}