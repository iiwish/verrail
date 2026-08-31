package orchestration

import (
	"context"
	"errors"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

type fakeOutboxStore struct {
	event       *OutboxEvent
	claimErr    error
	delivered   *DeliveryAck
	retry       *RetryAck
	failed      *FailureAck
	acknowledge error
}

func (store *fakeOutboxStore) Claim(context.Context, ClaimOptions) (*OutboxEvent, error) {
	return store.event, store.claimErr
}

func (store *fakeOutboxStore) MarkDelivered(_ context.Context, acknowledgment DeliveryAck) error {
	store.delivered = &acknowledgment
	return store.acknowledge
}

func (store *fakeOutboxStore) MarkRetry(_ context.Context, acknowledgment RetryAck) error {
	store.retry = &acknowledgment
	return store.acknowledge
}

func (store *fakeOutboxStore) MarkFailed(_ context.Context, acknowledgment FailureAck) error {
	store.failed = &acknowledgment
	return store.acknowledge
}

type fakeDeliverer struct {
	result DeliveryResult
	err    error
	event  *OutboxEvent
}

func (deliverer *fakeDeliverer) Deliver(_ context.Context, event OutboxEvent) (DeliveryResult, error) {
	deliverer.event = &event
	return deliverer.result, deliverer.err
}

func claimedTargetEvent(attempt int) *OutboxEvent {
	return &OutboxEvent{
		ID:            "942ebec0-ebec-4ba1-8e5a-dd2585f313fa",
		WorkspaceID:   testWorkspaceID,
		AggregateType: "target",
		AggregateID:   testTargetID,
		EventType:     TargetCreatedEventType,
		Payload:       []byte(`{"schemaVersion":1,"targetId":"` + testTargetID + `","targetRevisionId":"` + testRevisionID + `"}`),
		AttemptCount:  attempt,
		ClaimToken:    "5bc3eced-8c5b-44d3-96aa-a4a329327192",
		CreatedAt:     time.Date(2026, time.August, 26, 22, 0, 0, 0, time.UTC),
	}
}

func TestDispatcherDeliversAndFencedAcknowledges(t *testing.T) {
	store := &fakeOutboxStore{event: claimedTargetEvent(1)}
	deliverer := &fakeDeliverer{result: DeliveryResult{WorkflowID: "workflow-1", RunID: "run-1"}}
	dispatcher := NewDispatcher(store, deliverer, DispatcherConfig{MaxAttempts: 5})

	processed, err := dispatcher.ProcessOne(context.Background())

	require.NoError(t, err)
	require.True(t, processed)
	require.NotNil(t, deliverer.event)
	require.Equal(t, store.event.ID, deliverer.event.ID)
	require.Equal(t, &DeliveryAck{
		EventID:     store.event.ID,
		ClaimToken:  store.event.ClaimToken,
		WorkflowID:  "workflow-1",
		WorkflowRun: "run-1",
	}, store.delivered)
}

func TestDispatcherRetriesTransientFailureWithBoundedBackoff(t *testing.T) {
	now := time.Date(2026, time.August, 26, 22, 0, 0, 0, time.UTC)
	store := &fakeOutboxStore{event: claimedTargetEvent(2)}
	deliverer := &fakeDeliverer{err: errors.New("temporal unavailable")}
	dispatcher := NewDispatcher(store, deliverer, DispatcherConfig{
		MaxAttempts: 5,
		BackoffBase: time.Second,
		BackoffMax:  10 * time.Second,
		Now:         func() time.Time { return now },
	})

	processed, err := dispatcher.ProcessOne(context.Background())

	require.NoError(t, err)
	require.True(t, processed)
	require.Equal(t, &RetryAck{
		EventID:     store.event.ID,
		ClaimToken:  store.event.ClaimToken,
		AvailableAt: now.Add(2 * time.Second),
		LastError:   "temporal unavailable",
	}, store.retry)
}

func TestDispatcherFailsUnsupportedAndExhaustedEvents(t *testing.T) {
	tests := []struct {
		name          string
		event         *OutboxEvent
		deliveryError error
		expectedError string
	}{
		{
			name: "unsupported event",
			event: func() *OutboxEvent {
				event := claimedTargetEvent(1)
				event.EventType = "verrail.target.unknown.v1"
				return event
			}(),
			expectedError: "unsupported outbox event type: verrail.target.unknown.v1",
		},
		{
			name:          "retry exhaustion",
			event:         claimedTargetEvent(5),
			deliveryError: errors.New("temporal unavailable"),
			expectedError: "delivery attempts exhausted: temporal unavailable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeOutboxStore{event: test.event}
			dispatcher := NewDispatcher(store, &fakeDeliverer{err: test.deliveryError}, DispatcherConfig{MaxAttempts: 5})

			processed, err := dispatcher.ProcessOne(context.Background())

			require.NoError(t, err)
			require.True(t, processed)
			require.Equal(t, &FailureAck{
				EventID:    test.event.ID,
				ClaimToken: test.event.ClaimToken,
				LastError:  test.expectedError,
			}, store.failed)
		})
	}
}

func TestDispatcherReturnsIdleWithoutAnAvailableClaim(t *testing.T) {
	dispatcher := NewDispatcher(&fakeOutboxStore{}, &fakeDeliverer{}, DispatcherConfig{})
	processed, err := dispatcher.ProcessOne(context.Background())
	require.NoError(t, err)
	require.False(t, processed)
}

func TestBoundedErrorKeepsValidUTF8(t *testing.T) {
	message := boundedError(errors.New(string(make([]byte, 1999)) + "目标"))
	require.LessOrEqual(t, len(message), 2000)
	require.True(t, utf8.ValidString(message))
}
