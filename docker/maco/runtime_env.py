"""Load registered secret files without sourcing shell code or logging values."""

import os
from pathlib import Path
import re
import sys
from urllib.parse import quote


def parse_postgres(text):
    expected = {"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"}
    values = {}
    for line in text.splitlines():
        if not line:
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in expected or key in values or not value or "\x00" in value:
            raise ValueError("Invalid PostgreSQL credential file")
        values[key] = value
    if values.keys() != expected:
        raise ValueError("Incomplete PostgreSQL credential file")
    return values


def database_url(values, pool):
    if not re.fullmatch(r"[A-Za-z0-9.-]+", values["PGHOST"]):
        raise ValueError("Invalid PostgreSQL host")
    if not values["PGPORT"].isdigit() or not 1 <= int(values["PGPORT"]) <= 65535:
        raise ValueError("Invalid PostgreSQL port")
    if pool is not None and not 1 <= pool <= 20:
        raise ValueError("Invalid PostgreSQL pool budget")
    url = "postgresql://{}:{}@{}:{}/{}".format(
        quote(values["PGUSER"], safe=""), quote(values["PGPASSWORD"], safe=""),
        values["PGHOST"], values["PGPORT"], quote(values["PGDATABASE"], safe=""),
    )
    return url + ("?pool_max_conns={}".format(pool) if pool is not None else "")


def read_secret(filename):
    path = Path(filename)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError("Invalid secret path")
    with path.open("rb") as source:
        raw = source.read(65537)
    if not raw or len(raw) > 65536 or b"\x00" in raw:
        raise ValueError("Invalid secret file")
    return raw.decode("utf-8")


def main():
    try:
        env = dict(os.environ)
        filename = env.pop("VERRAIL_POSTGRES_ENV_FILE", None)
        pool = env.pop("VERRAIL_PGX_POOL_MAX", None)
        if filename:
            if env.get("DATABASE_URL") or env.get("DATABASE_MIGRATION_URL"):
                raise ValueError("Conflicting database configuration")
            env["DATABASE_URL"] = database_url(parse_postgres(read_secret(filename)), int(pool) if pool else None)
        elif pool:
            raise ValueError("Pool configuration requires registered credentials")
        for key in ("BETTER_AUTH_SECRET", "VERRAIL_DOMAIN_API_TOKEN", "OPENCODE_SERVER_PASSWORD"):
            filename = env.pop(key + "_FILE", None)
            if filename:
                if env.get(key):
                    raise ValueError("Conflicting secret configuration")
                env[key] = read_secret(filename).rstrip("\r\n")
                if not env[key]:
                    raise ValueError("Empty secret")
        if env.pop("VERRAIL_REQUIRE_OPENCODE_AUTH", "false") == "true" and not env.get("OPENCODE_SERVER_PASSWORD"):
            raise ValueError("OpenCode authentication is required")
        if env.pop("VERRAIL_REQUIRE_POSTGRES", "false") == "true" and not env.get("DATABASE_URL"):
            raise ValueError("External PostgreSQL is required")
        if len(sys.argv) < 2:
            raise ValueError("Missing command")
    except (ValueError, OSError):
        print("Invalid runtime secret configuration", file=sys.stderr)
        return 1
    os.execvpe(sys.argv[1], sys.argv[1:], env)


if __name__ == "__main__":
    sys.exit(main())
