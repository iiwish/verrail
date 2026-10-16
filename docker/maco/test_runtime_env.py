import importlib.util
from pathlib import Path
import unittest
import os
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("runtime_env", Path(__file__).with_name("runtime_env.py"))
runtime_env = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_env)


class RuntimeEnvTests(unittest.TestCase):
    def test_database_url_encodes_password_without_shell_expansion(self):
        values = runtime_env.parse_postgres("PGHOST=postgresql\nPGPORT=5432\nPGDATABASE=verrail_test\nPGUSER=verrail_test_app\nPGPASSWORD=a@:/$(id)#%\n")
        self.assertEqual(runtime_env.database_url(values, 4), "postgresql://verrail_test_app:a%40%3A%2F%24%28id%29%23%25@postgresql:5432/verrail_test?pool_max_conns=4")

    def test_missing_duplicate_and_unknown_fields_fail(self):
        valid = "PGHOST=postgresql\nPGPORT=5432\nPGDATABASE=db\nPGUSER=user\nPGPASSWORD=secret\n"
        for text in (valid.replace("PGPASSWORD=secret\n", ""), valid + "PGUSER=other\n", valid + "DATABASE_URL=bad\n"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                runtime_env.parse_postgres(text)

    def test_invalid_host_port_and_pool_fail(self):
        values = dict(PGHOST="postgresql", PGPORT="5432", PGDATABASE="db", PGUSER="user", PGPASSWORD="secret")
        for key, value in (("PGHOST", "host/evil"), ("PGPORT", "0"), ("PGPORT", "65536")):
            with self.assertRaises(ValueError):
                runtime_env.database_url({**values, key: value}, 4)
        for pool in (0, 21):
            with self.assertRaises(ValueError):
                runtime_env.database_url(values, pool)

    def test_node_url_does_not_contain_pgx_driver_options(self):
        values = dict(PGHOST="postgresql", PGPORT="5432", PGDATABASE="db", PGUSER="user", PGPASSWORD="secret")
        self.assertNotIn("?", runtime_env.database_url(values, None))

    def test_missing_auth_or_database_stops_before_command(self):
        for key in ("VERRAIL_REQUIRE_OPENCODE_AUTH", "VERRAIL_REQUIRE_POSTGRES"):
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("runtime_env.py")), sys.executable, "-c", "print('unexpected')"], env={"PATH": os.environ["PATH"], key: "true"}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr.strip(), "Invalid runtime secret configuration")

    def test_exec_receives_database_without_exposing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "postgres.env"
            path.write_text("PGHOST=postgresql\nPGPORT=5432\nPGDATABASE=db\nPGUSER=user\nPGPASSWORD=secret\n")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("runtime_env.py")), sys.executable, "-c", "import os; assert os.environ['DATABASE_URL'].endswith('/db?pool_max_conns=4'); assert 'VERRAIL_POSTGRES_ENV_FILE' not in os.environ"], env={"PATH": os.environ["PATH"], "VERRAIL_POSTGRES_ENV_FILE": str(path), "VERRAIL_PGX_POOL_MAX": "4"}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
