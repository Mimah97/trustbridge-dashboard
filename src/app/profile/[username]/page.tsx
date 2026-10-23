import { notFound } from "next/navigation";
import { Clock } from "lucide-react";
import type { Metadata } from "next";

import { prisma } from "@/lib/prisma";
import { computeReadiness } from "@/lib/readiness";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrustlineStatusBadge } from "@/components/TrustlineStatusBadge";

export const dynamic = "force-dynamic";

interface Props {
  params: { username: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `${params.username} — TrustBridge`,
    description: `TrustBridge readiness profile for @${params.username}`,
  };
}

export default async function PublicProfilePage({ params }: Props) {
  const { username } = params;

  // Validate username format before DB query
  if (!/^[a-zA-Z0-9_-]{1,39}$/.test(username)) {
    notFound();
  }

  const user = await prisma.user.findUnique({
    where: { githubUsername: username },
    select: {
      githubUsername: true,
      registration: {
        select: {
          profilePublic: true,
          showStellarAddress: true,
          stellarAddress: true,
          funded: true,
          trustlineReady: true,
          trustlineAuthorized: true,
          xlmBalance: true,
          spendableXlmBalance: true,
          lastCheckedAt: true,
          deletedAt: true,
        },
      },
    },
  });

  const reg = user?.registration;
  // Return 404 for any case that shouldn't be public — prevents user enumeration
  if (!user || !reg || reg.deletedAt || !reg.profilePublic) {
    notFound();
  }

  const readiness = computeReadiness(
    reg.funded,
    reg.trustlineReady,
    reg.xlmBalance,
    { authorized: reg.trustlineAuthorized, spendableBalance: reg.spendableXlmBalance }
  );

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-xl px-6 py-16 sm:px-8">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div>
              <CardTitle className="text-xl">@{user.githubUsername}</CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                TrustBridge contributor
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Readiness</span>
            <TrustlineStatusBadge status={readiness} />
          </div>

          {reg.showStellarAddress && (
            <div className="flex items-start justify-between gap-4">
              <span className="shrink-0 text-sm text-muted-foreground">
                Stellar address
              </span>
              <code className="break-all text-right font-mono text-xs text-foreground">
                {reg.stellarAddress}
              </code>
            </div>
          )}

          {reg.lastCheckedAt && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last checked</span>
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {new Date(reg.lastCheckedAt).toLocaleDateString(undefined, {
                  dateStyle: "medium",
                })}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
