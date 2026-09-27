import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which("docker"), "Docker Compose is required for normalization")
class ComposeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[2]
        # Tags deliberately cannot pass the release digest gate; these are syntax fixtures.
        env = {**os.environ, **{key: "fixture/" + key.lower() + ":test" for key in (
            "VERRAIL_CONTROL_IMAGE", "VERRAIL_DOMAIN_IMAGE", "VERRAIL_GATEWAY_IMAGE", "VERRAIL_TEMPORAL_IMAGE", "VERRAIL_REPOSITORY_IMAGE")},
            "VERRAIL_PUBLIC_URL": "http://127.0.0.1:3271", "VERRAIL_ALLOWED_HOSTNAMES": "127.0.0.1", "VERRAIL_CHAT_MODEL": "fixture/model",
            "VERRAIL_REPOSITORY_WORKSPACE_IDS": '["11111111-1111-4111-8111-111111111111"]'}
        result = subprocess.run(["docker", "compose", "-f", str(cls.root / "docker/maco/compose.yaml"), "config", "--format", "json"],
                                env=env, capture_output=True, text=True, check=True, timeout=30)
        cls.config = json.loads(result.stdout)
        cls.env = env
        cls.manifest = json.loads((cls.root / "deploy/maco.json").read_text())

    def test_exact_services_and_dependency_order(self):
        services = self.config["services"]
        self.assertEqual(set(services), set(self.manifest["services"]))
        self.assertEqual(services["temporal-migrate"]["depends_on"]["migrate"]["condition"], "service_completed_successfully")
        self.assertEqual(services["temporal"]["depends_on"]["temporal-migrate"]["condition"], "service_completed_successfully")
        self.assertEqual(services["orchestration-worker"]["depends_on"]["temporal-namespace"]["condition"], "service_completed_successfully")

    def test_secrets_network_and_persistence_boundaries(self):
        services = self.config["services"]
        self.assertEqual(services["control-plane"]["environment"]["PAPERCLIP_ALLOWED_HOSTNAMES"], "127.0.0.1,control-plane")
        self.assertEqual(services["execution-gateway"]["environment"]["VERRAIL_CONTROL_PLANE_URL"], "http://control-plane:3100")
        self.assertNotIn("1panel-network", services["execution-gateway"]["networks"])
        for name, service in services.items():
            mounts = service.get("volumes", [])
            for mount in mounts:
                self.assertFalse(mount["bind"].get("create_host_path", False))
                if "/secrets/" in mount["source"]:
                    self.assertTrue(mount["read_only"])
                if mount["source"].endswith("postgres-migration.env"):
                    self.assertIn(name, ("migrate", "temporal-migrate"))
            if name == "execution-gateway":
                self.assertFalse(any("postgres" in mount["source"] for mount in mounts))
            self.assertEqual(len(service["tmpfs"]), 2 if name == "control-plane" else 1)
            self.assertTrue(service["read_only"])
            self.assertEqual(service["user"], "1000:1000")
            if self.manifest["services"][name]["kind"] == "service":
                self.assertEqual(service["restart"], "unless-stopped")
                self.assertEqual(service["healthcheck"]["test"][0], "CMD")
        ports = [(name, port) for name, service in services.items() for port in service.get("ports", [])]
        self.assertEqual(len(ports), 1)
        self.assertEqual(ports[0][0], "control-plane")
        self.assertEqual(ports[0][1]["host_ip"], "127.0.0.1")

    def test_operator_overlay_changes_only_the_explicit_migration_job(self):
        result = subprocess.run(["docker", "compose", "-f", str(self.root / "docker/maco/compose.yaml"),
                                 "-f", str(self.root / "docker/maco/bootstrap.compose.yaml"), "config", "--format", "json"],
                                env=self.env, capture_output=True, text=True, check=True, timeout=30)
        config = json.loads(result.stdout)
        self.assertEqual(set(config["services"]), set(self.manifest["services"]))
        expected = json.loads(json.dumps(self.config))
        job = expected["services"]["migrate"]
        job["command"] = ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "/app/server/dist/first-operator-main.js"]
        job["stdin_open"] = True
        job["environment"].update(PAPERCLIP_DEPLOYMENT_MODE="authenticated", PAPERCLIP_DEPLOYMENT_EXPOSURE="private", PAPERCLIP_AUTH_DISABLE_SIGN_UP="true")
        self.assertEqual(config, expected)

    def test_recovery_authority_and_connection_budget(self):
        services = self.config["services"]
        recovery = services["repository-recovery"]
        self.assertEqual(recovery["image"], services["control-plane"]["image"])
        self.assertTrue(recovery["command"][-1].endswith("/execution/repository-recovery-main.js"))
        self.assertEqual(recovery["depends_on"]["domain-api"]["condition"], "service_healthy")
        self.assertEqual({mount["target"] for mount in recovery["volumes"]},
                         {"/run/secrets/postgres.env", "/run/secrets/domain-token"})
        self.assertFalse(recovery.get("ports"))
        # Temporal runs four roles with two one-connection persistence stores each.
        total = 8 + sum(int(services[name]["environment"][key]) for name, key in (
            ("control-plane", "DATABASE_POOL_MAX"), ("repository-recovery", "DATABASE_POOL_MAX"), ("repository-executor", "DATABASE_POOL_MAX"),
            ("domain-api", "VERRAIL_PGX_POOL_MAX"), ("orchestration-worker", "VERRAIL_PGX_POOL_MAX")))
        self.assertEqual(total, 20)
        self.assertLessEqual(total, self.manifest["database"]["pool_budget"])

    def test_repository_executor_is_scoped_and_shares_only_artifacts(self):
        services = self.config["services"]
        executor = services["repository-executor"]
        mounts = {mount["target"]: mount["source"] for mount in executor["volumes"]}
        self.assertEqual(set(mounts), {"/run/secrets/postgres.env", "/run/secrets/domain-token",
            "/run/secrets/providers.json", "/var/lib/verrail-artifacts", "/var/lib/verrail-repository",
            "/run/secrets/container-runner.json", "/run/secrets/container-runner-key", "/run/secrets/container-runner-known-hosts"})
        control_mounts = {mount["target"]: mount["source"] for mount in services["control-plane"]["volumes"]}
        self.assertEqual(mounts["/var/lib/verrail-artifacts"], control_mounts["/var/lib/verrail-artifacts"])
        self.assertNotIn("/var/lib/verrail", mounts)
        self.assertFalse(executor.get("ports"))
        self.assertEqual(executor["pids_limit"], 128)
        self.assertEqual(executor["environment"]["VERRAIL_REPOSITORY_CHECKOUT_ROOT"], "/var/lib/verrail-repository/workspaces")
        self.assertEqual(executor["environment"]["VERRAIL_REPOSITORY_CONTAINER_CONFIG_FILE"], "/run/secrets/container-runner.json")
        self.assertFalse(any("docker.sock" in mount["source"] for service in services.values() for mount in service.get("volumes", [])))
        self.assertEqual(services["orchestration-worker"]["environment"]["VERRAIL_EXECUTOR_RUNTIME_PROFILE"], "repository_sandbox")
        for service in ("domain-api", "control-plane"):
            self.assertEqual(services[service]["environment"]["VERRAIL_EXECUTOR_RUNTIME_PROFILE"], "repository_sandbox")
        self.assertEqual(services["orchestration-worker"]["environment"]["VERRAIL_EXECUTOR_PRINCIPAL_ID"], "verrail-repository-runner")

    def test_source_acquisition_has_private_bounded_scratch(self):
        control = self.config["services"]["control-plane"]
        root = control["environment"]["VERRAIL_REPOSITORY_SOURCE_SCRATCH"]
        self.assertIn(root + ":rw,nosuid,nodev,noexec,size=512m,mode=0700,uid=1000,gid=1000", control["tmpfs"])
        self.assertFalse(any(root in mount for mount in self.config["services"]["repository-executor"]["tmpfs"]))


if __name__ == "__main__":
    unittest.main()
