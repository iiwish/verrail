package orchestration

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

type OutboxEvent struct {
	ID            string
	WorkspaceID   string
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       []byte
	AttemptCount  int
	ClaimToken    string
	CreatedAt     time.Time
}

type ClaimOptions struct {
	LeaseDuration time.Duration
}

type DeliveryResult struct {
	WorkflowID string
	RunID      string
}

type DeliveryAck struct {
	EventID     string
	ClaimToken  string
	WorkflowID  string
	WorkflowRun string
}

type RetryAck struct {
	EventID     string
	ClaimToken  string
	AvailableAt time.Time
	LastError   string
}

type FailureAck struct {
	EventID    string
	ClaimToken string
	LastError  string
}

type OutboxStore interface {
	Claim(context.Context, ClaimOptions) (*OutboxEvent, error)
	MarkDelivered(context.Context, DeliveryAck) error
	MarkRetry(context.Context, RetryAck) error
	MarkFailed(context.Context, FailureAck) error
}

type Deliverer interface {
	Deliver(context.Context, OutboxEvent) (DeliveryResult, error)
}

type DispatcherConfig struct {
	LeaseDuration time.Duration
	MaxAttempts   int
	BackoffBase   time.Duration
	BackoffMax    time.Duration
	Now           func() time.Time
}

type Dispatcher struct {
	store       OutboxStore
	deliverer   Deliverer
	lease       time.Duration
	maxAttempts int
	backoffBase time.Duration
	backoffMax  time.Duration
	now         func() time.Time
}

func NewDispatcher(store OutboxStore, deliverer Deliverer, config DispatcherConfig) *Dispatcher {
	if config.LeaseDuration <= 0 {
		config.LeaseDuration = 30 * time.Second
	}
	if config.MaxAttempts <= 0 {
		config.MaxAttempts = 8
	}
	if config.BackoffBase <= 0 {
		config.BackoffBase = time.Second
	}
	if config.BackoffMax <= 0 {
		config.BackoffMax = time.Minute
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Dispatcher{
		store:       store,
		deliverer:   deliverer,
		lease:       config.LeaseDuration,
		maxAttempts: config.MaxAttempts,
		backoffBase: config.BackoffBase,
		backoffMax:  config.BackoffMax,
		now:         config.Now,
	}
}

func (dispatcher *Dispatcher) ProcessOne(ctx context.Context) (bool, error) {
	event, err := dispatcher.store.Claim(ctx, ClaimOptions{LeaseDuration: dispatcher.lease})
	if err != nil {
		return false, fmt.Errorf("claim outbox event: %w", err)
	}
	if event == nil {
		return false, nil
	}

	if event.EventType != TargetCreatedEventType {
		return true, dispatcher.store.MarkFailed(ctx, FailureAck{
			EventID:    event.ID,
			ClaimToken: event.ClaimToken,
			LastError:  "unsupported outbox event type: " + event.EventType,
		})
	}

	result, deliveryErr := dispatcher.deliverer.Deliver(ctx, *event)
	if deliveryErr == nil {
		if err := dispatcher.store.MarkDelivered(ctx, DeliveryAck{
			EventID:     event.ID,
			ClaimToken:  event.ClaimToken,
			WorkflowID:  result.WorkflowID,
			WorkflowRun: result.RunID,
		}); err != nil {
			return true, fmt.Errorf("acknowledge delivered outbox event: %w", err)
		}
		return true, nil
	}

	if isPermanent(deliveryErr) {
		if err := dispatcher.store.MarkFailed(ctx, FailureAck{
			EventID:    event.ID,
			ClaimToken: event.ClaimToken,
			LastError:  boundedError(deliveryErr),
		}); err != nil {
			return true, fmt.Errorf("mark permanent outbox failure: %w", err)
		}
		return true, nil
	}
	if event.AttemptCount >= dispatcher.maxAttempts {
		if err := dispatcher.store.MarkFailed(ctx, FailureAck{
			EventID:    event.ID,
			ClaimToken: event.ClaimToken,
			LastError:  "delivery attempts exhausted: " + boundedError(deliveryErr),
		}); err != nil {
			return true, fmt.Errorf("mark exhausted outbox failure: %w", err)
		}
		return true, nil
	}

	if err := dispatcher.store.MarkRetry(ctx, RetryAck{
		EventID:     event.ID,
		ClaimToken:  event.ClaimToken,
		AvailableAt: dispatcher.now().Add(dispatcher.backoff(event.AttemptCount)),
		LastError:   boundedError(deliveryErr),
	}); err != nil {
		return true, fmt.Errorf("schedule outbox retry: %w", err)
	}
	return true, nil
}

func (dispatcher *Dispatcher) backoff(attempt int) time.Duration {
	delay := dispatcher.backoffBase
	for index := 1; index < attempt && delay < dispatcher.backoffMax; index++ {
		if delay > dispatcher.backoffMax/2 {
			return dispatcher.backoffMax
		}
		delay *= 2
	}
	if delay > dispatcher.backoffMax {
		return dispatcher.backoffMax
	}
	return delay
}

type permanentError struct{ error }

func Permanent(err error) error {
	if err == nil {
		return nil
	}
	return permanentError{error: err}
}

func isPermanent(err error) bool {
	var permanent permanentError
	return errors.As(err, &permanent)
}

func boundedError(err error) string {
	const limit = 2000
	message := strings.ToValidUTF8(err.Error(), "?")
	if len(message) <= limit {
		return message
	}
	end := limit
	for end > 0 && !utf8.ValidString(message[:end]) {
		end--
	}
	return message[:end]
}
