package target

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

type deliveryFacts struct {
	submissionID, reviewID, acceptanceID string
	candidateCurrent, criteriaVerified   bool
	reviewApproved                       bool
}

// Read one immutable candidate and its current bindings in the caller's transaction.
// Missing proofs allow inspection/review, never Acceptance or an external effect.
func readDeliveryFacts(ctx context.Context, tx pgx.Tx, workspaceID, targetID string) (deliveryFacts, error) {
	var facts deliveryFacts
	var criteriaJSON []byte
	if err := tx.QueryRow(ctx, `select revision.acceptance_criteria from verrail_targets target join verrail_target_revisions revision on revision.id=target.active_target_revision_id and revision.workspace_id=target.workspace_id where target.workspace_id=$1 and target.id=$2`, workspaceID, targetID).Scan(&criteriaJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return facts, nil
		}
		return facts, err
	}
	var criteria []AcceptanceCriterion
	if err := json.Unmarshal(criteriaJSON, &criteria); err != nil {
		return facts, err
	}
	hashes := map[string]string{}
	for _, criterion := range criteria {
		if criterion.ProofContract != nil {
			if err := ValidateCriterionProofContract(criterion.ProofContract); err != nil {
				return facts, err
			}
			hashes[criterion.ID] = proofHash(criterion.ProofContract)
		}
	}
	hashJSON, _ := json.Marshal(hashes)
	err := tx.QueryRow(ctx, `
		select submission.id,
		  submission.target_revision_id=target.active_target_revision_id
		  and submission.graph_revision_id is not distinct from graph.active_graph_revision_id
		  and cardinality(submission.artifact_revision_ids)>0
		  and submission.artifact_revision_ids @> array(
		    select distinct on (artifact.id) revision.id from verrail_artifacts artifact
		    join verrail_artifact_revisions revision on revision.artifact_id=artifact.id and revision.workspace_id=artifact.workspace_id
		    where artifact.workspace_id=$1 and artifact.target_id=$2
		    order by artifact.id,revision.revision_number desc,revision.id desc)
		  and not exists(select 1 from unnest(submission.artifact_revision_ids) submitted(id)
		    where not exists(select 1 from verrail_artifact_revisions revision
		      join verrail_artifacts artifact on artifact.id=revision.artifact_id and artifact.workspace_id=revision.workspace_id
		      where revision.id=submitted.id and artifact.workspace_id=$1 and artifact.target_id=$2
		      and not exists(select 1 from verrail_artifact_revisions newer where newer.artifact_id=artifact.id and newer.revision_number>revision.revision_number)))
		  and not exists(select 1 from unnest(submission.verification_result_ids) submitted(id)
		    where not exists(select 1 from verrail_verification_results result
		      join verrail_claims claim on claim.id=result.claim_id and claim.workspace_id=result.workspace_id
		      where result.id=submitted.id and claim.workspace_id=$1 and claim.target_id=$2
		      and not exists(select 1 from verrail_criterion_proofs late where late.verification_result_id=result.id and late.phase='post_effect')
		      and (not ($3::jsonb ? claim.criterion_key) or exists(select 1 from verrail_criterion_proofs proof where proof.verification_result_id=result.id and proof.phase='pre_acceptance' and proof.target_revision_id=target.active_target_revision_id and proof.graph_revision_id=submission.graph_revision_id and proof.contract_hash=($3::jsonb->>claim.criterion_key)))
		      and claim.target_revision_id=target.active_target_revision_id
		      and not exists(select 1 from verrail_verification_results newer
		        join verrail_claims newer_claim on newer_claim.id=newer.claim_id and newer_claim.workspace_id=newer.workspace_id
		        where newer_claim.workspace_id=$1 and newer_claim.target_id=$2 and newer_claim.target_revision_id=target.active_target_revision_id
		        and newer_claim.criterion_key=claim.criterion_key and (newer.created_at,newer.id)>(result.created_at,result.id)
		        and (not ($3::jsonb ? newer_claim.criterion_key) or exists(select 1 from verrail_criterion_proofs proof where proof.verification_result_id=newer.id and proof.phase='pre_acceptance' and proof.target_revision_id=target.active_target_revision_id and proof.graph_revision_id=submission.graph_revision_id and proof.contract_hash=($3::jsonb->>newer_claim.criterion_key)))
		        and not exists(select 1 from verrail_criterion_proofs late where late.verification_result_id=newer.id and late.phase='post_effect')))),

		  jsonb_array_length(target_revision.acceptance_criteria)>0
		  and not exists(select 1 from jsonb_array_elements(target_revision.acceptance_criteria) criterion
		    where (not (criterion ? 'proofContract') or exists(select 1 from jsonb_array_elements(criterion->'proofContract'->'allOf') requirement where requirement->>'phase'='pre_acceptance'))
		    and not exists(select 1 from (
		      select result.id,result.verdict,result.claim_id,result.evidence_ids from verrail_verification_results result
		      join verrail_claims claim on claim.id=result.claim_id and claim.workspace_id=result.workspace_id
		      where claim.workspace_id=$1 and claim.target_id=$2 and claim.target_revision_id=target.active_target_revision_id
		        and claim.criterion_key=criterion->>'id'
		        and not exists(select 1 from verrail_criterion_proofs late where late.verification_result_id=result.id and late.phase='post_effect')
		        and (not (criterion ? 'proofContract') or exists(select 1 from verrail_criterion_proofs proof
		          where proof.verification_result_id=result.id and proof.workspace_id=$1 and proof.target_revision_id=submission.target_revision_id
		          and proof.graph_revision_id=submission.graph_revision_id and proof.phase='pre_acceptance'
		          and proof.contract_hash=($3::jsonb->>(criterion->>'id'))
		          and exists(select 1 from jsonb_array_elements(criterion->'proofContract'->'allOf') requirement where requirement->>'id'=proof.requirement_id and requirement->>'phase'='pre_acceptance')))
		      order by result.created_at desc,result.id desc limit 1
		    ) latest where latest.verdict='passed' and latest.id=any(submission.verification_result_ids)
		      and cardinality(latest.evidence_ids)>0
		      and not exists(select 1 from unnest(latest.evidence_ids) proof(id)
		        where not exists(select 1 from verrail_evidence evidence
		          where evidence.id=proof.id and evidence.workspace_id=$1 and evidence.target_id=$2 and evidence.claim_id=latest.claim_id
		          and evidence.producer_principal_type<>'agent' and evidence.kind<>'agent_observation'
		          and evidence.trust_level in ('medium','high')
		          and exists(select 1 from verrail_artifact_revisions artifact where artifact.workspace_id=$1
		            and artifact.id=any(submission.artifact_revision_ids) and artifact.content_hash=evidence.object_hash)
		          and (evidence.kind<>'ci_result' or exists(select 1 from verrail_integration_runs integration
		            where integration.workspace_id=$1 and integration.target_id=$2
		            and integration.target_revision_id=submission.target_revision_id
		            and integration.graph_revision_id=submission.graph_revision_id
		            and integration.commit_ref=submission.commit_ref
		            and integration.claim_id=latest.claim_id and integration.criterion_key=criterion->>'id'
		            and integration.verification_result_id=latest.id and integration.evidence_id=evidence.id
		            and integration.conclusion='success' and evidence.producer_principal_type='service')))))),
		  coalesce(review.id::text,''),
		  coalesce(review.verdict='approved' and review.reviewer_principal_type='user'
		    and not (submission.submitted_by_principal_type='user' and submission.submitted_by_principal_id=review.reviewer_principal_id),false),
		  coalesce(acceptance.id::text,'')
		from verrail_targets target
		left join verrail_work_graphs graph on graph.workspace_id=target.workspace_id and graph.target_id=target.id
		join verrail_target_revisions target_revision on target_revision.id=target.active_target_revision_id and target_revision.workspace_id=target.workspace_id
		join lateral (select * from verrail_submissions where workspace_id=$1 and target_id=$2 order by created_at desc,id desc limit 1) submission on true
		left join lateral (select * from verrail_delivery_reviews where workspace_id=$1 and submission_id=submission.id order by created_at desc,id desc limit 1) review on true
		left join verrail_acceptances acceptance on acceptance.workspace_id=$1 and acceptance.target_id=$2
		  and acceptance.submission_id=submission.id and acceptance.review_id=review.id
		  and acceptance.target_revision_id=target.active_target_revision_id
		  and acceptance.authority='outcome_owner' and acceptance.accepted_by_principal_type='user'
		  and target_revision.outcome_owner_principal_type='user'
		  and acceptance.accepted_by_principal_id=target_revision.outcome_owner_principal_id
		where target.workspace_id=$1 and target.id=$2
	`, workspaceID, targetID, hashJSON).Scan(&facts.submissionID, &facts.candidateCurrent, &facts.criteriaVerified, &facts.reviewID, &facts.reviewApproved, &facts.acceptanceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return deliveryFacts{}, nil
	}
	return facts, err
}

func (facts deliveryFacts) acceptanceValid() bool {
	return facts.candidateCurrent && facts.criteriaVerified && facts.reviewApproved && facts.acceptanceID != ""
}
