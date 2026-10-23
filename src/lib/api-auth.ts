import "server-only";

import { getServerSession, type Session } from "next-auth";

import { authOptions } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import type { AppRole } from "@/types";

/**
 * Role hierarchy: admin > operator > viewer.
 * A user with a higher role implicitly has lower-role permissions.
 */
const ROLE_HIERARCHY: Record<AppRole, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

function hasMinimumRole(userRole: AppRole | undefined, minimum: AppRole): boolean {
  if (!userRole) return false;
  return (ROLE_HIERARCHY[userRole] ?? 0) >= ROLE_HIERARCHY[minimum];
}

/**
 * Authorizes scheduler-triggered requests (e.g. Vercel Cron) that carry no
 * maintainer session. Requires `CRON_SECRET` to be configured — with it
 * unset, only maintainers can trigger the action.
 */
export function isAuthorizedScheduler(
  request: Request | { headers: Headers | { get(name: string): string | null } }
): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authHeader =
    request.headers instanceof Headers
      ? request.headers.get("authorization")
      : typeof request.headers.get === "function"
      ? request.headers.get("authorization")
      : null;
  return authHeader === `Bearer ${secret}`;
}

/**
 * Return the current session only when the user is a maintainer, otherwise
 * null. Shared by every maintainer-only API route.
 */
export async function requireMaintainerSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isMaintainer) {
    return null;
  }
  return session;
}

/**
 * Require a minimum RBAC role. Falls back to maintainer check for backwards
 * compatibility: existing maintainers without an explicit role get "viewer".
 *
 * Returns the session if the role requirement is met, otherwise null.
 * Records an audit log on denial.
 */
export async function requireRole(
  minimumRole: AppRole,
  action?: string
): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isMaintainer) return null;

  const userRole = (session.user.role as AppRole | undefined) ?? "viewer";

  if (hasMinimumRole(userRole, minimumRole)) {
    return session;
  }

  // Audit the denial
  await recordAuditLog({
    action: "rbac_access_denied",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      requiredRole: minimumRole,
      actualRole: userRole,
      action: action ?? "unknown",
    },
  });

  return null;
}

/**
 * Convenience: require operator role or higher.
 */
export async function requireOperator(action?: string): Promise<Session | null> {
  return requireRole("operator", action);
}

/**
 * Convenience: require admin role.
 */
export async function requireAdmin(action?: string): Promise<Session | null> {
  return requireRole("admin", action);
}

/**
 * Refresh the maintainer session. This re-evaluates the current server session
 * and returns it if the user is still a maintainer. It can be used by UI
 * components or API routes that need to ensure the maintainer flag is up-to-date
 * without forcing the user to re-login.
 */
export async function refreshMaintainerSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (session?.user?.isMaintainer) {
    return session;
  }
  return null;
}

export { hasMinimumRole, ROLE_HIERARCHY };
