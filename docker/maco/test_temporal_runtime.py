import unittest
from temporal_runtime import migration_commands, server_config


class TemporalRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.values = {"PGHOST": "postgresql", "PGPORT": "5432", "PGDATABASE": "verrail_test", "PGUSER": "verrail_test_app", "PGPASSWORD": 'quoted"password'}

    def test_separate_schemas_in_one_registered_database_and_bounded_pools(self):
        config = server_config(self.values, "172.30.0.2")
        stores = config["persistence"]["datastores"]
        self.assertEqual({store["sql"]["databaseName"] for store in stores.values()}, {"verrail_test"})
        self.assertEqual({store["sql"]["connectAttributes"]["search_path"] for store in stores.values()}, {"verrail_temporal,public", "verrail_visibility,public"})
        self.assertEqual(sum(store["sql"]["maxConns"] for store in stores.values()) * len(config["services"]), 8)

    def test_migrator_never_creates_or_drops_a_database_or_exposes_password_in_args(self):
        commands = list(migration_commands(self.values))
        self.assertEqual(len(commands), 4)
        for command, env in commands:
            self.assertNotIn(self.values["PGPASSWORD"], command)
            self.assertIn(command[1], ("setup-schema", "update-schema"))
            self.assertEqual(env["SQL_PASSWORD"], self.values["PGPASSWORD"])
            self.assertEqual(env["SQL_DATABASE"], "verrail_test")


if __name__ == "__main__":
    unittest.main()
