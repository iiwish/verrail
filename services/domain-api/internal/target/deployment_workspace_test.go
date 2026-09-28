package target

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"testing"
)

type workspaceLookupTx struct {
	pgx.Tx
	workspaceID string
	cwd, source string
}

type workspaceLookupRow struct {
	cwd, source string
	err         error
}

func (row workspaceLookupRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*dest[0].(**string) = &row.cwd
	*dest[1].(**string) = &row.source
	return nil
}
func (tx workspaceLookupTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	if args[1] != tx.workspaceID {
		return workspaceLookupRow{err: pgx.ErrNoRows}
	}
	return workspaceLookupRow{cwd: tx.cwd, source: tx.source}
}

func TestDeploymentWorkspaceResolution(t *testing.T) {
	ctx := context.Background()
	id := "11111111-1111-4111-8111-111111111111"
	tx := workspaceLookupTx{workspaceID: "workspace", cwd: "/registered/project", source: "local_path"}
	input := map[string]any{"projectWorkspaceId": id, "cwd": "/untrusted/client/path"}
	resolved, err := resolveDeploymentWorkspace(ctx, tx, "workspace", input)
	require.NoError(t, err)
	require.Equal(t, "/registered/project", resolved["cwd"])
	require.Equal(t, "/untrusted/client/path", input["cwd"])
	_, err = resolveDeploymentWorkspace(ctx, tx, "foreign-workspace", input)
	require.Error(t, err)
	for _, invalid := range []any{"not-a-uuid", 42, nil} {
		_, err = resolveDeploymentWorkspace(ctx, nil, "workspace", map[string]any{"projectWorkspaceId": invalid})
		require.Error(t, err)
	}
	for _, invalid := range []workspaceLookupTx{
		{workspaceID: "workspace", cwd: "relative", source: "local_path"},
		{workspaceID: "workspace", cwd: "/remote", source: "remote"},
		{workspaceID: "workspace", cwd: "/bad\x00path", source: "local_path"},
	} {
		_, err = resolveDeploymentWorkspace(ctx, invalid, "workspace", input)
		require.Error(t, err)
	}
	legacy := map[string]any{"cwd": "/pinned/historical/path"}
	resolved, err = resolveDeploymentWorkspace(ctx, nil, "workspace", legacy)
	require.NoError(t, err)
	require.Equal(t, legacy, resolved)
}
