package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/verrail/verrail/services/domain-api/internal/target"
)

const maxBodyBytes = 64 * 1024

type createFunc func(*http.Request, target.CreateCommand) (target.CreateResult, error)

type Server struct {
	token  string
	create createFunc
	logger *slog.Logger
}

func New(token string, store *target.Store, logger *slog.Logger) http.Handler {
	server := &Server{
		token:  token,
		logger: logger,
		create: func(request *http.Request, command target.CreateCommand) (target.CreateResult, error) {
			return store.Create(request.Context(), command)
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("POST /v1/workspaces/{workspaceId}/targets", server.createTarget)
	return mux
}

func (server *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"status": "ok", "service": "verrail-domain-api"})
}

func (server *Server) createTarget(response http.ResponseWriter, request *http.Request) {
	if !server.authorized(request) {
		writeError(response, &target.Error{Status: 401, Code: "DOMAIN_API_UNAUTHORIZED", Message: "Unauthorized"})
		return
	}
	command := target.CreateCommand{
		WorkspaceID: request.PathValue("workspaceId"),
		Principal: target.Principal{
			Type: request.Header.Get("X-Verrail-Principal-Type"),
			ID:   request.Header.Get("X-Verrail-Principal-Id"),
		},
		IdempotencyKey: request.Header.Get("Idempotency-Key"),
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&command.Input); err != nil {
		status := 400
		code := "TARGET_COMMAND_INVALID"
		if strings.Contains(err.Error(), "request body too large") {
			status, code = 413, "TARGET_COMMAND_TOO_LARGE"
		}
		writeError(response, &target.Error{Status: status, Code: code, Message: "Invalid Target command"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, &target.Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: "Target command must contain one JSON object"})
		return
	}
	if err := target.ValidateCommand(&command); err != nil {
		writeError(response, target.AsError(err))
		return
	}
	result, err := server.create(request, command)
	if err != nil {
		domainError := target.AsError(err)
		if domainError.Status >= 500 {
			server.logger.Error("Target command failed", "error", err)
		}
		writeError(response, domainError)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeJSON(response, status, result)
}

func (server *Server) authorized(request *http.Request) bool {
	provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	if server.token == "" || len(provided) != len(server.token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(server.token)) == 1
}

func writeError(response http.ResponseWriter, err *target.Error) {
	writeJSON(response, err.Status, map[string]any{
		"error":     err.Message,
		"code":      err.Code,
		"retryable": err.Retryable,
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
