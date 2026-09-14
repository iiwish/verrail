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
            "VERRAIL_CONTROL_IMAGE", "VERRAIL_DOMAIN_IMAGE", "VERRAIL_GATEWAY_IMAGE", "VERRAIL_TEMPORAL_IMAGE")},
            "VERRAIL_PUBLIC_URL": "http://127.0.0.1:3271", "VERRAIL_ALLOWED_HOSTNAMES": "127.0.0.1", "VERRAIL_CHAT_MODEL": "fixture/model"}
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
            self.assertEqual(len(service["tmpfs"]), 1)
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


if __name__ == "__main__":
    unittest.main()
