import "next-auth";
import "next-auth/jwt";

export type AppRole = "admin" | "operator" | "viewer";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      githubUsername?: string;
      isMaintainer?: boolean;
      /**
       * The maintainer org this user belongs to, as recorded during sign-in.
       * Sourced from GITHUB_MAINTAINER_ORG at the time of the JWT callback.
       * Defaults to "default" when the DB or env value is absent so that API
       * route org-scoping logic can always rely on a non-empty string.
       */
      maintainerOrgId?: string;
      role?: AppRole;
      csrfToken?: string;
      /** The org the maintainer is currently scoped to. Defaults to "default". */
      maintainerOrgId?: string;
      /**
       * All orgs the maintainer belongs to (from ALLOWED_MAINTAINER_ORGS).
       * Only populated for maintainers; empty array for contributors.
       */
      availableOrgs?: string[];
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubId?: string;
    githubUsername?: string;
    isMaintainer?: boolean;
    /**
     * Org identifier stored on the JWT so that session refreshes do not
     * require a round-trip back to the database or the GitHub API.
     */
    maintainerOrgId?: string;
    role?: AppRole;
    /** Active org for this session (set at sign-in, switchable via /api/auth/switch-org). */
    maintainerOrgId?: string;
    /** All orgs this maintainer belongs to (baked in at sign-in). */
    availableOrgs?: string[];
  }
}