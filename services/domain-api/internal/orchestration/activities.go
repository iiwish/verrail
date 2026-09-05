package orchestration

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/verrail/verrail/services/domain-api/internal/target"
	"go.temporal.io/sdk/temporal"
)

type DomainActivities struct {
	store               *target.Store
	servicePrincipalID  string
	executorPrincipalID string
	runtimeProfile      string
	leaseDuration       time.Duration
	graceDuration       time.Duration
}

type DomainActivitiesConfig struct {
	ServicePrincipalID  string
	ExecutorPrincipalID string
	RuntimeProfile      string
	LeaseDuration       time.Duration
	GraceDuration       time.Duration
}

func NewDomainActivities(store *target.Store, config DomainActivitiesConfig) *DomainActivities {
	if config.ServicePrincipalID == "" {
		config.ServicePrincipalID = "verrail-orchestration-worker"
	}
	if config.ExecutorPrincipalID == "" {
		config.ExecutorPrincipalID = "verrail-host-runner"
	}
	if config.RuntimeProfile == "" {
		config.RuntimeProfile = "host_trusted"
	}
	if config.LeaseDuration <= 0 {
		config.LeaseDuration = 2 * time.Minute
	}
	if config.GraceDuration < 0 {
		config.GraceDuration = 0
	}
	if config.GraceDuration == 0 {
		config.GraceDuration = 30 * time.Second
	}
	return &DomainActivities{
		store:               store,
		servicePrincipalID:  config.ServicePrincipalID,
		executorPrincipalID: config.ExecutorPrincipalID,
		runtimeProfile:      config.RuntimeProfile,
		leaseDuration:       config.LeaseDuration,
		graceDuration:       config.GraceDuration,
	}
}

func (activities *DomainActivities) ReconcileTarget(ctx context.Context, input ReconcileTargetActivityInput) (ReconcileTargetActivityResult, error) {
	if input.SchemaVersion != SchemaVersion || input.Cycle < 1 {
		return ReconcileTargetActivityResult{}, fmt.Errorf("invalid Target reconciliation Activity input")
	}
	command := target.ReconcileGraphCommand{
		WorkspaceID:      input.WorkspaceID,
		TargetID:         input.TargetID,
		TargetRevisionID: input.TargetRevisionID,
		GraphRevisionID:  input.GraphRevisionID,
		Principal:        target.Principal{Type: "service", ID: activities.servicePrincipalID},
		IdempotencyKey:   fmt.Sprintf("orchestrate:reconcile:%s:%d", input.GraphRevisionID, input.Cycle),
	}
	if err := target.ValidateReconcileGraphCommand(&command); err != nil {
		return ReconcileTargetActivityResult{}, err
	}
	reconciled, err := activities.store.ReconcileGraph(ctx, command)
	if err != nil {
		return ReconcileTargetActivityResult{}, err
	}
	result := ReconcileTargetActivityResult{
		SchemaVersion:      SchemaVersion,
		ActivatedNodeIDs:   reconciled.ActivatedNodeIDs,
		ScheduledRuns:      []ScheduledAgentRun{},
		ActiveRunIDs:       append([]string(nil), reconciled.ActiveRunIDs...),
		WaitingTaskNodeIDs: reconciled.WaitingTaskNodeIDs,
		WaitingGateNodeIDs: reconciled.WaitingGateNodeIDs,
		BlockedNodeIDs:     reconciled.BlockedNodeIDs,
		AllCompleted:       reconciled.AllCompleted,
	}
	for _, node := range reconciled.AgentNodes {
		runCommand := target.CreateRunCommand{
			WorkspaceID:     input.WorkspaceID,
			TargetID:        input.TargetID,
			GraphRevisionID: input.GraphRevisionID,
			WorkNodeID:      node.WorkNodeID,
			Principal:       target.Principal{Type: "service", ID: activities.servicePrincipalID},
			IdempotencyKey:  fmt.Sprintf("orchestrate:run:%s:%s", input.GraphRevisionID, node.WorkNodeID),
			Input: target.CreateRunInput{
				Kind: "agent_run",
				Actor: target.ResponsiblePrincipal{
					PrincipalType: "agent",
					PrincipalID:   node.DeploymentRevisionID,
				},
			},
		}
		if err := target.ValidateCreateRunCommand(&runCommand); err != nil {
			return ReconcileTargetActivityResult{}, err
		}
		run, err := activities.store.CreateRun(ctx, runCommand)
		if err != nil {
			return ReconcileTargetActivityResult{}, err
		}
		result.ScheduledRuns = append(result.ScheduledRuns, ScheduledAgentRun{
			RunID:                run.RunID,
			TargetID:             run.TargetID,
			TargetRevisionID:     run.TargetRevisionID,
			GraphRevisionID:      run.GraphRevisionID,
			WorkNodeID:           run.WorkNodeID,
			DeploymentRevisionID: node.DeploymentRevisionID,
		})
		if !containsString(result.ActiveRunIDs, run.RunID) {
			result.ActiveRunIDs = append(result.ActiveRunIDs, run.RunID)
		}
	}
	sort.Strings(result.ActiveRunIDs)
	return result, nil
}

