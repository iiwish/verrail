"""Run pinned Temporal binaries using registered, separately mounted credentials."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

from runtime_env import database_url, parse_postgres, read_secret


def server_config(values, address):
    database_url(values, None)
    stores = {}
    for name, schema in (("default", "verrail_temporal"), ("visibility", "verrail_visibility")):
        stores[name] = {"sql": {
            "pluginName": "postgres12", "databaseName": values["PGDATABASE"],
            "connectAddr": values["PGHOST"] + ":" + values["PGPORT"], "connectProtocol": "tcp",
            "user": values["PGUSER"], "password": values["PGPASSWORD"],
            "connectAttributes": {"search_path": schema + ",public"},
            "maxConns": 1, "maxIdleConns": 1, "maxConnLifetime": "1h",
        }}
    return {
        "log": {"stdout": True, "level": "info"},
        "persistence": {"numHistoryShards": 4, "defaultStore": "default", "visibilityStore": "visibility", "datastores": stores},
        "global": {"membership": {"maxJoinDuration": "30s", "broadcastAddress": address}},
        "services": {name: {"rpc": {"grpcPort": grpc, "membershipPort": membership, "bindOnIP": "0.0.0.0"}}
                     for name, grpc, membership in (("frontend", 7233, 6933), ("history", 7234, 6934), ("matching", 7235, 6935), ("worker", 7239, 6939))},
        "clusterMetadata": {"enableGlobalNamespace": False, "failoverVersionIncrement": 10, "masterClusterName": "active", "currentClusterName": "active",
                            "clusterInformation": {"active": {"enabled": True, "initialFailoverVersion": 1, "rpcName": "frontend", "rpcAddress": "127.0.0.1:7233"}}},
        "publicClient": {"hostPort": "127.0.0.1:7233"},
    }


def migration_commands(values):
    database_url(values, None)
    env = {"PATH": os.environ["PATH"], "SQL_HOST": values["PGHOST"], "SQL_PORT": values["PGPORT"],
           "SQL_DATABASE": values["PGDATABASE"], "SQL_USER": values["PGUSER"], "SQL_PASSWORD": values["PGPASSWORD"], "SQL_PLUGIN": "postgres12"}
    for schema, source in (("verrail_temporal", "temporal"), ("verrail_visibility", "visibility")):
        scoped = {**env, "SQL_CONNECT_ATTRIBUTES": "search_path=" + schema + "%2Cpublic"}
        yield ["temporal-sql-tool", "setup-schema", "-v", "0.0"], scoped
        yield ["temporal-sql-tool", "update-schema", "--schema-name", "postgresql/v12/" + source], scoped


def main():
    try:
        mode = sys.argv[1]
        if mode == "namespace":
            args = ["temporal", "operator", "namespace"]
            connection = ["--address", "temporal:7233", "--namespace", "verrail-test"]
            result = subprocess.run(args + ["describe"] + connection, capture_output=True, timeout=30)
            if result.returncode:
                subprocess.run(args + ["create", "--retention", "336h"] + connection, capture_output=True, timeout=30, check=True)
            return 0
        values = parse_postgres(read_secret(os.environ["VERRAIL_POSTGRES_ENV_FILE"]))
        if mode == "migrate":
            for command, env in migration_commands(values):
                subprocess.run(command, env=env, capture_output=True, timeout=300, check=True)
            print("Temporal schema migration complete")
            return 0
        if mode != "server":
            raise ValueError("Invalid mode")
        config = server_config(values, socket.gethostbyname(socket.gethostname()))
        directory = Path(tempfile.mkdtemp(prefix="verrail-temporal-"))
        filename = directory / "config.yaml"
        descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(config, output)
        env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp"), "USER": "temporal", "TEMPORAL_SERVER_CONFIG_FILE_PATH": str(filename)}
        os.execvpe("temporal-server", ["temporal-server", "start"], env)
    except (ValueError, OSError, KeyError, IndexError, subprocess.SubprocessError):
        print("Temporal configuration or operation failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
