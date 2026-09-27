import { z } from "zod";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";

const resultSchema = z.object({
  runId: z.string().uuid(), runAttemptId: z.string().uuid(), leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(), source: repositoryExecutionRequestSchema.shape.source,
  artifacts: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
    title: z.string().trim().min(1).max(200), kind: z.enum(["code_change", "document", "report"]),
    bytes: z.number().int().nonnegative().max(32 * 1024 * 1024),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), contentRef: z.string().max(200),
  }).strict()).min(1).max(10),
}).strict();

export function validateRepositoryResult(raw: unknown, input: RepositoryExecutionRequest) {
  const request = repositoryExecutionRequestSchema.parse(input);
  const result = resultSchema.parse(raw);
  if (result.runId !== request.runId || result.runAttemptId !== request.runAttemptId
    || result.leaseId !== request.leaseId || result.fencingToken !== request.fencingToken
    || JSON.stringify(result.source) !== JSON.stringify(request.source)
    || result.artifacts.length > request.output.maxFiles
    || result.artifacts.reduce((total, item) => total + item.bytes, 0) > request.output.maxTotalBytes
    || new Set(result.artifacts.map(item => item.path)).size !== result.artifacts.length
    || result.artifacts.some((item, ordinal) => item.ordinal !== ordinal || item.bytes > request.output.maxFileBytes
      || item.contentRef !== `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${item.contentHash}`)) {
    throw new Error("REPOSITORY_RESULT_INVALID");
  }
  return result;
}
