package target

import (
	"encoding/json"
	"os"
	"testing"
)

type repositoryStaleFenceHashVector struct {
	Name  string `json:"name"`
	Probe struct {
		WorkspaceID    string              `json:"workspaceId"`
		RunID          string              `json:"runId"`
		RunAttemptID   string              `json:"runAttemptId"`
		IdempotencyKey string              `json:"idempotencyKey"`
		Input          ReportRunEventInput `json:"input"`
	} `json:"probe"`
	SerializedInput string `json:"serializedInput"`
	RequestSHA256   string `json:"requestSha256"`
}

func TestRepositoryStaleFenceRequestHashInterop(t *testing.T) {
	data, err := os.ReadFile("testdata/repository-stale-fence-hash-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SchemaVersion int                              `json:"schemaVersion"`
		Synthetic     bool                             `json:"synthetic"`
		Vectors       []repositoryStaleFenceHashVector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || !fixture.Synthetic || len(fixture.Vectors) != 3 {
		t.Fatal("unexpected synthetic TypeScript interoperability fixture")
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			if vector.Probe.Input.Payload != nil || vector.Probe.Input.EmittedAt.Nanosecond() != 0 {
				t.Fatal("fixture must enter the validator payload-free at a whole UTC second")
			}
			command := ReportRunEventCommand{WorkspaceID: vector.Probe.WorkspaceID, RunID: vector.Probe.RunID,
				RunAttemptID: vector.Probe.RunAttemptID, IdempotencyKey: vector.Probe.IdempotencyKey,
				Principal: Principal{Type: "service", ID: "verrail-repository-runner"}, Input: vector.Probe.Input}
			if err := ValidateReportRunEventCommand(&command); err != nil {
				t.Fatal(err)
			}
			if command.Input.Payload == nil || len(command.Input.Payload) != 0 {
				t.Fatal("production validator must normalize absent payload to an empty map")
			}
			encoded, err := json.Marshal(command.Input)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != vector.SerializedInput || command.RequestHash != vector.RequestSHA256 {
				t.Fatalf("Go normalized wire/hash differs from TypeScript: %s / %s", encoded, command.RequestHash)
			}
			// Both nil and empty maps must stay absent under the existing omitempty contract.
			command.Input.Payload = nil
			nilHash, err := hashExecutionInput(command.Input)
			if err != nil || nilHash != vector.RequestSHA256 {
				t.Fatalf("nil-payload hash differs: %s / %v", nilHash, err)
			}
			command.Input.Payload = map[string]any{"marker": "not-a-payload-free-probe"}
			nonemptyHash, err := hashExecutionInput(command.Input)
			if err != nil || nonemptyHash == vector.RequestSHA256 {
				t.Fatalf("nonempty payload must not retain the fixed-probe hash: %s / %v", nonemptyHash, err)
			}
		})
	}
}

func TestRepositoryStaleFenceInvalidCalendarDates(t *testing.T) {
	for _, date := range []string{"2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-16T24:00:00Z", "2026-10-16T00:00:60Z"} {
		t.Run(date, func(t *testing.T) {
			var input ReportRunEventInput
			if err := json.Unmarshal([]byte(`{"emittedAt":"`+date+`"}`), &input); err == nil {
				t.Fatal("Go must reject an invalid calendar timestamp")
			}
		})
	}
}
