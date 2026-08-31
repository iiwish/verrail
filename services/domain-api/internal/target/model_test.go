package target

import (
	"strings"
	"testing"
)

func TestValidateCommandCanonicalizesAndHashes(t *testing.T) {
	command := CreateCommand{
		WorkspaceID:    "1081b57b-22a5-4508-b12e-24f6ca1c0d6c",
		Principal:      Principal{Type: "user", ID: "user-1"},
		IdempotencyKey: "target:create:1234",
		Input: CreateInput{
			ProjectID:          "f74bfcd7-e107-4ab3-9e88-0ce69e99ed07",
			Title:              "  Governed Target  ",
			OutcomeOwner:       OutcomeOwner{PrincipalType: "user", PrincipalID: "user-1"},
			Goal:               "  Create one durable fact.  ",
			Constraints:        []string{" One writer. "},
			AcceptanceCriteria: []AcceptanceCriterionInput{{Title: " It is idempotent. "}},
			RiskLevel:          "high",
		},
	}
	if err := ValidateCommand(&command); err != nil {
		t.Fatalf("ValidateCommand: %v", err)
	}
	if command.Input.Title != "Governed Target" || command.Input.Constraints[0] != "One writer." {
		t.Fatalf("command was not normalized: %#v", command.Input)
	}
	if len(command.RequestHash) != 64 {
		t.Fatalf("unexpected request hash %q", command.RequestHash)
	}

	replay := command
	if err := ValidateCommand(&replay); err != nil {
		t.Fatalf("ValidateCommand replay: %v", err)
	}
	if replay.RequestHash != command.RequestHash {
		t.Fatalf("same payload produced a different hash")
	}
}

func TestValidateCommandRejectsUnsafeBoundaries(t *testing.T) {
	command := CreateCommand{
		WorkspaceID:    "1081b57b-22a5-4508-b12e-24f6ca1c0d6c",
		Principal:      Principal{Type: "agent", ID: "agent-1"},
		IdempotencyKey: "unsafe key",
		Input:          CreateInput{ProjectID: "f74bfcd7-e107-4ab3-9e88-0ce69e99ed07"},
	}
	if err := ValidateCommand(&command); err == nil {
		t.Fatal("expected invalid command to fail")
	}
}

func TestValidateCommandCountsUnicodeCharactersInsteadOfBytes(t *testing.T) {
	command := CreateCommand{
		WorkspaceID:    "1081b57b-22a5-4508-b12e-24f6ca1c0d6c",
		Principal:      Principal{Type: "user", ID: "user-1"},
		IdempotencyKey: "target:create:unicode",
		Input: CreateInput{
			ProjectID:          "f74bfcd7-e107-4ab3-9e88-0ce69e99ed07",
			Title:              strings.Repeat("目", 160),
			OutcomeOwner:       OutcomeOwner{PrincipalType: "user", PrincipalID: "user-1"},
			Goal:               "Create one durable fact.",
			AcceptanceCriteria: []AcceptanceCriterionInput{{Title: "It is reviewable."}},
			RiskLevel:          "medium",
		},
	}
	if err := ValidateCommand(&command); err != nil {
		t.Fatalf("160 Unicode characters should be valid: %v", err)
	}
	command.Input.Title = strings.Repeat("目", 161)
	if err := ValidateCommand(&command); err == nil {
		t.Fatal("161 Unicode characters should exceed the title limit")
	}
}
