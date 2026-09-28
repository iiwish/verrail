import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { createRepositoryExecutionController } from "./repository-controller.js";
import { createRepositoryRunReporter } from "./repository-run-events.js";
import { reconcileRepositoryCompletion } from "./repository-reconciliation.js";

type ControllerOptions = Parameters<typeof createRepositoryExecutionController>[0];

// The scheduler supplies a Go-started Attempt and its authoritative event cursor.
// Neither requests nor cursors from a browser/model may enter this internal API.
export function createStartedRepositoryRunExecutor(options: Omit<ControllerOptions, "renewRun" | "emit"> & {
  domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
}) {
  return async (request: RepositoryExecutionRequest, lastEventCursor: number, signal: AbortSignal) => {
    const reporter = createRepositoryRunReporter({ request, lastEventCursor, domainApi: options.domainApi });
    const execute = createRepositoryExecutionController({ ...options,
      renewRun: async (_request, currentSignal) => { await reporter.renew(currentSignal); },
      emit: async (_request, text, currentSignal) => { await reporter.progress(text, currentSignal); },
    });
    // An error may precede ownership or follow an ambiguous claim response.
    // Do not fail another controller's Run; recovery must inspect durable state.
    const outcome = await execute(request, signal);
    if (outcome.status === "already_dispatched") return outcome;
    if (outcome.status === "canceled") {
      // Use the durable cursor after all in-flight events and cleanup have
      // settled, not the possibly aborted/ambiguous execution event stream.
      const completion = await reconcileRepositoryCompletion({ db: options.db, domainApi: options.domainApi,
        workspaceId: request.workspaceId, runAttemptId: request.runAttemptId, signal: AbortSignal.timeout(5000) }, "canceled");
      if (completion.status !== "registered") throw new Error("REPOSITORY_CANCELLATION_NOT_REGISTERED");
      return { status: "canceled" as const };
    }
    // Do not turn an ambiguous success response into a failure command or repeat
    // execution. The durable transport result is available for reconciliation.
    const event = await reporter.succeed(outcome.result, signal);
    return { status: "succeeded" as const, result: outcome.result, event };
  };
}
