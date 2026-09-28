ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_submission_review_uq" UNIQUE("submission_id","review_id");--> statement-breakpoint
ALTER TABLE "verrail_acceptances" DROP CONSTRAINT "verrail_acceptances_submission_uq";