func (activities *DomainActivities) EnsureRunAttempt(ctx context.Context, input EnsureRunAttemptActivityInput) (EnsureRunAttemptActivityResult, error) {
	if input.SchemaVersion != SchemaVersion || input.AttemptOrdinal < 1 || input.MaxAttempts < 1 {
		return EnsureRunAttemptActivityResult{}, fmt.Errorf("invalid Run attempt Activity input")
	}
	command := target.CreateRunAttemptCommand{
		WorkspaceID:    input.WorkspaceID,
		RunID:          input.RunID,
		Principal:      target.Principal{Type: "service", ID: activities.servicePrincipalID},
		IdempotencyKey: fmt.Sprintf("orchestrate:attempt:%s:%d", input.RunID, input.AttemptOrdinal),
		Input: target.CreateRunAttemptInput{
			RuntimeProfile: activities.runtimeProfile,
			Executor: target.ExecutorPrincipal{
				PrincipalType: "service",
				PrincipalID:   activities.executorPrincipalID,
			},
			LeaseDurationSeconds: int(activities.leaseDuration.Seconds()),
			GraceDurationSeconds: int(activities.graceDuration.Seconds()),
			MaxAttempts:          input.MaxAttempts,
		},
	}
	if err := target.ValidateCreateRunAttemptCommand(&command); err != nil {
		return EnsureRunAttemptActivityResult{}, err
	}
	attempt, err := activities.store.CreateRunAttempt(ctx, command)
	if err != nil {
		var domainErr *target.Error
		if errors.As(err, &domainErr) && domainErr.Code == "RUN_ATTEMPTS_EXHAUSTED" {
			return EnsureRunAttemptActivityResult{}, temporal.NewNonRetryableApplicationError(domainErr.Message, domainErr.Code, err)
		}
		return EnsureRunAttemptActivityResult{}, err
	}
	recoverAfterValue := attempt.GraceExpiresAt
	if recoverAfterValue == "" {
		expiresAt, err := time.Parse(time.RFC3339Nano, attempt.ExpiresAt)
		if err != nil {
			return EnsureRunAttemptActivityResult{}, fmt.Errorf("parse ExecutionLease expiry: %w", err)
		}
		recoverAfterValue = expiresAt.Add(activities.graceDuration).Format(time.RFC3339Nano)
	}
	recoverAfter, err := time.Parse(time.RFC3339Nano, recoverAfterValue)
	if err != nil {
		return EnsureRunAttemptActivityResult{}, fmt.Errorf("parse ExecutionLease grace expiry: %w", err)
	}
	return EnsureRunAttemptActivityResult{
		SchemaVersion: SchemaVersion,
		RunID:         attempt.RunID,
		RunAttemptID:  attempt.RunAttemptID,
		LeaseID:       attempt.LeaseID,
		AttemptNumber: attempt.AttemptNumber,
		FencingToken:  attempt.FencingToken,
		RecoverAfter:  recoverAfter,
		Replayed:      attempt.Replayed,
	}, nil
}

func (activities *DomainActivities) RequestRunCancellation(ctx context.Context, input RequestRunCancellationActivityInput) error {
	if input.SchemaVersion != SchemaVersion {
		return fmt.Errorf("invalid Run cancellation Activity input")
	}
	command := target.RequestRunCancellationCommand{
		WorkspaceID:    input.WorkspaceID,
		RunID:          input.RunID,
		Principal:      target.Principal{Type: "service", ID: activities.servicePrincipalID},
		IdempotencyKey: "orchestrate:cancel:" + input.RunID,
	}
	if err := target.ValidateRequestRunCancellationCommand(&command); err != nil {
		return err
	}
	_, err := activities.store.RequestRunCancellation(ctx, command)
	return err
}

func (activities *DomainActivities) ObserveRunRecovery(ctx context.Context, input ObserveRunRecoveryActivityInput) (ObserveRunRecoveryActivityResult, error) {
	if input.SchemaVersion != SchemaVersion {
		return ObserveRunRecoveryActivityResult{}, fmt.Errorf("invalid recovery Activity input")
	}
	return activities.store.ObserveRunForRecovery(ctx, input.WorkspaceID, input.RunID, target.Principal{Type: "service", ID: activities.servicePrincipalID})
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
