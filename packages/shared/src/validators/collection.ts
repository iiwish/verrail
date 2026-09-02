import { z } from "zod";

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000).nullable().optional(),
}).strict();

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
