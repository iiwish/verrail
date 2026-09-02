DO $$
DECLARE
  workspace RECORD;
  definition_id uuid;
  version_id uuid;
  evaluation_id uuid;
  deployment_id uuid;
  revision_id uuid;
  runtime_name text;
  model_name text;
  prompt_text text;
  version_hash text;
BEGIN
  FOR workspace IN
    SELECT company.id AS workspace_id, agent.id AS compatibility_agent_id,
           agent.name AS agent_name, agent.adapter_type, agent.adapter_config,
           agent.capabilities
    FROM companies company
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM agents candidate
      WHERE candidate.company_id = company.id
      ORDER BY (candidate.metadata->>'builtInKey' = 'director') DESC,
               candidate.created_at, candidate.id
      LIMIT 1
    ) agent ON true
  LOOP
    IF EXISTS (
      SELECT 1 FROM verrail_deployments deployment
      WHERE deployment.workspace_id = workspace.workspace_id AND deployment.is_default
    ) THEN
      CONTINUE;
    END IF;

    definition_id := md5('verrail-default-definition:' || workspace.workspace_id::text)::uuid;
    version_id := md5('verrail-default-version:' || workspace.workspace_id::text)::uuid;
    evaluation_id := md5('verrail-default-evaluation:' || workspace.workspace_id::text)::uuid;
    deployment_id := md5('verrail-default-deployment:' || workspace.workspace_id::text)::uuid;
    revision_id := md5('verrail-default-deployment-revision:' || workspace.workspace_id::text)::uuid;
    runtime_name := coalesce(workspace.adapter_type, 'unconfigured');
    model_name := coalesce(workspace.adapter_config->>'model', 'unconfigured');
    prompt_text := coalesce(workspace.capabilities, 'Compatibility snapshot. Publish a governed version before production use.');
    version_hash := md5('verrail-default-version:' || workspace.workspace_id::text);

    INSERT INTO verrail_agent_definitions (
      id, workspace_id, compatibility_agent_id, name, description, status,
      created_by_principal_type, created_by_principal_id
    ) VALUES (
      definition_id, workspace.workspace_id, workspace.compatibility_agent_id,
      coalesce(workspace.agent_name, 'Workspace Director'),
      'Compatibility snapshot imported as a paused default identity; evaluate before activation.',
      'published', 'service', 'migration-0237'
    );

    INSERT INTO verrail_agent_versions (
      id, workspace_id, agent_definition_id, version_number, runtime, model, prompt,
      skills, tools, output_schema, capability_ceiling, supply_chain, content_hash,
      created_by_principal_type, created_by_principal_id
    ) VALUES (
      version_id, workspace.workspace_id, definition_id, 1, runtime_name, model_name,
      prompt_text, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
      jsonb_build_object('compatibilityImport', true, 'compatibilityAgentId', workspace.compatibility_agent_id),
      version_hash, 'service', 'migration-0237'
    );

    INSERT INTO verrail_evaluation_runs (
      id, workspace_id, candidate_agent_version_id, status, safety_status, summary,
      created_by_principal_type, created_by_principal_id
    ) VALUES (
      evaluation_id, workspace.workspace_id, version_id, 'inconclusive', 'not_run',
      'Compatibility import is intentionally not a passing production evaluation.',
      'service', 'migration-0237'
    );

    INSERT INTO verrail_deployments (
      id, workspace_id, agent_definition_id, name, status, is_default,
      created_by_principal_type, created_by_principal_id
    ) VALUES (
      deployment_id, workspace.workspace_id, definition_id, 'Workspace default',
      'paused', true, 'service', 'migration-0237'
    );

    INSERT INTO verrail_deployment_revisions (
      id, workspace_id, deployment_id, revision_number, agent_version_id,
      evaluation_run_id, state, runtime_config, content_hash,
      created_by_principal_type, created_by_principal_id
    ) VALUES (
      revision_id, workspace.workspace_id, deployment_id, 1, version_id,
      evaluation_id, 'paused', '{}'::jsonb,
      md5('verrail-default-deployment-revision:' || workspace.workspace_id::text),
      'service', 'migration-0237'
    );
  END LOOP;
END $$;
