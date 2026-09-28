import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { authAccounts, authUsers, type Db } from "@paperclipai/db";
import { z } from "zod";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";

const firstOperatorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(16).max(128),
}).strict();

// Operator-only job; never mount this capability as an HTTP endpoint.
export async function bootstrapFirstOperator(db: Db, value: unknown) {
  const input = firstOperatorSchema.parse(value);
  const password = await hashPassword(input.password);
  const userId = randomUUID();
  const timestamp = new Date();
  const result = await claimFirstInstanceAdmin(db, {
    userId,
    onClaim: async tx => {
      await tx.execute(sql`lock table ${authUsers} in share row exclusive mode`);
      const existing = await tx.select({ id: authUsers.id }).from(authUsers)
        .where(sql`lower(${authUsers.email}) = ${input.email}`).limit(1);
      if (existing.length) throw new Error("First operator email already exists");
      await tx.insert(authUsers).values({
        id: userId, name: input.name, email: input.email, emailVerified: false,
        createdAt: timestamp, updatedAt: timestamp,
      });
      await tx.insert(authAccounts).values({
        id: randomUUID(), userId, accountId: userId, providerId: "credential", password,
        createdAt: timestamp, updatedAt: timestamp,
      });
    },
  });
  return result.status === "claimed"
    ? { status: "created" as const, userId }
    : { status: "already_initialized" as const };
}
