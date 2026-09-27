import type { Db } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { createRepositoryClaimedLeaseValidator, createRepositoryLeaseValidator, createRepositoryOfferedLeaseValidator } from "./repository-lease.js";
import { createRepositoryRunReporter } from "./repository-run-events.js";

export async function startOfferedRepositoryAttempt(options: {
  db: Db; domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  request: RepositoryExecutionRequest; lastEventCursor: number; signal: AbortSignal;
}) {
  const { db, request, signal } = options;
  await createRepositoryOfferedLeaseValidator(db)(request, signal);
  const reporter = createRepositoryRunReporter(options);
  await reporter.claim(signal);
  await createRepositoryClaimedLeaseValidator(db)(request, signal);
  const started = await reporter.start(signal);
  await createRepositoryLeaseValidator(db)(request, signal);
  return started.cursor;
}
